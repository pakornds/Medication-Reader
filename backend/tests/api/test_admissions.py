"""Admission handoff acceptance cases through the registered application."""
import base64
from pathlib import Path
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient

from app.main import create_app


@pytest.fixture
def client(monkeypatch):
    for role, key in (("nurse", "NURSE"), ("doctor", "DOCTOR"), ("pharmacist", "REVIEWER")):
        monkeypatch.setenv(f"MEDICATION_READER_DEMO_{key}_TOKEN", "fixture-" + role)
    with TestClient(create_app()) as http:
        yield http


def headers(role):
    return {"X-Demo-Reviewer-Token": "fixture-" + role}


def record(sid, kind, text, **fields):
    return {"source": {"id": sid, "kind": kind, "reporter": "Synthetic intake", "source_date": "2026-11-21"},
            "wording": text, **fields}


def photo(sid, bag, appearance=None, pairing="matched", name=None, directions=None):
    fixture = Path(__file__).parents[1] / "fixtures" / "ai" / "label-side.png"
    return record(sid, "reverse_photo", name or appearance or bag, name=name, directions=directions,
                  photo=dict(media_type="image/png", data=base64.b64encode(fixture.read_bytes()).decode(),
                             bag=bag, region=[0,.1,.5,.5], appearance=appearance, pairing=pairing))


class Case:
    def __init__(self, http, role):
        self.http, self.role = http, role
        resp = http.post("/admissions", json={"patient_alias": "Demo A"}, headers=headers(role))
        assert resp.status_code == 201
        self.state = resp.json()
        self.path = "/admissions/" + self.state["id"]

    def send(self, action, *, status=200, role=None, **fields):
        self.payload = {"revision": self.state["revision"], "request_id": str(uuid4()),
                        "command": {"action": action, **fields}}
        resp = self.http.post(self.path + "/actions", json=self.payload, headers=headers(role or self.role))
        assert resp.status_code == status, resp.text
        if status == 200:
            self.state = resp.json()
        return resp

    def add(self, entry):
        self.send("add", entry=entry)
        return list(self.state["rows"])[-1]

    def link(self, row, entry, **extra):
        return self.send("link", row_id=row, entry=entry, confirmed=True, **extra)

    def interview(self, row, source, **changes):
        answer = dict(ownership="patient", current_use="current", dose="fixture amount", route="oral",
                      schedule="reported schedule", reason="patient-reported reason")
        self.send("interview", row_id=row, source_id=source, **(answer | changes))


@pytest.mark.parametrize("role", ["nurse", "doctor", "pharmacist"])
def test_routine_finish_each_role_and_separate_import(client, role):
    case = Case(client, role)
    for n, name in enumerate(["metformin", "bottled lactulose", "amlodipine 5 mg box"]):
        row = case.add(record(f"label{n}", "transfer_record", name, name=name))
        case.link(row, record(f"report{n}", "patient_report", "Synthetic reported regimen"))
        case.interview(row, f"report{n}")
        case.send("verify", row_id=row, source_id=f"report{n}")
    assert case.state["rows"][row]["entries"][0]["directions_status"] == "missing"
    assert case.state["rows"][row]["entries"][0]["indication"] is None
    case.send("finish")
    replay = client.post(case.path+"/actions", headers=headers(role), json=case.payload)
    assert replay.json() == case.state
    assert case.state["status"] == "Finished" and not case.state["receipts"]
    later = client.get(case.path, headers=headers("pharmacist"))
    assert later.headers["cache-control"] == "no-store"
    assert later.json()["events"][-1]["actor"]["role"] == role
    if role != "pharmacist":
        case.send("import", role=role, row_ids=[row], status=403)
    case.send("import", role="pharmacist", row_ids=[row])
    receipt = case.state["receipts"][0]
    assert receipt["imported_row_ids"] == [row]
    duplicate = client.post(case.path+"/actions", headers=headers("pharmacist"), json=case.payload)
    assert duplicate.json()["receipts"] == [receipt]
    stored = client.get("/imports", headers=headers("pharmacist"), params={"imported_at": receipt["imported_at"]})
    assert len(stored.json()) == 1
    assert stored.json()[0]["snapshot"]["rows"][0]["verification"]["reviewer"]["role"] == role


def test_two_strengths_and_documented_interview_survive_later_photos(client):
    case = Case(client, "doctor")
    for n, (name, schedule) in enumerate([("losartan 25 mg", "scheduled"), ("losartan 50 mg", "as needed")]):
        prior = f"prior{n}"
        row = case.add(record(prior, "transfer_record", name + " · documented interview · " + schedule, name=name))
        case.interview(row, prior, schedule=schedule, note="Clarify at handoff" if n else None)
        case.link(row, photo(f"blister{n}", f"pack{n}", name=name))
        case.send("verify", row_id=row, source_id=prior)
        checked = case.state["rows"][row]["verified"]
        assert checked["answer"]["schedule"] == schedule and checked["source_id"] == prior
        assert checked["answer"]["note"] == ("Clarify at handoff" if n else None)
    case.send("finish")
    assert len(case.state["rows"]) == 2


def test_mixed_bags_referral_separate_sessions_and_decisions(client):
    case = Case(client, "nurse")
    r1 = case.add(photo("left", "bag A", "round", "uncertain"))
    r2 = case.add(photo("right", "bag B", "oblong", "uncertain"))
    r3 = case.add(photo("mixed", "bag A", "speckled", "uncertain"))
    for row, bag, sid in [(r1,"bag A","left"), (r2,"bag B","right"), (r3,"bag A","mixed")]:
        case.link(row, photo(sid+"2", bag, "separate appearance"), replaces=sid)
        case.link(row, record(row, "patient_report", "Synthetic interview"))
        case.interview(row,row, **({"ownership":"other","current_use":"not_owned"} if row==r3 else {}))
    case.send("propose", row_id=r1, name="Demo candidate", reference="demo-a-blue")
    case.link(r1, record("manual", "reviewer_record", "Dispensing staff matched bag A to Demo alternative",
                         name="Demo alternative", identity_basis="dispensing_confirmation"))
    for role in ("doctor", "nurse"):
        if role == "doctor":  # This encounter is assigned only to the nurse and pharmacist.
            assert client.get(case.path, headers=headers(role)).status_code == 404
            assert client.get("/admissions", headers=headers(role)).json() == []
        else:
            case.send("decide", row_id=r1, outcome="confirm", name="Demo candidate", source_id="left2",
                      finding="Recorded observation", status=403)
    case.send("verify", row_id=r1, source_id=r1, status=422)
    case.send("finish", status=422)
    case.send("refer", row_ids=[r1,r2,r3], checked="Retook each bag", reason="Identify current tablets")
    retry = client.post(case.path+"/actions", headers=headers("nurse"), json=case.payload)
    assert retry.json() == case.state
    assert client.get("/admissions", headers=headers("pharmacist")).json()[0]["status"] == "Awaiting pharmacist review"
    case.role = "pharmacist"
    case.send("decide", row_id=r1, outcome="correct", name="Demo alternative", source_id="left2",
              finding="Appearance only", status=422)
    case.send("decide", row_id=r1, outcome="correct", name="Demo alternative", source_id="manual",
              finding="Item-specific confirmation with dispensing staff")
    case.send("decide", row_id=r3, outcome="reject", source_id=r3, finding="Caregiver identifies a different owner")
    case.send("decide", row_id=r2, outcome="pending", source_id="right2", finding="Needs independent evidence")
    case.send("finish", status=422)
    case.link(r2, record("dispatch", "prescription", "Dispensing verification: Demo B", name="Demo B",
                         identity_basis="item_specific_record"))
    case.send("decide", row_id=r2, outcome="confirm", source_id="dispatch", name="Demo B",
              finding="Pharmacist matched the individual item to its documented package")
    for row in (r1,r2,r3):
        case.send("verify", row_id=row, source_id=row)
    case.send("finish")
    assert case.state["rows"][r1]["unknown"] and case.state["rows"][r1]["superseded"] == ["left"]
    assert len([e for e in case.state["events"] if e["action"] == "refer"]) == 1


def test_stale_edits_permissions_and_discontinuation(client):
    case = Case(client,"doctor")
    row = case.add(record("label","prescription","Demo A",name="Demo A"))
    old = dict(case.payload, request_id="separate")
    assert client.post(case.path+"/actions",json=old,headers=headers("doctor")).status_code == 409
    case.link(row, record("report","caregiver_report","Patient says they stopped"))
    case.send("interview", row_id=row, ownership="patient", current_use="discontinued_order",
              source_id="report", status=422)
    case.interview(row,"report",current_use="reported_stopped")
    case.send("decide",row_id=row,outcome="confirm",name="Demo A",source_id="label",finding="Test",status=403)
    case.send("verify",row_id=row,source_id="report")
    case.send("finish")
    assert case.state["rows"][row]["verified"]["answer"]["current_use"] == "reported_stopped"
    case.send("import", row_ids=[row], status=403)
    assert client.get(case.path).status_code == 403
