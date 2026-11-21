"""Acceptance checks for current, case-bound synthetic screening in FastAPI."""

import json
from datetime import UTC, datetime, timedelta
from pathlib import Path
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient

from app.main import create_app
from app.schemas.review_scopes import ScreeningFixture
from app.services import review_snapshots

_FIXTURE = Path(__file__).resolve().parents[3] / "fixtures/checks/demo-overlap-v2/case.json"
_NURSE = {"X-Demo-Reviewer-Token": "fixture-nurse"}
_DOCTOR = {"X-Demo-Reviewer-Token": "fixture-doctor"}
_PHARMACIST = {"X-Demo-Reviewer-Token": "fixture-pharmacist"}


@pytest.fixture
def fixture_case():
    return ScreeningFixture.model_validate_json(_FIXTURE.read_text(encoding="utf-8"))


@pytest.fixture
def client(monkeypatch, fixture_case):
    monkeypatch.setenv("MEDICATION_READER_DEMO_NURSE_TOKEN", "fixture-nurse")
    monkeypatch.setenv("MEDICATION_READER_DEMO_DOCTOR_TOKEN", "fixture-doctor")
    monkeypatch.setenv("MEDICATION_READER_DEMO_REVIEWER_TOKEN", "fixture-pharmacist")
    app = create_app()
    app.state.review_snapshots.clock = lambda: fixture_case.reports[0].ran_at
    with TestClient(app) as http:
        yield http


def _source(source_id, wording, name=None, *, kind="reviewer_record"):
    return {
        "source": {"id": source_id, "kind": kind, "reporter": "Synthetic intake"},
        "name": name,
        "wording": wording,
        "record_basis": "documented_interview" if name else None,
    }


class Encounter:
    def __init__(self, http, headers=_DOCTOR, *, assigned_roles=None):
        self.http = http
        self.headers = headers
        created = http.post("/admissions", headers=headers, json={
            "patient_alias": "Synthetic screening", "assigned_roles": assigned_roles or [],
        })
        assert created.status_code == 201, created.text
        self.case = created.json()
        self.path = f"/admissions/{self.case['id']}"
        self.snapshot_id = None

    def apply(self, action, *, headers=None, **data):
        response = self.http.post(
            self.path + "/actions", headers=headers or self.headers,
            json={"revision": self.case["revision"], "request_id": uuid4().hex, "command": {"action": action, **data}},
        )
        assert response.status_code == 200, response.text
        self.case = response.json()

    def seed(self, fixture_case):
        self.row_ids = {}
        before = fixture_case.snapshots[0]
        for row in before.rows:
            description = next(ref.description for ref in before.evidence if ref.id == row.evidence_ids[0])
            wording = f"{row.product_name}. {description}" if row.product_name else description
            self.apply("add", entry=_source(row.evidence_ids[0], wording, row.product_name))
            row_id = list(self.case["rows"])[-1]
            self.row_ids[row.id] = row_id
            if row.id == "R2":
                self.apply(
                    "link", row_id=row_id, confirmed=True,
                    entry=_source("E4", "Synthetic interview about overlap with Demo Amber", kind="patient_report"),
                )
            if row.use_status == "current":
                self.apply(
                    "interview", row_id=row_id, source_id=row.evidence_ids[0], ownership="patient",
                    current_use="current", dose="fixture", route=row.route, schedule=row.schedule,
                )
                self.apply("verify", row_id=row_id, source_id=row.evidence_ids[0])

    def exposure(self, status, evidence_ids=None):
        exposure = {"row_ids": [self.row_ids["R1"], self.row_ids["R2"]], "status": status}
        if status != "unknown":
            exposure.update(evidence_ids=evidence_ids or ["E4"], observed_at="2026-11-21T04:05:00Z")
        return exposure

    def update_snapshot(self, *exposures, status=200, **overrides):
        payload = {
            "admission_revision": self.case["revision"],
            "previous_snapshot_id": self.snapshot_id,
            "exposures": exposures,
        } | overrides
        response = self.http.put(self.path + "/review-snapshot", headers=self.headers, json=payload)
        assert response.status_code == status, response.text
        assert response.headers["cache-control"] == "no-store"
        if status == 200:
            self.snapshot_id = response.json()["snapshot_id"]
        return response

    def run(self, kind, *, enabled=True, snapshot_id=None, status=200):
        response = self.http.post(
            self.path + f"/review-reports/{kind}", headers=self.headers,
            json={"snapshot_id": snapshot_id or self.snapshot_id, "enabled": enabled},
        )
        assert response.status_code == status, response.text
        assert response.headers["cache-control"] == "no-store"
        return response

    def report(self, kind, *, snapshot_id=None, status=200, headers=None):
        response = self.http.get(
            self.path + f"/review-reports/{kind}", headers=headers or self.headers,
            params={"snapshot_id": snapshot_id or self.snapshot_id},
        )
        assert response.status_code == status, response.text
        assert response.headers["cache-control"] == "no-store"
        return response


def test_published_fixture_runs_both_reports_under_one_current_snapshot(client, fixture_case):
    encounter = Encounter(client)
    encounter.seed(fixture_case)
    for fixture_snapshot in fixture_case.snapshots:
        exposure = fixture_snapshot.exposures[0].model_dump(mode="json")
        exposure["row_ids"] = [encounter.row_ids[row_id] for row_id in exposure["row_ids"]]
        client.app.state.review_snapshots.clock = lambda: next(
            report.ran_at for report in fixture_case.reports if report.snapshot_id == fixture_snapshot.snapshot_id
        )
        previous = encounter.snapshot_id
        version = encounter.update_snapshot(exposure).json()
        assert version["current"]
        assert version["case_id"] == encounter.case["id"]
        assert version["mapping_version"] == fixture_case.release.mapping_version
        if previous:
            assert version["snapshot_id"] != previous
            assert encounter.report("DDI", snapshot_id=previous, status=409).json()["detail"]["code"] == "stale_snapshot"
        for expected in (r for r in fixture_case.reports if r.snapshot_id == fixture_snapshot.snapshot_id):
            even_without_other_kind = encounter.run(expected.kind).json()
            assert even_without_other_kind == encounter.report(expected.kind).json()
            assert even_without_other_kind["snapshot_id"] == version["snapshot_id"]
            assert even_without_other_kind["release_id"] == fixture_case.release.id
            assert even_without_other_kind["mapping_version"] == version["mapping_version"]
            assert even_without_other_kind["status"] == expected.status
            assert even_without_other_kind["coverage"] == expected.coverage.model_dump()
            actual_scopes = {
                (tuple(s["row_ids"]), tuple(s["ingredient_ids"]), s["rule_id"], s["parent_scope_id"] is not None):
                    (s["outcome"], s["reason_code"], s["evidence_ids"], s["follow_up_ids"])
                for s in even_without_other_kind["scopes"]
            }
            expected_scopes = {
                (tuple(encounter.row_ids[r] for r in s.row_ids), tuple(s.ingredient_ids), s.rule_id, s.parent_scope_id is not None):
                    (s.outcome, s.reason_code, s.evidence_ids, s.follow_up_ids)
                for s in expected.scopes
            }
            assert actual_scopes == expected_scopes


def test_evidence_only_edit_retires_current_reports_and_pending_admission_rows_cannot_be_verified_by_screening(
    client, fixture_case,
):
    encounter = Encounter(client)
    encounter.seed(fixture_case)
    encounter.update_snapshot(encounter.exposure("unknown"))
    previous = encounter.snapshot_id
    assert encounter.run("DRP").json()["coverage"]["findings"] == 1
    old_revision = encounter.case["revision"]
    encounter.apply(
        "link", row_id=encounter.row_ids["R1"], confirmed=True,
        entry=_source("E5", "Additional supporting evidence for the same item"),
    )

    described = client.get(encounter.path + "/review-snapshot", headers=encounter.headers).json()
    assert described["snapshot_id"] == previous
    assert not described["current"]
    assert encounter.report("DRP", status=409).json()["detail"]["code"] == "stale_snapshot"
    encounter.run("DRP", status=409)
    encounter.update_snapshot(status=409, admission_revision=old_revision)
    encounter.update_snapshot(encounter.exposure("unknown"))
    rerun = encounter.run("DRP").json()
    assert rerun["coverage"] == {"total_scopes": 3, "evaluated_scopes": 0, "findings": 0, "excluded_scopes": 3}


def test_only_timing_changes_supersede_both_kinds_and_invalid_exposure_cannot_replace_current_snapshot(client, fixture_case):
    encounter = Encounter(client)
    encounter.seed(fixture_case)
    unknown = encounter.update_snapshot(encounter.exposure("unknown")).json()
    prior_reports = {kind: encounter.run(kind).json() for kind in ("DDI", "DRP")}
    client.app.state.review_snapshots.clock = lambda: fixture_case.reports[2].ran_at

    wrong_pair = encounter.exposure("confirmed")
    wrong_pair["row_ids"] = [encounter.row_ids["R1"], encounter.row_ids["R3"]]
    assert encounter.update_snapshot(wrong_pair, status=422).json()["detail"]["code"] == "invalid_exposure"
    encounter.update_snapshot(encounter.exposure("confirmed", ["source-from-another-case"]), status=422)
    duplicates = encounter.exposure("confirmed", ["E4", "E4"])
    rejection = encounter.update_snapshot(duplicates, status=422)
    assert rejection.json()["detail"] == {
        "code": "invalid_exposure",
        "message": "Cite each exposure source only once.",
        "recoverable": True,
    }
    for kind, previous in prior_reports.items():
        assert encounter.report(kind).json() == previous

    confirmed = encounter.update_snapshot(encounter.exposure("confirmed")).json()
    assert confirmed["admission_revision"] == unknown["admission_revision"]
    assert confirmed["snapshot_id"] != unknown["snapshot_id"]
    encounter.update_snapshot(encounter.exposure("unknown"), status=409, previous_snapshot_id=unknown["snapshot_id"])
    for kind in ("DDI", "DRP"):
        encounter.report(kind, snapshot_id=unknown["snapshot_id"], status=409)
        encounter.report(kind, status=404)
        assert encounter.run(kind).json()["coverage"]["findings"] == 1


def test_mapping_change_even_with_same_release_id_stales_previous_report(client, fixture_case, tmp_path, monkeypatch):
    copied = tmp_path / "case.json"
    bundled = _FIXTURE.read_text(encoding="utf-8")
    copied.write_text(bundled, encoding="utf-8")
    monkeypatch.setattr(review_snapshots, "_FIXTURE_PATH", copied)
    encounter = Encounter(client)
    encounter.seed(fixture_case)
    version = encounter.update_snapshot().json()
    encounter.run("DRP")

    source = json.loads(bundled)
    source["release"]["mapping_version"] = "synthetic-map-updated"
    copied.write_text(json.dumps(source), encoding="utf-8")
    encounter.report("DRP", status=409)
    copied.write_text(bundled, encoding="utf-8")
    encounter.report("DRP", status=409)
    copied.write_text(json.dumps(source), encoding="utf-8")
    new = encounter.update_snapshot().json()
    assert new["release_id"] == version["release_id"]
    assert new["mapping_version"] == "synthetic-map-updated"
    assert new["snapshot_id"] != version["snapshot_id"]
    assert encounter.run("DRP").json()["mapping_version"] == "synthetic-map-updated"
    copied.write_text("unreadable release", encoding="utf-8")
    assert encounter.report("DRP", status=503).json()["detail"]["code"] == "fixture_unavailable"
    copied.write_text(json.dumps(source), encoding="utf-8")
    encounter.report("DRP", status=409)


def test_expiry_boundary_stales_previous_reports_then_rerun_explains_coverage_gap(client, fixture_case, tmp_path, monkeypatch):
    copied = tmp_path / "case.json"
    source = json.loads(_FIXTURE.read_text(encoding="utf-8"))
    ran_at = fixture_case.reports[2].ran_at
    expiry = (ran_at.date() + timedelta(days=1)).isoformat()
    source["release"]["rules"][0]["reference"]["expires_on"] = expiry
    copied.write_text(json.dumps(source), encoding="utf-8")
    monkeypatch.setattr(review_snapshots, "_FIXTURE_PATH", copied)
    client.app.state.review_snapshots.clock = lambda: ran_at
    encounter = Encounter(client)
    encounter.seed(fixture_case)
    encounter.update_snapshot(encounter.exposure("confirmed"))
    assert encounter.run("DDI").json()["coverage"]["findings"] == 1

    client.app.state.review_snapshots.clock = lambda: datetime.fromisoformat(expiry).replace(tzinfo=UTC)
    assert encounter.report("DDI", status=409).json()["detail"]["code"] == "stale_snapshot"
    encounter.update_snapshot(encounter.exposure("confirmed"))
    report = encounter.run("DDI").json()
    assert report["status"] == "unavailable"
    assert report["coverage"]["findings"] == 0
    assert any(scope["reason_code"] == "expired_reference" for scope in report["scopes"])


def test_case_isolation_independent_toggle_and_no_receiving_system_or_browser_cache_write(client, fixture_case):
    first = Encounter(client, _PHARMACIST, assigned_roles=["nurse"])
    first.seed(fixture_case)
    first.update_snapshot()
    disabled = first.run("DDI", enabled=False).json()
    assert disabled["status"] == "not_run"
    assert not disabled["scopes"]
    first.report("DRP", status=404)
    found = first.run("DRP")
    assert found.json()["coverage"]["findings"] == 1
    assert "set-cookie" not in found.headers
    assert first.report("DDI").json() == disabled

    first.report("DRP", headers=_DOCTOR, status=404)
    first.report("DRP", headers=_NURSE, status=403)
    assert client.get(first.path, headers=_NURSE).status_code == 200
    other = Encounter(client, _DOCTOR)
    other.update_snapshot()
    assert other.report("DRP", snapshot_id=first.snapshot_id, status=409).json()["detail"]["code"] == "stale_snapshot"
    loaded_admission = client.get(first.path, headers=_NURSE).json()
    assert not loaded_admission["receipts"]
    assert "snapshot_id" not in loaded_admission
    assert client.app.state.admissions.hospital._db.execute("SELECT COUNT(*) FROM imports").fetchone() == (0,)

    with TestClient(create_app()) as restarted:
        unavailable = restarted.get(first.path + "/review-snapshot", headers=_PHARMACIST)
        assert unavailable.status_code == 404


def test_only_doctor_or_pharmacist_verification_can_establish_eligible_current_use(client, fixture_case):
    encounter = Encounter(client, assigned_roles=["nurse"])
    encounter.seed(fixture_case)
    amber = encounter.row_ids["R1"]
    slate = encounter.row_ids["R2"]
    encounter.apply("verify", headers=_NURSE, row_id=amber, source_id="E1")
    encounter.update_snapshot()
    for kind in ("DDI", "DRP"):
        report = encounter.run(kind).json()
        pair = next(scope for scope in report["scopes"] if scope["row_ids"] == [amber, slate])
        assert pair["reason_code"] == "doctor_or_pharmacist_verification_required"
        assert report["coverage"]["findings"] == report["coverage"]["evaluated_scopes"] == 0
        assert report["coverage"]["total_scopes"] == 3
    nurse = client.post(
        encounter.path + "/review-reports/DDI", headers=_NURSE, json={"snapshot_id": encounter.snapshot_id}
    )
    assert nurse.status_code == 403

    encounter.apply("verify", row_id=amber, source_id="E1")
    encounter.update_snapshot()
    assert encounter.run("DRP").json()["coverage"]["findings"] == 1

    encounter.apply(
        "interview", row_id=amber, source_id="E1", ownership="patient", current_use="reported_stopped"
    )
    encounter.apply("verify", row_id=amber, source_id="E1")
    encounter.update_snapshot()
    for kind in ("DDI", "DRP"):
        report = encounter.run(kind).json()
        pair = next(scope for scope in report["scopes"] if scope["row_ids"] == [amber, slate])
        assert pair["reason_code"] == "discontinued_medication"
        assert report["warnings"] == ["Discontinued medicines are not checked for interactions."]
        assert report["coverage"]["findings"] == report["coverage"]["evaluated_scopes"] == 0
        assert report["coverage"]["total_scopes"] == 3
