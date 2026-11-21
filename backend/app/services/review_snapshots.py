"""Case-bound, transient screening over the bundled synthetic reference."""

from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from hashlib import sha256
from json import dumps, loads
from pathlib import Path
from uuid import uuid4

from pydantic import Field

from app.schemas.evidence import REPORT_KINDS, ContractModel, Text
from app.schemas.review_scopes import (
    ExposureObservation,
    Revision,
    ScreeningEvidence,
    ScreeningKind,
    ScreeningRelease,
    ScreeningReport,
    ScreeningRow,
    ScreeningSnapshot,
)
from app.services.admissions import active
from app.services.fixture_scopes import evaluate_fixture_report

_FIXTURE_PATH = Path(__file__).resolve().parents[3] / "fixtures/checks/demo-overlap-v2/case.json"
_CLINICAL_SCREENING_ROLES = frozenset({"doctor", "pharmacist"})
_STOPPED_WARNING = "Discontinued medicines are not checked for interactions."


class ReviewSnapshotError(ValueError):
    def __init__(self, code: str, message: str, status: int) -> None:
        super().__init__(message)
        self.code = code
        self.status = status


class SnapshotUpdate(ContractModel):
    admission_revision: Revision
    previous_snapshot_id: Text | None = None
    exposures: list[ExposureObservation] = Field(default_factory=list, max_length=100)


class SnapshotVersion(ContractModel):
    case_id: Text
    snapshot_id: Text
    admission_revision: Revision
    release_id: Text
    mapping_version: Text
    current: bool


class VersionedScreeningReport(ScreeningReport):
    mapping_version: Text
    warnings: list[Text] = Field(default_factory=list)


@dataclass(frozen=True)
class FixtureReference:
    release: ScreeningRelease
    products: dict[str, ScreeningRow]

    def validity(self, snapshot: ScreeningSnapshot, when: datetime) -> str:
        day = when.date()
        references = [self.release.reference, *(rule.reference for rule in self.release.rules)]
        windows = {
            req.max_age_hours
            for rule in self.release.rules
            for req in rule.context_requirements
            if req.max_age_hours is not None
        }
        freshness = []
        for observation in snapshot.exposures:
            observed_at = observation.observed_at
            if observed_at and observation.status != "unknown":
                freshness.append((
                    observed_at > when,
                    [when - observed_at > timedelta(hours=hours) for hours in sorted(windows)],
                ))
        # Include the full fixture reference as well as applicability at the request time.
        payload = dumps(
            {
                "release": self.release.model_dump(mode="json"),
                "products": {key: row.model_dump(mode="json") for key, row in self.products.items()},
                "reference_dates": [(day < ref.reviewed_on, day >= ref.expires_on) for ref in references],
                "exposure_windows": freshness,
            },
            sort_keys=True,
            separators=(",", ":"),
        )
        return sha256(payload.encode()).hexdigest()


def load_fixture_reference() -> FixtureReference:
    try:
        data = loads(_FIXTURE_PATH.read_text(encoding="utf-8"))
        release = ScreeningRelease.model_validate(data["release"])
        reference_snapshot = ScreeningSnapshot.model_validate(data["snapshots"][0])
        if reference_snapshot.release_id != release.id:
            raise ValueError("Fixture mapping release mismatch")
        products = {
            row.product_name.casefold(): row for row in reference_snapshot.rows
            if row.mapping_status == "complete" and row.product_name
        }
        if not products:
            raise ValueError("Fixture product map is empty")
        return FixtureReference(release, products)
    except (OSError, KeyError, IndexError, TypeError, ValueError) as error:
        raise ReviewSnapshotError("fixture_unavailable", "The synthetic screening reference is unavailable.", 503) from error


@dataclass
class _CurrentSnapshot:
    version: SnapshotVersion
    snapshot: ScreeningSnapshot
    validity: str
    reports: dict[ScreeningKind, VersionedScreeningReport] = field(default_factory=dict)
    stale: bool = False


class ReviewSnapshotStore:
    """Keep at most one snapshot per case. Call with the authorized case under its store lock."""

    def __init__(
        self,
        load_reference: Callable[[], FixtureReference] = load_fixture_reference,
        clock: Callable[[], datetime] = lambda: datetime.now(UTC),
    ) -> None:
        self.load_reference = load_reference
        self.clock = clock
        self._versions: dict[str, _CurrentSnapshot] = {}

    def update(self, case: dict, request: SnapshotUpdate) -> SnapshotVersion:
        existing = self._versions.get(case["id"])
        expected = existing.version.snapshot_id if existing else None
        if request.admission_revision != case["revision"] or request.previous_snapshot_id != expected:
            raise ReviewSnapshotError("stale_snapshot", "Reload the encounter snapshot before updating.", 409)
        if len(case["rows"]) > 100:
            raise ReviewSnapshotError("fixture_row_limit", "Synthetic screening supports up to 100 rows.", 422)
        reference = self.load_reference()
        now = self.clock().astimezone(UTC)
        snapshot = _project_snapshot(case, reference, request.exposures)
        version = SnapshotVersion(
            case_id=case["id"],
            snapshot_id=snapshot.snapshot_id,
            admission_revision=case["revision"],
            release_id=snapshot.release_id,
            mapping_version=reference.release.mapping_version,
            current=True,
        )
        self._versions[case["id"]] = _CurrentSnapshot(version, snapshot, reference.validity(snapshot, now))
        return version

    def describe(self, case: dict) -> SnapshotVersion:
        existing = self._get(case)
        current = self._current_reference(existing, case) is not None
        return existing.version.model_copy(update={"current": current})

    def run(
        self, case: dict, snapshot_id: str, kind: ScreeningKind, *, enabled: bool
    ) -> VersionedScreeningReport:
        existing, reference, when = self._require_current(case, snapshot_id)
        report = evaluate_fixture_report(existing.snapshot, reference.release, kind, evaluated_at=when, enabled=enabled)
        stopped = {row.id for row in existing.snapshot.rows if row.use_status == "stopped"}
        nurse_only = {
            row["id"] for row in case["rows"].values()
            if _current_use_status(row["verified"] or {}) == "nurse_only"
        }
        for scope in report.scopes:
            if scope.reason_code == "use_not_current":
                if stopped.intersection(scope.row_ids):
                    scope.reason_code = "discontinued_medication"
                elif nurse_only.intersection(scope.row_ids):
                    scope.reason_code = "doctor_or_pharmacist_verification_required"
        versioned = VersionedScreeningReport(
            **report.model_dump(),
            mapping_version=existing.version.mapping_version,
            warnings=[_STOPPED_WARNING] if enabled and stopped else [],
        )
        existing.reports[kind] = versioned
        return versioned

    def get_report(self, case: dict, snapshot_id: str, kind: ScreeningKind) -> VersionedScreeningReport:
        existing, _, _ = self._require_current(case, snapshot_id)
        report = existing.reports.get(kind)
        if report is None:
            raise ReviewSnapshotError("report_unavailable", "This report has not been run.", 404)
        return report

    def _get(self, case: dict) -> _CurrentSnapshot:
        existing = self._versions.get(case["id"])
        if existing is None:
            raise ReviewSnapshotError("snapshot_unavailable", "Encounter snapshot unavailable.", 404)
        return existing

    def _require_current(
        self, case: dict, snapshot_id: str
    ) -> tuple[_CurrentSnapshot, FixtureReference, datetime]:
        existing = self._get(case)
        if existing.version.snapshot_id == snapshot_id:
            context = self._current_reference(existing, case)
            if context is not None:
                reference, now = context
                return existing, reference, now
        raise ReviewSnapshotError("stale_snapshot", "Reload and rerun screening for the current encounter.", 409)

    def _current_reference(
        self, existing: _CurrentSnapshot, case: dict,
    ) -> tuple[FixtureReference, datetime] | None:
        if existing.stale or existing.version.admission_revision != case["revision"]:
            self._retire(existing)
            return None
        try:
            reference = self.load_reference()
        except ReviewSnapshotError:
            self._retire(existing)
            raise
        now = self.clock().astimezone(UTC)
        if existing.validity != reference.validity(existing.snapshot, now):
            self._retire(existing)
            return None
        return reference, now

    @staticmethod
    def _retire(existing: _CurrentSnapshot) -> None:
        existing.stale = True
        existing.reports.clear()


def _project_snapshot(
    case: dict, reference: FixtureReference, exposures: list[ExposureObservation],
) -> ScreeningSnapshot:
    rows = []
    evidence = []
    exposure_evidence = {}
    for row in case["rows"].values():
        entries = active(row)
        rows.append(_project_row(row, entries, reference, case["revision"]))
        evidence.extend(
            ScreeningEvidence(id=entry["source"]["id"], revision=case["revision"], description=entry["source"]["kind"])
            for entry in entries
        )
        exposure_evidence[row["id"]] = {
            entry["source"]["id"] for entry in entries
            if entry["source"]["kind"] in REPORT_KINDS or entry["record_basis"] == "documented_interview"
        }

    pairs = set()
    for observation in exposures:
        pair = frozenset(observation.row_ids)
        if pair in pairs or pair - exposure_evidence.keys():
            raise ReviewSnapshotError("invalid_exposure", "Select a unique pair of rows in this encounter.", 422)
        available = set().union(*(exposure_evidence[row_id] for row_id in pair))
        if set(observation.evidence_ids) - available:
            raise ReviewSnapshotError("invalid_exposure", "Cite an active reported-use source linked to that pair.", 422)
        pairs.add(pair)

    return ScreeningSnapshot(
        case_id=case["id"],
        snapshot_id=uuid4().hex,
        release_id=reference.release.id,
        evidence=evidence,
        rows=rows,
        exposures=exposures,
    )


def _current_use_status(verification: dict) -> str:
    answer = verification.get("answer") or {}
    if answer.get("ownership") != "patient":
        return "pending"
    if answer.get("current_use") in {"reported_stopped", "discontinued_order"}:
        return "stopped"
    if answer.get("current_use") == "current":
        return "current" if verification["actor"]["role"] in _CLINICAL_SCREENING_ROLES else "nurse_only"
    return "pending"


def _project_row(row: dict, entries: list[dict], reference: FixtureReference, revision: int) -> ScreeningRow:
    verification = row["verified"] or {}
    identity = verification.get("identity") or {}
    answer = verification.get("answer") or {}
    product = reference.products.get(identity.get("name", "").casefold())
    use_status = _current_use_status(verification)

    entry_ids = [entry["source"]["id"] for entry in entries]
    verified_ids = {identity.get("source_id"), verification.get("source_id")}
    if product and not (verified_ids - set(entry_ids)):
        links = sorted(verified_ids)
        mapping_status = "complete"
    else:
        links = entry_ids
        mapping_status = "incomplete" if identity else "unresolved"
    schedule = (answer.get("schedule") or "").strip().casefold()
    return ScreeningRow(
        id=row["id"],
        revision=revision,
        product_id=product.product_id if product else None,
        product_name=product.product_name if product else None,
        ingredient_ids=product.ingredient_ids if mapping_status == "complete" else [],
        mapping_status=mapping_status,
        route=(answer.get("route") or "").strip().casefold() or None,
        use_status="pending" if use_status == "nurse_only" else use_status,
        schedule=schedule if schedule in {"scheduled", "prn"} else None,
        evidence_ids=links,
    )
