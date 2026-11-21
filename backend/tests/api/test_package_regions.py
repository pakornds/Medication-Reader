import base64
import json
from io import BytesIO
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from PIL import Image

from app.ai.client import OpenAIClient
from app.main import create_app

SCENES = Path(__file__).parents[1] / "fixtures" / "package_regions"
BOX_A = {"x": 0.109, "y": 0.180, "width": 0.312, "height": 0.569}
BOX_B = {"x": 0.554, "y": 0.236, "width": 0.312, "height": 0.569}
GROUP = {"x": 0.109, "y": 0.180, "width": 0.437, "height": 0.625}
HEADERS = {"X-Demo-Reviewer-Token": "fixture-clinician"}


@pytest.fixture(autouse=True)
def configured_reviewer(monkeypatch):
    monkeypatch.setenv("MEDICATION_READER_DEMO_NURSE_TOKEN", "fixture-clinician")


def register_capture(client, scene="clear", side="front", image=None):
    case = client.post("/admissions", headers=HEADERS, json={"patient_alias": "Synthetic"}).json()
    manifest = {"case_id": case["id"], "front": {"attachment_id": "photo-one", "revision": 1}}
    if side == "reverse":
        manifest["reverse"] = {"attachment_id": "photo-two", "revision": 2}
    command = {"revision": case["revision"], "request_id": "originals", "manifest": manifest}
    files = {"command": (None, json.dumps(command), "application/json")}
    for key in ("front", "reverse"):
        if key in manifest:
            files[key] = image if image and key == side else (
                "scene.png", (SCENES / f"{scene}.png").read_bytes(), "image/png",
            )
    url = f"/admissions/{case['id']}/capture"
    assert client.post(url, files=files, headers=HEADERS).status_code == 200
    return url, {"side": side, **manifest[side]}, command


def client_for(output, calls, during_request=None):
    def transport(request, _timeout):
        calls.append(json.loads(request.data))
        if during_request:
            during_request()
        return json.dumps({"status": "completed", "output": [{
            "type": "message", "content": [{"type": "output_text", "text": json.dumps(output)}],
        }]}).encode()

    provider = OpenAIClient(api_key="fixture", model="fixture", transport=transport)
    return TestClient(create_app(get_provider=lambda: provider))


@pytest.mark.parametrize(("scene", "side", "regions"), [
    ("clear", "front", [BOX_A, BOX_B]),
    ("overlapping", "reverse", [GROUP]),
    ("empty", "front", []),
])
def test_registered_endpoint_returns_editable_geometry(scene, side, regions):
    calls = []
    with client_for({"regions": regions}, calls) as client:
        url, view, command = register_capture(client, scene, side)
        response = client.post(url + "/propose-regions", headers=HEADERS, json=view)
        case = client.get(url.removesuffix("/capture"), headers=HEADERS).json()
    assert response.status_code == 200
    assert response.json() == {"case_id": case["id"], **view, "regions": regions}
    assert case["capture"]["packages"] == [] and case["capture"][side]["regions"] == []
    assert response.headers["cache-control"] == "no-store"
    body, = calls
    content = body["input"][0]["content"]
    url, = [entry["image_url"] for entry in content if entry["type"] == "input_image"]
    with Image.open(BytesIO(base64.b64decode(url.split(",")[1]))) as actual:
        with Image.open(SCENES / f"{scene}.png") as expected:
            assert actual.tobytes() == expected.convert("RGB").tobytes()
    assert body["store"] is False
    assert command["manifest"]["case_id"] not in json.dumps(content)


@pytest.mark.parametrize("output", [
    {"regions": [BOX_A, {**BOX_B, "x": 0.9}]},
    {"regions": [{**BOX_A, "width": 0}]},
    {"regions": [{**BOX_A, "name": "fictional drug"}]},
    {"regions": [BOX_A], "confirmed": True},
])
def test_invalid_provider_output_preserves_manual_selection(output):
    with client_for(output, []) as client:
        url, view, command = register_capture(client)
        response = client.post(url + "/propose-regions", json=view, headers=HEADERS)
        assert response.status_code == 502
        assert response.json()["detail"]["code"] == "provider_invalid_output"
        assert response.json()["detail"]["recoverable"] is True
        command.update(revision=2, request_id="manual")
        command["manifest"]["front"]["regions"] = [{"id": "staff-box", "bounds": BOX_A}]
        saved = client.post(url, files={"command": (None, json.dumps(command))}, headers=HEADERS)
        assert saved.json()["capture"]["front"]["regions"][0]["id"] == "staff-box"


def test_unauthorized_or_wrong_view_cannot_reach_the_provider():
    calls = []
    with client_for({"regions": []}, calls) as client:
        url, view, _ = register_capture(client)
        assert client.post(url + "/propose-regions", json=view).status_code == 403
        for change in ({"revision": 2}, {"side": "reverse"}, {"attachment_id": "old"}):
            response = client.post(url + "/propose-regions", json={**view, **change}, headers=HEADERS)
            assert response.status_code == 404 and response.json()["detail"]["recoverable"]
    assert calls == []


def test_revision_superseded_during_provider_call_discards_output():
    def replace_revision():
        command.update(revision=2, request_id="new-revision")
        command["manifest"]["front"]["revision"] += 1
        assert client.post(url, files={"command": (None, json.dumps(command))}, headers=HEADERS).status_code == 200

    with client_for({"regions": [BOX_A]}, [], replace_revision) as client:
        url, view, command = register_capture(client)
        response = client.post(url + "/propose-regions", json=view, headers=HEADERS)
        assert response.status_code == 404 and response.json()["detail"]["recoverable"]
        assert "regions" not in response.json()


def test_rotated_original_is_sent_in_display_coordinates_once():
    original = Image.new("RGB", (80, 40), "white")
    original.paste("black", (0, 0, 40, 40))
    exif = Image.Exif()
    exif[274] = 6
    photo = BytesIO()
    original.save(photo, "JPEG", exif=exif)
    calls = []
    with client_for({"regions": [BOX_A]}, calls) as client:
        url, view, _ = register_capture(client, image=("scene.jpg", photo.getvalue(), "image/jpeg"))
        assert client.post(url + "/propose-regions", json=view, headers=HEADERS).status_code == 200
    body, = calls
    url = body["input"][0]["content"][-1]["image_url"]
    with Image.open(BytesIO(base64.b64decode(url.split(",")[1]))) as upright:
        assert upright.size == (40, 80)
        assert upright.getpixel((20, 10)) == (0, 0, 0)
        assert upright.getpixel((20, 70)) == (255, 255, 255)
        assert not upright.getexif()
