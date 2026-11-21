"""Optional scope checks against fictional references only."""

from datetime import UTC, datetime
from itertools import combinations

from app.schemas.checks import (
    CheckedScope,
    CheckExclusion,
    CheckFinding,
    CheckRequest,
    CheckSummary,
    ReferenceVersion,
)
from app.schemas.review import ReviewRow

REFERENCE = ReferenceVersion(name="Synthetic coverage rules", version="demo-v1")
DEMO_IDS = frozenset({"demo-a", "demo-b", "demo-c"})
DDI_PAIRS = {
    frozenset({"demo-a", "demo-b"}): "Simulated finding for Demo A and Demo B.",
    frozenset({"demo-a", "demo-c"}): None,
}
DRP_RULE_ID = "synthetic-regimen-review"


def _eligibility(row: ReviewRow) -> tuple[str | None, str | None]:
    verification = row.verification
    if (
        verification is None
        or verification.status != "current"
        or verification.reviewer.role not in {"doctor", "pharmacist"}
    ):
        return None, "Current use has not been verified by a clinician."
    if verification.identity is None or verification.normalized_medication_id is None:
        return None, "Medication identity is unresolved."
    if {item.id for item in row.discrepancies} != set(verification.resolved_discrepancies):
        return None, "Evidence discrepancies remain unresolved."
    if verification.normalized_medication_id not in DEMO_IDS:
        return None, "Medication is outside the synthetic reference."
    return verification.normalized_medication_id, None


def _ddi_scopes(request: CheckRequest):
    if len(request.rows) == 1:
        row = request.rows[0]
        _, reason = _eligibility(row)
        yield CheckedScope(row_ids=[row.id]), reason or "A second verified medication is required.", None
        return

    for left, right in combinations(request.rows, 2):
        scope = CheckedScope(row_ids=[left.id, right.id])
        left_id, left_reason = _eligibility(left)
        right_id, right_reason = _eligibility(right)
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


def _drp_scopes(request: CheckRequest):
    for row in request.rows:
        scope = CheckedScope(row_ids=[row.id], rule_id=DRP_RULE_ID)
        _, reason = _eligibility(row)
        verification = row.verification
        if reason is not None:
            yield scope, reason, None
        elif not all((verification.dose, verification.route, verification.frequency)):
            yield scope, "Verified dose, route and frequency are required.", None
        elif request.context.get("fixture_context") not in {"present", "flagged"}:
            yield scope, "Required synthetic context is missing.", None
        else:
            finding = (
                "Simulated regimen review finding."
                if request.context["fixture_context"] == "flagged"
                else None
            )
            yield scope, None, finding


def run_checks(request: CheckRequest) -> CheckSummary:
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
        evaluated=evaluated,
        excluded=excluded,
        findings=findings,
    )
