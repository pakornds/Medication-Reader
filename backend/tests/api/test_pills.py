import json
import struct
import zlib
from base64 import b64encode
from pathlib import Path

import pytest
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient

from app.ai.client import OpenAIClient
from app.api.pills import create_pills_router

FIXTURES = Path(__file__).parents[1] / "fixtures"
pytestmark = pytest.mark.anyio


def _round_fixture_png() -> bytes:
    def chunk(kind, data):
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data))

    # A white circular silhouette against a gray background, with an obscured center.
    rows = []
    for y in range(100):
        row = bytearray([0])
        for x in range(100):
            if (x - 50) ** 2 + (y - 50) ** 2 <= 32 ** 2:
                row.append(40 if 38 <= x <= 62 and 40 <= y <= 60 else 245)
            else:
                row.append(160)
        rows.append(bytes(row))
    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", 100, 100, 8, 0, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(b"".join(rows)))
        + chunk(b"IEND", b"")
    )


def synthetic_request() -> dict:
    transfer = json.loads((FIXTURES / "contracts" / "transfer_case.json").read_text(encoding="utf-8"))
    evidence = transfer["request"]["evidence"]
    evidence["items"].append({
        "id": "pill-round", "source_id": "reverse-photo", "row_id": "row-round", "kind": "pill_crop"
    })
    photos = [
        ("pill-c", (FIXTURES / "ai" / "reverse-crop.png").read_bytes()),
        ("pill-round", _round_fixture_png()),
    ]
    return {
        "evidence": evidence,
        "crops": [
            {
                "crop": {"source_id": "reverse-photo", "item_id": item_id},
                "media_type": "image/png",
                "image_base64": b64encode(content).decode(),
            }
            for item_id, content in photos
        ],
    }


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture
def payload():
    return synthetic_request()


@pytest.fixture
async def client(payload):
    state = {"calls": 0, "wrong": None, "overlap": False, "timeout": False, "follow_up": None}

    def transport(request, _timeout):
        index = state["calls"]
        state["calls"] += 1
        if state["timeout"] and index == 1:
            raise TimeoutError
        posted = json.loads(request.data)
        contents = posted["input"][0]["content"]
        context = json.loads(contents[0]["text"])
        upload = payload["crops"][index]
        crop = upload["crop"]
        assert context["crop"] == crop
        assert contents[2]["image_url"] == f"data:image/png;base64,{upload['image_base64']}"
        assert "without medication identity" in posted["instructions"]
        observation = {
            "row_id": context["row_id"],
            "crop": crop.copy(),
            "imprint": {"status": "unreadable" if index else "missing"},
            "shape": {"status": "readable", "value": "round" if index else "oval", "evidence": crop.copy()},
            "form": {"status": "readable", "value": "tablet", "evidence": crop.copy()},
            "color": {"status": "readable", "value": "white" if index else "blue", "evidence": crop.copy()},
            "overlapping": state["overlap"],
            "follow_up": state["follow_up"],
        }
        wrong = state["wrong"]
        if wrong == "row":
            observation["row_id"] = "unrelated"
        elif wrong == "crop":
            observation["crop"]["item_id"] = "pill-round"
        elif wrong == "field":
            observation["shape"]["evidence"]["item_id"] = "pill-round"
        elif wrong == "identity":
            observation["medication_name"] = "Demo A"
        return json.dumps({
            "status": "completed",
            "output": [{
                "type": "message",
                "content": [{"type": "output_text", "text": json.dumps(observation)}],
            }],
        }).encode()

    provider = OpenAIClient(api_key="fixture-key", model="fixture-model", transport=transport)
    app = FastAPI()
    app.include_router(create_pills_router(lambda: provider))
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as http:
        yield http, state


async def test_two_different_crops_are_described_separately(client, payload):
    http, state = client
    response = await http.post("/pills/observe", json=payload)
    assert response.status_code == 200, response.text
    rows = response.json()
    assert [(row["row_id"], row["shape"]["value"]) for row in rows] == [
        ("row-c", "oval"), ("row-round", "round")
    ]
    assert rows[1]["imprint"]["status"] == "unreadable"
    assert rows[1]["imprint"]["value"] is None
    assert "other side" in rows[0]["follow_up"]
    assert "clearer photo" in rows[1]["follow_up"]
    assert [row["crop"] for row in rows] == [upload["crop"] for upload in payload["crops"]]
    assert state["calls"] == 2
    print(json.dumps({
        "http_status": response.status_code,
        "crops": [
            {"row": row["row_id"], "shape": row["shape"]["value"], "imprint": row["imprint"]["status"]}
            for row in rows
        ],
    }))


async def test_overlap_gets_clearer_view_request(client, payload):
    http, state = client
    state["overlap"] = True
    state["follow_up"] = "The tablet is Demo A."
    rows = (await http.post("/pills/observe", json=payload)).json()
    assert rows[0]["overlapping"] is True
    assert "items separated" in rows[0]["follow_up"]
    assert "Demo A" not in rows[0]["follow_up"]


@pytest.mark.parametrize("wrong", ["row", "crop", "field", "identity"])
async def test_provider_cannot_swap_evidence_or_assign_identity(client, payload, wrong):
    http, state = client
    state["wrong"] = wrong
    response = await http.post("/pills/observe", json=payload)
    assert response.status_code == 502
    assert response.json()["detail"]["code"] == (
        "provider_invalid_output" if wrong == "identity" else "unsupported_pill_evidence"
    )


@pytest.mark.parametrize("invalid", ["unlocated", "duplicate", "malformed", "oversized"])
async def test_invalid_crops_are_rejected_before_any_provider_call(client, payload, invalid):
    http, state = client
    if invalid == "unlocated":
        payload["crops"][1]["crop"]["item_id"] = "unknown"
    elif invalid == "duplicate":
        payload["crops"][1]["crop"] = payload["crops"][0]["crop"].copy()
    elif invalid == "malformed":
        payload["crops"][1]["image_base64"] = b64encode(b"not an image").decode()
    else:
        payload["crops"][1]["image_base64"] = "A" * 14_000_004
    response = await http.post("/pills/observe", json=payload)
    assert response.status_code == 422
    assert response.json()["detail"]["code"] == "invalid_pill_crop"
    assert len(response.content) < 300
    assert state["calls"] == 0


async def test_provider_failure_does_not_return_partial_observations(client, payload):
    http, state = client
    state["timeout"] = True
    response = await http.post("/pills/observe", json=payload)
    assert response.status_code == 503
    assert response.json()["detail"]["code"] == "provider_timeout"
    assert response.json()["detail"]["recoverable"] is True
