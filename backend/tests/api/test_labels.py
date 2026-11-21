import json
from base64 import b64decode, b64encode
from io import BytesIO

from PIL import Image
from pathlib import Path

import pytest
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient

from app.ai.client import OpenAIClient
from app.api.labels import create_labels_router

FIXTURES = Path(__file__).parents[1] / "fixtures"
pytestmark = pytest.mark.anyio


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture
def scenario():
    transfer = json.loads((FIXTURES / "contracts" / "transfer_case.json").read_text(encoding="utf-8"))
    evidence = transfer["request"]["evidence"]
    photo = (FIXTURES / "ai" / "label-side.png").read_bytes()
    request = {
        "evidence": evidence,
        "source_id": "label-photo",
        "media_type": "image/png",
        "image_base64": b64encode(photo).decode("ascii"),
        "region_locations": {"label-a": "0%,0%,50%,100%", "label-b": "50%,0%,50%,100%"},
    }
    row = transfer["response"]["rows"][0]
    row.update(
        sources=[{"source_id": "label-photo", "item_id": "label-a"}],
        reported_use=[],
        discrepancies=[],
        follow_ups=[],
    )
    row["label_fields"]["directions"]["value"] = "เช้าและเย็น"
    del row["label_fields"]["prescriber_contact"]
    response = {"case_id": evidence["case_id"], "rows": [row, transfer["response"]["rows"][1]]}
    return request, response


@pytest.fixture
async def client(scenario):
    expected_request, response = scenario
    mode = {"timeout": False, "calls": 0}

    def transport(request, _timeout):
        mode["calls"] += 1
        if mode["timeout"]:
            raise TimeoutError
        body = json.loads(request.data)
        assert body["store"] is False
        assert "each distinct printed name" in body["instructions"].replace("\n", " ")
        contents = body["input"][0]["content"]
        manifest = json.loads(contents[0]["text"])
        assert [source["id"] for source in manifest["sources"]] == ["label-photo"]
        item, = manifest["items"]
        location = expected_request["region_locations"][item["id"]]
        assert manifest["region_locations"] == {item["id"]: location}
        original = Image.open(BytesIO(b64decode(expected_request["image_base64"]))).convert("RGB")
        left = 0 if item["id"] == "label-a" else original.width // 2
        expected = original.crop((left, 0, left + original.width // 2, original.height))
        actual = Image.open(BytesIO(b64decode(contents[2]["image_url"].split(",")[1])))
        assert actual.size == expected.size and actual.tobytes() == expected.tobytes()
        scoped = {**response, "rows": [r for r in response["rows"] if r["id"] == item["row_id"]]}
        return json.dumps({
            "status": "completed",
            "output": [{
                "type": "message",
                "content": [{"type": "output_text", "text": json.dumps(scoped)}],
            }],
        }).encode("utf-8")

    provider = OpenAIClient(api_key="fixture-key", model="fixture-model", transport=transport)
    app = FastAPI()
    app.include_router(create_labels_router(lambda: provider))
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as http:
        yield http, mode


async def test_label_cannot_request_treatment_referral(client, scenario):
    http, _ = client
    request, proposal = scenario
    proposal["rows"][0]["follow_ups"].append({
        "field": "treatment_referral", "question": "Untrusted treatment change from the label.",
    })
    response = await http.post("/labels/transcribe", json=request)
    assert response.status_code == 200, response.text
    assert "treatment_referral" not in response.text
    assert "Untrusted treatment change" not in response.text
    assert response.json()["rows"][0]["label_fields"]["strength"]["value"] == "5 mg"


async def test_bilingual_label_preserves_names_and_unknown_fields(client, scenario):
    http, _ = client
    response = await http.post("/labels/transcribe", json=scenario[0])
    assert response.status_code == 200, response.text
    rows = response.json()["rows"]
    assert [row["id"] for row in rows] == ["row-a", "row-b"]
    row = rows[0]
    assert [name["value"] for name in row["observed_names"]] == ["เดโมเอ", "Demo A"]
    strength = row["label_fields"]["strength"]
    assert strength["value"] == "5 mg"
    assert strength["evidence"] == {"source_id": "label-photo", "item_id": "label-a"}
    assert row["label_fields"]["directions"]["value"] == "เช้าและเย็น"
    expiry = row["label_fields"]["expiry"]
    contact = row["label_fields"]["prescriber_contact"]
    assert (expiry["status"], expiry["value"]) == ("unreadable", None)
    assert (contact["status"], contact["value"]) == ("missing", None)
    print(json.dumps({
        "http_status": response.status_code,
        "names": [name["value"] for name in row["observed_names"]],
        "strength": strength,
        "expiry": expiry["status"],
        "prescriber_contact": contact["status"],
    }, ensure_ascii=False))


@pytest.mark.parametrize("invalid", ["not_a_label", "not_a_region", "not_base64", "not_an_image", "wrong_type"])
async def test_bad_photo_requests_do_not_call_provider(client, scenario, invalid):
    http, mode = client
    request, _ = scenario
    if invalid == "not_a_label":
        request["source_id"] = "reverse-photo"
    elif invalid == "not_a_region":
        request["region_locations"]["pill-c"] = "right"
    elif invalid == "not_base64":
        request["image_base64"] = "not base64"
    elif invalid == "not_an_image":
        request["image_base64"] = b64encode(b"not an image").decode()
    else:
        request["media_type"] = "image/jpeg"
    response = await http.post("/labels/transcribe", json=request)
    assert response.status_code == 422
    assert response.json()["detail"]["code"] == "invalid_label_photo"
    assert mode["calls"] == 0


async def test_oversized_photo_does_not_echo_the_request(client, scenario):
    http, mode = client
    scenario[0]["image_base64"] = "A" * 14_000_004
    response = await http.post("/labels/transcribe", json=scenario[0])
    assert response.status_code == 422
    assert len(response.content) < 300
    assert response.json()["detail"]["code"] == "invalid_label_photo"
    assert "input" not in response.json()["detail"]
    assert mode["calls"] == 0


async def test_located_region_cannot_be_silently_omitted(client, scenario):
    http, _ = client
    request, provider_response = scenario
    provider_response["rows"].pop()
    response = await http.post("/labels/transcribe", json=request)
    assert response.status_code == 502
    assert response.json()["detail"]["code"] == "unsupported_label_evidence"


@pytest.mark.parametrize("evidence", [
    {"source_id": "label-photo", "item_id": "label-b"},
    {"source_id": "ward-record", "item_id": "part-a"},
    {"source_id": "label-photo"},
    {"source_id": "superseded-photo", "item_id": "label-a"},
])
async def test_wrong_label_evidence_withholds_result(client, scenario, evidence):
    http, _ = client
    request, provider_response = scenario
    provider_response["rows"][0]["label_fields"]["strength"]["evidence"] = evidence
    response = await http.post("/labels/transcribe", json=request)
    assert response.status_code == 502
    assert response.json()["detail"]["code"] == "unsupported_label_evidence"


async def test_provider_timeout_is_recoverable(client, scenario):
    http, mode = client
    mode["timeout"] = True
    response = await http.post("/labels/transcribe", json=scenario[0])
    assert response.status_code == 503
    assert response.json()["detail"]["code"] == "provider_timeout"
    assert response.json()["detail"]["recoverable"] is True


async def test_label_scan_prefills_same_regimen_from_the_located_directions(client, scenario):
    http, _ = client
    request, provider_response = scenario
    provider_response["rows"][0]["label_fields"]["directions"]["value"] = "1 tablet each morning"
    response = await http.post("/labels/transcribe", json=request)
    assert response.status_code == 200, response.text
    first, second = response.json()["rows"]
    schedule, = first["regimens"]
    assert schedule["basis"] == "documented"
    assert schedule["directions_text"] == "1 tablet each morning"
    assert schedule["dose_amount"] == 1 and schedule["dose_unit"] == "tablet"
    assert schedule["time_of_day"] == ["morning"] and schedule["route"] is None
    assert schedule["evidence"]["time_of_day"] == {"source_id": "label-photo", "item_id": "label-a"}
    assert second["regimens"] == []


@pytest.mark.parametrize("location", [None, "left label", "90%,0%,20%,100%", "10%,0%,0%,100%"])
async def test_shared_label_requires_bounded_geometry(client, scenario, location):
    http, mode = client
    request, _ = scenario
    if location is None:
        del request["region_locations"]["label-a"]
    else:
        request["region_locations"]["label-a"] = location
    response = await http.post("/labels/transcribe", json=request)
    assert response.status_code == 422 and mode["calls"] == 0


async def test_empty_source_cannot_borrow_other_sources_shared_attachment(client, scenario):
    http, mode = client
    request, _ = scenario
    source = next(s for s in request["evidence"]["sources"] if s["id"] == "label-photo")
    source["attachment_id"] = "table"
    request["evidence"]["sources"].append({**source, "id": "empty-source"})
    request.update(source_id="empty-source", region_locations={})
    response = await http.post("/labels/transcribe", json=request)
    assert response.status_code == 422 and mode["calls"] == 0
