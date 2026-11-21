import pytest
from pydantic import ValidationError

from app.schemas.analysis import MedicationSuggestion
from app.schemas.evidence import CaseEvidence, EvidenceRef
from app.schemas.openapi import contract_openapi
from app.schemas.regimen import RegimenComponent, RegimenParseRequest
from app.schemas.review import CurrentUseVerification
from app.services.checks import CoverageRequest, run_checks
from app.services.regimens import parse_directions

SOURCE = EvidenceRef(source_id="record")
EVIDENCE = CaseEvidence(case_id="case", sources=[{"id": "record", "kind": "transfer_record"}])


def parse(text):
    return parse_directions(RegimenParseRequest(
        evidence=EVIDENCE, row_id="row", component_id="schedule", basis="documented",
        directions_text=text, source=SOURCE,
    )).regimens


def test_split_schedule_keeps_each_amount_with_its_own_time_and_frequency():
    words = "1 tablet each morning and 2 tablets each evening"
    morning, evening = parse(words)
    assert morning.component_id != evening.component_id
    assert (morning.dose_amount, morning.time_of_day) == (1, ["morning"])
    assert (evening.dose_amount, evening.time_of_day) == (2, ["evening"])
    for component in (morning, evening):
        assert (component.frequency_count, component.period_value, component.period_unit) == (1, 1, "day")
        assert component.directions_text == words
        assert component.evidence["dose_amount"] == SOURCE


@pytest.mark.parametrize("text", [
    "Do not take 1 tablet each morning",
    "1 tablet and 2 tablets each morning",
    "1 tablet each morning except Wednesday",
    "1 to 2 tablets each evening",
    "1 tablet each morning then taper",
])
def test_unsupported_or_negated_statement_preserves_every_word(text):
    component, = parse(text)
    assert component.parse_status == "unparsed"
    assert component.unparsed_text == component.directions_text == text
    assert component.evidence == {"directions_text": SOURCE}


def test_prn_interval_preserves_condition_without_turning_interval_into_daily_count():
    component, = parse("every 8 hours as needed for pain")
    assert component.parse_status == "partial"
    assert component.unparsed_text == "for pain"
    assert (component.period_value, component.period_unit) == (8, "hour")
    assert component.schedule_type == "interval"
    assert component.frequency_count is None
    assert component.as_needed is True
    assert component.evidence["as_needed"] == SOURCE


@pytest.mark.parametrize(("words", "route"), [
    ("รับประทานครั้งละ 1 เม็ด ทุกเช้า", "oral"),
    ("1 เม็ด ทุกเช้า", None),
])
def test_thai_label_preserves_text_and_only_sources_documented_route(words, route):
    component, = parse(words)
    assert component.directions_text == words
    assert component.route == route
    assert (component.dose_amount, component.dose_unit) == (1, "tablet")
    assert component.time_of_day == ["morning"]
    assert (component.frequency_count, component.period_unit) == (1, "day")
    assert component.meal_relation is None


def verification_input():
    component, = parse("Take 1 tablet by mouth each morning")
    return {
        "reviewer": {"id": "p", "name": "Synthetic reviewer", "role": "pharmacist"},
        "verified_at": "2026-11-21T00:00:00Z", "status": "current",
        "identity": {"value": "Demo A", "evidence": SOURCE}, "normalized_medication_id": "demo-a",
        "evidence": [SOURCE], "regimens": [component.model_dump() | {"basis": "verified"}],
    }


def test_verified_and_observed_fields_have_distinct_contracts():
    verification = verification_input()
    verified = verification["regimens"][0]
    with pytest.raises(ValidationError, match="one verified regimen representation"):
        CurrentUseVerification.model_validate(verification | {"dose": {"value": "1", "evidence": SOURCE}})
    with pytest.raises(ValidationError, match="verified regimen components"):
        MedicationSuggestion(id="row", identity_status="named", observed_names=[verification["identity"]],
                             sources=[SOURCE], regimens=[verified])
    with pytest.raises(ValidationError, match="unique"):
        CurrentUseVerification.model_validate(verification | {"regimens": [verified, verified]})
    with pytest.raises(ValidationError, match="source reference"):
        RegimenComponent.model_validate(verified | {"evidence": {"directions_text": SOURCE}})
    with pytest.raises(ValidationError, match="count per period"):
        RegimenComponent.model_validate(verified | {"schedule_type": "interval"})
    with pytest.raises(ValidationError):
        RegimenComponent.model_validate(verified | {"frequency_count": True})


def test_drp_uses_structured_verified_fields_and_their_field_level_sources():
    verification = verification_input()
    row = {
        "id": "row", "identity_status": "named", "sources": [SOURCE], "revision": 1,
        "observed_names": [verification["identity"]], "verification": verification,
    }
    request = {"kind": "DRP", "enabled": True, "context": {"fixture_context": "present"},
               "evidence": EVIDENCE, "rows": [row]}
    checked = run_checks(CoverageRequest.model_validate(request))
    assert checked.status == "complete"
    verification["regimens"][0]["evidence"]["dose_amount"] = {"source_id": "unknown"}
    skipped = run_checks(CoverageRequest.model_validate(request))
    assert skipped.status == "unavailable"
    assert "traceable evidence" in skipped.excluded[0].reason


def test_parser_models_are_in_preregistration_contract():
    assert {"RegimenParseRequest", "RegimenParseResult", "RegimenComponent"} <= (
        contract_openapi()["components"]["schemas"].keys()
    )


@pytest.mark.parametrize(("words", "amount", "unit", "times", "route", "meal", "residual"), [
    ("รับประทานครั้งละ ครึ่งเม็ด วันละ 1 ครั้ง หลังอาหารเช้า",
     0.5, "tablet", ["morning"], "oral", "after meals", None),
    ("รับประทานครั้งละ 1 เม็ด วันละ 2 ครั้ง หลังอาหารเช้า-เย็น รับประทานทุกวันจนยาหมด",
     1, "tablet", ["morning", "evening"], "oral", "after meals", "รับประทานทุกวันจนยาหมด"),
    ("ที่มีอาการ 1 หยด วันละ 3 ครั้ง เช้า กลางวัน เย็น; มีอายุการใช้ 1 เดือน หลังจากเปิดใช้ครั้งแรก",
     1, "drop", ["morning", "noon", "evening"], None, None, "full"),
])
def test_thai_label_frequency_keeps_original_and_cites_only_explicit_fields(
    words, amount, unit, times, route, meal, residual,
):
    component, = parse(words)
    assert component.directions_text == words
    assert component.unparsed_text == (words if residual == "full" else residual)
    assert component.parse_status == ("partial" if residual else "complete")
    assert (component.dose_amount, component.dose_unit) == (amount, unit)
    assert component.time_of_day == times
    assert (component.frequency_count, component.period_value, component.period_unit) == (len(times), 1, "day")
    assert (component.route, component.meal_relation, component.as_needed) == (route, meal, None)
    assert all(ref == SOURCE for ref in component.evidence.values())


@pytest.mark.parametrize("words", [
    "ห้ามรับประทานครั้งละ 1 เม็ด วันละ 2 ครั้ง เช้า-เย็น",
    "1 เม็ด วันละ 2 ครั้ง เช้า ยกเว้นวันจันทร์",
    "1 เม็ด วันละ 2 ครั้ง เช้า กลางวัน เย็น",
    "1 เม็ด วันละ 1 ครั้ง หลังอาหารเช้า; ถ้าปวดให้เพิ่มเป็น 2 เม็ด",
])
def test_thai_label_frequency_preserves_contradictions_and_unrecognized_qualifiers(words):
    component, = parse(words)
    assert component.unparsed_text == words
    assert component.parse_status == "unparsed"
    assert component.evidence == {"directions_text": SOURCE}
