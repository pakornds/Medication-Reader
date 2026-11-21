import json

import pytest
from httpx import ASGITransport, AsyncClient

from app.ai.client import OpenAIClient
from app.main import create_app
from test_medication_analysis import multipart_parts, synthetic_case

pytestmark = pytest.mark.anyio


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture
async def client():
    form, photos, result = synthetic_case()
    calls = []

    def transport(request, _timeout):
        body = json.loads(request.data)
        calls.append(body)
        return json.dumps({
            "status": "completed",
            "output": [{
                "type": "message",
                "content": [{"type": "output_text", "text": json.dumps(result)}],
            }],
        }).encode()

    provider = OpenAIClient(api_key="fixture-key", model="fixture-model", transport=transport)
    app = create_app(get_provider=lambda: provider)
    async with app.router.lifespan_context(app):
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as http:
            yield http, form, photos, calls


async def test_main_factory_publishes_feature_operations(client):
    http, _, _, _ = client
    response = await http.get("/openapi.json")
    assert response.status_code == 200
    spec = response.json()
    operations = {
        "/health": {"get"},
        "/labels/transcribe": {"post"},
        "/pills/observe": {"post"},
        "/pill-candidates": {"post"},
        "/pill-candidates/references/{reference_id}": {"get"},
        "/medication-analysis": {"post"},
        "/checks": {"post"},
        "/checks/local": {"post"},
        "/checks/local/products": {"get"},
        "/regimens/parse": {"post"},
        "/imports": {"get", "post"},
        "/imports/approvals": {"post"},
    }
    for path, methods in operations.items():
        assert methods <= spec["paths"][path].keys()
    form = spec["paths"]["/medication-analysis"]["post"]["requestBody"]
    assert "multipart/form-data" in form["content"]
    assert {"DemoReviewer": []} in spec["paths"]["/imports/approvals"]["post"]["security"]


async def test_main_factory_dispatches_sourced_analysis_form(client):
    http, form, photos, calls = client
    assert (await http.get("/health")).json() == {"status": "ok"}
    response = await http.post("/medication-analysis", files=multipart_parts(form, photos))
    assert response.status_code == 200, response.text
    preview = response.json()
    named, _, unknown = preview["rows"]
    assert named["label_fields"]["directions"]["evidence"]["source_id"] == "label-photo"
    assert named["reported_use"][0]["evidence"]["source_id"] == "patient-account"
    assert unknown["identity_status"] == "unlabeled"
    assert unknown["reverse_crop"]["item_id"] == "pill-c"
    assert len(calls) == 1
    assert calls[0]["model"] == "fixture-model"
    assert calls[0]["store"] is False
    print(json.dumps({
        "http_status": response.status_code,
        "provider": calls[0]["model"],
        "directions_source": named["label_fields"]["directions"]["evidence"]["source_id"],
        "reported_use_source": named["reported_use"][0]["evidence"]["source_id"],
        "unknown_crop": unknown["reverse_crop"]["item_id"],
    }))


async def test_mock_import_requires_the_configured_server_token(client, monkeypatch):
    http, _, _, _ = client
    access = {"X-Demo-Reviewer-Token": "fixture-reviewer-token"}
    search = {"imported_at": "2026-11-21T04:00:00Z"}
    monkeypatch.delenv("MEDICATION_READER_DEMO_REVIEWER_TOKEN", raising=False)
    assert (await http.get("/imports", headers=access, params=search)).status_code == 403
    monkeypatch.setenv("MEDICATION_READER_DEMO_REVIEWER_TOKEN", "fixture-reviewer-token")
    assert (await http.get("/imports", params=search)).status_code == 403
    assert (await http.get(
        "/imports", headers={"X-Demo-Reviewer-Token": "different"}, params=search
    )).status_code == 403
    response = await http.get("/imports", headers=access, params=search)
    assert response.status_code == 200
    assert response.json() == []
