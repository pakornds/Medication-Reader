"""Continue an intake case through ordinary evidence and package-capture commands."""
import json
from base64 import b64encode
from pathlib import Path
from uuid import uuid4

import pytest

from test_admission_intake import submission, submit
from test_admission_package_capture import picture, submit as submit_capture
from test_admissions import client, headers, photo, record


def send(http, case, command):
    response = http.post(f"/admissions/{case['id']}/actions", headers=headers("nurse"), json={
        "revision": case["revision"], "request_id": str(uuid4()), "command": command})
    assert response.status_code == 200, response.text
    return response.json()


def reported_medicine():
    source = {"source_id": "account"}
    return dict(row=dict(id="item-2", identity_status="named", sources=[source],
                         observed_names=[dict(value="Demo A", evidence=source)]),
                origin="manual", sources=[dict(id="account", kind="patient_report")],
                items=[], notes={"account": "I think this medicine is Demo A"}, regions={}, physical_items={})


@pytest.mark.parametrize("via_capture", [False, True], ids=["ordinary-source", "shared-capture"])
def test_reported_intake_name_becomes_proposal_and_new_rows_keep_distinct_ids(client, via_capture):
    case = submit(client, submission(reported_medicine()))
    if via_capture:
        fixture = Path(__file__).resolve().parents[3] / "fixtures/package-capture/two-photos.json"
        manifest = json.loads(fixture.read_text().replace("demo-two-photos", case["id"]))
        response = submit_capture(client, "/admissions/" + case["id"], dict(
            revision=case["revision"], request_id="capture", manifest=manifest,
            existing_rows={"pending-b-round": "item-2"}), {"front": picture(6), "reverse": picture(1)})
        assert response.status_code == 200, response.text
        saved = response.json()
        assert len(set(saved["capture_rows"].values())) == len(saved["capture_rows"]) > 1
    else:
        case = send(client, case, dict(action="add", entry=record("rx", "prescription", "Demo B", name="Demo B")))
        assert set(case["rows"]) == {"item-2", "item-3"}
        saved = send(client, case, dict(action="link", row_id="item-2", confirmed=True,
                                        entry=photo("unmarked", "bag", "unmarked tablet")))
    row = saved["rows"]["item-2"]
    assert row["entries"][0]["source"]["id"] == "account" and row["unknown"]
    assert row["proposal"]["proposer"] == "demo-nurse" and row["proposal"]["name"] == "Demo A"


def test_unpaired_original_allows_next_independent_photo_without_a_capture_manifest(client):
    ref = {"source_id": "unmarked", "item_id": "crop"}
    medicine = dict(row=dict(id="loose", identity_status="unlabeled", unknown_label="Loose tablet", sources=[ref]),
                    origin="analysis", sources=[dict(id="unmarked", kind="reverse_photo", attachment_id="original")],
                    items=[dict(id="crop", source_id="unmarked", row_id="loose", kind="pill_crop")],
                    notes={}, regions={"crop": dict(x=0, y=0, width=.5, height=1)}, physical_items={"crop": "bag"})
    payload = submission(medicine)
    payload["originals"] = {"original": dict(media_type="image/png", data=b64encode(picture(1)).decode())}
    case = submit(client, payload)
    assert "capture" not in case
    updated = send(client, case, dict(action="link", row_id="loose", confirmed=True,
                                      entry=photo("different-evidence", "bag", "new photo of tablet")))
    assert len(updated["rows"]["loose"]["entries"]) == 2
    assert updated["rows"]["loose"]["unknown"] and not updated["rows"]["loose"]["confirmed"]
