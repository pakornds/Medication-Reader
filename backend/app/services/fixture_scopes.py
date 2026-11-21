"""Deterministic screening for the synthetic review-scope contract."""

from datetime import UTC, datetime, timedelta
from itertools import combinations, product
from urllib.parse import quote

from app.schemas.review_scopes import (
    ExposureObservation,
    ScopeCoverage,
    ScreeningKind,
    ScreeningReference,
    ScreeningRelease,
    ScreeningReport,
    ScreeningRow,
    ScreeningRule,
    ScreeningScope,
    ScreeningSnapshot,
)

_DUPLICATE_RULE = "demo-duplicate-ingredient-v1"
_CONDITIONAL_EXPOSURE_RULE = "demo-ddi-conditional-exposure"
_DEMO_PRODUCTS = {"demo-amber": "Demo Amber", "demo-slate": "Demo Slate"}
_INGREDIENT_FOLLOW_UP = "ask-shared-ingredient-intent"
_OVERLAP_FOLLOW_UP = "ask-last-use-and-overlap"
_IDENTITY_FOLLOW_UP = "ask-independent-identity"


def evaluate_fixture_report(
    snapshot: ScreeningSnapshot,
    release: ScreeningRelease,
    kind: ScreeningKind,
    *,
    evaluated_at: datetime,
    enabled: bool = True,
) -> ScreeningReport:
    """Evaluate one synthetic report against the supplied immutable inputs."""
    scopes = []
    if enabled:
        if evaluated_at.utcoffset() is None:
            raise ValueError("Evaluation time requires a time zone")
        evaluated_at = evaluated_at.astimezone(UTC)
        scopes = _evaluate_scopes(snapshot, release, kind, evaluated_at)

    coverage = ScopeCoverage.from_scopes(scopes)
    if not enabled:
        status = "not_run"
    elif not coverage.evaluated_scopes:
        status = "unavailable"
    elif coverage.excluded_scopes:
        status = "partial"
    else:
        status = "complete"

    report = ScreeningReport(
        case_id=snapshot.case_id,
        snapshot_id=snapshot.snapshot_id,
        release_id=snapshot.release_id,
        kind=kind,
        status=status,
        ran_at=evaluated_at if enabled else None,
        coverage=coverage,
        scopes=scopes,
    )
    report.validate_context(snapshot, release)
    return report


def _evaluate_scopes(
    snapshot: ScreeningSnapshot,
    release: ScreeningRelease,
    kind: ScreeningKind,
    evaluated_at: datetime,
) -> list[ScreeningScope]:
    rules = sorted((rule for rule in release.rules if rule.kind == kind), key=lambda rule: rule.id)
    follow_ups = {follow_up.id for follow_up in release.follow_ups}
    exposures = {frozenset(item.row_ids): item for item in snapshot.exposures}
    reference_gap = _reference_gap(release.reference, evaluated_at)
    duplicate_rule = next((rule for rule in rules if rule.id == _DUPLICATE_RULE), None)
    unsupported_drp_rules = [rule for rule in rules if rule.kind == "DRP" and rule.id != _DUPLICATE_RULE]
    scopes = []
    for left, right in combinations(sorted(snapshot.rows, key=lambda row: row.id), 2):
        rows = [left.id, right.id]
        gap = _row_gap(left, right) or reference_gap
        pair = ScreeningScope(
            scope_id=_scope_id(kind.lower(), *rows),
            row_ids=rows,
            outcome="unevaluated",
            reason_code=gap or "unsupported_rule",
            evidence_ids=sorted(set(left.evidence_ids) | set(right.evidence_ids)),
        )
        if pair.reason_code in {"unresolved_identity", "incomplete_mapping"}:
            pair = _follow_up(pair, follow_ups, _IDENTITY_FOLLOW_UP)
        if kind == "DRP":
            if duplicate_rule is not None or not unsupported_drp_rules:
                scopes.append(_evaluate_duplicate(pair, left, right, duplicate_rule, evaluated_at, follow_ups))
            # Each declared DRP rule in this fixture service has its own row-pair scope.
            for rule in unsupported_drp_rules:
                scope = pair.model_copy(update={
                    "scope_id": f"{pair.scope_id}-{_scope_id(rule.id)}",
                    "reason_code": "unsupported_rule",
                    "follow_up_ids": [],
                })
                scopes.append(_cite_rule(scope, rule))
        elif gap:
            scopes.append(pair)
        else:
            observation = exposures.get(frozenset(rows))
            scopes.extend(_evaluate_ddi(pair, left, right, rules, observation, evaluated_at, follow_ups))
    return scopes


def _scope_id(*parts: str) -> str:
    # Escape separator characters so opaque row and ingredient IDs cannot collide.
    return "-".join(quote(part, safe="").replace("-", "%2D") for part in parts)


def _row_gap(left: ScreeningRow, right: ScreeningRow) -> str | None:
    for status, reason in (
        ("unresolved", "unresolved_identity"),
        ("incomplete", "incomplete_mapping"),
    ):
        if status in (left.mapping_status, right.mapping_status):
            return reason
    if left.use_status != "current" or right.use_status != "current":
        return "use_not_current"
    if not left.route or not right.route:
        return "missing_route"
    return None


def _reference_gap(reference: ScreeningReference, evaluated_at: datetime) -> str | None:
    day = evaluated_at.date()
    if day >= reference.expires_on:
        return "expired_reference"
    if day < reference.reviewed_on:
        return "reference_not_current"
    return None


def _cite_rule(scope: ScreeningScope, rule: ScreeningRule) -> ScreeningScope:
    return scope.model_copy(update={
        "rule_id": rule.id,
        "rule_version": rule.version,
        "reference_section": rule.reference.source_section,
    })


def _follow_up(scope: ScreeningScope, allowed: set[str], follow_up: str) -> ScreeningScope:
    if follow_up in allowed:
        return scope.model_copy(update={"follow_up_ids": [follow_up]})
    return scope


def _is_demo_product_pair(left: ScreeningRow, right: ScreeningRow) -> bool:
    return {row.product_id: row.product_name for row in (left, right)} == _DEMO_PRODUCTS


def _evaluate_ddi(
    pair: ScreeningScope,
    left: ScreeningRow,
    right: ScreeningRow,
    rules: list[ScreeningRule],
    observation: ExposureObservation | None,
    evaluated_at: datetime,
    follow_ups: set[str],
) -> list[ScreeningScope]:
    ingredients = {tuple(sorted(ids)) for ids in product(left.ingredient_ids, right.ingredient_ids)}
    overlap_follow_up_applies = _is_demo_product_pair(left, right) and any(
        row.product_id == "demo-slate" and row.schedule == "prn" for row in (left, right)
    )
    children = []
    for ids in sorted(ingredients):
        child = pair.model_copy(update={
            "scope_id": f"{pair.scope_id}-{_scope_id(*ids)}",
            "parent_scope_id": pair.scope_id,
            "ingredient_ids": list(ids),
        })
        candidates = [rule for rule in rules if tuple(sorted(rule.ingredient_ids)) == ids]
        matching = [rule for rule in candidates if left.route in rule.routes and right.route in rule.routes]
        if len(matching) == 1:
            child = _evaluate_ddi_rule(_cite_rule(child, matching[0]), matching[0], observation, evaluated_at)
        elif candidates and not matching:
            if len(candidates) == 1:
                child = _cite_rule(child, candidates[0])
            child = child.model_copy(update={"reason_code": "unsupported_route"})
        if (
            overlap_follow_up_applies
            and child.rule_id == _CONDITIONAL_EXPOSURE_RULE
            and child.reason_code in {"unconfirmed_overlap", "stale_overlap", "future_overlap"}
        ):
            child = _follow_up(child, follow_ups, _OVERLAP_FOLLOW_UP)
        children.append(child)

    # Unknown child coverage takes precedence. Keep every child result for inspection.
    priority = {"unevaluated": 0, "finding": 1, "no_finding": 2}
    representative = min(children, key=lambda scope: priority[scope.outcome])
    parent = representative.model_copy(update={
        "scope_id": pair.scope_id,
        "parent_scope_id": None,
        "evidence_ids": sorted({evidence for child in children for evidence in child.evidence_ids}),
        "follow_up_ids": sorted({follow_up for child in children for follow_up in child.follow_up_ids}),
    })
    return [parent, *children]


def _evaluate_ddi_rule(
    child: ScreeningScope,
    rule: ScreeningRule,
    observation: ExposureObservation | None,
    evaluated_at: datetime,
) -> ScreeningScope:
    gap = _reference_gap(rule.reference, evaluated_at)
    if gap:
        return child.model_copy(update={"reason_code": gap})

    if not rule.context_requirements:
        return child.model_copy(update={"outcome": rule.fixture_outcome, "reason_code": None})

    # The contract only supports one pair-exposure predicate per DDI rule.
    requirement = rule.context_requirements[0]
    if requirement.required_status == "unknown":
        return child
    if observation is None:
        return child.model_copy(update={"reason_code": "unconfirmed_overlap"})

    evidence = sorted(set(child.evidence_ids) | set(observation.evidence_ids))
    observed_at = observation.observed_at
    if observation.status == "unknown" or observed_at is None:
        gap = "unconfirmed_overlap"
    elif observed_at > evaluated_at:
        gap = "future_overlap"
    elif (
        requirement.max_age_hours is not None
        and evaluated_at - observed_at > timedelta(hours=requirement.max_age_hours)
    ):
        gap = "stale_overlap"
    if gap:
        return child.model_copy(update={"reason_code": gap, "evidence_ids": evidence})

    outcome = rule.fixture_outcome if observation.status == requirement.required_status else "no_finding"
    return child.model_copy(update={"outcome": outcome, "reason_code": None, "evidence_ids": evidence})


def _evaluate_duplicate(
    pair: ScreeningScope,
    left: ScreeningRow,
    right: ScreeningRow,
    rule: ScreeningRule | None,
    evaluated_at: datetime,
    follow_ups: set[str],
) -> ScreeningScope:
    if rule is None:
        return pair
    pair = _cite_rule(pair, rule)
    if pair.reason_code != "unsupported_rule":
        return pair
    if rule.ingredient_ids or rule.context_requirements:
        return pair
    gap = _reference_gap(rule.reference, evaluated_at)
    if gap:
        return pair.model_copy(update={"reason_code": gap})
    if left.route not in rule.routes or right.route not in rule.routes:
        return pair.model_copy(update={"reason_code": "unsupported_route"})

    shared = sorted(set(left.ingredient_ids) & set(right.ingredient_ids))
    outcome = rule.fixture_outcome if shared else "no_finding"
    result = pair.model_copy(update={"ingredient_ids": shared, "outcome": outcome, "reason_code": None})
    if outcome == "finding" and _is_demo_product_pair(left, right):
        return _follow_up(result, follow_ups, _INGREDIENT_FOLLOW_UP)
    return result
