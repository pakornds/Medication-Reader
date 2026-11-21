"""Optional scope checks against fictional references only."""

from datetime import UTC, datetime
from itertools import combinations

from app.schemas.analysis import AnalysisResult, EvidenceValidationError, validate_analysis_result
from app.schemas.checks import (
    CheckedScope,
    CheckExclusion,
    CheckFinding,
    CheckRequest,
    CheckSummary,
    ReferenceVersion,
)
from app.schemas.evidence import PHOTO_KINDS, CaseEvidence, EvidenceRef, SourceKind
from app.schemas.review import ReviewRow

REFERENCE = ReferenceVersion(name="Synthetic coverage rules", version="demo-v1")
DEMO_IDS = frozenset({"demo-a", "demo-b", "demo-c"})
DDI_PAIRS = {
    frozenset({"demo-a", "demo-b"}): "Simulated finding for Demo A and Demo B.",
    frozenset({"demo-a", "demo-c"}): None,
}
STOPPED_WARNING = "Discontinued medicines are not checked for interactions."


def use_exclusion(row: ReviewRow) -> str | None:
    verification = row.verification
    if verification and verification.status == "no_longer_current":
        return STOPPED_WARNING
    if verification and verification.reviewer.role == "nurse":
        return "Current use has nurse-only verification; doctor or pharmacist verification is required."
    if not verification and row.identity_status != "named":
        return "Current use and medication identity remain unverified."
    if not verification or verification.status != "current" or verification.reviewer.role not in {"doctor", "pharmacist"}:
        return "Current use has not been verified by a clinician."
    return None


DRP_RULE_ID = "synthetic-regimen-review"


class CoverageRequest(CheckRequest):
    evidence: CaseEvidence


def _traceable(reference: EvidenceRef, row_id: str, evidence: CaseEvidence) -> bool:
    source = next((item for item in evidence.sources if item.id == reference.source_id), None)
    if source is None or source.availability != "available" or source.kind == SourceKind.REVERSE_PHOTO:
        return False
    if reference.item_id is None:
        return source.kind not in PHOTO_KINDS
    return any(
        item.id == reference.item_id
        and item.source_id == reference.source_id
        and item.row_id == row_id
        and item.kind != "pill_crop"
        for item in evidence.items
    )


def _eligibility(row: ReviewRow, evidence: CaseEvidence) -> tuple[str | None, str | None]:
    verification = row.verification
    reason = use_exclusion(row)
    if reason:
        return None, reason
    if verification.identity is None or verification.normalized_medication_id is None:
        return None, "Medication identity is unresolved."
    if {item.id for item in row.discrepancies} != set(verification.resolved_discrepancies):
        return None, "Evidence discrepancies remain unresolved."
    try:
        validate_analysis_result(AnalysisResult(case_id=evidence.case_id, rows=[row]), evidence)
    except EvidenceValidationError:
        return None, "The row has invalid case evidence."
    if not all(_traceable(reference, row.id, evidence) for reference in verification.evidence):
        return None, "Current-use verification lacks traceable evidence."
    if not _traceable(verification.identity.evidence, row.id, evidence):
        return None, "Verified identity lacks traceable non-appearance evidence."
    if verification.normalized_medication_id not in DEMO_IDS:
        return None, "Medication is outside the synthetic reference."
    return verification.normalized_medication_id, None


def _ddi_scopes(request: CoverageRequest):
    eligible = {row.id: _eligibility(row, request.evidence) for row in request.rows}
    if len(request.rows) == 1:
        row = request.rows[0]
        _, reason = eligible[row.id]
        yield CheckedScope(row_ids=[row.id]), reason or "A second verified medication is required.", None
        return

    for left, right in combinations(request.rows, 2):
        scope = CheckedScope(row_ids=[left.id, right.id])
        left_id, left_reason = eligible[left.id]
        right_id, right_reason = eligible[right.id]
        reasons = [
            f"{row.id}: {reason}"
            for row, reason in ((left, left_reason), (right, right_reason))
            if reason is not None
        ]
        if reasons:
            yield scope, " ".join(reasons), None
            continue
        pair = frozenset({left_id, right_id})
        if pair not in DDI_PAIRS:
            yield scope, "The pair is outside the synthetic reference.", None
            continue
        yield scope, None, DDI_PAIRS[pair]


def _drp_scopes(request: CoverageRequest):
    for row in request.rows:
        scope = CheckedScope(row_ids=[row.id], rule_id=DRP_RULE_ID)
        _, reason = _eligibility(row, request.evidence)
        verification = row.verification
        if reason is not None:
            yield scope, reason, None
        elif not verification.has_complete_regimen() or not all(
            _traceable(ref, row.id, request.evidence) for ref in verification.regimen_references()
        ):
            yield scope, "Verified dose, route and frequency require traceable evidence.", None
        elif request.context.get("fixture_context") not in {"present", "flagged"}:
            yield scope, "Required synthetic context is missing.", None
        else:
            finding = (
                "Simulated regimen review finding."
                if request.context["fixture_context"] == "flagged"
                else None
            )
            yield scope, None, finding


def run_checks(request: CoverageRequest) -> CheckSummary:
    if not request.enabled:
        return CheckSummary(kind=request.kind, status="not_run")

    evaluated: list[CheckedScope] = []
    excluded: list[CheckExclusion] = []
    findings: list[CheckFinding] = []
    scopes = _ddi_scopes(request) if request.kind == "DDI" else _drp_scopes(request)
    for scope, reason, finding in scopes:
        if reason is not None:
            excluded.append(CheckExclusion(scope=scope, reason=reason))
            continue
        evaluated.append(scope)
        if finding is not None:
            findings.append(CheckFinding(scope=scope, source=REFERENCE, description=finding))

    if not evaluated:
        status = "unavailable"
    elif excluded:
        status = "partial"
    else:
        status = "complete"
    return CheckSummary(
        kind=request.kind,
        status=status,
        ran_at=datetime.now(UTC) if evaluated else None,
        source=REFERENCE,
        warnings=[STOPPED_WARNING] if any(use_exclusion(row) == STOPPED_WARNING for row in request.rows) else [],
        evaluated=evaluated,
        excluded=excluded,
        findings=findings,
    )
