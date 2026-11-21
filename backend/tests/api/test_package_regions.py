import base64
import json
from pathlib import Path
from io import BytesIO

import pytest
from PIL import Image
from fastapi.testclient import TestClient

from app.ai.client import OpenAIClient
from app.main import create_app

SCENES = Path(__file__).parents[1] / "fixtures" / "package_regions"
BOX_A = {"x": 0.109, "y": 0.180, "width": 0.312, "height": 0.569}
BOX_B = {"x": 0.554, "y": 0.236, "width": 0.312, "height": 0.569}
GROUP = {"x": 0.109, "y": 0.180, "width": 0.437, "height": 0.625}
URL = "/packages/propose-regions"


def photo_request(scene="clear", side="front"):
    capture = {
        "case_id": "synthetic-case",
        "front": {"attachment_id": "photo-one", "revision": 3},
        "reverse": {"attachment_id": "photo-two", "revision": 2},
    }
    return {
        "capture": capture, "side": side, **capture[side],
        "media_type": "image/png",
        "image_base64": base64.b64encode((SCENES / f"{scene}.png").read_bytes()).decode(),
    }


def client_for(output, calls):
    def transport(request, _timeout):
        calls.append(json.loads(request.data))
        return json.dumps({"status": "completed", "output": [{
            "type": "message", "content": [{"type": "output_text", "text": json.dumps(output)}],
        }]}).encode()

    client = OpenAIClient(api_key="fixture", model="fixture", transport=transport)
    return TestClient(create_app(get_provider=lambda: client))


@pytest.mark.parametrize(("scene", "side", "regions"), [
    ("clear", "front", [BOX_A, BOX_B]),
    ("overlapping", "reverse", [GROUP]),
    ("empty", "front", []),
])
def test_registered_endpoint_returns_revision_bound_editable_geometry(scene, side, regions):
    payload = photo_request(scene, side)
    calls = []
    with client_for({"regions": regions}, calls) as client:
        response = client.post(URL, json=payload)
    assert response.status_code == 200
    assert response.json() == {
        "case_id": "synthetic-case", "side": side, "revision": payload["revision"],
        "attachment_id": payload["attachment_id"], "regions": regions,
    }
    body, = calls
    content = body["input"][0]["content"]
    image_url, = [entry["image_url"] for entry in content if entry["type"] == "input_image"]
    assert image_url.startswith("data:image/png;base64,")
    with Image.open(BytesIO(base64.b64decode(image_url.split(",")[1]))) as actual:
        with Image.open(SCENES / f"{scene}.png") as expected:
            assert actual.tobytes() == expected.convert("RGB").tobytes()
    assert body["store"] is False
    assert "synthetic-case" not in json.dumps(content)


@pytest.mark.parametrize("output", [
    {"regions": [BOX_A, {**BOX_B, "x": 0.9}]},
    {"regions": [{**BOX_A, "width": 0}]},
    {"regions": [{**BOX_A, "name": "fictional drug"}]},
    {"regions": [BOX_A], "confirmed": True},
])
def test_provider_invalid_output_returns_recoverable_error_without_partial_regions(output):
    with client_for(output, []) as client:
        response = client.post(URL, json=photo_request())
    assert response.status_code == 502
    assert response.json()["detail"]["code"] == "provider_invalid_output"
    assert response.json()["detail"]["recoverable"] is True
    assert "regions" not in response.json()


@pytest.mark.parametrize("change", [{"revision": 2}, {"side": "reverse"}, {"attachment_id": "old"}])
def test_obsolete_or_mismatched_view_is_rejected_before_provider(change):
    calls = []
    with client_for({"regions": []}, calls) as client:
        response = client.post(URL, json={**photo_request(), **change})
    assert response.status_code == 409
    assert response.json()["detail"]["recoverable"] is True
    assert calls == []


def test_invalid_image_does_not_reach_the_provider():
    calls = []
    with client_for({}, calls) as client:
        response = client.post(URL, json={**photo_request(), "image_base64": "garbage"})
    assert response.status_code == 422
    assert response.json()["detail"]["recoverable"]
    assert calls == []


def test_rotated_original_is_sent_in_display_coordinates_once():
    payload = photo_request()
    original = Image.new("RGB", (80, 40), "white")
    original.paste("black", (0, 0, 40, 40))
    exif = Image.Exif()
    exif[274] = 6
    photo = BytesIO()
    original.save(photo, "JPEG", exif=exif)
    payload.update(media_type="image/jpeg", image_base64=base64.b64encode(photo.getvalue()).decode())
    calls = []
    with client_for({"regions": [BOX_A]}, calls) as client:
        assert client.post(URL, json=payload).status_code == 422
        payload["capture"]["front"]["exif_orientation"] = 6
        assert client.post(URL, json=payload).status_code == 200
    body, = calls
    url = body["input"][0]["content"][-1]["image_url"]
    with Image.open(BytesIO(base64.b64decode(url.split(",")[1]))) as upright:
        assert upright.size == (40, 80)
        assert upright.getpixel((20, 10)) == (0, 0, 0)
        assert upright.getpixel((20, 70)) == (255, 255, 255)
        assert not upright.getexif()
