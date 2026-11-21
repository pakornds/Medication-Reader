"""One transfer document can supply distinct row-linked evidence through the admission API."""

from test_admission_regimens import component
from test_admissions import Case, client, headers, record
from test_local_screening import refs


WARD = {"id": "W1", "kind": "transfer_record", "organization": "Demo Hospital",
        "department_or_ward": "Transfer ward"}
LINES = ("1. Demo Amber, recorded interview: 1 tablet by mouth each morning.",
         "2. Demo Slate, recorded interview: 2 tablets by mouth each evening.")


def register(case, source=WARD):
    case.send("register_document", source=source, wording="\n".join(LINES))


def excerpt(case, index):
    return {"case_id": case.state["id"], "source_id": "W1", "wording": LINES[index],
            "name": ("Demo Amber", "Demo Slate")[index], "record_basis": "documented_interview"}


def test_second_session_imports_two_row_specific_excerpts(client):
    case = Case(client, "nurse")
    register(case)
    first = case.add(excerpt(case, 0))
    second = case.add(record("order", "prescription", "Demo Slate", name="Demo Slate"))
    case.link(second, excerpt(case, 1))
    register(case, WARD | {"id": "W2"})
    for row_id in (first, second):
        case.interview(row_id, "W1")
        case.send("verify", row_id=row_id, source_id="W1", identity_source_id="W1")

    case.role = "pharmacist"
    case.state = client.get(case.path, headers=headers(case.role)).json()
    assert set(case.state["documents"]) == {"W1", "W2", "order"}
    for row_id, line in zip((first, second), LINES, strict=True):
        assigned = [e for e in case.state["rows"][row_id]["entries"] if e["source"]["id"] == "W1"]
        assert [e["wording"] for e in assigned] == [line]
    case.send("import", row_ids=[first, second])
    receipt, = case.state["receipts"]
    assert receipt["imported_row_ids"] == [first, second]
    readback = client.get("/imports", headers=headers(case.role), params={"imported_at": receipt["imported_at"]})
    assert readback.status_code == 200
    snapshot = readback.json()[0]["snapshot"]
    assert [s["id"] for s in snapshot["evidence"]["sources"]] == ["W1", "order"]
    assert {i["row_id"]: i["excerpt"] for i in snapshot["evidence"]["items"] if i["source_id"] == "W1"} == {
        first: LINES[0], second: LINES[1],
    }
    for row in snapshot["rows"]:
        citation = {"source_id": "W1", "item_id": row["id"]}
        assert row["verification"]["identity"]["evidence"] == citation
        assert row["verification"]["dose"]["evidence"] == citation


def test_registration_and_references_remain_encounter_local_and_grounded(client):
    case = Case(client, "nurse")
    other = Case(client, "nurse")
    register(case)
    row = case.add(excerpt(case, 0))
    valid = excerpt(case, 1)
    other.send("add", entry=valid, status=422)
    register(other)  # Same logical ID in another encounter must not make the reference portable.
    other.send("add", entry=valid, status=422)
    case.send("register_document", source=WARD | {"organization": "Another ward"}, wording=LINES[1], status=422)
    case.send("add", entry=valid | {"source_id": "unknown"}, status=422)
    case.send("add", entry=valid | {"wording": "Demo Slate fabricated line"}, status=422)
    case.send("add", entry=valid | {"name": "Demo Amber"}, status=422)
    case.send("link", confirmed=True, row_id=row, entry=valid, status=422)
    inline = {"source": WARD, "wording": LINES[1], "name": "Demo Slate"}
    case.send("add", entry=inline | {"source": WARD | {"department_or_ward": "Wrong ward"}}, status=422)
    case.send("add", entry=inline | {"wording": "Demo Slate unsupported inline wording."}, status=422)
    assert client.get(case.path, headers=headers(case.role)).json() == case.state
    case.add(inline)


def test_existing_inline_entries_can_share_document_metadata(client):
    case = Case(client, "doctor")
    first = case.add({"source": WARD, "wording": LINES[0], "name": "Demo Amber"})
    second = case.add({"source": WARD, "wording": LINES[1], "name": "Demo Slate"})
    assert case.state["rows"][first]["entries"][0]["wording"] == LINES[0]
    assert case.state["rows"][second]["entries"][0]["wording"] == LINES[1]
    case.add(excerpt(case, 1))
    case.send("add", entry=excerpt(case, 0) | {"wording": "Demo Amber in a new invented line"}, status=422)
    case.send("add", entry={"source": WARD | {"organization": "Another hospital"}, "wording": LINES[0]}, status=422)
    case.add(record("R", "patient_report", "Synthetic interview"))
    case.send("add", entry=record("R", "patient_report", "Another report"), status=422)


def test_optional_screening_accepts_both_rows_of_one_document(client, refs):
    case = Case(client, "doctor")
    register(case)
    for index in range(2):
        row = case.add(excerpt(case, index))
        case.interview(row, "W1")
        timing = ("morning", "evening")[index]
        regimen = component(row, "W1", index + 1, timing)
        regimen["evidence"]["dose_amount"] = {"source_id": "W1"}
        case.send("verify", row_id=row, source_id="W1", regimens=[regimen])
        saved, = case.state["rows"][row]["verified"]["regimens"]
        assert saved["evidence"]["dose_amount"] == {"source_id": "W1", "item_id": row}
    case.send("verify", row_id="item-2", source_id="W1", regimens=[component("item-1", "W1", 1, "morning")],
              status=422)
    target = {"case_id": case.state["id"], "admission_revision": case.state["revision"]}
    for path, payload in (("/checks", target | {"kind": "DDI"}), ("/checks/local", target)):
        response = client.post(path, headers=headers(case.role), json=payload)
        assert response.status_code == 200, response.text
    case.send("import", role="pharmacist", row_ids=["item-1", "item-2"])
    receipt, = case.state["receipts"]
    stored, = client.get("/imports", headers=headers("pharmacist"), params={"imported_at": receipt["imported_at"]}).json()
    for row in stored["snapshot"]["rows"]:
        regimen, = row["verification"]["regimens"]
        assert regimen["evidence"]["dose_amount"] == {"source_id": "W1", "item_id": row["id"]}


def test_registered_document_and_unavailable_followup_reserve_distinct_ids(client):
    case = Case(client, "nurse")
    pending = WARD | {"availability": "unavailable", "unavailable_reason": "Awaiting ward response"}
    register(case)
    case.send("record_unavailable_source", source=pending, status=422)
    case.send("record_unavailable_source", source=pending | {"id": "W2"})
    case.send("register_document", source=WARD | {"id": "W2"}, wording=LINES[0], status=422)
    case.send("add", entry=excerpt(case, 0) | {"source_id": "W2"}, status=422)
