"""A reported name remains a hypothesis when an unidentified physical item is linked."""
import json
from base64 import b64encode
from pathlib import Path

import pytest

from test_admission_package_capture import picture, submit
from test_admissions import Case, client, headers, photo, record


@pytest.fixture
def report():
    return record("account", "patient_report", "I think this tablet is Demo A", name="Demo A")


def check_unresolved(case, row):
    saved = case.state["rows"][row]
    account = next(entry for entry in saved["entries"] if entry["source"]["id"] == "account")
    assert account["wording"] == "I think this tablet is Demo A"
    assert account["source"]["kind"] == "patient_report"
    assert saved["interview"]["source_id"] == "account"
    assert saved["unknown"] and not saved["confirmed"] and not saved["verified"]
    assert saved["proposal"]["name"] == "Demo A" and saved["proposal"]["reference"] == "account"
    response = case.send("verify", row_id=row, source_id="account", status=422)
    assert response.json()["detail"] == "Identity requires pharmacist review."
    response = case.send("import", role="pharmacist", row_ids=[row], status=422)
    assert response.json()["detail"] == "Select verified rows with a resolved identity."
    assert not case.state["receipts"]


def confirm_and_read_back(case, row):
    case.send("refer", row_ids=[row], checked="Unmarked tablet and reported name",
              reason="Confirm which item the patient brought")
    case.role = "pharmacist"
    case.link(row, record("dispensing", "reviewer_record",
                          "Dispensing pharmacy matched the unique number on this bag to Demo A.",
                          name="Demo A", identity_basis="dispensing_confirmation"))
    case.send("decide", row_id=row, outcome="confirm", source_id="dispensing", name="Demo A",
              finding="Verified dispensing number for this bag")
    case.send("verify", row_id=row, source_id="account")
    case.send("import", row_ids=[row])
    stamp = case.state["receipts"][0]["imported_at"]
    response = case.http.get("/imports", headers=headers("pharmacist"), params={"imported_at": stamp})
    assert response.status_code == 200
    saved, = response.json()[0]["snapshot"]["rows"]
    assert saved["identity_status"] == "unlabeled"
    assert saved["verification"]["identity"]["value"] == "Demo A"
    assert saved["verification"]["identity"]["evidence"]["source_id"] == "dispensing"
    assert saved["reported_use"][0]["value"] == "I think this tablet is Demo A"
    assert saved["reported_use"][0]["evidence"]["source_id"] == "account"


@pytest.mark.parametrize("report_first", [True, False], ids=["report-first", "photo-first"])
def test_report_and_unmarked_crop_have_same_result_in_either_order(client, report, report_first):
    case = Case(client, "nurse")
    crop = photo("unmarked", "bag A", "unmarked tablet")
    if report_first:
        row = case.add(report)
        case.interview(row, "account")
        case.send("verify", row_id=row, source_id="account")
        case.link(row, crop)
    else:
        row = case.add(crop)
        case.link(row, report)
        case.interview(row, "account")

    check_unresolved(case, row)
    duplicate = photo("another-region", "bag A", name="Demo A")
    duplicate.update(wording="Second crop of the same image marked Demo A",
                     identity_basis="matched_original_package")
    duplicate["photo"]["region"] = [.5, .2, .5, .5]
    case.link(row, duplicate)
    case.send("decide", role="pharmacist", row_id=row, outcome="confirm", source_id="another-region",
              name="Demo A", finding="Reused the same original", status=422)
    confirm_and_read_back(case, row)


@pytest.mark.parametrize("report_first", [True, False], ids=["report-first", "capture-first"])
def test_report_and_shared_capture_appearance_have_same_result(client, report, report_first):
    case = Case(client, "nurse")
    pending = "pending-b-round"
    if report_first:
        row = case.add(report)
        case.interview(row, "account")
        case.send("verify", row_id=row, source_id="account")
    fixture = Path(__file__).resolve().parents[3] / "fixtures/package-capture/two-photos.json"
    manifest = json.loads(fixture.read_text().replace("demo-two-photos", case.state["id"]))
    command = dict(revision=case.state["revision"], request_id="capture", manifest=manifest,
                   existing_rows={pending: row} if report_first else {})
    saved = submit(client, case.path, command, {"front": picture(6), "reverse": picture(1)})
    assert saved.status_code == 200, saved.text
    case.state = saved.json()
    if not report_first:
        row = case.state["capture_rows"][pending]
        case.link(row, report)
        case.interview(row, "account")

    check_unresolved(case, row)
    duplicate = photo("capture-crop", "bag B", name="Demo A")
    duplicate.update(wording="Another crop of the table photo showing Demo A",
                     identity_basis="matched_original_package")
    duplicate["source"]["attachment_id"] = manifest["front"]["attachment_id"]
    case.link(row, duplicate)
    case.send("decide", role="pharmacist", row_id=row, outcome="confirm", source_id="capture-crop",
              name="Demo A", finding="Reused the same table photo", status=422)

    reupload = photo("reuploaded-original", "bag B", name="Demo A")
    reupload.update(wording="Reuploaded original claimed to show Demo A",
                    identity_basis="matched_original_package")
    reupload["photo"]["data"] = b64encode(picture(6)).decode()
    case.link(row, reupload)
    case.send("decide", role="pharmacist", row_id=row, outcome="confirm", source_id="reuploaded-original",
              name="Demo A", finding="Reuploaded the same table photo", status=422)
    confirm_and_read_back(case, row)


@pytest.mark.parametrize("add_label", [False, True], ids=["report-only", "readable-package"])
def test_report_history_and_readable_original_package_can_still_be_verified(client, report, add_label):
    case = Case(client, "nurse")
    row = case.add(report)
    source = "account"
    if add_label:
        source = "original"
        label = photo(source, "original carton", name="Demo A")
        label["source"]["kind"] = "label_photo"
        case.link(row, label)
        case.link(row, photo("reverse-appearance", "original carton", "tablet visible through package"))
    case.interview(row, "account")
    case.send("verify", row_id=row, source_id="account")
    saved = case.state["rows"][row]
    assert not saved["unknown"]
    assert saved["verified"]["identity"]["source_id"] == source
    case.send("finish")
