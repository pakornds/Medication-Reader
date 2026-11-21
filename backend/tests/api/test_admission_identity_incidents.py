"""Named physical-identity disputes in the admission API."""

import base64
from copy import deepcopy
from datetime import datetime
from io import BytesIO

import pytest
from PIL import Image, ImageDraw

from test_admissions import Case, client, headers, photo, record


def disputed_case(client, role):
    case = Case(client, role)
    bag = photo("bag-label", "Bag A", name="Demo Amber")
    bag["source"].update(kind="label_photo", attachment_id="bag-image")
    row_id = case.add(bag)
    case.link(row_id, record(
        "transfer", "transfer_record", "Bag A was listed as Demo Slate", name="Demo Slate",
    ))
    case.link(row_id, record("account", "patient_report", "Patient reports using the tablet from Bag A"))
    case.interview(row_id, "account")
    return case, row_id, bag


def verify(case, row_id, identity_source_id, status=200):
    return case.send(
        "verify", row_id=row_id, source_id="account", identity_source_id=identity_source_id,
        resolution="Reviewed the evidence for the physical item in Bag A.", status=status,
    )


def confirm_from_dispensing_record(case, row_id):
    case.link(row_id, record(
        "dispensing", "reviewer_record",
        "Demo pharmacy confirmed dispensing number A-001 on Bag A contains Demo Slate.",
        name="Demo Slate", identity_basis="dispensing_confirmation",
    ))
    return verify(case, row_id, "dispensing")


@pytest.mark.parametrize("role", ["nurse", "doctor", "pharmacist"])
def test_named_dispute_requires_independent_item_evidence(client, role):
    case, row_id, bag = disputed_case(client, role)
    for unsupported in ("bag-label", "transfer"):
        assert verify(case, row_id, unsupported, 422).json()["detail"] == (
            "Cite separate item-specific documentation to resolve the disputed identity."
        )
    case.send("finish", status=422)

    retry_crop = deepcopy(bag)
    retry_crop["source"]["id"] = "second-crop"
    retry_crop["photo"]["region"] = [0.5, 0.1, 0.5, 0.5]
    retry_crop.update(
        wording="Demo Amber read again from Bag A.",
        identity_basis="matched_original_package",
    )
    case.link(row_id, retry_crop)
    verify(case, row_id, "second-crop", 422)

    case.link(row_id, record(
        "reported-name", "patient_report", "Patient thinks Bag A is Demo Slate.", name="Demo Slate",
    ))
    verify(case, row_id, "reported-name", 422)
    assert case.state["rows"][row_id]["verified"] is None
    assert case.state["identity_incidents"] == {}

    confirm_from_dispensing_record(case, row_id)
    incident, = case.state["identity_incidents"].values()
    assert incident["encounter_id"] == case.state["id"]
    assert incident["row_id"] == row_id
    assert {entry["source_id"] for entry in incident["conflicting_sources"]} == {
        "bag-label", "transfer", "second-crop", "reported-name",
    }
    assert incident["corroborating_source_id"] == "dispensing"
    assert incident["identity"] == "Demo Slate"
    assert incident["decision"] == "corrected"
    assert incident["reviewer"]["role"] == role
    assert datetime.fromisoformat(incident["recorded_at"]).utcoffset() is not None
    assert case.state["rows"][row_id]["verified"]["identity"] == {
        "name": "Demo Slate", "source_id": "dispensing",
    }

    retry = client.post(case.path + "/actions", json=case.payload, headers=headers(role))
    assert retry.status_code == 200
    assert retry.json()["identity_incidents"] == case.state["identity_incidents"]
    verify(case, row_id, "dispensing")
    assert case.state["identity_incidents"] == retry.json()["identity_incidents"]


def test_pharmacy_can_append_incident_assessment_after_finish(client):
    case, row_id, _ = disputed_case(client, "nurse")
    confirm_from_dispensing_record(case, row_id)
    incident_id, = case.state["identity_incidents"]
    original = deepcopy(case.state["identity_incidents"][incident_id])

    case.send("finish")
    assert case.state["status"] == "Finished"
    frozen_rows = deepcopy(case.state["rows"])
    command = {
        "incident_id": incident_id,
        "outcome": "confirmed_medication_error",
        "assessment": "Pharmacy checked synthetic dispensing number A-001.",
    }
    case.send("assess_identity_incident", status=403, **command)
    response = client.get(case.path, headers=headers("pharmacist"))
    assert response.status_code == 200
    assert response.headers["cache-control"] == "no-store"
    assert response.json()["identity_incidents"][incident_id] == original

    unsolicited = client.get(case.path, headers=headers("doctor"))
    assert unsolicited.status_code == 404
    other, other_row, _ = disputed_case(client, "pharmacist")
    confirm_from_dispensing_record(other, other_row)
    other.send("assess_identity_incident", status=404, **command)
    case.send("assess_identity_incident", role="pharmacist", **command)
    assert case.state["status"] == "Finished"
    assert case.state["rows"] == frozen_rows
    actual = case.state["identity_incidents"][incident_id]
    assert all(actual[field] == value for field, value in original.items() if field != "pharmacy_assessments")
    assessment, = actual["pharmacy_assessments"]
    assert assessment["outcome"] == "confirmed_medication_error"
    assert assessment["recorder"]["id"] == "demo-pharmacist"
    assert datetime.fromisoformat(assessment["recorded_at"]).utcoffset() is not None
    retry = client.post(case.path + "/actions", json=case.payload, headers=headers("pharmacist"))
    assert retry.status_code == 200
    assert retry.json()["identity_incidents"][incident_id] == actual
    changed = deepcopy(case.payload)
    changed["command"]["assessment"] = "Different assessment"
    assert client.post(case.path + "/actions", json=changed, headers=headers("pharmacist")).status_code == 409

def test_superseded_corroboration_keeps_history_and_cannot_verify_again(client):
    case, row_id, _ = disputed_case(client, "doctor")

    def labeled_photo(source_id, attachment, shade):
        entry = photo(source_id, "Bag A", name="Demo Slate")
        entry["source"].update(kind="label_photo", attachment_id=attachment)
        image = Image.new("RGB", (90, 50), shade)
        ImageDraw.Draw(image).text((3, 3), "DEMO SLATE", fill="black")
        output = BytesIO()
        image.save(output, format="PNG")
        entry["photo"]["data"] = base64.b64encode(output.getvalue()).decode()
        return entry

    proof = labeled_photo("matched-package", "independent-photo", "white")
    proof.update(wording="Original matched package A-001 identifies Demo Slate.",
                 identity_basis="matched_original_package")
    case.link(row_id, proof)
    verify(case, row_id, "matched-package")
    original = deepcopy(case.state["identity_incidents"])

    replacement = labeled_photo("replacement", "retake-photo", "lightgray")
    case.link(row_id, replacement, replaces="matched-package")
    verify(case, row_id, "matched-package", 422)
    verify(case, row_id, "replacement", 422)
    assert case.state["rows"][row_id]["verified"] is None
    assert case.state["identity_incidents"] == original


def test_reported_name_cannot_resolve_a_named_package_dispute(client):
    case = Case(client, "nurse")
    bag = photo("bag-label", "Bag A", name="Demo Amber")
    bag["source"]["kind"] = "label_photo"
    row_id = case.add(bag)
    case.link(row_id, record(
        "account", "patient_report", "I think the tablet in Bag A is Demo Slate.", name="Demo Slate",
    ))
    case.interview(row_id, "account")
    verify(case, row_id, "account", 422)
    verify(case, row_id, "bag-label", 422)
    assert case.state["rows"][row_id]["verified"] is None
