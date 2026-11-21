"""Whole unmarked-table uploads produce independently grounded package rows through the ordinary route."""
import json
from base64 import b64decode
from io import BytesIO

import pytest
from fastapi.testclient import TestClient
from PIL import Image

from app.ai.client import OpenAIClient
from app.main import create_app


def upload(client, *, reverse=False, marked=False, reverse_only=False, question=None, with_note=False):
    image = Image.new("RGB", (120, 80), "red")
    image.paste("blue", (60, 0, 120, 80))
    data = BytesIO()
    image.save(data, "PNG")
    sides = ["reverse"] if reverse_only else (["front", "reverse"] if reverse else ["front"])
    form = dict(evidence=dict(case_id="example", sources=[dict(id=s, attachment_id=s,
                     kind="label_photo" if s == "front" else "reverse_photo") for s in sides]),
                photo_source_ids=sides, scene_photo_ids=sides)
    if question:
        form["question"] = question
    if with_note:
        form["evidence"]["sources"].append(dict(id="note",kind="patient_report"))
        form["patient_report"] = [dict(value="I remember a different medicine.", evidence=dict(source_id="note"))]
    if marked:
        form["scene_photo_ids"] = []
        form["evidence"]["sources"].append(dict(id="left", attachment_id="front", kind="label_photo"))
        form["evidence"]["items"] = [dict(id="left", source_id="left", row_id="order-a", kind="label_region")]
        form["region_locations"] = {"left": {"left": "0%,0%,50%,100%"}}
    files = [("form", (None, json.dumps(form), "application/json"))]
    files.extend(("photos", ("example.png", data.getvalue(), "image/png")) for _ in sides)
    result = client.post("/medication-analysis", files=files)
    assert result.status_code == 200, result.text
    return result.json()


def provider_calls(*, partial=False, empty=False, invalid_blue=0):
    calls = []
    def transport(request, _timeout):
        nonlocal invalid_blue
        body = json.loads(request.data)
        content = body["input"][0]["content"]
        pixels = Image.open(BytesIO(b64decode(content[-1]["image_url"].split(",")[1])))
        assert body["store"] is False
        calls.append((body["text"]["format"]["name"], pixels.size))
        if body["text"]["format"]["name"] == "ProposedBounds":
            reply = {"regions": [] if empty else [dict(x=x,y=0,width=.5,height=1) for x in [0,.5]]}
        else:
            name = "Synthetic red label" if pixels.getpixel((0, 0))[0] else "Synthetic blue label"
            if partial and name == "Synthetic blue label":
                raise TimeoutError()
            reply = dict(names=[name], directions="1 tablet each morning", amount_prescribed="21 tablets",
                         facility=dict(organization="Synthetic Clinic", organization_phone="000-0000"))
            if invalid_blue and name == "Synthetic blue label":
                invalid_blue -= 1
                reply = {"names": "wrong shape", "directions": ""}
        return json.dumps(dict(status="completed", output=[dict(type="message", content=[
            dict(type="output_text",text=json.dumps(reply))])])).encode()
    return OpenAIClient(api_key="fixture", model="fixture", transport=transport), calls


def test_two_sides_two_distinct_crops_no_duplicate_orders_from_reverse():
    provider, calls = provider_calls()
    with TestClient(create_app(get_provider=lambda: provider)) as client:
        preview = upload(client, reverse=True)
        repeated = upload(client, reverse=True)
    rows = preview["rows"]
    assert [r["observed_names"][0]["value"] for r in rows] == ["Synthetic red label","Synthetic blue label"]
    assert [r["id"] for r in rows] == [r["id"] for r in repeated["rows"]]
    assert {r["id"] for r in rows} == {l["row_id"] for l in preview["located_regions"] if l["attachment_id"]=="front"}
    assert all(r["observed_names"][0]["evidence"] == r["sources"][0] for r in rows)
    for row in rows:
        ref = row["sources"][0]
        assert row["label_fields"]["amount_prescribed"] == {"status":"readable","value":"21 tablets","evidence":ref}
        regimen, = row["regimens"]
        assert regimen["dose_amount"] == 1 and regimen["time_of_day"] == ["morning"]
        assert regimen["evidence"]["directions_text"] == ref
        assert preview["dispensing_facilities"][row["id"]]["organization_phone"] == "000-0000"
        assert preview["dispensing_facilities"][row["id"]]["evidence"] == ref
    assert len(preview["located_regions"]) == 4 and not preview["photo_issues"]
    assert calls.count(("ProposedBounds",(120,80))) == 4 and calls.count(("PrintedLabel",(60,80))) == 4


THAI_DIRECTIONS = "รับประทานครั้งละ 1 เม็ด/แคปซูล วันละ 3 ครั้ง หลังอาหาร เช้า เที่ยง เย็น หลังอาหารทันที"
THAI_CHOICES = {
    "dose": {"amount": 1, "unit": "tablet or capsule", "quote": "ครั้งละ 1 เม็ด/แคปซูล"},
    "schedule": {"kind": "frequency", "count": 3, "period": 1, "period_unit": "day", "quote": "วันละ 3 ครั้ง"},
    "times": {"values": ["morning", "noon", "evening"], "quote": "เช้า เที่ยง เย็น"},
    "route": {"value": "oral", "quote": "รับประทาน"},
    "meal": {"value": "immediately after meals", "quote": "หลังอาหารทันที"},
}


@pytest.mark.parametrize("marked", [False, True])
def test_openai_prefills_fixed_choices_for_exact_thai_label(marked, monkeypatch, tmp_path):
    monkeypatch.setenv("LOCAL_TMT_DB", str(tmp_path / "no-catalogue.sqlite"))
    calls = []

    def transport(request, _timeout):
        body = json.loads(request.data)
        response_schema = body["text"]["format"]
        contract = response_schema["name"]
        calls.append(contract)
        ref = {"source_id": "left", "item_id": "left"}
        if contract == "ProposedBounds":
            output = {"regions": [{"x": 0, "y": 0, "width": 1, "height": 1}]}
        elif contract == "PrintedLabel":
            assert response_schema["schema"]["$defs"]["Dose"]["properties"]["unit"]["enum"]
            output = {"names": ["Ibuprofen"], "directions": THAI_DIRECTIONS, "structured_directions": THAI_CHOICES}
        elif contract == "LabelAnalysisResult":
            output = {"case_id": "example", "rows": [{
                "id": "order-a", "identity_status": "named", "sources": [ref],
                "observed_names": [{"value": "Ibuprofen", "evidence": ref}],
                "label_fields": {"directions": {"status": "readable", "value": THAI_DIRECTIONS, "evidence": ref}},
            }]}
        elif contract == "LabelDirectionsChoices":
            assert json.loads(body["input"][0]["content"][0]["text"]) == {"directions": THAI_DIRECTIONS}
            assert len(body["input"][0]["content"]) == 1
            output = THAI_CHOICES
        else:
            raise AssertionError(f"Unexpected model contract: {contract}")
        return json.dumps({"status": "completed", "output": [{"type": "message", "content": [
            {"type": "output_text", "text": json.dumps(output)},
        ]}]}).encode()

    provider = OpenAIClient(api_key="fixture", model="fixture", transport=transport)
    with TestClient(create_app(get_provider=lambda: provider)) as client:
        row, = upload(client, marked=marked)["rows"]
    schedule, = row["regimens"]
    assert schedule["basis"] == "documented" and schedule["parse_status"] == "complete"
    assert schedule["directions_text"] == THAI_DIRECTIONS
    assert (schedule["dose_amount"], schedule["dose_unit"]) == (1, "tablet or capsule")
    assert (schedule["frequency_count"], schedule["period_value"], schedule["period_unit"]) == (3, 1, "day")
    assert schedule["time_of_day"] == ["morning", "noon", "evening"]
    assert (schedule["route"], schedule["meal_relation"], schedule["as_needed"]) == ("oral", "immediately after meals", None)
    assert all(ref == row["label_fields"]["directions"]["evidence"] for ref in schedule["evidence"].values())
    assert calls == (["LabelAnalysisResult", "LabelDirectionsChoices"] if marked else ["ProposedBounds", "PrintedLabel"])


def test_label_choices_reject_unsubstantiated_values_and_keep_original():
    from app.schemas.evidence import EvidenceRef
    from app.services.label_directions import LabelDirectionsChoices, label_regimen

    choices = LabelDirectionsChoices.model_validate(THAI_CHOICES | {
        "dose": {"amount": 1, "unit": "tablet", "quote": "ครั้งละ 1 เม็ด"},
        "schedule": THAI_CHOICES["schedule"] | {"count": 4},
        "times": THAI_CHOICES["times"] | {"values": ["morning", "evening", "bedtime"]},
        "as_needed": {"value": True, "quote": "เมื่อมีอาการ"},
    })
    schedule = label_regimen(choices, THAI_DIRECTIONS, EvidenceRef(source_id="label"))
    assert schedule.parse_status == "partial" and schedule.unparsed_text == THAI_DIRECTIONS
    assert schedule.dose_unit is None and schedule.frequency_count is None and not schedule.time_of_day
    assert schedule.as_needed is None
    assert schedule.route == "oral" and schedule.meal_relation == "immediately after meals"
    assert label_regimen(choices, "ห้าม" + THAI_DIRECTIONS, EvidenceRef(source_id="label")) is None


@pytest.mark.parametrize(("text", "quote", "amount", "unit"), [
    ("Take 1–2 tablets twice daily", "2 tablets", 2, "tablet"),
    ("Take 1 1/2 tablets daily", "2 tablets", 2, "tablet"),
    ("Take 0,5 mL twice daily", "5 mL", 5, "mL"),
    ("รับประทานครั้งละ ๑–๒ เม็ด วันละ ๒ ครั้ง", "๒ เม็ด", 2, "tablet"),
    ("ไม่ควรรับประทานครั้งละ 1 เม็ด", "ครั้งละ 1 เม็ด", 1, "tablet"),
])
def test_label_choices_cannot_select_part_of_a_dose_range_or_negation(text, quote, amount, unit):
    from app.schemas.evidence import EvidenceRef
    from app.services.label_directions import LabelDirectionsChoices, label_regimen

    choices = LabelDirectionsChoices.model_validate({"dose": {"amount": amount, "unit": unit, "quote": quote}})
    assert label_regimen(choices, text, EvidenceRef(source_id="label")) is None


def test_label_choices_cannot_relabel_fragments_of_time_and_route_words():
    from app.schemas.evidence import EvidenceRef
    from app.services.label_directions import LabelDirectionsChoices, label_regimen

    ref = EvidenceRef(source_id="label")
    time = LabelDirectionsChoices.model_validate({"times": {"values": ["noon"], "quote": "noon"}})
    assert label_regimen(time, "Take 1 tablet every afternoon", ref) is None
    thai_noon = LabelDirectionsChoices.model_validate({"times": {"values": ["noon"], "quote": "เที่ยง"}})
    assert label_regimen(thai_noon, "รับประทานก่อนเที่ยงคืน", ref) is None
    route = LabelDirectionsChoices.model_validate({"route": {"value": "topical", "quote": "ทา"}})
    assert label_regimen(route, THAI_DIRECTIONS, ref) is None


def test_label_choices_keep_unrepresented_qualifications_even_if_model_omits_flag():
    from app.schemas.evidence import EvidenceRef
    from app.services.label_directions import LabelDirectionsChoices, label_regimen

    text = "every 8 hours as needed for pain"
    choices = LabelDirectionsChoices.model_validate({
        "schedule": {"kind": "interval", "period": 8, "period_unit": "hour", "quote": "every 8 hours"},
        "as_needed": {"value": True, "quote": "as needed"},
    })
    result = label_regimen(choices, text, EvidenceRef(source_id="label"))
    assert result.parse_status == "partial" and result.unparsed_text == text
    assert result.as_needed and result.period_value == 8


def test_per_crop_failure_does_not_erase_readable_sibling():
    provider, _ = provider_calls(partial=True)
    with TestClient(create_app(get_provider=lambda:provider)) as client:
        preview = upload(client)
    assert [r["identity_status"] for r in preview["rows"]] == ["named","unreadable"]
    assert preview["rows"][1]["observed_names"] == []
    assert preview["photo_issues"][0]["item_id"] == preview["rows"][1]["id"]
    assert preview["photo_issues"][0]["provider_code"] == "provider_timeout"


def test_missing_configuration_and_empty_scene_never_make_medicine(monkeypatch):
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    with TestClient(create_app()) as client:
        result = upload(client)
    assert result["rows"] == [] and result["located_regions"] == []
    assert result["photo_issues"][0]["provider_code"] == "provider_unconfigured"
    provider, _ = provider_calls(empty=True)
    with TestClient(create_app(get_provider=lambda: provider)) as client:
        result = upload(client)
    assert not result["rows"] and result["photo_issues"][0]["code"] == "no_regions"


def test_bounded_original_client_can_recover_using_the_narrow_crop_contract():
    provider, calls = provider_calls()
    with TestClient(create_app(get_provider=lambda: provider)) as client:
        preview = upload(client, marked=True)
    assert calls == [("LabelAnalysisResult", (60, 80)), ("PrintedLabel", (60, 80))]
    row, = preview["rows"]
    assert row["id"] == "order-a" and row["observed_names"][0]["value"] == "Synthetic red label"
    assert row["observed_names"][0]["evidence"] == {"source_id":"left", "item_id":"left"}


def test_reverse_only_unknown_displays_a_citation_without_claiming_a_match():
    provider, _ = provider_calls()
    with TestClient(create_app(get_provider=lambda: provider)) as client:
        preview = upload(client, reverse_only=True)
    assert len(preview["rows"]) == 2
    for row in preview["rows"]:
        assert row["identity_status"] == "unlabeled" and row["reverse_crop"] is None
        assert row["sources"] == [{"source_id": row["id"], "item_id": row["id"]}]


def test_only_a_front_item_attributed_to_this_row_establishes_a_reverse_match():
    from app.schemas.evidence import EvidenceItem, EvidenceRef
    from app.services.medication_analysis import FormAnalysisInput, FormGrounding
    from test_medication_analysis import synthetic_case

    payload, _, _ = synthetic_case()
    form = FormAnalysisInput.model_validate(payload)
    ref = EvidenceRef(source_id="reverse-photo", item_id="pill-c")
    assert not FormGrounding(form, {}).supports_crop(ref, "row-c")
    form.evidence.items.append(EvidenceItem(id="front-c", source_id="label-photo", row_id="row-c", kind="label_region"))
    assert FormGrounding(form, {}).supports_crop(ref, "row-c")


def test_question_stays_pending_on_scene_only_or_unassessed_remainder(monkeypatch):
    question = "Which source confirms this morning dose?"
    provider, _ = provider_calls()
    with TestClient(create_app(get_provider=lambda: provider)) as client:
        preview = upload(client, question=question)
    assert preview["unassessed_question"] and len(preview["rows"]) == 2
    assert not preview["remaining_evidence_unassessed"]
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    with TestClient(create_app()) as client:
        failed = upload(client, question=question, with_note=True)
    assert failed["unassessed_question"] and failed["remaining_evidence_unassessed"]
    assert not failed["rows"] and len(failed["unassigned_reports"]) == 1


def test_invalid_structured_crop_gets_one_repair_and_keeps_citation():
    for failures, expected in [(1, "named"), (2, "unreadable")]:
        provider, calls = provider_calls(invalid_blue=failures)
        with TestClient(create_app(get_provider=lambda: provider)) as client:
            preview = upload(client)
        first, second = preview["rows"]
        assert first["identity_status"] == "named" and second["identity_status"] == expected
        assert calls.count(("PrintedLabel", (60, 80))) == 3
        assert second["sources"] == [{"source_id": second["id"], "item_id": second["id"]}]
        assert bool(preview["photo_issues"]) == (failures == 2)
