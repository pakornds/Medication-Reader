"""Run each public screening entry point against real assigned admission state."""

import sqlite3
from contextlib import closing

import pytest

from fastapi.testclient import TestClient

from app.api import checks, local_screening
from app.regimen_demo import create_app as create_regimen_demo
from test_local_screening import refs
from test_review_reports import Encounter, _DOCTOR, _NURSE, _PHARMACIST, _source, client, fixture_case

WARNING = "Discontinued medicines are not checked for interactions."


def seed(http, creator, assigned_roles):
    encounter = Encounter(http, creator, assigned_roles=assigned_roles)
    for index, (name, state, actor) in enumerate([
        ("Demo A", "current", creator), ("Demo B", "current", creator),
        ("Demo Blue tablet", "current", creator), ("Demo Pink tablet", "current", creator),
        ("Demo Amber", "reported_stopped", creator), ("Demo Slate", "current", _NURSE),
        (None, None, None), ("Demo Amber", "current", creator),
    ]):
        source_id = f"fixture-{index}"
        entry = _source(source_id, f"Documented interview about {name}." if name else "Unidentified loose item", name)
        if state == "reported_stopped":
            entry["source"]["source_date"] = "2026-01-02"
            entry["wording"] = f"{name} stopped on 2026-01-02."
        encounter.apply("add", entry=entry)
        if state:
            row_id = list(encounter.case["rows"])[-1]
            encounter.apply("interview", row_id=row_id, source_id=source_id, ownership="patient",
                            current_use=state, dose="fixture", route="oral", schedule="scheduled")
            encounter.apply("verify", row_id=row_id, source_id=source_id, headers=actor)
    encounter.update_snapshot()
    return encounter


def requests(encounter):
    target = {"case_id": encounter.case["id"], "admission_revision": encounter.case["revision"]}
    yield "/checks/local", target
    for kind in ("DDI", "DRP"):
        yield "/checks", {**target, "kind": kind, "context": {"fixture_context": "present"}}
        yield encounter.path + "/review-reports/" + kind, {"snapshot_id": encounter.snapshot_id}


def test_every_entry_point_enforces_assignment_and_session_role(client, refs):
    encounter = seed(client, _PHARMACIST, ["nurse"])
    for path, payload in requests(encounter):
        for headers, expected in [({}, 403), (_NURSE, 403), (_DOCTOR, 404), (_PHARMACIST, 200)]:
            response = client.post(path, headers=headers, json=payload)
            assert response.status_code == expected, (path, response.text)


def test_current_use_coverage_and_stopped_warning_across_engines(client, refs):
    encounter = seed(client, _DOCTOR, ["nurse"])
    for path, payload in requests(encounter):
        response = client.post(path, json=payload, headers=_DOCTOR)
        assert response.status_code == 200, response.text
        report = response.json()
        assert WARNING in report["warnings"]
        if path == "/checks/local":
            rows = {r["row_id"]: r for r in report["rows"]}
            assert rows["item-5"]["reason"] == WARNING
            assert "nurse-only" in rows["item-6"]["reason"]
            assert rows["item-7"]["reason"]
            pair = next(p for p in report["pairs"] if p["row_ids"] == ["item-3", "item-4"])
            assert pair["ddi"]["status"] == pair["duplicate"]["status"] == "potential"
            for pair in report["pairs"]:
                if {"item-5", "item-6", "item-7"}.intersection(pair["row_ids"]):
                    assert pair["ddi"]["status"] == pair["duplicate"]["status"] == "unassessed"
        elif path == "/checks":
            assert report["evaluated"]
            scopes = report["excluded"]
            assert any("item-5" in s["scope"]["row_ids"] and WARNING in s["reason"] for s in scopes)
            assert any("item-6" in s["scope"]["row_ids"] and "nurse-only" in s["reason"] for s in scopes)
            assert any("item-7" in s["scope"]["row_ids"] for s in scopes)
        else:
            assert report["coverage"]["total_scopes"]
            assert any(s["reason_code"] == "discontinued_medication" for s in report["scopes"])
            assert any(s["reason_code"] == "doctor_or_pharmacist_verification_required" for s in report["scopes"])


def test_rejects_forged_rows_stale_revisions_and_missing_local_reference(client, refs, monkeypatch, tmp_path):
    encounter = seed(client, _DOCTOR, ["nurse"])
    for path, payload in requests(encounter):
        response = client.post(path, json={**payload, "role": "doctor", "rows": []}, headers=_DOCTOR)
        assert response.status_code == 422
        if path.startswith("/checks"):
            assert client.post(path, json={**payload, "admission_revision": 1}, headers=_DOCTOR).status_code == 409
    monkeypatch.setenv("LOCAL_TMT_DB", str(tmp_path / "absent.sqlite"))
    path, payload = next(requests(encounter))
    response = client.post(path, json=payload, headers=_DOCTOR)
    assert response.status_code == 503 and response.json()["detail"]["code"] == "local_reference_unavailable"


def test_empty_encounter_keeps_disabled_check_available(client):
    encounter = Encounter(client)
    target = {"case_id": encounter.case["id"], "admission_revision": 1, "kind": "DDI"}
    assert client.post("/checks", json=target, headers=_DOCTOR).status_code == 422
    report = client.post("/checks", json={**target, "enabled": False}, headers=_DOCTOR)
    assert report.status_code == 200 and report.json()["status"] == "not_run"


@pytest.mark.parametrize(("module", "engine", "path"), [
    (checks, "run_checks", "/checks"),
    (local_screening, "screen_local", "/checks/local"),
])
def test_encounter_edit_during_calculation_rejects_late_result(client, refs, monkeypatch, module, engine, path):
    encounter = seed(client, _DOCTOR, ["nurse"])
    original = getattr(module, engine)

    def edit_during_check(*args, **kwargs):
        result = original(*args, **kwargs)
        encounter.apply("add", entry=_source("late", "Unidentified synthetic item"))
        return result

    monkeypatch.setattr(module, engine, edit_during_check)
    target = {"case_id": encounter.case["id"], "admission_revision": encounter.case["revision"]}
    if path == "/checks":
        target["kind"] = "DDI"
    assert client.post(path, json=target, headers=_DOCTOR).status_code == 409


def test_ambiguous_product_label_cannot_choose_a_tpu(client, refs):
    encounter = seed(client, _DOCTOR, ["nurse"])
    with closing(sqlite3.connect(refs[0])) as db:
        db.execute("UPDATE product SET label = 'Demo Blue tablet' WHERE tpu = '303'")
        db.commit()
    path, target = next(requests(encounter))
    response = client.post(path, json=target, headers=_DOCTOR)
    assert response.status_code == 200
    blue = next(row for row in response.json()["rows"] if row["row_id"] == "item-3")
    assert blue["tpu"] is None and blue["reason"]


def test_regimen_demo_applies_same_local_screening_boundary(client, refs):
    with TestClient(create_regimen_demo()) as demo:
        encounter = Encounter(demo, _PHARMACIST, assigned_roles=["nurse"])
        entry = _source("example", "Documented interview about Demo Blue tablet.", "Demo Blue tablet")
        encounter.apply("add", entry=entry)
        target = {"case_id": encounter.case["id"], "admission_revision": encounter.case["revision"]}
        for headers, expected in [({}, 403), (_NURSE, 403), (_DOCTOR, 404), (_PHARMACIST, 200)]:
            assert demo.post("/checks/local", json=target, headers=headers).status_code == expected
        assigned = Encounter(demo, _DOCTOR)
        target.update(case_id=assigned.case["id"], admission_revision=assigned.case["revision"])
        assert demo.post("/checks/local", json=target, headers=_DOCTOR).status_code == 200
