"""Tests of deterministic screening over synthetic encounter snapshots."""

from datetime import timedelta
from pathlib import Path

import pytest

from app.schemas.review_scopes import ScreeningFixture, ScreeningRelease
from app.services.fixture_scopes import evaluate_fixture_report

_CASE_PATH = Path(__file__).resolve().parents[3] / "fixtures/checks/demo-overlap-v2/case.json"


@pytest.fixture
def fixture_case():
    return ScreeningFixture.model_validate_json(_CASE_PATH.read_text(encoding="utf-8"))


def test_published_before_and_after_reports(fixture_case):
    snapshots = {snapshot.snapshot_id: snapshot for snapshot in fixture_case.snapshots}
    for expected in fixture_case.reports:
        snapshot = snapshots[expected.snapshot_id]
        # Input order does not change pair IDs, child comparisons, or aggregate coverage.
        shuffled = snapshot.model_copy(update={"rows": list(reversed(snapshot.rows))})
        result = evaluate_fixture_report(
            snapshot, fixture_case.release, expected.kind, evaluated_at=expected.ran_at
        )
        assert result == evaluate_fixture_report(
            shuffled, fixture_case.release, expected.kind, evaluated_at=expected.ran_at
        )
        assert result.model_dump(exclude={"scopes"}) == expected.model_dump(exclude={"scopes"})
        assert {scope.scope_id: scope for scope in result.scopes} == {
            scope.scope_id: scope for scope in expected.scopes
        }


@pytest.mark.parametrize("kind", ["DDI", "DRP"])
def test_single_product_has_no_comparison_and_disabled_checks_do_not_run(fixture_case, kind):
    before = fixture_case.snapshots[0]
    snapshot = before.model_copy(update={"rows": [before.rows[1]], "exposures": []})
    evaluated_at = fixture_case.reports[0].ran_at
    report = evaluate_fixture_report(snapshot, fixture_case.release, kind, evaluated_at=evaluated_at)
    assert report.status == "unavailable"
    assert report.simulated
    assert report.coverage.total_scopes == 0
    assert report.scopes == []

    disabled = evaluate_fixture_report(
        before, fixture_case.release, kind, evaluated_at=evaluated_at, enabled=False
    )
    assert disabled.status == "not_run"
    assert disabled.ran_at is None
    assert disabled.scopes == []


def test_disjoint_products_are_checked_by_drp_but_need_explicit_ddi_coverage(fixture_case):
    before = fixture_case.snapshots[0]
    left, right, _ = before.rows
    right = right.model_copy(update={"ingredient_ids": ["Z"], "product_name": left.product_name})
    snapshot = before.model_copy(update={"rows": [left, right]})
    evaluated_at = fixture_case.reports[0].ran_at

    drp = evaluate_fixture_report(snapshot, fixture_case.release, "DRP", evaluated_at=evaluated_at)
    assert drp.status == "complete"
    assert drp.coverage.evaluated_scopes == 1
    assert drp.coverage.findings == 0
    assert drp.scopes[0].ingredient_ids == []
    assert drp.scopes[0].outcome == "no_finding"

    ddi = evaluate_fixture_report(snapshot, fixture_case.release, "DDI", evaluated_at=evaluated_at)
    assert ddi.status == "unavailable"
    assert ddi.coverage.total_scopes == 1
    assert ddi.coverage.findings == 0
    assert ddi.scopes[1].ingredient_ids == ["X", "Z"]
    assert ddi.scopes[1].reason_code == "unsupported_rule"


def test_ordered_cross_ingredient_inputs_share_one_unordered_child_and_pair(fixture_case):
    confirmed = fixture_case.snapshots[1]
    left, right, _ = confirmed.rows
    left = left.model_copy(update={"ingredient_ids": ["Y", "X"]})
    duplicate = next(rule for rule in fixture_case.release.rules if rule.kind == "DRP")
    y_rule = fixture_case.release.rules[1].model_copy(update={
        "id": "demo-ddi-y-y-covered",
        "ingredient_ids": ["Y", "Y"],
    })
    release = fixture_case.release.model_copy(update={"rules": [*fixture_case.release.rules, y_rule]})
    snapshot = confirmed.model_copy(update={"rows": [right, left]})
    evaluated_at = fixture_case.reports[2].ran_at

    ddi = evaluate_fixture_report(snapshot, release, "DDI", evaluated_at=evaluated_at)
    assert ddi.status == "complete"
    assert ddi.coverage.total_scopes == ddi.coverage.evaluated_scopes == ddi.coverage.findings == 1
    assert [scope.ingredient_ids for scope in ddi.scopes[1:]] == [["X", "X"], ["X", "Y"], ["Y", "Y"]]

    drp = evaluate_fixture_report(snapshot, release, "DRP", evaluated_at=evaluated_at)
    assert drp.coverage.total_scopes == drp.coverage.evaluated_scopes == drp.coverage.findings == 1
    assert drp.scopes[0].ingredient_ids == ["X", "Y"]
    assert drp.scopes[0].rule_id == duplicate.id


@pytest.mark.parametrize(
    ("changed", "reason"),
    [
        ({"mapping_status": "incomplete"}, "incomplete_mapping"),
        ({"route": None}, "missing_route"),
        ({"route": "topical"}, "unsupported_route"),
        ({"use_status": "stopped"}, "use_not_current"),
    ],
)
@pytest.mark.parametrize("kind", ["DDI", "DRP"])
def test_ineligible_rows_remain_in_pair_denominator(fixture_case, changed, reason, kind):
    before = fixture_case.snapshots[0]
    left, right, _ = before.rows
    snapshot = before.model_copy(update={"rows": [left.model_copy(update=changed), right]})
    report = evaluate_fixture_report(
        snapshot, fixture_case.release, kind, evaluated_at=fixture_case.reports[0].ran_at
    )
    assert report.status == "unavailable"
    assert report.coverage.total_scopes == report.coverage.excluded_scopes == 1
    assert report.scopes[0].reason_code == reason
    assert report.scopes[0].evidence_ids == ["E1", "E2"]


@pytest.mark.parametrize("kind", ["DDI", "DRP"])
def test_expired_release_or_individual_rule_never_reports_pair_as_checked(fixture_case, kind):
    release = fixture_case.release
    confirmed = fixture_case.snapshots[1]
    snapshot = confirmed.model_copy(update={"rows": confirmed.rows[:2]})
    evaluated_at = fixture_case.reports[2].ran_at + timedelta(days=1)
    expired_reference = release.reference.model_copy(update={"expires_on": evaluated_at.date()})
    expired_release = release.model_copy(update={"reference": expired_reference})
    report = evaluate_fixture_report(snapshot, expired_release, kind, evaluated_at=evaluated_at)
    assert report.status == "unavailable"
    assert report.coverage.total_scopes == report.coverage.excluded_scopes == 1
    assert report.scopes[0].reason_code == "expired_reference"

    primary_rule = release.rules[0 if kind == "DDI" else 2]
    rules = [
        rule.model_copy(update={"reference": expired_reference}) if rule.id == primary_rule.id else rule
        for rule in release.rules
    ]
    report = evaluate_fixture_report(
        snapshot, release.model_copy(update={"rules": rules}), kind, evaluated_at=evaluated_at
    )
    assert report.status == "unavailable"
    assert report.coverage.findings == 0
    assert report.scopes[0].reason_code == "expired_reference"
    assert report.scopes[0].rule_version == primary_rule.version


def test_exposure_must_be_fresh_and_specific_to_pair(fixture_case):
    release = fixture_case.release
    first, *other_rules = release.rules
    requirement = first.context_requirements[0].model_copy(update={"max_age_hours": 1})
    release = release.model_copy(update={
        "rules": [first.model_copy(update={"context_requirements": [requirement]}), *other_rules]
    })
    snapshot = fixture_case.snapshots[1]
    source = snapshot.exposures[0]
    ran_at = fixture_case.reports[2].ran_at
    for altered, reason, expected_evidence in [
        ({"row_ids": ["R1", "R3"]}, "unconfirmed_overlap", ["E1", "E2"]),
        ({"observed_at": ran_at - timedelta(hours=1, seconds=1)}, "stale_overlap", ["E1", "E2", "E4"]),
        ({"observed_at": ran_at + timedelta(seconds=1)}, "future_overlap", ["E1", "E2", "E4"]),
    ]:
        changed = snapshot.model_copy(update={"exposures": [source.model_copy(update=altered)]})
        report = evaluate_fixture_report(changed, release, "DDI", evaluated_at=ran_at)
        assert report.status == "unavailable"
        assert report.coverage.findings == 0
        assert report.scopes[0].reason_code == reason
        assert report.scopes[0].evidence_ids == expected_evidence


def test_sourced_exclusion_evaluates_ddi_without_finding(fixture_case):
    confirmed = fixture_case.snapshots[1]
    source = confirmed.exposures[0].model_copy(update={"row_ids": ["R2", "R1"], "status": "excluded"})
    snapshot = confirmed.model_copy(update={"exposures": [source]})
    report = evaluate_fixture_report(
        snapshot, fixture_case.release, "DDI", evaluated_at=fixture_case.reports[2].ran_at
    )
    assert report.status == "partial"
    assert report.coverage.evaluated_scopes == 1
    assert report.coverage.findings == 0
    assert report.scopes[0].outcome == "no_finding"
    conditional = next(scope for scope in report.scopes if scope.scope_id == "ddi-R1-R2-X-Y")
    assert conditional.outcome == "no_finding"
    assert conditional.evidence_ids == ["E1", "E2", "E4"]



@pytest.mark.parametrize("include_supported", [True, False])
def test_unsupported_drp_release_rule_remains_visible_in_coverage(fixture_case, include_supported):
    before = fixture_case.snapshots[0]
    snapshot = before.model_copy(update={"rows": before.rows[:2]})
    configured = fixture_case.release.model_dump()
    supported = next(rule for rule in configured["rules"] if rule["kind"] == "DRP")
    if not include_supported:
        configured["rules"].remove(supported)
    configured["rules"].append({**supported, "id": "unsupported-demo-rule", "version": "2"})
    release = ScreeningRelease.model_validate(configured)

    report = evaluate_fixture_report(snapshot, release, "DRP", evaluated_at=fixture_case.reports[0].ran_at)
    assert report.status == ("partial" if include_supported else "unavailable")
    assert report.coverage.total_scopes == (2 if include_supported else 1)
    assert report.coverage.findings == (1 if include_supported else 0)
    assert report.coverage.excluded_scopes == 1
    unsupported = next(scope for scope in report.scopes if scope.rule_id == "unsupported-demo-rule")
    assert unsupported.row_ids == ["R1", "R2"]
    assert unsupported.outcome == "unevaluated"
    assert unsupported.reason_code == "unsupported_rule"
    assert unsupported.rule_version == "2"
    assert unsupported.reference_section == supported["reference"]["source_section"]


@pytest.mark.parametrize(
    "unrelated_product",
    [
        {"product_id": "demo-teal", "product_name": "Demo Teal"},
        {"product_name": "Demo Teal"},
    ],
)
def test_named_follow_ups_do_not_leak_to_other_products(fixture_case, unrelated_product):
    before = fixture_case.snapshots[0]
    left, right, _ = before.rows
    snapshot = before.model_copy(update={"rows": [left.model_copy(update=unrelated_product), right]})
    evaluated_at = fixture_case.reports[0].ran_at

    ddi = evaluate_fixture_report(snapshot, fixture_case.release, "DDI", evaluated_at=evaluated_at)
    assert ddi.scopes[0].reason_code == "unconfirmed_overlap"
    assert all(not scope.follow_up_ids for scope in ddi.scopes)

    drp = evaluate_fixture_report(snapshot, fixture_case.release, "DRP", evaluated_at=evaluated_at)
    assert drp.coverage.findings == 1
    assert drp.scopes[0].follow_up_ids == []


def test_named_prn_follow_up_requires_slates_prn_role(fixture_case):
    before = fixture_case.snapshots[0]
    left, right, _ = before.rows
    snapshot = before.model_copy(update={"rows": [
        left.model_copy(update={"schedule": "prn"}),
        right.model_copy(update={"schedule": "scheduled"}),
    ]})
    report = evaluate_fixture_report(
        snapshot, fixture_case.release, "DDI", evaluated_at=fixture_case.reports[0].ran_at
    )

    assert report.scopes[0].reason_code == "unconfirmed_overlap"
    assert all(not scope.follow_up_ids for scope in report.scopes)
