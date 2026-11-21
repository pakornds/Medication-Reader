"""Domain contract for the versioned synthetic screening fixtures."""

from datetime import date
from typing import Annotated, Literal

from pydantic import AnyHttpUrl, AwareDatetime, Field, model_validator

from .evidence import ContractModel, Text

ScreeningKind = Literal["DDI", "DRP"]
Outcome = Literal["finding", "no_finding", "unevaluated"]
ExposureStatus = Literal["unknown", "excluded", "confirmed"]
Revision = Annotated[int, Field(ge=1)]
Count = Annotated[int, Field(ge=0)]


def _unique_ids(ids: list[str], name: str) -> set[str]:
    unique = set(ids)
    if len(ids) != len(unique):
        raise ValueError(f"Duplicate {name}")
    return unique


def _require_ids(ids: list[str], supported: set[str], name: str) -> None:
    if _unique_ids(ids, name) - supported:
        raise ValueError(f"Unknown {name}")


class ScreeningReference(ContractModel):
    source_url: AnyHttpUrl
    source_section: Text
    jurisdiction: Text
    population: Text
    permitted_use: Literal["synthetic_demo"]
    source_revision_date: date
    reviewed_on: date
    expires_on: date

    @model_validator(mode="after")
    def check_dates(self):
        if not (self.source_revision_date <= self.reviewed_on < self.expires_on):
            raise ValueError("Reference revision, review and expiry dates are out of order")
        return self


class RuleContextRequirement(ContractModel):
    field: Literal["pair_exposure"]
    required_status: ExposureStatus
    unit: Literal["status"]
    max_age_hours: Annotated[int, Field(gt=0)] | None = None


class ScreeningRule(ContractModel):
    id: Text
    version: Text
    kind: ScreeningKind
    routes: list[Text] = Field(min_length=1)
    ingredient_ids: list[Text] = Field(default_factory=list)
    context_requirements: list[RuleContextRequirement]
    fixture_outcome: Literal["finding", "no_finding"]
    description: Text
    reference: ScreeningReference

    @model_validator(mode="after")
    def check_rule(self):
        _unique_ids(self.routes, "rule routes")
        _unique_ids([requirement.field for requirement in self.context_requirements], "context fields")
        # The same substance may occur on both sides of an ingredient pair.
        if self.kind == "DDI" and len(self.ingredient_ids) != 2:
            raise ValueError("DDI fixture rules require an ingredient pair")
        return self


class ScreeningFollowUp(ContractModel):
    id: Text
    question: Text


class ScreeningRelease(ContractModel):
    id: Text
    mapping_version: Text
    reference: ScreeningReference
    rules: list[ScreeningRule] = Field(min_length=1)
    follow_ups: list[ScreeningFollowUp] = Field(default_factory=list)

    @model_validator(mode="after")
    def check_rules(self):
        _unique_ids([rule.id for rule in self.rules], "rule IDs")
        _unique_ids([follow_up.id for follow_up in self.follow_ups], "release follow-up IDs")
        return self


class ScreeningEvidence(ContractModel):
    id: Text
    revision: Revision
    description: Text


class ScreeningRow(ContractModel):
    id: Text
    revision: Revision
    product_id: Text | None = None
    product_name: Text | None = None
    ingredient_ids: list[Text] = Field(default_factory=list)
    mapping_status: Literal["complete", "incomplete", "unresolved"]
    route: Text | None = None
    use_status: Literal["current", "stopped", "pending"]
    schedule: Literal["scheduled", "prn"] | None = None
    evidence_ids: list[Text] = Field(min_length=1)

    @model_validator(mode="after")
    def check_mapping(self):
        _unique_ids(self.ingredient_ids, "row ingredient IDs")
        if self.mapping_status == "complete" and (not self.product_id or not self.ingredient_ids):
            raise ValueError("A complete row mapping requires a product and ingredients")
        return self


class ExposureObservation(ContractModel):
    row_ids: list[Text] = Field(min_length=2, max_length=2)
    status: ExposureStatus
    evidence_ids: list[Text] = Field(default_factory=list)
    observed_at: AwareDatetime | None = None

    @model_validator(mode="after")
    def check_exposure(self):
        _unique_ids(self.row_ids, "exposure row IDs")
        if self.status != "unknown" and (not self.evidence_ids or self.observed_at is None):
            raise ValueError("Documented exposure requires evidence and observation time")
        return self


class ScreeningSnapshot(ContractModel):
    case_id: Text
    snapshot_id: Text
    release_id: Text
    evidence: list[ScreeningEvidence]
    rows: list[ScreeningRow]
    exposures: list[ExposureObservation] = Field(default_factory=list)

    @model_validator(mode="after")
    def check_evidence(self):
        row_ids = _unique_ids([row.id for row in self.rows], "snapshot row IDs")
        evidence_ids = _unique_ids([item.id for item in self.evidence], "snapshot evidence IDs")
        for row in self.rows:
            _require_ids(row.evidence_ids, evidence_ids, "row evidence IDs")
        pairs = set()
        for observation in self.exposures:
            _require_ids(observation.row_ids, row_ids, "exposure row IDs")
            _require_ids(observation.evidence_ids, evidence_ids, "exposure evidence IDs")
            pair = frozenset(observation.row_ids)
            if pair in pairs:
                raise ValueError("Duplicate exposure observation for a row pair")
            pairs.add(pair)
        return self


class ScreeningScope(ContractModel):
    scope_id: Text
    parent_scope_id: Text | None = None
    row_ids: list[Text] = Field(min_length=1, max_length=2)
    ingredient_ids: list[Text] = Field(default_factory=list)
    rule_id: Text | None = None
    rule_version: Text | None = None
    outcome: Outcome
    reason_code: Text | None = None
    evidence_ids: list[Text] = Field(default_factory=list)
    reference_section: Text | None = None
    follow_up_ids: list[Text] = Field(default_factory=list)

    @model_validator(mode="after")
    def check_scope(self):
        _unique_ids(self.row_ids, "scope row IDs")
        _unique_ids(self.follow_up_ids, "scope follow-up IDs")
        if (self.outcome == "unevaluated") != (self.reason_code is not None):
            raise ValueError("Unevaluated scopes require a reason code")
        if (self.rule_id is None) != (self.rule_version is None):
            raise ValueError("Scope rule ID and version must be provided together")
        if self.parent_scope_id is not None and (len(self.row_ids) != 2 or len(self.ingredient_ids) != 2):
            raise ValueError("An ingredient child scope requires both a row pair and ingredient pair")
        return self


class ScopeCoverage(ContractModel):
    total_scopes: Count
    evaluated_scopes: Count
    findings: Count
    excluded_scopes: Count

    @classmethod
    def from_scopes(cls, scopes: list[ScreeningScope]) -> "ScopeCoverage":
        counted = [scope for scope in scopes if scope.parent_scope_id is None]
        excluded = sum(scope.outcome == "unevaluated" for scope in counted)
        return cls(
            total_scopes=len(counted),
            evaluated_scopes=len(counted) - excluded,
            findings=sum(scope.outcome == "finding" for scope in counted),
            excluded_scopes=excluded,
        )


class ScreeningReport(ContractModel):
    case_id: Text
    snapshot_id: Text
    release_id: Text
    kind: ScreeningKind
    status: Literal["not_run", "unavailable", "partial", "complete"]
    simulated: Literal[True] = True
    ran_at: AwareDatetime | None
    coverage: ScopeCoverage
    scopes: list[ScreeningScope]

    @model_validator(mode="after")
    def check_coverage(self):
        _unique_ids([scope.scope_id for scope in self.scopes], "report scope IDs")
        if self.coverage != ScopeCoverage.from_scopes(self.scopes):
            raise ValueError("Coverage must equal the distinct parent scopes")

        parent_scopes = {scope.scope_id: scope for scope in self.scopes if scope.parent_scope_id is None}
        scopes_by_parent = {}
        counted_scopes = set()
        for scope in self.scopes:
            rows = frozenset(scope.row_ids)
            if self.kind == "DDI" and len(rows) != 2:
                raise ValueError("DDI report scopes require two distinct rows")
            if scope.parent_scope_id is None:
                key = (rows, scope.rule_id if self.kind == "DRP" else None)
                if key in counted_scopes:
                    raise ValueError("Duplicate counted row scope")
                counted_scopes.add(key)
                continue
            parent = parent_scopes.get(scope.parent_scope_id)
            if parent is None or rows != set(parent.row_ids):
                raise ValueError("Child scope requires a parent with the same row pair in the report")
            scopes_by_parent.setdefault(parent.scope_id, []).append(scope.outcome)
        for parent_id, outcomes in scopes_by_parent.items():
            expected = (
                "unevaluated" if "unevaluated" in outcomes
                else "finding" if "finding" in outcomes
                else "no_finding"
            )
            if parent_scopes[parent_id].outcome != expected:
                raise ValueError("Parent outcome does not reflect its child scopes")

        if self.status == "not_run":
            if self.ran_at is not None or self.scopes:
                raise ValueError("A report that did not run cannot have a timestamp or scopes")
        else:
            count = self.coverage
            expected = (
                "unavailable" if not count.evaluated_scopes
                else "partial" if count.excluded_scopes
                else "complete"
            )
            if self.status != expected or self.ran_at is None:
                raise ValueError("Report status and timestamp must reflect coverage")
        return self

    def validate_context(self, snapshot: ScreeningSnapshot, release: ScreeningRelease) -> None:
        if (self.case_id, self.snapshot_id, self.release_id) != (
            snapshot.case_id, snapshot.snapshot_id, snapshot.release_id
        ) or self.release_id != release.id:
            raise ValueError("Report snapshot or release does not match the encounter")
        rows = {row.id: row for row in snapshot.rows}
        evidence_ids = {item.id for item in snapshot.evidence}
        follow_up_ids = {follow_up.id for follow_up in release.follow_ups}
        rules = {rule.id: rule for rule in release.rules}
        for scope in self.scopes:
            _require_ids(scope.row_ids, set(rows), "scope row IDs")
            _require_ids(scope.evidence_ids, evidence_ids, "scope evidence IDs")
            _require_ids(scope.follow_up_ids, follow_up_ids, "scope follow-up IDs")
            available_ingredients = {
                ingredient for row_id in scope.row_ids for ingredient in rows[row_id].ingredient_ids
            }
            if set(scope.ingredient_ids) - available_ingredients:
                raise ValueError("Scope cites an ingredient outside its rows")
            if scope.parent_scope_id is not None:
                left, right = (rows[row_id].ingredient_ids for row_id in scope.row_ids)
                first, second = scope.ingredient_ids
                if not ((first in left and second in right) or (second in left and first in right)):
                    raise ValueError("Child ingredient scope must compare ingredients across its rows")
            if scope.rule_id is not None:
                rule = rules.get(scope.rule_id)
                if (
                    rule is None or rule.kind != self.kind or rule.version != scope.rule_version
                    or rule.reference.source_section != scope.reference_section
                ):
                    raise ValueError("Scope rule reference does not match the release and report kind")
                if scope.parent_scope_id is not None and sorted(scope.ingredient_ids) != sorted(rule.ingredient_ids):
                    raise ValueError("Child ingredient scope does not match its rule")


class ScreeningFixture(ContractModel):
    release: ScreeningRelease
    snapshots: list[ScreeningSnapshot] = Field(min_length=1)
    reports: list[ScreeningReport] = Field(min_length=1)

    @model_validator(mode="after")
    def check_reports(self):
        _unique_ids([snapshot.snapshot_id for snapshot in self.snapshots], "fixture snapshot IDs")
        snapshots = {snapshot.snapshot_id: snapshot for snapshot in self.snapshots}
        if any(snapshot.release_id != self.release.id for snapshot in snapshots.values()):
            raise ValueError("Snapshot release does not match fixture release")
        report_scopes = {}
        for report in self.reports:
            snapshot = snapshots.get(report.snapshot_id)
            if snapshot is None:
                raise ValueError("Report refers to an unknown snapshot")
            kind_scopes = report_scopes.setdefault(report.snapshot_id, {})
            if report.kind in kind_scopes:
                raise ValueError("Duplicate report kind for a snapshot")
            kind_scopes[report.kind] = {scope.scope_id for scope in report.scopes}
            report.validate_context(snapshot, self.release)
        for reports in report_scopes.values():
            if reports.get("DDI", set()) & reports.get("DRP", set()):
                raise ValueError("DDI and DRP must have independent scope IDs")
        return self
