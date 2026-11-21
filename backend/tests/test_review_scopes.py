import json
from pathlib import Path

import pytest
from pydantic import ValidationError

from app.schemas.review_scopes import ScreeningFixture

FIXTURE = Path(__file__).parents[2] / "fixtures" / "checks" / "demo-overlap-v2" / "case.json"


@pytest.fixture
def payload():
    return json.loads(FIXTURE.read_text(encoding="utf-8"))


def test_fixture_preserves_both_encounters_and_exact_coverage():
    fixture = ScreeningFixture.model_validate_json(FIXTURE.read_bytes())
    before, confirmed = fixture.snapshots
    assert [(row.id, row.route, row.schedule) for row in before.rows] == [
        ("R1", "oral", "scheduled"),
        ("R2", "oral", "prn"),
        ("R3", None, None),
    ]
    assert [row.id for row in confirmed.rows] == ["R1", "R2", "R3"]
    assert before.snapshot_id != confirmed.snapshot_id
    assert before.exposures[0].status == "unknown"
    assert confirmed.exposures[0].row_ids == ["R1", "R2"]
    assert confirmed.exposures[0].status == "confirmed"
    assert confirmed.exposures[0].evidence_ids == ["E4"]
    assert confirmed.exposures[0].observed_at is not None
    reports = {(report.snapshot_id, report.kind): report for report in fixture.reports}
    assert {
        key: (report.status, *report.coverage.model_dump().values())
        for key, report in reports.items()
    } == {
        (before.snapshot_id, "DDI"): ("unavailable", 3, 0, 0, 3),
        (before.snapshot_id, "DRP"): ("partial", 3, 1, 1, 2),
        (confirmed.snapshot_id, "DDI"): ("partial", 3, 1, 1, 2),
        (confirmed.snapshot_id, "DRP"): ("partial", 3, 1, 1, 2),
    }
    ddi = reports[before.snapshot_id, "DDI"]
    drp = reports[before.snapshot_id, "DRP"]
    assert {scope.scope_id for scope in ddi.scopes}.isdisjoint(scope.scope_id for scope in drp.scopes)
    assert [(scope.ingredient_ids, scope.outcome) for scope in ddi.scopes if scope.parent_scope_id] == [
        (["X", "Y"], "unevaluated"),
        (["X", "X"], "no_finding"),
    ]
    rule = fixture.release.rules[0]
    assert rule.context_requirements[0].field == "pair_exposure"
    assert rule.context_requirements[0].required_status == "confirmed"
    assert rule.reference.permitted_use == "synthetic_demo"


@pytest.mark.parametrize("reference", ["absent", "ddi-R1-R3", "ddi-R1-R2-X-X", "drp-R1-R2"])
def test_child_scope_requires_a_same_pair_parent_in_its_report(payload, reference):
    payload["reports"][0]["scopes"][1]["parent_scope_id"] = reference
    with pytest.raises(ValidationError, match="Child scope requires a parent"):
        ScreeningFixture.model_validate(payload)


@pytest.mark.parametrize("field", [
    "source_url", "source_section", "jurisdiction", "population", "permitted_use",
    "source_revision_date", "reviewed_on", "expires_on",
])
def test_release_and_rule_metadata_are_required(payload, field):
    del payload["release"]["reference"][field]
    del payload["release"]["rules"][0]["reference"][field]
    with pytest.raises(ValidationError) as error:
        ScreeningFixture.model_validate(payload)
    missing_fields = {tuple(item["loc"]) for item in error.value.errors()}
    assert ("release", "reference", field) in missing_fields
    assert ("release", "rules", 0, "reference", field) in missing_fields


def test_expected_coverage_cannot_count_an_ingredient_child_as_a_completed_pair(payload):
    payload["reports"][0]["coverage"]["evaluated_scopes"] = 1
    with pytest.raises(ValidationError, match="Coverage must equal"):
        ScreeningFixture.model_validate(payload)


def test_out_of_case_exposure_evidence_is_rejected(payload):
    payload["snapshots"][1]["exposures"][0]["evidence_ids"] = ["outside"]
    with pytest.raises(ValidationError, match="Unknown exposure evidence IDs"):
        ScreeningFixture.model_validate(payload)


def test_scope_reference_cannot_point_to_a_rule_from_the_other_report(payload):
    scope = payload["reports"][0]["scopes"][1]
    rule = payload["release"]["rules"][2]
    scope.update(rule_id=rule["id"], rule_version=rule["version"], reference_section=rule["reference"]["source_section"])
    with pytest.raises(ValidationError, match="Scope rule reference"):
        ScreeningFixture.model_validate(payload)


def test_child_ingredients_must_be_supported_on_opposite_rows(payload):
    scope = payload["reports"][0]["scopes"][1]
    scope["ingredient_ids"] = ["Y", "Y"]
    with pytest.raises(ValidationError, match="compare ingredients across its rows"):
        ScreeningFixture.model_validate(payload)


def test_report_cannot_claim_a_finding_if_an_ingredient_scope_remains_unchecked(payload):
    report = payload["reports"][0]
    report.update(status="partial")
    report["coverage"].update(evaluated_scopes=1, excluded_scopes=2, findings=1)
    report["scopes"][0].update(outcome="finding", reason_code=None)
    with pytest.raises(ValidationError, match="Parent outcome"):
        ScreeningFixture.model_validate(payload)


def test_empty_encounter_can_have_a_no_pair_report(payload):
    snapshot = payload["snapshots"][0]
    snapshot.update(evidence=[], rows=[], exposures=[])
    report = payload["reports"][0]
    report["scopes"] = []
    report["coverage"] = {field: 0 for field in report["coverage"]}
    payload.update(snapshots=[snapshot], reports=[report])
    result = ScreeningFixture.model_validate(payload).reports[0]
    assert result.status == "unavailable"
    assert result.coverage.total_scopes == 0


def test_ddi_denominator_includes_even_unidentified_pairs(payload):
    report = payload["reports"][2]
    report["scopes"] = report["scopes"][:3]
    report["status"] = "complete"
    report["coverage"].update(total_scopes=1, excluded_scopes=0)
    with pytest.raises(ValidationError, match="every distinct snapshot row pair"):
        ScreeningFixture.model_validate(payload)


def test_ddi_parent_cannot_be_promoted_by_omitting_unchecked_ingredients(payload):
    report = payload["reports"][0]
    del report["scopes"][1]
    report["scopes"][0].update(outcome="no_finding", reason_code=None)
    report["status"] = "partial"
    report["coverage"].update(evaluated_scopes=1, excluded_scopes=2)
    with pytest.raises(ValidationError, match="every cross-row ingredient comparison"):
        ScreeningFixture.model_validate(payload)


def test_ddi_child_with_new_id_cannot_repeat_same_ingredient_pair(payload):
    report = payload["reports"][0]
    original = report["scopes"][1]
    report["scopes"].append({
        **original, "scope_id": "another-child", "ingredient_ids": list(reversed(original["ingredient_ids"]))
    })
    with pytest.raises(ValidationError, match="Duplicate ingredient comparison"):
        ScreeningFixture.model_validate(payload)


def test_incomplete_ingredient_mapping_cannot_count_as_evaluated(payload):
    payload["snapshots"][1]["rows"][1]["mapping_status"] = "incomplete"
    with pytest.raises(ValidationError, match="require complete ingredient mappings"):
        ScreeningFixture.model_validate(payload)


def test_scope_evidence_must_belong_to_its_rows_or_exposure_pair(payload):
    payload["reports"][2]["scopes"][0]["evidence_ids"].append("E3")
    with pytest.raises(ValidationError, match="Unknown scope evidence IDs"):
        ScreeningFixture.model_validate(payload)


@pytest.mark.parametrize(("report", "scope"), [(2, 1), (3, 0)])
@pytest.mark.parametrize("missing", ["rule", "section", "evidence"])
def test_evaluated_leaf_requires_provenance_and_evidence(payload, report, scope, missing):
    selected = payload["reports"][report]["scopes"][scope]
    if missing == "rule":
        selected.update(rule_id=None, rule_version=None)
    elif missing == "section":
        selected["reference_section"] = None
    else:
        selected["evidence_ids"] = []
    with pytest.raises(ValidationError, match="Evaluated leaf scope requires rule provenance and evidence"):
        ScreeningFixture.model_validate(payload)


def test_aggregate_parent_does_not_need_its_own_rule(payload):
    payload["reports"][2]["scopes"][0].update(
        rule_id=None, rule_version=None, reference_section=None, evidence_ids=[]
    )
    result = ScreeningFixture.model_validate(payload).reports[2]
    assert result.coverage.evaluated_scopes == 1
