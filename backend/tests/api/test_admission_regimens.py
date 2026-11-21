"""Clinician-verified components through the assigned encounter and hospital receipt APIs."""
from copy import deepcopy

import pytest

from test_admissions import Case, client, headers, photo, record


def component(row, source_id, amount, timing):
    fields = dict(directions_text=f"{amount} {'tablet' if amount == 1 else 'tablets'} by mouth each {timing}", dose_amount=amount,
                  dose_unit="tablet", route="oral", schedule_type="frequency", frequency_count=1,
                  period_value=1, period_unit="day", time_of_day=[timing])
    return dict(component_id=timing, basis="verified", parse_status="complete", **fields,
                evidence={field: {"source_id": source_id, "item_id": row} for field in fields})


def prepare(case):
    row = case.add(record("ward", "prescription", "Demo tablets by mouth: 1 tablet each morning", name="Demo",
                          directions="1 tablet each morning"))
    case.link(row, record("patient", "patient_report", "2 tablets by mouth each evening"))
    case.interview(row, "patient", dose=None, schedule=None, route=None)
    return row


def test_components_survive_handoff_and_selected_import(client):
    case = Case(client, "doctor")
    row = prepare(case)
    components = [component(row, "ward", 1, "morning"), component(row, "patient", 2, "evening")]
    components[1]["evidence"]["route"] = {"source_id": "ward", "item_id": row}
    case.send("verify", row_id=row, source_id="patient", regimens=components)
    seen = client.get(case.path, headers=headers("pharmacist")).json()["rows"][row]["verified"]
    assert seen["actor"]["role"] == "doctor"
    for actual, submitted in zip(seen["regimens"], components, strict=True):
        assert {key: actual[key] for key in submitted} == submitted
    case.send("import", row_ids=[row], status=403)
    case.send("import", role="pharmacist", row_ids=[row])
    receipt, = case.state["receipts"]
    records = client.get("/imports", headers=headers("pharmacist"), params={"imported_at": receipt["imported_at"]})
    saved, = records.json()[0]["snapshot"]["rows"]
    assert saved["verification"]["regimens"] == seen["regimens"]
    assert all(saved["verification"][field] is None for field in ("dose", "route", "frequency"))
    assert {(r["basis"], r["directions_text"]) for r in saved["regimens"]} == {
        ("documented", "1 tablet each morning"), ("reported", "2 tablets by mouth each evening")}

    # Reordering unchanged components leaves the already imported clinical snapshot intact.
    reordered = list(reversed(deepcopy(components)))
    reordered[0]["component_id"] = "new-editor-id"
    case.send("verify", row_id=row, source_id="patient", regimens=reordered)
    case.send("import", role="pharmacist", row_ids=[row], status=409)
    changed = deepcopy(components)
    changed[1]["evidence"]["route"] = {"source_id": "patient", "item_id": row}
    case.send("verify", row_id=row, source_id="patient", regimens=changed)
    case.send("import", role="pharmacist", row_ids=[row])
    assert len(case.state["receipts"]) == 2


def test_verified_components_supply_the_screening_snapshot(client):
    from test_review_reports import Encounter, _source

    encounter = Encounter(client)
    for name, source in [("Demo Amber", "amber"), ("Demo Slate", "slate")]:
        encounter.apply("add", entry=_source(source, f"{name}: synthetic interview", name))
        row = list(encounter.case["rows"])[-1]
        encounter.apply("interview", row_id=row, source_id=source, ownership="patient", current_use="current",
                        route="different reported route")
        encounter.apply("verify", row_id=row, source_id=source, regimens=[component(row, source, 1, "morning")])
    encounter.update_snapshot()
    report = encounter.run("DRP").json()
    assert report["regimen_analysis"] == []
    assert report["coverage"]["findings"] == 1

    mixed = component(row, source, 2, "evening")
    mixed["route"] = "topical"
    encounter.apply("verify", row_id=row, source_id=source, regimens=[component(row, source, 1, "morning"), mixed])
    encounter.update_snapshot()
    report = encounter.run("DRP").json()
    assert report["regimen_analysis"] == []
    assert report["coverage"]["evaluated_scopes"] == 0


@pytest.mark.parametrize("invalid", ["foreign_row", "foreign_source", "superseded", "incomplete",
                                     "reported_basis", "repeated_id", "appearance"])
def test_rejects_unattributable_or_incomplete_components_before_handoff(client, invalid):
    case = Case(client, "doctor")
    row = prepare(case)
    other = case.add(record("other", "prescription", "Another product: Demo B", name="Demo B"))
    case.link(row, photo("old", "bag", name="Demo"))
    case.link(row, photo("new", "bag", name="Demo"), replaces="old")
    case.link(row, photo("appearance", "bag", appearance="blue tablet", pairing="uncertain"))
    components = [component(row, "patient", 2, "evening")]
    value = components[0]
    if invalid == "foreign_row":
        value["evidence"]["dose_amount"]["item_id"] = other
    elif invalid == "foreign_source":
        value["evidence"]["dose_amount"] = {"source_id": "other"}
    elif invalid in {"superseded", "appearance"}:
        value["evidence"]["dose_amount"]["source_id"] = "old" if invalid == "superseded" else "appearance"
    elif invalid == "incomplete":
        del value["dose_amount"], value["evidence"]["dose_amount"]
    elif invalid == "reported_basis":
        value["basis"] = "reported"
    elif invalid == "repeated_id":
        components.append(deepcopy(value))
    case.send("verify", row_id=row, source_id="patient", regimens=components, status=422)
    assert client.get(case.path, headers=headers("pharmacist")).json() == case.state
    assert case.state["rows"][row]["verified"] is None
    case.send("import", role="pharmacist", row_ids=[row], status=422)
