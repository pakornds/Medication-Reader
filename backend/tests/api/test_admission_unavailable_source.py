"""Outstanding record requests stay visible without becoming clinical evidence."""
import json
from copy import deepcopy
from pathlib import Path
from uuid import uuid4

from test_admission_package_capture import picture, submit
from test_admissions import Case, client, headers, photo, record


def missing_record():
    return {
        "id": "ward-list",
        "kind": "transfer_record",
        "organization": "Synthetic Hospital",
        "department_or_ward": "Demo ward",
        "availability": "unavailable",
        "unavailable_reason": "Records desk closed",
    }


def test_unavailable_request_shared_only_with_assigned_staff_and_replays_safely(client):
    case = Case(client, "nurse")
    source = missing_record()
    follow_up = "Request the ward list when the records desk reopens."
    case.send("record_unavailable_source", source=source, follow_up=follow_up)
    url = case.path + "/actions"
    payload = case.payload
    original = case.state

    pharmacist = client.get(case.path, headers=headers("pharmacist"))
    assert pharmacist.status_code == 200
    assert pharmacist.headers["cache-control"] == "no-store"
    saved = pharmacist.json()["unavailable_sources"]["ward-list"]
    assert {key: saved["source"][key] for key in source} == source
    assert saved["follow_up"] == follow_up
    assert pharmacist.json()["events"][-1]["sources"] == ["ward-list"]
    assert pharmacist.json()["rows"] == {}
    doctor = client.get(case.path, headers=headers("doctor"))
    assert doctor.status_code == 404
    assert "ward-list" not in doctor.text
    assert client.post(url, headers=headers("doctor"), json=payload).status_code == 404
    another = Case(client, "nurse")
    assert another.state["unavailable_sources"] == {}

    assert client.post(url, headers=headers("nurse"), json=payload).json() == original
    changed = deepcopy(payload)
    changed["command"]["follow_up"] = "Different follow-up on the same request."
    assert client.post(url, headers=headers("nurse"), json=changed).status_code == 409
    changed["request_id"] = str(uuid4())
    assert client.post(url, headers=headers("nurse"), json=changed).status_code == 409
    duplicate = case.send("record_unavailable_source", source=source, status=422)
    assert duplicate.json()["detail"] == "Use a new logical source ID."


def test_unavailable_source_cannot_support_review_and_eligible_row_can_import(client):
    case = Case(client, "nurse")
    source = missing_record()
    case.send("record_unavailable_source", source=source)
    case.send("add", entry={"source": source, "wording": "Unavailable list"}, status=422)
    case.send("add", entry=record("ward-list", "transfer_record", "Synthetic conflicting ID"), status=422)
    row = case.add(record("order", "prescription", "Demo A", name="Demo A"))
    renamed = source | {"id": "order"}
    case.send("record_unavailable_source", source=renamed, status=422)
    no_reason = source | {"id": "no-reason", "unavailable_reason": None}
    case.send("record_unavailable_source", source=no_reason, status=422)
    available = source | {"id": "available", "availability": "available", "unavailable_reason": None}
    case.send("record_unavailable_source", source=available, status=422)
    attached = source | {"id": "attached", "attachment_id": "a-file"}
    case.send("record_unavailable_source", source=attached, status=422)

    failure = case.send("interview", row_id=row, source_id="ward-list",
                        ownership="patient", current_use="current", status=422)
    assert failure.json()["detail"] == "Select an active source linked to this item."
    case.link(row, record("report", "patient_report", "Patient reports taking Demo A."))
    case.interview(row, "report")
    case.send("verify", row_id=row, source_id="report", identity_source_id="ward-list", status=422)
    case.send("verify", row_id=row, source_id="ward-list", status=422)
    case.send("import", role="pharmacist", row_ids=[row], status=422)

    case.send("verify", row_id=row, source_id="report")
    case.send("finish")
    case.send("import", role="pharmacist", row_ids=[row])
    receipt, = case.state["receipts"]
    assert receipt["imported_row_ids"] == [row]
    response = client.get("/imports", headers=headers("pharmacist"), params={"imported_at": receipt["imported_at"]})
    assert response.status_code == 200
    stored, = response.json()
    assert {source["id"] for source in stored["snapshot"]["evidence"]["sources"]} == {"order", "report"}
    assert "ward-list" in case.state["unavailable_sources"]


def test_capture_and_unavailable_sources_cannot_reuse_each_others_ids(client):
    fixture = Path(__file__).resolve().parents[3] / "fixtures/package-capture/two-photos.json"
    template = fixture.read_text()
    capture_source = json.loads(template)["sources"][0]["id"]
    unavailable = missing_record() | {"id": capture_source}
    images = {"front": picture(6), "reverse": picture(1)}

    def capture(case):
        manifest = json.loads(template.replace("demo-two-photos", case.state["id"]))
        command = {"revision": case.state["revision"], "request_id": str(uuid4()), "manifest": manifest}
        return submit(client, case.path, command, images)

    outstanding = Case(client, "nurse")
    outstanding.send("record_unavailable_source", source=unavailable)
    result = capture(outstanding)
    assert result.status_code == 422
    assert result.json()["detail"] == "Use a new logical source ID."

    photographed = Case(client, "nurse")
    result = capture(photographed)
    assert result.status_code == 200
    photographed.state = result.json()
    failure = photographed.send("record_unavailable_source", source=unavailable, status=422)
    assert failure.json()["detail"] == "Use a new logical source ID."

    manifest = deepcopy(photographed.state["capture"])
    manifest["sources"] = [source for source in manifest["sources"] if source["id"] != capture_source]
    for package in manifest["packages"]:
        for item in package["items"]:
            item["evidence"] = [item_source for item_source in item["evidence"]
                                if item_source["source_id"] != capture_source]
    command = {"revision": photographed.state["revision"], "request_id": str(uuid4()), "manifest": manifest}
    updated = submit(client, photographed.path, command)
    assert updated.status_code == 200, updated.text
    photographed.state = updated.json()
    failure = photographed.send("record_unavailable_source", source=unavailable, status=422)
    assert failure.json()["detail"] == "Use a new logical source ID."


def test_unavailable_reference_is_rejected_on_originally_unknown_item(client):
    case = Case(client, "pharmacist")
    case.send("record_unavailable_source", source=missing_record())
    row = case.add(photo("unmarked", "Demo bag", "unmarked tablet"))
    failed = case.send("propose", row_id=row, name="Demo A", reference="ward-list", status=422)
    assert failed.json()["detail"] == "An unavailable source cannot support identity."
    assert case.state["rows"][row]["proposal"] is None
    case.link(row, record("confirmed", "reviewer_record", "Dispensing staff matched the number on Demo bag to Demo A.",
                          name="Demo A", identity_basis="dispensing_confirmation"))
    case.send("decide", row_id=row, source_id="confirmed", name="Demo A", outcome="confirm",
              finding="Checked the documented dispensing number for Demo A.")
    case.link(row, record("account", "patient_report", "Patient reports taking Demo A."))
    case.interview(row, "account")
    failed = case.send("verify", row_id=row, source_id="account", identity_source_id="ward-list", status=422)
    assert failed.json()["detail"] == "An unavailable source cannot support identity."
    case.send("verify", row_id=row, source_id="account")
    assert case.state["rows"][row]["verified"]["identity"]["source_id"] == "confirmed"
