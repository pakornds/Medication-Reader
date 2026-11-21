import json
from base64 import b64encode
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
        "region_locations": {"label-a": "left", "label-b": "middle"},
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
    response = {"case_id": evidence["case_id"], "rows": [row]}
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
        assert [item["id"] for item in manifest["items"]] == ["label-a", "label-b"]
        assert manifest["region_locations"] == expected_request["region_locations"]
        assert contents[2]["image_url"] == f"data:image/png;base64,{expected_request['image_base64']}"
        return json.dumps({
            "status": "completed",
            "output": [{
                "type": "message",
                "content": [{"type": "output_text", "text": json.dumps(response)}],
            }],
        }).encode("utf-8")

    provider = OpenAIClient(api_key="fixture-key", model="fixture-model", transport=transport)
    app = FastAPI()
    app.include_router(create_labels_router(lambda: provider))
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as http:
        yield http, mode


async def test_bilingual_label_preserves_names_and_unknown_fields(client, scenario):
    http, _ = client
    response = await http.post("/labels/transcribe", json=scenario[0])
    assert response.status_code == 200, response.text
    row = response.json()["rows"][0]
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


@pytest.mark.parametrize("invalid", ["not_a_label", "not_a_region", "not_base64"])
async def test_bad_photo_requests_do_not_call_provider(client, scenario, invalid):
    http, mode = client
    request, _ = scenario
    if invalid == "not_a_label":
        request["source_id"] = "reverse-photo"
    elif invalid == "not_a_region":
        request["region_locations"]["pill-c"] = "right"
    else:
        request["image_base64"] = "not base64"
    response = await http.post("/labels/transcribe", json=request)
    assert response.status_code == 422
    assert response.json()["detail"]["code"] == "invalid_label_photo"
    assert mode["calls"] == 0


@pytest.mark.parametrize("evidence", [
    {"source_id": "label-photo", "item_id": "label-b"},
    {"source_id": "ward-record", "item_id": "part-a"},
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
