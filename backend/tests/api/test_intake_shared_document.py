"""The ordinary intake and clinical review share the same verbatim case document."""
from copy import deepcopy
from uuid import uuid4

from test_admission_intake import observation, submission, submit
from test_admissions import client, headers


FULL_TEXT = "Transfer list\nDemo Amber 5 mg each morning\nDemo Slate 5 mg each evening"
SOURCE = {"id": "ward-list", "kind": "transfer_record", "department_or_ward": "Synthetic ward"}


def documented(row_id, name, directions):
    ref = {"source_id": SOURCE["id"]}
    return {
        "row": {"id": row_id, "identity_status": "named", "sources": [ref],
                "observed_names": [{"value": name, "evidence": ref}],
                "label_fields": {"strength": observation("5 mg", ref), "directions": observation(directions, ref)}},
        "origin": "analysis", "sources": [SOURCE], "notes": {SOURCE["id"]: FULL_TEXT},
        "document_excerpts": {SOURCE["id"]: name + " 5 mg " + directions},
        "items": [], "regions": {}, "physical_items": {},
    }


def clinical(client, case, command):
    response = client.post("/admissions/" + case["id"] + "/actions", headers=headers("nurse"), json={
        "revision": case["revision"], "request_id": str(uuid4()), "command": command,
    })
    assert response.status_code == 200, response.text
    return response.json()


def test_register_once_and_reuse_in_clinical_review(client):
    amber = documented("amber", "Demo Amber", "each morning")
    slate = documented("slate", "Demo Slate", "each evening")
    request = submission(amber)
    first = submit(client, request)
    assert first["documents"]["ward-list"]["wording"] == FULL_TEXT
    assert first["rows"]["amber"]["entries"][0]["wording"] == FULL_TEXT.splitlines()[1]

    updated = {**request, "revision": first["revision"], "rows": [amber, slate]}
    saved = submit(client, updated)
    assert submit(client, updated) == saved
    for rid, line in zip(("amber", "slate"), FULL_TEXT.splitlines()[1:], strict=True):
        entry, = saved["rows"][rid]["entries"]
        assert entry["source"]["id"] == "ward-list" and entry["wording"] == line
    case = clinical(client, saved, {"action": "add", "entry": {
        "case_id": saved["id"], "source_id": "ward-list", "wording": "Demo Slate 5 mg each evening", "name": "Demo Slate",
    }})
    assert case["rows"]["item-3"]["entries"][0]["source"]["department_or_ward"] == "Synthetic ward"
    assert list(case["documents"]) == ["ward-list"]
    revised = deepcopy(updated)
    revised["revision"] = case["revision"]
    for row in revised["rows"]:
        row["notes"]["ward-list"] = FULL_TEXT.replace("5 mg", "15 mg")
    submit(client, revised, 409)
    assert client.get("/admissions/" + case["id"], headers=headers("nurse")).json() == case


def test_ambiguous_excerpt_fails_atomically(client):
    amber = documented("amber", "Demo Amber", "each morning")
    slate = documented("slate", "Demo Slate", "each evening")
    for row in (amber, slate):
        row["notes"]["ward-list"] = "Demo Amber 5 mg each morning or Demo Slate 5 mg each evening"
        row["document_excerpts"] = {}
    request = submission(amber, slate)
    error = submit(client, request, 422)
    assert "Select a verbatim excerpt" in error["detail"]
    assert client.get("/admissions", headers=headers("nurse")).json() == []
    for row in (amber, slate):
        row["document_excerpts"] = {"ward-list": row["notes"]["ward-list"]}
    assert "separately" in submit(client, request, 422)["detail"]
    amber["document_excerpts"]["ward-list"] = "Demo Amber 5 mg each morning"
    slate["document_excerpts"]["ward-list"] = "Demo Slate 5 mg each evening"
    assert len(submit(client, request)["rows"]) == 2


def test_overlapping_names_and_previously_registered_document(client):
    request = submission()
    case = submit(client, request)
    full_text = "Demo Amber 5 mg each morning\nDemo Amber XR 5 mg each evening"
    case = clinical(client, case, {"action": "register_document", "source": SOURCE, "wording": full_text})
    rows = [documented("amber", "Demo Amber", "each morning"), documented("xr", "Demo Amber XR", "each evening")]
    for row in rows:
        row["notes"]["ward-list"] = full_text
    updated = submit(client, {**request, "rows": rows, "revision": case["revision"]})
    assert updated["rows"]["xr"]["entries"][0]["wording"] == full_text.splitlines()[1]
    assert list(updated["documents"]) == ["ward-list"]


def test_document_without_original_wording_rejects_the_entire_intake(client):
    row = documented("amber", "Demo Amber", "each morning")
    row["notes"].clear()
    assert "original wording" in submit(client, submission(row), 422)["detail"]
    assert client.get("/admissions", headers=headers("nurse")).json() == []
