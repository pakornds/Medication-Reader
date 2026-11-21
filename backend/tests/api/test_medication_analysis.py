import json
from copy import deepcopy
from pathlib import Path

import pytest
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient

from app.ai.client import OpenAIClient
from app.api.medication_analysis import create_medication_analysis_router
from app.services.medication_analysis import FormAnalysisInput

FIXTURES = Path(__file__).parents[1] / "fixtures"
pytestmark = pytest.mark.anyio


def synthetic_case():
    transfer = json.loads((FIXTURES / "contracts" / "transfer_case.json").read_text(encoding="utf-8"))
    form = transfer["request"]
    form.update(
        photo_source_ids=["label-photo", "reverse-photo"],
        region_locations={
            "label-photo": {"label-a": "0%,0%,50%,100%", "label-b": "50%,0%,50%,100%"},
            "reverse-photo": {"pill-c": "single crop in right pouch"},
        },
        patient_report_row_ids={"patient-account": "row-a"},
    )
    named = transfer["response"]["rows"][0]
    named["label_fields"]["directions"]["value"] = "เช้าและเย็น"
    next(
        dispute for dispute in named["discrepancies"] if dispute["field"] == "directions"
    )["observed_values"][0]["value"] = "เช้าและเย็น"
    photos = [
        ("label-side.png", (FIXTURES / "ai" / "label-side.png").read_bytes(), "image/png"),
        ("reverse-crop.png", (FIXTURES / "ai" / "reverse-crop.png").read_bytes(), "image/png"),
    ]
    return form, photos, transfer["response"]


def multipart_parts(form, photos):
    return [
        ("form", (None, json.dumps(form, ensure_ascii=False), "application/json")),
        *(("photos", photo) for photo in photos),
    ]


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture
def case():
    return synthetic_case()


def scoped_ocr(submitted, result):
    item, = submitted["items"]
    row = deepcopy(next(row for row in result["rows"] if row["id"] == item["row_id"]))
    ref = {"source_id": item["source_id"], "item_id": item["id"]}
    row.update(sources=[ref], reported_use=[], discrepancies=[], follow_ups=[], regimens=[])
    for observation in [*row["observed_names"], *row["label_fields"].values()]:
        if "evidence" in observation:
            observation["evidence"] = ref
    return {"case_id": submitted["case_id"], "rows": [row]}


@pytest.fixture
async def client(case):
    form, photos, response = case
    state = {"calls": 0, "timeout": False}

    def transport(request, _timeout):
        state["calls"] += 1
        if state["timeout"]:
            raise TimeoutError
        body = json.loads(request.data)
        content = body["input"][0]["content"]
        submitted = json.loads(content[0]["text"])
        if body["text"]["format"]["name"] == "LabelDirectionsChoices":
            output = {}
        elif "items" in submitted:
            output = scoped_ocr(submitted, response)
        else:
            expected = FormAnalysisInput.model_validate(form).model_dump(mode="json")
            assert submitted["patient_report"] == expected["patient_report"]
            assert submitted["other_source_notes"] == expected["other_source_notes"]
            assert submitted["question"] == form["question"]
            assert list(submitted["uploaded_photo_sources"]) == form["photo_source_ids"]
            assert len([item for item in content if item["type"] == "input_image"]) == int(bool(photos))
            assert "only user request" in body["instructions"]
            output = response
        return json.dumps({
            "status": "completed",
            "output": [{
                "type": "message",
                "content": [{"type": "output_text", "text": json.dumps(output)}],
            }],
        }).encode()

    provider = OpenAIClient(api_key="fixture-key", model="fixture-model", transport=transport)
    app = FastAPI()
    app.include_router(create_medication_analysis_router(lambda: provider))
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as http:
        yield http, state


async def test_mixed_form_keeps_unresolved_item_and_sources(client, case):
    http, _ = client
    form, photos, _ = case
    response = await http.post("/medication-analysis", files=multipart_parts(form, photos))
    assert response.status_code == 200, response.text
    preview = response.json()
    named, _, unknown = preview["rows"]
    assert named["reported_use"][0]["evidence"]["source_id"] == "patient-account"
    assert named["label_fields"]["directions"]["evidence"]["source_id"] == "label-photo"
    assert [item["basis"] for item in named["regimens"]] == ["documented", "reported"]
    assert {item["field"] for item in named["discrepancies"]} == {"identity", "directions"}
    assert unknown["identity_status"] == "unlabeled"
    assert unknown["reverse_crop"] is None
    assert {"source_id":"reverse-photo", "item_id":"pill-c"} in unknown["sources"]
    assert unknown["dispensing_source_id"] is None
    assert {item["question"] for item in unknown["follow_ups"]} == {
        "Does the patient have the original labeled package?",
        "Can the dispensing clinic confirm the directions?",
        "Can the reviewer match the reverse photo to this item?",
    }
    assert unknown["follow_ups"][1]["potential_source_id"] == "prior-clinic"
    assert [source["id"] for source in preview["unavailable_sources"]] == ["prior-clinic"]
    print(json.dumps({
        "http_status": response.status_code,
        "reported_use_source": named["reported_use"][0]["evidence"]["source_id"],
        "printed_directions_source": named["label_fields"]["directions"]["evidence"]["source_id"],
        "unknown": unknown["identity_status"],
        "unmatched_crop": unknown["sources"][0]["item_id"],
        "follow_up_fields": [item["field"] for item in unknown["follow_ups"]],
    }))


async def test_same_photo_wrong_item_strength_is_withheld(client, case):
    http, _ = client
    form, photos, model_output = case
    model_output["rows"][0]["label_fields"]["strength"].update(
        value="10 mg", evidence={"source_id": "label-photo", "item_id": "label-b"}
    )
    response = await http.post("/medication-analysis", files=multipart_parts(form, photos))
    assert response.status_code == 200, response.text
    row = response.json()["rows"][0]
    assert row["label_fields"]["strength"] == {"status": "missing", "value": None, "evidence": None}
    assert any(item["field"] == "strength" for item in row["follow_ups"])
    assert response.json()["rows"][1]["label_fields"]["strength"]["value"] == "10 mg"


async def test_fixed_regimens_are_derived_from_grounded_wording(client, case):
    http, _ = client
    form, photos, model_output = case
    row = model_output["rows"][0]
    row["regimens"] = [{"time_of_day": ["not a supported time"], "basis": "verified"}]
    response = await http.post("/medication-analysis", files=multipart_parts(form, photos))
    assert response.status_code == 200, response.text
    regimens = response.json()["rows"][0]["regimens"]
    assert [component["basis"] for component in regimens] == ["documented", "reported"]
    assert regimens[0]["directions_text"] == "เช้าและเย็น"
    assert regimens[1]["directions_text"] == form["patient_report"][0]["value"]


async def test_disputed_label_value_must_match_the_transcribed_fact(client, case):
    http, _ = client
    form, photos, model_output = case
    direction_dispute = next(
        dispute for dispute in model_output["rows"][0]["discrepancies"]
        if dispute["field"] == "directions"
    )
    direction_dispute["observed_values"][0]["value"] = "unsupported"
    response = await http.post("/medication-analysis", files=multipart_parts(form, photos))
    assert response.status_code == 200, response.text
    named = response.json()["rows"][0]
    assert [item["field"] for item in named["discrepancies"]] == ["identity"]
    assert any(item["field"] == "directions" for item in named["follow_ups"])


async def test_logical_sources_can_share_one_uploaded_photo(client, case):
    http, _ = client
    form, photos, model_output = case
    label_source = next(source for source in form["evidence"]["sources"] if source["id"] == "label-photo")
    label_source["attachment_id"] = "one-photo"
    form["evidence"]["sources"].append({
        **label_source, "id": "other-label-source", "organization": "Demo Ward Pharmacy"
    })
    label_item = next(item for item in form["evidence"]["items"] if item["id"] == "label-b")
    label_item["source_id"] = "other-label-source"
    form["region_locations"]["label-photo"].pop("label-b")
    form["region_locations"]["other-label-source"] = {"label-b": "50%,0%,50%,100%"}
    other = model_output["rows"][1]
    for ref in (
        *other["sources"],
        other["observed_names"][0]["evidence"],
        other["label_fields"]["strength"]["evidence"],
    ):
        ref["source_id"] = "other-label-source"
    response = await http.post("/medication-analysis", files=multipart_parts(form, photos))
    assert response.status_code == 200, response.text
    assert response.json()["rows"][1]["label_fields"]["strength"]["evidence"] == {
        "source_id": "other-label-source", "item_id": "label-b"
    }

async def test_whole_photo_does_not_establish_unknown_items_dispensing_source(client, case):
    http, _ = client
    form, photos, model_output = case
    unknown = model_output["rows"][2]
    unknown["sources"].append({"source_id": "label-photo"})
    unknown["dispensing_source_id"] = "label-photo"
    response = await http.post("/medication-analysis", files=multipart_parts(form, photos))
    assert response.status_code == 200, response.text
    assert response.json()["rows"][2]["dispensing_source_id"] is None


async def test_ambiguous_patient_account_is_unassigned(client, case):
    http, _ = client
    form, photos, _ = case
    form["patient_report_row_ids"] = {}
    response = await http.post("/medication-analysis", files=multipart_parts(form, photos))
    assert response.status_code == 200, response.text
    preview = response.json()
    assert preview["rows"][0]["reported_use"] == []
    assert [item["value"] for item in preview["unassigned_reports"]] == [
        item["value"] for item in form["patient_report"]
    ]


async def test_report_cannot_borrow_a_name_from_another_statement(client, case):
    http, _ = client
    form, photos, model_output = case
    form["patient_report_row_ids"].clear()
    form["patient_report"][0]["value"] = "Demo A in the morning"
    other = {"value": "Demo B at night", "evidence": {"source_id": "patient-account"}}
    form["patient_report"].append(other)
    model_output["rows"][0]["reported_use"] = [other]
    response = await http.post("/medication-analysis", files=multipart_parts(form, photos))
    assert response.status_code == 200, response.text
    preview = response.json()
    assert preview["rows"][0]["reported_use"] == []
    assert [item["value"] for item in preview["unassigned_reports"]] == [
        "Demo A in the morning", "Demo B at night"
    ]


async def test_same_name_on_two_rows_leaves_report_unassigned(client, case):
    http, _ = client
    form, photos, model_output = case
    form["patient_report_row_ids"].clear()
    form["patient_report"][0]["value"] = "Demo A in the morning"
    model_output["rows"][0]["reported_use"] = form["patient_report"]
    model_output["rows"][1]["observed_names"][0]["value"] = "Demo A"
    response = await http.post("/medication-analysis", files=multipart_parts(form, photos))
    assert response.status_code == 200, response.text
    assert response.json()["rows"][0]["reported_use"] == []
    assert len(response.json()["unassigned_reports"]) == 1


async def test_partial_report_keeps_original_uncertain_wording(client, case):
    http, _ = client
    form, photos, model_output = case
    form["patient_report_row_ids"].clear()
    form["patient_report"][0]["value"] = "Demo A in the morning; unsure about the other pill"
    model_output["rows"][0]["reported_use"][0]["value"] = "Demo A in the morning"
    response = await http.post("/medication-analysis", files=multipart_parts(form, photos))
    assert response.status_code == 200, response.text
    preview = response.json()
    assert preview["rows"][0]["reported_use"][0]["value"] == "Demo A in the morning"
    assert preview["unassigned_reports"][0]["value"] == form["patient_report"][0]["value"]


async def test_text_only_form_returns_a_sourced_named_item(client, case):
    http, _ = client
    form, photos, model_output = case
    photos.clear()
    form["photo_source_ids"].clear()
    form["region_locations"].clear()
    form["patient_report_row_ids"].clear()
    form["patient_report"].clear()
    form["evidence"]["sources"] = [
        source for source in form["evidence"]["sources"] if source["id"] == "ward-record"
    ]
    form["evidence"]["items"].clear()
    model_output["rows"] = [{
        "id": "from-note",
        "identity_status": "named",
        "sources": [{"source_id": "ward-record"}],
        "observed_names": [{"value": "Demo C", "evidence": {"source_id": "ward-record"}}],
    }]
    response = await http.post("/medication-analysis", files=multipart_parts(form, photos))
    assert response.status_code == 200, response.text
    assert response.json()["rows"][0]["observed_names"][0]["value"] == "Demo C"


async def test_photo_only_form_keeps_photo_evidence(client, case):
    http, _ = client
    form, photos, _ = case
    form["patient_report_row_ids"].clear()
    form["patient_report"].clear()
    form["other_source_notes"].clear()
    response = await http.post("/medication-analysis", files=multipart_parts(form, photos))
    assert response.status_code == 200, response.text
    named = response.json()["rows"][0]
    assert named["observed_names"][0]["evidence"]["source_id"] == "label-photo"
    assert named["reported_use"] == []
    assert named["discrepancies"] == []


@pytest.mark.parametrize("invalid", ["missing_photo", "wrong_media", "wrong_region", "json_only"])
async def test_invalid_form_does_not_call_provider(client, case, invalid):
    http, state = client
    form, photos, _ = case
    if invalid == "missing_photo":
        photos.pop()
    elif invalid == "wrong_media":
        photos[0] = ("label.png", b"invalid PNG", "image/png")
    elif invalid == "wrong_region":
        form["region_locations"]["label-photo"]["pill-c"] = "wrong"
    if invalid == "json_only":
        response = await http.post("/medication-analysis", json=form)
    else:
        response = await http.post("/medication-analysis", files=multipart_parts(form, photos))
    assert response.status_code == 422
    assert response.json()["detail"]["code"] == "invalid_analysis_form"
    assert state["calls"] == 0


async def test_timeout_is_recoverable(client, case):
    http, state = client
    form, photos, _ = case
    state["timeout"] = True
    response = await http.post("/medication-analysis", files=multipart_parts(form, photos))
    assert response.status_code == 503
    assert response.json()["detail"]["code"] == "provider_timeout"
    assert response.json()["detail"]["recoverable"] is True
