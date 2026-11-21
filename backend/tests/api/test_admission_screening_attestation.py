"""Screening attestation and admission import boundaries through the registered application."""

from datetime import UTC, datetime

from test_admissions import Case, client, headers, record


def add_current_interview(case, source, name, *, dose, schedule="scheduled"):
    row = case.add(record(f"{source}-label", "prescription", name, name=name))
    case.link(row, record(source, "patient_report", f"Synthetic report of current use of {name}"))
    case.interview(row, source, dose=dose, route="oral", schedule=schedule)
    return row


def run_drp(case, previous_snapshot_id=None):
    snapshot = case.http.put(
        case.path + "/review-snapshot", headers=headers(case.role),
        json={"admission_revision": case.state["revision"], "previous_snapshot_id": previous_snapshot_id},
    )
    assert snapshot.status_code == 200, snapshot.text
    snapshot_id = snapshot.json()["snapshot_id"]
    report = case.http.post(
        case.path + "/review-reports/DRP", headers=headers(case.role), json={"snapshot_id": snapshot_id},
    )
    assert report.status_code == 200, report.text
    return snapshot_id, report.json()


def test_clinician_attestation_enables_shared_ingredient_screening_with_missing_dose(client):
    client.app.state.review_snapshots.clock = lambda: datetime(2026, 11, 21, 7, tzinfo=UTC)
    case = Case(client, "doctor")
    amber = add_current_interview(case, "use-amber", "Demo Amber", dose=None)
    slate = add_current_interview(case, "use-slate", "Demo Slate", dose="fixture dose")
    previous, before = run_drp(case)
    assert before["coverage"]["evaluated_scopes"] == 0

    for row, source, role in ((amber, "use-amber", "doctor"), (slate, "use-slate", "pharmacist")):
        case.send("attest_current_use", role=role, row_id=row, source_id=source)
        saved = case.state["rows"][row]
        attested = saved["screening_attestation"]
        assert saved["verified"] is None
        assert attested["actor"]["id"] == f"demo-{role}"
        assert attested["actor"]["role"] == role
        assert attested["source_id"] == source
        assert attested["identity"]["source_id"] == f"{source}-label"
        assert attested["answer"]["route"] == "oral"
        assert datetime.fromisoformat(attested["at"]).utcoffset().total_seconds() == 0
        event = case.state["events"][-1]
        assert event["action"] == "attest_current_use"
        assert event["rows"] == [row]
        assert set(event["sources"]) == {source, f"{source}-label"}
    assert case.state["rows"][amber]["screening_attestation"]["answer"]["dose"] is None

    _, after = run_drp(case, previous)
    assert after["coverage"]["evaluated_scopes"] == 1
    assert after["coverage"]["findings"] == 1
    result, = after["scopes"]
    assert result["row_ids"] == [amber, slate]
    assert result["ingredient_ids"] == ["X"]
    assert result["rule_id"] == "demo-duplicate-ingredient-v1"
    assert after["regimen_analysis"] == [{
        "row_id": amber,
        "status": "unavailable",
        "missing_fields": ["dose"],
        "reason": "Regimen analysis unavailable because the dose is missing.",
    }]

    case.send("verify", row_id=amber, source_id="use-amber", status=422)
    case.send("import", role="pharmacist", row_ids=[amber], status=422)
    assert not case.state["receipts"]
    case.send("verify", row_id=slate, source_id="use-slate")
    case.send("import", role="pharmacist", row_ids=[slate])
    assert case.state["receipts"][0]["imported_row_ids"] == [slate]


def test_routine_nurse_verification_and_role_boundary_are_preserved(client):
    case = Case(client, "nurse")
    row = add_current_interview(case, "use", "Demo Amber", dose="fixture dose")
    case.send("attest_current_use", row_id=row, source_id="use", status=403)
    case.send("attest_current_use", role="doctor", row_id=row, source_id="use", status=404)
    case.send("verify", row_id=row, source_id="use")
    assert case.state["rows"][row]["verified"]["actor"]["role"] == "nurse"
    case.send("finish")
    case.send("import", role="pharmacist", row_ids=[row])
    assert case.state["receipts"][0]["imported_row_ids"] == [row]


def test_attestation_cites_same_active_interview_and_does_not_survive_changed_evidence(client):
    client.app.state.review_snapshots.clock = lambda: datetime(2026, 11, 21, 7, tzinfo=UTC)
    case = Case(client, "doctor")
    amber = add_current_interview(case, "use-amber", "Demo Amber", dose=None, schedule=None)
    slate = add_current_interview(case, "use-slate", "Demo Slate", dose="fixture dose")
    case.send("attest_current_use", row_id=amber, source_id="use-slate", status=422)
    case.send("attest_current_use", row_id=amber, source_id="use-amber")
    case.send("verify", row_id=slate, source_id="use-slate")
    first, report = run_drp(case)
    assert report["regimen_analysis"][0]["missing_fields"] == ["dose", "schedule"]

    case.interview(amber, "use-amber", current_use="reported_stopped", dose=None, schedule=None)
    second, edited = run_drp(case, first)
    assert edited["coverage"]["evaluated_scopes"] == 0
    assert edited["regimen_analysis"] == []
    case.send("attest_current_use", row_id=amber, source_id="use-amber", status=422)
    case.interview(amber, "use-amber", dose=None, schedule=None)
    _, restored = run_drp(case, second)
    assert restored["coverage"]["evaluated_scopes"] == 0


def test_patient_report_cannot_establish_identity_for_screening(client):
    case = Case(client, "doctor")
    row = case.add(record("report", "patient_report", "Reports taking Demo Amber", name="Demo Amber"))
    case.interview(row, "report", dose=None, route="oral", schedule="scheduled")
    case.send("attest_current_use", row_id=row, source_id="report", status=422)
