"""Scanned observations round-trip through the registered encounter and receipt APIs."""

from test_admissions import Case, client, headers, photo, record


def scanned_label(source_id, amount, *, scanned_dose="1 tablet", reviewed_dose="1 tablet", **fields):
    entry = photo(source_id, "synthetic bag A", name="Demo Tablet")
    entry["source"].update(kind="label_photo", attachment_id=f"upload-{source_id}")
    selected = {"source_id": source_id, "item_id": "selected"}
    entry.update(
        wording=f"Demo Tablet | {amount} dispensed | {reviewed_dose} | smudged expiry",
        dose=reviewed_dose,
        scan_fields={
            "amount_prescribed": {"status": "readable", "value": amount, "evidence": selected},
            "dose": {"status": "readable", "value": scanned_dose, "evidence": selected},
            "expiry": {"status": "unreadable", "evidence": selected},
            "prescriber_contact": {"status": "missing"},
            **fields,
        },
    )
    return entry


def prepare_review(case, row):
    case.link(row, record("interview", "patient_report", "Reports one tablet by mouth each morning"))
    case.interview(row, "interview", dose="1 tablet", schedule="each morning")


def import_snapshot(case, row):
    case.send("import", role="pharmacist", row_ids=[row])
    receipt = case.state["receipts"][0]
    assert receipt["imported_row_ids"] == [row]
    result = case.http.get("/imports", headers=headers("pharmacist"), params={"imported_at": receipt["imported_at"]})
    assert result.status_code == 200, result.text
    stored, = result.json()
    return stored["snapshot"]


def test_scan_statuses_and_quantities_keep_original_item_link(client):
    case = Case(client, "nurse")
    row = case.add(scanned_label("front", "21 tablets"))
    prepare_review(case, row)
    case.send("verify", row_id=row, source_id="interview")
    snapshot = import_snapshot(case, row)
    saved, = snapshot["rows"]
    citation = {"source_id": "front", "item_id": row}
    assert saved["label_fields"]["amount_prescribed"] == {
        "status": "readable", "value": "21 tablets", "evidence": citation,
    }
    assert saved["label_fields"]["dose"] == {"status": "readable", "value": "1 tablet", "evidence": citation}
    assert saved["label_fields"]["expiry"] == {"status": "unreadable", "value": None, "evidence": citation}
    assert saved["label_fields"]["prescriber_contact"] == {"status": "missing", "value": None, "evidence": citation}
    assert saved["verification"]["dose"]["value"] == "1 tablet"
    assert saved["verification"]["dose"]["evidence"]["source_id"] == "interview"
    assert next(s for s in snapshot["evidence"]["sources"] if s["id"] == "front")["attachment_id"] == "upload-front"
    assert {"id": row, "source_id": "front", "row_id": row, "kind": "label_region"} in snapshot["evidence"]["items"]


def test_retake_and_review_correction_replace_stale_scan_values(client):
    case = Case(client, "nurse")
    row = case.add(scanned_label("original", "21 tablets"))
    retake = scanned_label("retake", "14 tablets", scanned_dose="2 tablets", directions={
        "status": "readable",
        "value": "twice daily",
        "evidence": {"source_id": "retake", "item_id": "selected"},
    })
    case.link(row, retake, replaces="original")
    prepare_review(case, row)
    case.send("verify", row_id=row, source_id="interview", identity_source_id="retake",
              resolution="Read the retaken package and corrected the scan dose to 1 tablet")
    snapshot = import_snapshot(case, row)
    saved, = snapshot["rows"]
    citation = {"source_id": "retake", "item_id": row}
    assert saved["label_fields"]["amount_prescribed"] == {
        "status": "readable", "value": "14 tablets", "evidence": citation,
    }
    assert saved["label_fields"]["dose"] == {"status": "readable", "value": "1 tablet", "evidence": citation}
    assert saved["label_fields"]["directions"] == {"status": "missing", "value": None, "evidence": citation}
    assert "route" not in saved["label_fields"]
    assert all(regimen["basis"] != "documented" for regimen in saved["regimens"])
    assert {source["id"] for source in snapshot["evidence"]["sources"]} == {"retake", "interview"}
    assert {item["source_id"] for item in snapshot["evidence"]["items"]} == {"retake", "interview"}


def test_conflicting_quantities_keep_each_active_source_without_selecting_a_value(client):
    case = Case(client, "nurse")
    row = case.add(scanned_label("first", "21 tablets"))
    case.link(row, scanned_label("second", "14 tablets"))
    prepare_review(case, row)
    case.send("verify", row_id=row, source_id="interview", status=422)
    case.send("verify", row_id=row, source_id="interview",
              resolution="Active scans disagree about the dispensed quantity. Leave the quantity unresolved.")
    snapshot = import_snapshot(case, row)
    saved, = snapshot["rows"]
    assert "amount_prescribed" not in saved["label_fields"]
    conflict, = saved["discrepancies"]
    assert conflict["field"] == "amount_prescribed"
    assert conflict["observed_values"] == [
        {"value": "21 tablets", "evidence": {"source_id": "first", "item_id": row}},
        {"value": "14 tablets", "evidence": {"source_id": "second", "item_id": row}},
    ]

