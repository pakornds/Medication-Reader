"""Whole-table capture through assigned staff sessions, with synthetic originals."""
import json
import logging
from copy import deepcopy
from io import BytesIO
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from PIL import Image, ImageOps

from app.main import create_app
from test_admissions import headers, record


def picture(orientation):
    image = Image.new("RGB", (160, 100))
    image.putdata([(x, y, (x + y) % 256) for y in range(100) for x in range(160)])
    metadata = Image.Exif()
    metadata[274] = orientation
    output = BytesIO()
    image.save(output, "PNG", exif=metadata)
    return output.getvalue()


@pytest.fixture
def session(monkeypatch):
    for role, key in (("nurse", "NURSE"), ("doctor", "DOCTOR"), ("pharmacist", "REVIEWER")):
        monkeypatch.setenv(f"MEDICATION_READER_DEMO_{key}_TOKEN", "fixture-" + role)
    with TestClient(create_app()) as http:
        case = http.post("/admissions", json={"patient_alias": "Synthetic capture"}, headers=headers("nurse")).json()
        template = Path(__file__).parents[3] / "fixtures/package-capture/two-photos.json"
        manifest = json.loads(template.read_text().replace("demo-two-photos", case["id"]))
        yield http, "/admissions/" + case["id"], manifest


def submit(http, path, command, originals=None, role="nurse"):
    files = [("command", (None, json.dumps(command), "application/json"))]
    for side, data in (originals or {}).items():
        files.append((side, ("private-test-filename.png", data, "image/png")))
    return http.post(path + "/capture", headers=headers(role), files=files)


def test_two_originals_across_review_sessions(session, caplog):
    http, path, manifest = session
    # Bind an existing known order via its ordinary single-item admission action.
    known = record("record-a", "prescription", "Synthetic A", name="Synthetic A")
    legacy = http.post(path + "/actions", headers=headers("nurse"), json={
        "revision": 1, "request_id": "legacy", "command": {"action": "add", "entry": known},
    })
    assert legacy.status_code == 200
    command = dict(revision=2, request_id="two-views", manifest=manifest, existing_rows={"order-a": "item-1"})
    originals = {"front": picture(6), "reverse": picture(1)}
    saved = submit(http, path, command, originals)
    assert saved.status_code == 200, saved.text
    state = saved.json()
    resumed = http.get(path, headers=headers("pharmacist"))
    assert resumed.json() == state and resumed.headers["cache-control"] == "no-store"
    assert len(state["capture_rows"]) == len(state["rows"]) == 4
    assert len({r["package_id"] for r in state["rows"].values()}) == 3
    assert not state["rows"]["item-1"]["unknown"]
    assert all(state["rows"][state["capture_rows"][i]]["unknown"] for i in ("pending-b-round", "pending-b-oval"))
    sources = {s["id"]: s for s in state["capture"]["sources"]}
    assert sources["clinic-a"]["organization"] != sources["clinic-c"]["organization"]
    assert sources["clinic-a"]["attachment_id"] == sources["clinic-c"]["attachment_id"]
    assert len(http.app.state.admissions.originals[manifest["case_id"]]) == 2
    assert 'private-test-filename' not in resumed.text
    assert '"data":' not in resumed.text
    for package in state["capture"]["packages"]:
        for item in package["items"]:
            for evidence in item["evidence"]:
                link = evidence["region"]
                view = manifest[link["side"]]
                bounds = next(r["bounds"] for r in view["regions"] if r["id"] == link["region_id"])
                original = ImageOps.exif_transpose(Image.open(BytesIO(originals[link["side"]])))
                w, h = original.size
                x, y = bounds["x"], bounds["y"]
                box = (round(x*w), round(y*h), round((x+bounds["width"])*w), round((y+bounds["height"])*h))
                crop = http.post(path + "/capture/region", json=link, headers=headers("pharmacist"))
                assert crop.headers["cache-control"] == "no-store"
                assert Image.open(BytesIO(crop.content)).tobytes() == original.crop(box).tobytes()
    added = deepcopy(manifest)
    added["front"]["regions"].append({"id": "new-crop", "bounds": {"x": 0, "y": 0, "width": .1, "height": .1}})
    added["sources"].append(dict(id="new-logical", kind="label_photo", attachment_id=manifest["front"]["attachment_id"]))
    extra = deepcopy(added["packages"][0]["items"][0])
    extra["row_id"] = "second-order-a"
    extra["evidence"] = [dict(extra["evidence"][0], item_id="new-evidence", source_id="new-logical")]
    added["packages"][0]["items"].append(extra)
    update = submit(http, path, dict(revision=3, request_id="metadata-only", manifest=added))
    assert update.status_code == 200, update.text
    assert len(update.json()["rows"]) == 5
    assert submit(http, path, command, originals).json() == update.json()
    assert submit(http, path, dict(command, request_id="stale"), originals).status_code == 409
    with caplog.at_level(logging.INFO, logger="uvicorn.access"):
        logging.getLogger("uvicorn.access").info('%s - "%s %s HTTP/%s" %d', "client", "POST", path + "/capture", "1.1", 200)
    assert not any(manifest["case_id"] in r.getMessage() or "private-test-filename" in r.getMessage()
                   for r in caplog.records if r.name != "httpx")


def test_capture_denies_foreign_or_missing_references_atomically(session):
    http, path, manifest = session
    command = dict(revision=1, request_id="capture", manifest=manifest)
    originals = {"front": picture(6), "reverse": picture(1)}
    assert submit(http, path, command, originals, role="doctor").status_code == 404
    assert submit(http, path, command, {"front": picture(1), "reverse": picture(1)}).status_code == 422
    assert submit(http, path, command, {"front": picture(6)}).status_code == 422
    assert http.get(path, headers=headers("nurse")).json()["revision"] == 1
    assert submit(http, path, command, originals).status_code == 200
    link = manifest["packages"][0]["front_regions"][0]
    region = path + "/capture/region"
    view = {k: link[k] for k in ("side", "revision", "attachment_id")}
    assert http.post(path + "/capture/view", headers=headers("pharmacist"), json=view).content == originals["front"]
    assert http.post(path + "/capture/view", headers=headers("doctor"), json=view).status_code == 404
    assert http.post(region, headers=headers("doctor"), json=link).status_code == 404
    for change in (dict(case_id="another-case"), dict(revision=99), dict(region_id="unknown")):
        assert http.post(region, headers=headers("nurse"), json=dict(link, **change)).status_code == 404
    foreign = deepcopy(manifest)
    foreign["packages"][0]["front_regions"][0]["case_id"] = "foreign"
    assert submit(http, path, dict(command, revision=2, request_id="foreign", manifest=foreign)).status_code == 422


def test_geometry_edits_use_new_revision_and_keep_original(session):
    http, path, manifest = session
    manifest["front"].pop("exif_orientation")
    command = dict(revision=1, request_id="initial", manifest=manifest)
    saved = submit(http, path, command, {"front": picture(6), "reverse": picture(1)})
    assert saved.status_code == 200 and saved.json()["capture"]["front"]["exif_orientation"] == 6
    prior = manifest["packages"][0]["front_regions"][0]
    manifest["front"]["regions"][0]["bounds"]["x"] = .1
    change = dict(revision=2, request_id="move", manifest=manifest)
    assert submit(http, path, change).status_code == 409
    manifest["front"]["revision"] = 2
    for package in manifest["packages"]:
        refs = package["front_regions"] + [e["region"] for item in package["items"] for e in item["evidence"]]
        for ref in refs:
            if ref["side"] == "front":
                ref["revision"] = 2
    revised = submit(http, path, change)
    assert revised.status_code == 200 and revised.json()["capture_rows"] == saved.json()["capture_rows"]
    assert http.post(path + "/capture/region", headers=headers("nurse"), json=dict(prior, revision=1)).status_code == 404
    assert http.post(path + "/capture/region", headers=headers("nurse"), json=prior).status_code == 200
