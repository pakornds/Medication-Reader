"""Use small fictional reference releases to exercise the actual HTTP contract."""

import sqlite3
from contextlib import closing

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api.local_screening import router


@pytest.fixture
def client():
    app = FastAPI()
    app.include_router(router)
    with TestClient(app) as session:
        yield session


@pytest.fixture
def refs(tmp_path, monkeypatch):
    tmt, fest = tmp_path / "tmt.sqlite", tmp_path / "fest.sqlite"
    with closing(sqlite3.connect(tmt)) as db:
        db.executescript("""
            CREATE TABLE metadata(key TEXT, value TEXT);
            INSERT INTO metadata VALUES ('tmt_release','tmt-test'), ('mapping_version','map-v1'),
                ('mapping_sha256','snapshot-test'), ('fest_sha256','test-digest');
            CREATE TABLE product(tpu TEXT PRIMARY KEY,label TEXT,composition_status TEXT,ddi_status TEXT,legacy_status TEXT,fest_route TEXT);
            INSERT INTO product VALUES ('101','Demo Blue tablet','complete','mapped','unchanged','53'),
                ('202','Demo Pink tablet','complete','mapped','unchanged','53'),
                ('303','Demo Yellow tablet','incomplete','no_exact_fest_product_form_route','unchanged',NULL);
            CREATE TABLE ingredient(tpu TEXT,subs_id TEXT,name TEXT);
            INSERT INTO ingredient VALUES ('101','S1','Demo ingredient'),
                ('202','S1','Demo ingredient'),('202','S2','Second ingredient'),('303','S1','Demo ingredient');
            CREATE TABLE product_atc(tpu TEXT,atc TEXT);
            INSERT INTO product_atc VALUES ('101','A01AA01'),('202','B01BB02');
        """)
    with closing(sqlite3.connect(fest)) as db:
        db.executescript("""
            CREATE TABLE source(publisher TEXT,archive_filename TEXT,sha256 TEXT,license_url TEXT);
            INSERT INTO source VALUES ('FEST','fest-test','test-digest','https://example.invalid/terms');
            CREATE TABLE rule(id TEXT PRIMARY KEY, updated TEXT, relevance_no TEXT, clinical_consequence_no TEXT,entry_xml TEXT);
            CREATE TABLE citation(rule_id TEXT,citation_no TEXT,url TEXT);
            INSERT INTO citation VALUES ('demo-rule','Fixture publication','https://example.invalid/reference');
            CREATE TABLE atc_member(rule_id TEXT,side INTEGER,atc TEXT,name_no TEXT);
            INSERT INTO atc_member VALUES ('demo-rule',2,'A01A','A class'), ('demo-rule',1,'B01BB02','B'),
                ('same-side',2,'A01AA01','A'), ('same-side',2,'B01BB02','B');
            CREATE TABLE unassessed(source_entry TEXT,entry_xml TEXT);
        """)
        xml = """<Entry><Interaksjon><Situasjonskriterium>Fixture route condition</Situasjonskriterium>
            <Interaksjonsmekanisme>Fixture mechanism</Interaksjonsmekanisme>
            <Kildegrunnlag DN="Fixture evidence" /></Interaksjon></Entry>"""
        for key in ("same-side", "demo-rule"):
            db.execute("INSERT INTO rule VALUES (?,?,?,?,?)",
                       (key, "2026-01-01", "Forholdsregler bør tas", "Fixture consequence", xml))
        db.commit()
    monkeypatch.setenv("LOCAL_TMT_DB", str(tmt))
    monkeypatch.setenv("LOCAL_FEST_DB", str(fest))
    return tmt, fest


def body(codes=("101", "202", None)):
    names = {"101": "Demo Blue tablet", "202": "Demo Pink tablet", "303": "Demo Yellow tablet"}
    rows, items = [], []
    for i, code in enumerate(codes):
        row_id = f"row-{i}"
        source = {"source_id": "record", "item_id": f"item-{i}"}
        items.append(dict(id=source["item_id"], source_id="record", row_id=row_id, kind="record_excerpt"))
        name = names.get(code)
        row = dict(id=row_id, revision=1, identity_status="named" if name else "unlabeled",
                   sources=[source], unknown_label=None if name else "Unidentified item")
        if name:
            identity = {"value": name, "evidence": source}
            row.update(observed_names=[identity], verification=dict(
                reviewer=dict(id="fixture", name="Fixture pharmacist", role="pharmacist"),
                verified_at="2026-01-03T00:00:00Z", status="current", identity=identity,
                normalized_medication_id=code, evidence=[source],
            ))
        rows.append(row)
    return {"rows": rows, "evidence": {
        "case_id": "fictional-encounter", "sources": [dict(id="record", kind="transfer_record")], "items": items}}


def run(client, request):
    response = client.post("/checks/local", json=request)
    assert response.status_code == 200, response.text
    return response.json()


def test_opposing_groups_hierarchy_citations_partial_scope_and_snapshot(client, refs):
    request = body()
    result = run(client, request)
    assert (result["fest_release"], result["tmt_release"]) == ("fest-test", "tmt-test")
    assert len(result["pairs"]) == 3
    pair, *gaps = result["pairs"]
    assert pair["row_ids"] == ["row-0", "row-1"]
    assert pair["ddi"]["status"] == "potential"
    rule, = pair["ddi"]["interactions"]
    assert rule["rule_id"] == "demo-rule" and rule["matched_atcs"] == [["A01A"], ["B01BB02"]]
    assert rule["condition"] == "Fixture route condition" and rule["source_basis"] == "Fixture evidence"
    assert rule["references"][0]["title"] == "Fixture publication"
    assert pair["duplicate"]["status"] == "potential"
    assert pair["duplicate"]["ingredients"] == [{"subs_id": "S1", "name": "Demo ingredient"}]
    for gap in gaps:
        assert gap["ddi"]["status"] == gap["duplicate"]["status"] == "unassessed"
    assert result["rows"][2]["reason"] and not result["rows"][2]["tpu"]
    assert result["snapshot_id"] == run(client, request)["snapshot_id"]
    request["rows"][0]["revision"] += 1
    assert result["snapshot_id"] != run(client, request)["snapshot_id"]


@pytest.mark.parametrize("field,value", [
    ("normalized_medication_id", "202"), ("normalized_medication_id", "999"),
    ("status", "no_longer_current"), ("status", "uncertain"),
    ("identity", {"value": "Demo Blue tablet", "evidence": {"source_id": "unrelated"}}),
    ("evidence", [{"source_id": "record", "item_id": "item-1"}]),
    ("reviewer", {"id": "clerk", "name": "Fixture clerk", "role": "staff"}),
])
def test_unverified_or_mismatched_product_is_outside_both_checks(client, refs, field, value):
    request = body(("101", "202"))
    request["rows"][0]["verification"][field] = value
    result = run(client, request)
    assert result["rows"][0]["reason"]
    assert result["pairs"][0]["ddi"]["status"] == result["pairs"][0]["duplicate"]["status"] == "unassessed"


def test_disputed_identity_needs_a_new_independent_source(client, refs):
    request = body(("101", "202"))
    row = request["rows"][0]
    ref = row["sources"][0]
    row["discrepancies"] = [dict(id="identity-conflict", field="identity", question="Which item is this?",
                                 observed_values=[{"value": "Demo Blue", "evidence": ref},
                                                  {"value": "Demo Pink", "evidence": ref}])]
    row["verification"]["resolved_discrepancies"] = ["identity-conflict"]
    result = run(client, request)
    assert result["pairs"][0]["ddi"]["status"] == "unassessed"
    assert "independent" in result["rows"][0]["reason"]


def test_partial_mapping_does_not_clear_or_assert_duplicate(client, refs):
    pair, = run(client, body(("101", "303")))["pairs"]
    assert pair["duplicate"]["status"] == pair["ddi"]["status"] == "unassessed"


def test_unassessed_parent_does_not_hide_explicit_opposing_group_rule(client, refs):
    with closing(sqlite3.connect(refs[1])) as db:
        db.execute("INSERT INTO unassessed VALUES (?,?)", ("demo", '<Entry><InteraksjonIkkeVurdert><Atc V="A01"/></InteraksjonIkkeVurdert></Entry>'))
        db.commit()
    pair, = run(client, body(("101", "202")))["pairs"]
    assert pair["ddi"]["status"] == "potential" and pair["ddi"]["interactions"][0]["rule_id"] == "demo-rule"
    assert pair["duplicate"]["status"] == "potential"


def test_exact_unassessed_marks_scope_and_retains_any_positive_rule(client, refs):
    with closing(sqlite3.connect(refs[1])) as db:
        db.execute("INSERT INTO unassessed VALUES (?,?)", ("explicit", '<Entry><InteraksjonIkkeVurdert><Atc V="A01AA01"/></InteraksjonIkkeVurdert></Entry>'))
        db.commit()
    pair, = run(client, body(("101", "202")))["pairs"]
    assert pair["ddi"]["status"] == "partial" and "unassessed" in pair["ddi"]["reasons"][0]
    assert pair["ddi"]["interactions"][0]["rule_id"] == "demo-rule"
    assert pair["duplicate"]["status"] == "potential"
    with closing(sqlite3.connect(refs[1])) as db:
        db.execute("DELETE FROM atc_member WHERE rule_id='demo-rule'")
        db.commit()
    pair, = run(client, body(("101", "202")))["pairs"]
    assert pair["ddi"]["status"] == "unassessed" and not pair["ddi"]["interactions"]


def test_no_rule_limited_negative_and_no_pair(client, refs):
    with closing(sqlite3.connect(refs[1])) as db:
        db.execute("DELETE FROM atc_member WHERE rule_id='demo-rule'")
        db.commit()
    pair, = run(client, body(("101", "202")))["pairs"]
    assert pair["ddi"]["status"] == "lookup_complete" and not pair["ddi"]["interactions"]
    assert "limited coverage" in pair["ddi"]["reasons"][0]
    assert run(client, body(("101",)))["pairs"] == []


def test_missing_db_or_stale_crosswalk_fails_closed(client, refs, monkeypatch, tmp_path):
    with closing(sqlite3.connect(refs[1])) as db:
        db.execute("UPDATE source SET sha256='different'")
        db.commit()
    report = run(client, body())
    assert report["fest_release"] is None and "different releases" in report["ddi_unavailable_reason"]
    assert report["pairs"][0]["ddi"]["status"] == "unassessed"
    assert report["pairs"][0]["duplicate"]["status"] == "potential"
    monkeypatch.delenv("LOCAL_FEST_DB")
    without_fest = run(client, body())
    assert "missing" in without_fest["ddi_unavailable_reason"]
    assert without_fest["pairs"][0]["duplicate"]["status"] == "potential"
    missing = tmp_path / "missing.sqlite"
    monkeypatch.setenv("LOCAL_TMT_DB", str(missing))
    response = client.post("/checks/local", json=body())
    assert response.status_code == 503 and not missing.exists()
    assert response.json()["detail"]["code"] == "local_reference_unavailable"


def test_duplicate_row_ids_rejected(client, refs):
    request = body(("101",))
    request["rows"].append(request["rows"][0])
    assert client.post("/checks/local", json=request).status_code == 422


def test_changed_product_needs_explicit_current_release_and_reports_single_row_mapping(client, refs):
    with closing(sqlite3.connect(refs[0])) as db:
        db.execute("UPDATE product SET legacy_status='clinical_fields_changed' WHERE tpu='101'")
        db.commit()
    request = body(("101",))
    stale = run(client, request)["rows"][0]
    assert stale["tpu"] is None and "changed" in stale["reason"]
    verification = request["rows"][0]["verification"]
    verification["tmt_release"] = "prior-release"
    assert "different TMT release" in run(client, request)["rows"][0]["reason"]
    verification["tmt_release"] = "tmt-test"
    selected = run(client, request)["rows"][0]
    assert selected["tpu"] == "101" and selected["composition_status"] == "complete" and selected["ddi_status"] == "mapped"


def test_reference_classed_no_action_does_not_become_an_alert(client, refs):
    with closing(sqlite3.connect(refs[1])) as db:
        db.execute("UPDATE rule SET relevance_no='Ingen tiltak nødvendig'")
        db.commit()
    ddi = run(client, body(("101", "202")))["pairs"][0]["ddi"]
    assert ddi["status"] == "lookup_complete"
    assert ddi["interactions"][0]["relevance"] == "Ingen tiltak nødvendig"


@pytest.mark.parametrize("route,expected", [("ophthalmic", "differs"), ("per documented schedule", "cannot be compared")])
def test_explicit_route_conflict_retains_signal_and_prevents_a_negative(client, refs, route, expected):
    request = body(("101", "202"))
    row = request["rows"][0]
    row["verification"]["route"] = {"value": route, "evidence": row["sources"][0]}
    report = run(client, request)
    pair, = report["pairs"]
    assert pair["ddi"]["status"] == "partial"
    assert expected in report["rows"][0]["route_note"] and expected in pair["ddi"]["reasons"][0]
    assert pair["ddi"]["interactions"][0]["rule_id"] == "demo-rule"
    assert pair["duplicate"]["status"] == "potential"
    with closing(sqlite3.connect(refs[1])) as db:
        db.execute("DELETE FROM atc_member WHERE rule_id='demo-rule'")
        db.commit()
    pair, = run(client, request)["pairs"]
    assert pair["ddi"]["status"] == "unassessed"


def test_absent_route_is_explicit_and_form_mapping_gaps_are_human_readable(client, refs):
    request = body(("101", "202", "303"))
    result = run(client, request)
    assert "Actual route is missing" in result["rows"][0]["route_note"]
    pair = result["pairs"][1]
    assert pair["ddi"]["status"] == "unassessed"
    assert "exact ingredients, form and catalogue route" in pair["ddi"]["reasons"][0]


def test_structured_component_route_controls_the_gap(client, refs):
    request = body(("101", "202"))
    row = request["rows"][0]
    ref = row["sources"][0]
    row["verification"]["regimens"] = [{
        "basis": "verified", "component_id": "current-use", "directions_text": "ophthalmic",
        "parse_status": "complete", "route": "ophthalmic",
        "evidence": {"directions_text": ref, "route": ref},
    }]
    assert run(client, request)["pairs"][0]["ddi"]["status"] == "partial"
    component = row["verification"]["regimens"][0]
    component.update(route="oral", directions_text="oral")
    result = run(client, request)
    assert result["pairs"][0]["ddi"]["status"] == "potential"
    assert result["rows"][0]["route_note"] is None
