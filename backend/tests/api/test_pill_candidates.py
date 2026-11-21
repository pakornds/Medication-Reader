import json
from pathlib import Path

import pytest
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient

from app.api.pill_candidates import router
from app.schemas.pills import CandidateResult

FIXTURES = Path(__file__).parents[1] / "fixtures"
pytestmark = pytest.mark.anyio


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture
async def client():
    app = FastAPI()
    app.include_router(router)
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as http:
        yield http


@pytest.fixture
def query():
    evidence = json.loads((FIXTURES / "contracts" / "transfer_case.json").read_text(
        encoding="utf-8"
    ))["request"]["evidence"]
    crop = {"source_id": "reverse-photo", "item_id": "pill-c"}
    return {
        "evidence": evidence,
        "observation": {
            "row_id": "row-c",
            "crop": crop,
            "imprint": {"status": "unreadable"},
            "shape": {"status": "readable", "value": "oval", "evidence": crop.copy()},
            "form": {"status": "readable", "value": "tablet", "evidence": crop.copy()},
            "color": {"status": "readable", "value": "pale blue", "evidence": crop.copy()},
        },
    }


async def test_similar_presentations_are_unresolved_and_include_images(client, query):
    response = await client.post("/pill-candidates", json=query)
    assert response.status_code == 200, response.text
    result = CandidateResult.model_validate(response.json())
    assert result.status == "unresolved"
    assert [candidate.reference_id for candidate in result.candidates] == [
        "demo-a-blue", "demo-a-pink"
    ]
    blue, pink = result.candidates
    assert blue.fictional_medication == pink.fictional_medication == "Demo A"
    assert "similar silhouette" in blue.matches
    assert any("pink" in difference for difference in pink.differences)
    image = await client.get(blue.image_reference)
    assert image.status_code == 200
    assert image.headers["content-type"] == "image/png"
    assert image.content.startswith(b"\x89PNG\r\n\x1a\n")


async def test_observed_imprint_distinguishes_a_different_oval_reference(client, query):
    observation = query["observation"]
    observation["imprint"] = {
        "status": "readable", "value": "b2", "evidence": observation["crop"]
    }
    response = await client.post("/pill-candidates", json=query)
    result = CandidateResult.model_validate(response.json())
    assert [candidate.reference_id for candidate in result.candidates] == ["demo-b-white"]
    assert "imprint: B2" in result.candidates[0].matches
    assert result.status == "unresolved"


async def test_no_match_includes_follow_up(client, query):
    observation = query["observation"]
    observation["imprint"] = {
        "status": "readable", "value": "NO MATCH", "evidence": observation["crop"]
    }
    response = await client.post("/pill-candidates", json=query)
    result = CandidateResult.model_validate(response.json())
    assert result.candidates == []
    assert result.status == "unresolved"
    assert result.follow_up


async def test_overlapping_items_need_a_retake(client, query):
    query["observation"]["overlapping"] = True
    response = await client.post("/pill-candidates", json=query)
    result = CandidateResult.model_validate(response.json())
    assert result.candidates == []
    assert "clearer photo" in result.follow_up


async def test_wrong_photo_source_is_rejected(client, query):
    query["observation"]["color"]["evidence"]["item_id"] = "different-crop"
    response = await client.post("/pill-candidates", json=query)
    assert response.status_code == 422
    assert response.json()["detail"]["code"] == "invalid_crop"


async def test_unknown_reference_image_is_not_served(client):
    response = await client.get("/pill-candidates/references/unlisted")
    assert response.status_code == 404
