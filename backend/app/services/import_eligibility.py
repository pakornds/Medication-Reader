"""Validate pharmacist-approved snapshots before the receiving system writes."""

import json
from datetime import UTC, datetime
from hashlib import sha256
from threading import Lock

from app.schemas.analysis import AnalysisResult, EvidenceValidationError, validate_analysis_result
from app.schemas.evidence import PHOTO_KINDS, CaseEvidence
from app.schemas.regimen import validate_regimen_evidence
from app.schemas.review import (
    ImportRequest,
    PharmacistApproval,
    ReviewerIdentity,
    ReviewRow,
    ServiceError,
)


class EligibilityError(ValueError):
    def __init__(self, code: str, message: str, row_ids: list[str] | None = None) -> None:
        super().__init__(message)
        self.detail = ServiceError(
            code=code, message=message, recoverable=True, row_ids=row_ids or []
        )


def _require_pharmacist(actor: ReviewerIdentity) -> None:
    if actor.role != "pharmacist":
        raise EligibilityError("pharmacist_required", "A pharmacist must approve the import.")


def _validate_review(row: ReviewRow, evidence: CaseEvidence) -> None:
    verification = row.verification
    if (
        verification is None
        or verification.reviewer.role not in {"doctor", "pharmacist"}
        or verification.status == "uncertain"
        or verification.identity is None
    ):
        raise EligibilityError("review_required", "Verify identity and current use.", [row.id])
    if verification.status == "current" and not verification.has_complete_regimen():
        raise EligibilityError("regimen_required", "Verify dose, route and frequency.", [row.id])
    if {item.id for item in row.discrepancies} != set(verification.resolved_discrepancies):
        raise EligibilityError("unresolved_conflict", "Resolve the evidence conflicts.", [row.id])

    sources = {source.id: source for source in evidence.sources}
    items = {(item.source_id, item.id): item for item in evidence.items}
    references = [*verification.evidence, verification.identity.evidence]
    references.extend(verification.regimen_references())
    try:
        validate_analysis_result(AnalysisResult(case_id=evidence.case_id, rows=[row]), evidence)
        for component in verification.regimens:
            validate_regimen_evidence(component, row.id, evidence)
        for reference in references:
            source = sources.get(reference.source_id)
            item = items.get((reference.source_id, reference.item_id))
            if source is None or source.availability != "available":
                raise EvidenceValidationError("Unknown or unavailable review source")
            if reference.item_id is not None and (item is None or item.row_id != row.id):
                raise EvidenceValidationError("Evidence item belongs to another row")
            if source.kind in PHOTO_KINDS and item is None:
                raise EvidenceValidationError("Photo verification requires a located item")
        identity_ref = verification.identity.evidence
        identity_source = sources[identity_ref.source_id]
        if identity_source.kind in PHOTO_KINDS:
            identity_item = items[(identity_ref.source_id, identity_ref.item_id)]
            if identity_item.kind != "label_region":
                raise EvidenceValidationError("Appearance cannot verify medication identity")
    except EvidenceValidationError:
        raise EligibilityError(
            "invalid_evidence", "A reviewed field lacks attributable case evidence.", [row.id]
        ) from None


def _fingerprint(row: ReviewRow, evidence: CaseEvidence) -> str:
    snapshot = {
        "row": row.model_dump(mode="json", exclude={"approval"}),
        "evidence": evidence.model_dump(mode="json"),
    }
    return sha256(json.dumps(snapshot, sort_keys=True).encode("utf-8")).hexdigest()


class ApprovalLedger:
    """In-memory approvals retain only a fingerprint of the reviewed case snapshot."""

    def __init__(self) -> None:
        self._approvals: dict[tuple[str, str], tuple[str, PharmacistApproval]] = {}
        self._lock = Lock()

    def approve(
        self, actor: ReviewerIdentity, row: ReviewRow, evidence: CaseEvidence
    ) -> PharmacistApproval:
        _require_pharmacist(actor)
        _validate_review(row, evidence)
        approval = PharmacistApproval(
            pharmacist_id=actor.id,
            approved_at=datetime.now(UTC),
            row_revision=row.revision,
        )
        with self._lock:
            self._approvals[(evidence.case_id, row.id)] = (
                _fingerprint(row, evidence),
                approval.model_copy(),
            )
        return approval

    def eligible_rows(self, actor: ReviewerIdentity, request: ImportRequest) -> list[ReviewRow]:
        _require_pharmacist(actor)
        by_id = {row.id: row for row in request.rows}
        selected = request.selected_row_ids
        if len(by_id) != len(request.rows) or len(set(selected)) != len(selected):
            raise EligibilityError("duplicate_row", "Rows and selections must be unique.")
        if missing_ids := [row_id for row_id in selected if row_id not in by_id]:
            raise EligibilityError("unknown_row", "A selected row is missing.", missing_ids)

        rows = [by_id[row_id] for row_id in selected]
        with self._lock:
            for row in rows:
                approval = row.approval
                recorded = self._approvals.get((request.evidence.case_id, row.id))
                if (
                    approval is None
                    or approval.pharmacist_id != actor.id
                    or approval.row_revision != row.revision
                    or recorded != (_fingerprint(row, request.evidence), approval)
                ):
                    raise EligibilityError(
                        "approval_required", "Approve the current reviewed row.", [row.id]
                    )
                _validate_review(row, request.evidence)
        return rows
