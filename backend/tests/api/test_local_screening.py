"""Exercise release and clinical coverage logic with fictional SQLite references."""

import gzip
import json
import sqlite3
from contextlib import closing

import pytest
from pydantic import ValidationError

from app.schemas.local_screening import CatalogueScreeningRequest, LocalScreeningRequest
from app.services import ingredient_route_reference
from app.services.local_screening import ReferenceUnavailable, screen_catalogue_list, screen_local


@pytest.fixture
def refs(tmp_path, monkeypatch):
    tmt, fest = tmp_path / "tmt.sqlite", tmp_path / "fest.sqlite"
    with closing(sqlite3.connect(tmt)) as db:
        db.executescript("""
            CREATE TABLE metadata(key TEXT, value TEXT);
            INSERT INTO metadata VALUES ('tmt_release','tmt-test'), ('mapping_version','map-v1'),
                ('mapping_sha256','snapshot-test'), ('fest_sha256','test-digest'), ('legacy_tmt_release','tmt-legacy');
            CREATE TABLE product(tpu TEXT PRIMARY KEY,label TEXT,composition_status TEXT,ddi_status TEXT,legacy_status TEXT,fest_route TEXT,legacy_label TEXT);
            INSERT INTO product VALUES ('101','Demo Blue tablet','complete','mapped','unchanged','53','Blue original presentation'),
                ('202','Demo Pink tablet','complete','mapped','unchanged','53','Pink original presentation'),
                ('303','Demo Yellow tablet','incomplete','no_exact_fest_product_form_route','unchanged',NULL,'Yellow original presentation');
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


@pytest.fixture
def ingredient_route_refs(refs, monkeypatch):
    tmt, fest = refs
    routes = ingredient_route_reference.IngredientRoutes(
        "fixture-routes", {"doxycycline": {"53": {"atc": "J01AA02", "products_by_form": {"53": "fixture-tablet"}}}}, {},
    )
    monkeypatch.setattr(ingredient_route_reference, "REVIEWED_TMT_RELEASES", {"tmt-test"})
    monkeypatch.setattr(ingredient_route_reference, "load_routes", lambda sha: routes if sha == "test-digest" else None)
    with closing(sqlite3.connect(tmt)) as db:
        db.executescript("""
            ALTER TABLE product ADD COLUMN fest_form TEXT;
            ALTER TABLE product ADD COLUMN active_tmt INTEGER DEFAULT 1;
            INSERT INTO product(tpu,label,composition_status,ddi_status,fest_route,fest_form) VALUES
                ('737856','I-RON','complete','no_exact_fest_product_form_route','53','53'),
                ('441548','SIADOCIN','complete','no_exact_fest_product_form_route','53','891'),
                ('461798','TRAMA','complete','no_exact_fest_product_form_route','53','53'),
                ('432331','RONTIN','complete','mapped','53','891');
            INSERT INTO ingredient VALUES
                ('737856','689632','ferrous fumarate'), ('441548','226372','doxycycline'),
                ('461798','864627','tramadol hydrochloride'), ('432331','322132','gabapentin');
            INSERT INTO product_atc VALUES ('432331','N02BF01');
        """)
    with closing(sqlite3.connect(fest)) as db:
        for key, left, right in [
            ("fixture-iron-doxycycline", "B03AA02", "J01AA02"),
            ("fixture-opioid-class", "N02A", "N02BF01"),
            ("fixture-doxycycline-third-drug", "J01AA", "A01AA01"),
        ]:
            db.execute("INSERT INTO rule SELECT ?,updated,relevance_no,clinical_consequence_no,entry_xml "
                       "FROM rule WHERE id = 'demo-rule'", (key,))
            db.execute("INSERT INTO citation SELECT ?,citation_no,url FROM citation WHERE rule_id = 'demo-rule'",
                       (key,))
            db.executemany("INSERT INTO atc_member VALUES (?,?,?,?)", [
                (key, 1, left, left), (key, 2, right, right),
            ])
        db.commit()
    return tmt, fest


def catalogue_pair(codes=("737856", "441548")):
    request = CatalogueScreeningRequest.model_validate({"rows": [
        {"row_id": str(i), "tpu": code, "release": "tmt-test"} for i, code in enumerate(codes)
    ]})
    return screen_catalogue_list(request).pairs[0]


@pytest.mark.parametrize("reverse", [False, True])
@pytest.mark.parametrize("ids,expected_atcs,rule_id", [
    (("737856", "441548"), (["B03AA02"], ["J01AA02"]), "fixture-iron-doxycycline"),
    (("461798", "432331"), (["N02A"], ["N02BF01"]), "fixture-opioid-class"),
    (("441548", "101"), (["J01AA"], ["A01AA01"]), "fixture-doxycycline-third-drug"),
])
def test_catalogue_reports_ingredient_rule_with_partial_coverage(
    ingredient_route_refs, reverse, ids, expected_atcs, rule_id,
):
    pair = catalogue_pair(ids[::-1] if reverse else ids)
    assert pair.ddi.status == "partial"
    assert pair.duplicate.status == "lookup_complete"
    rule, = pair.ddi.interactions
    assert rule.matched_atcs == (expected_atcs[::-1] if reverse else expected_atcs)
    assert rule.rule_id == rule_id
    assert rule.references[0].title == "Fixture publication"
    assert rule.ingredient_route_match.route == "oral"
    assert rule.ingredient_route_match.references
    assert rule.ingredient_route_match.mapping_version == "fixture-routes"


@pytest.mark.parametrize("edit", [
    "UPDATE product SET fest_route=NULL WHERE tpu='441548'",
    "UPDATE product SET fest_route='52' WHERE tpu='441548'",
    "UPDATE product SET fest_form='842' WHERE tpu='441548'",
    "INSERT INTO ingredient VALUES ('441548','S1','Unreviewed ingredient')",
    "UPDATE product SET active_tmt=0 WHERE tpu='441548'",
])
def test_catalogue_keeps_uncovered_products_unassessed(ingredient_route_refs, edit):
    tmt, _ = ingredient_route_refs
    with closing(sqlite3.connect(tmt)) as db:
        db.execute(edit)
        db.commit()
    assert catalogue_pair().ddi.status == "unassessed"
    assert catalogue_pair().ddi.interactions == []


def test_catalogue_does_not_extend_fallback_to_other_pairs_or_fest_releases(ingredient_route_refs, monkeypatch):
    pair = catalogue_pair(("461798", "441548"))
    assert pair.ddi.status == "unassessed" and not pair.ddi.interactions
    monkeypatch.setattr(ingredient_route_reference, "load_routes", lambda sha: None)
    assert catalogue_pair().ddi.status == "unassessed"


def test_catalogue_does_not_replace_a_conflicting_exact_atc(ingredient_route_refs):
    tmt, _ = ingredient_route_refs
    with closing(sqlite3.connect(tmt)) as db:
        db.execute("UPDATE product_atc SET atc='N03AX12' WHERE tpu='432331'")
        db.commit()
    assert catalogue_pair(("461798", "432331")).ddi.status == "unassessed"


def test_catalogue_fallback_cannot_clear_a_pair_from_a_no_action_rule(ingredient_route_refs):
    _, fest = ingredient_route_refs
    with closing(sqlite3.connect(fest)) as db:
        db.execute("UPDATE rule SET relevance_no='Ingen tiltak nødvendig' WHERE id='fixture-iron-doxycycline'")
        db.commit()
    pair = catalogue_pair()
    assert pair.ddi.status == "unassessed" and not pair.ddi.interactions


def test_reference_checks_release_and_blocks_conflicted_ingredient(tmp_path):
    path = tmp_path / "ingredient-routes.json.gz"
    source = {
        "format_version": 1, "fest_sha256": "test-digest", "ingredients": {},
        "blocked": {"ferrous fumarate": ["53"]},
    }
    path.write_bytes(gzip.compress(json.dumps(source).encode()))
    routes = ingredient_route_reference.load_routes("test-digest", path)
    assert routes is not None
    assert ingredient_route_reference.load_routes("other-release", path) is None
    assert routes.resolve(release="TMTRF20200217", ingredients={"689632": "ferrous fumarate"},
                          form_route=("53", "53"), composition_status="complete",
                          ddi_status="no_exact_fest_product_form_route") is None


def test_ingredient_match_summary_covers_other_members_of_the_fest_class(ingredient_route_refs):
    tmt, fest = ingredient_route_refs
    rule_id = "ID_45F34CDB-4002-4DA6-8846-9F8F00E6A177"
    with closing(sqlite3.connect(tmt)) as db:
        db.execute("UPDATE product_atc SET atc='J01AA06' WHERE tpu='432331'")
        db.commit()
    with closing(sqlite3.connect(fest)) as db:
        db.execute("UPDATE rule SET id=? WHERE id='fixture-iron-doxycycline'", (rule_id,))
        db.execute("UPDATE atc_member SET rule_id=?, atc='J01AA' WHERE rule_id='fixture-iron-doxycycline' AND side=2",
                   (rule_id,))
        db.execute("UPDATE atc_member SET rule_id=? WHERE rule_id='fixture-iron-doxycycline'", (rule_id,))
        db.commit()
    rule, = catalogue_pair(("737856", "432331")).ddi.interactions
    assert "tetracycline antibiotics" in rule.ingredient_route_match.summary_en
    assert "doxycycline" not in rule.ingredient_route_match.summary_en


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


def run(request):
    return screen_local(LocalScreeningRequest.model_validate(request)).model_dump(mode="json")


def test_opposing_groups_hierarchy_citations_partial_scope_and_snapshot(refs):
    request = body()
    result = run(request)
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
    assert result["snapshot_id"] == run(request)["snapshot_id"]
    request["rows"][0]["revision"] += 1
    assert result["snapshot_id"] != run(request)["snapshot_id"]


@pytest.mark.parametrize("field,value", [
    ("normalized_medication_id", "202"), ("normalized_medication_id", "999"),
    ("status", "no_longer_current"), ("status", "uncertain"),
    ("identity", {"value": "Demo Blue tablet", "evidence": {"source_id": "unrelated"}}),
    ("evidence", [{"source_id": "record", "item_id": "item-1"}]),
    ("reviewer", {"id": "clerk", "name": "Fixture clerk", "role": "staff"}),
])
def test_unverified_or_mismatched_product_is_outside_both_checks(refs, field, value):
    request = body(("101", "202"))
    request["rows"][0]["verification"][field] = value
    result = run(request)
    assert result["rows"][0]["reason"]
    assert result["pairs"][0]["ddi"]["status"] == result["pairs"][0]["duplicate"]["status"] == "unassessed"


def test_disputed_identity_needs_a_new_independent_source(refs):
    request = body(("101", "202"))
    row = request["rows"][0]
    ref = row["sources"][0]
    row["discrepancies"] = [dict(id="identity-conflict", field="identity", question="Which item is this?",
                                 observed_values=[{"value": "Demo Blue", "evidence": ref},
                                                  {"value": "Demo Pink", "evidence": ref}])]
    row["verification"]["resolved_discrepancies"] = ["identity-conflict"]
    result = run(request)
    assert result["pairs"][0]["ddi"]["status"] == "unassessed"
    assert "independent" in result["rows"][0]["reason"]


def test_partial_mapping_does_not_clear_or_assert_duplicate(refs):
    pair, = run(body(("101", "303")))["pairs"]
    assert pair["duplicate"]["status"] == pair["ddi"]["status"] == "unassessed"


def test_unassessed_parent_does_not_hide_explicit_opposing_group_rule(refs):
    with closing(sqlite3.connect(refs[1])) as db:
        db.execute("INSERT INTO unassessed VALUES (?,?)", ("demo", '<Entry><InteraksjonIkkeVurdert><Atc V="A01"/></InteraksjonIkkeVurdert></Entry>'))
        db.commit()
    pair, = run(body(("101", "202")))["pairs"]
    assert pair["ddi"]["status"] == "potential" and pair["ddi"]["interactions"][0]["rule_id"] == "demo-rule"
    assert pair["duplicate"]["status"] == "potential"


def test_exact_unassessed_marks_scope_and_retains_any_positive_rule(refs):
    with closing(sqlite3.connect(refs[1])) as db:
        db.execute("INSERT INTO unassessed VALUES (?,?)", ("explicit", '<Entry><InteraksjonIkkeVurdert><Atc V="A01AA01"/></InteraksjonIkkeVurdert></Entry>'))
        db.commit()
    pair, = run(body(("101", "202")))["pairs"]
    assert pair["ddi"]["status"] == "partial" and "unassessed" in pair["ddi"]["reasons"][0]
    assert pair["ddi"]["interactions"][0]["rule_id"] == "demo-rule"
    assert pair["duplicate"]["status"] == "potential"
    with closing(sqlite3.connect(refs[1])) as db:
        db.execute("DELETE FROM atc_member WHERE rule_id='demo-rule'")
        db.commit()
    pair, = run(body(("101", "202")))["pairs"]
    assert pair["ddi"]["status"] == "unassessed" and not pair["ddi"]["interactions"]


def test_no_rule_limited_negative_and_no_pair(refs):
    with closing(sqlite3.connect(refs[1])) as db:
        db.execute("DELETE FROM atc_member WHERE rule_id='demo-rule'")
        db.commit()
    pair, = run(body(("101", "202")))["pairs"]
    assert pair["ddi"]["status"] == "lookup_complete" and not pair["ddi"]["interactions"]
    assert "limited coverage" in pair["ddi"]["reasons"][0]
    assert run(body(("101",)))["pairs"] == []


def test_missing_db_or_stale_crosswalk_fails_closed(refs, monkeypatch, tmp_path):
    with closing(sqlite3.connect(refs[1])) as db:
        db.execute("UPDATE source SET sha256='different'")
        db.commit()
    report = run(body())
    assert report["fest_release"] is None and "different releases" in report["ddi_unavailable_reason"]
    assert report["pairs"][0]["ddi"]["status"] == "unassessed"
    assert report["pairs"][0]["duplicate"]["status"] == "potential"
    monkeypatch.setenv("LOCAL_FEST_DB", str(tmp_path / "missing-fest.sqlite"))
    without_fest = run(body())
    assert "missing" in without_fest["ddi_unavailable_reason"]
    assert without_fest["pairs"][0]["duplicate"]["status"] == "potential"
    missing = tmp_path / "missing.sqlite"
    monkeypatch.setenv("LOCAL_TMT_DB", str(missing))
    with pytest.raises(ReferenceUnavailable):
        run(body())
    assert not missing.exists()


def test_duplicate_row_ids_rejected(refs):
    request = body(("101",))
    request["rows"].append(request["rows"][0])
    with pytest.raises(ValidationError):
        run(request)


def test_changed_product_needs_explicit_current_release_and_reports_single_row_mapping(refs):
    with closing(sqlite3.connect(refs[0])) as db:
        db.execute("UPDATE product SET legacy_status='clinical_fields_changed' WHERE tpu='101'")
        db.commit()
    request = body(("101",))
    stale = run(request)["rows"][0]
    assert stale["tpu"] is None and "changed" in stale["reason"]
    verification = request["rows"][0]["verification"]
    verification["tmt_release"] = "prior-release"
    assert "different TMT release" in run(request)["rows"][0]["reason"]
    verification["tmt_release"] = "tmt-test"
    selected = run(request)["rows"][0]
    assert selected["tpu"] == "101" and selected["composition_status"] == "complete" and selected["ddi_status"] == "mapped"


def test_reference_classed_no_action_does_not_become_an_alert(refs):
    with closing(sqlite3.connect(refs[1])) as db:
        db.execute("UPDATE rule SET relevance_no='Ingen tiltak nødvendig'")
        db.commit()
    ddi = run(body(("101", "202")))["pairs"][0]["ddi"]
    assert ddi["status"] == "lookup_complete"
    assert ddi["interactions"][0]["relevance"] == "Ingen tiltak nødvendig"


@pytest.mark.parametrize("route,expected", [("ophthalmic", "differs"), ("per documented schedule", "cannot be compared")])
def test_explicit_route_conflict_retains_signal_and_prevents_a_negative(refs, route, expected):
    request = body(("101", "202"))
    row = request["rows"][0]
    row["verification"]["route"] = {"value": route, "evidence": row["sources"][0]}
    report = run(request)
    pair, = report["pairs"]
    assert pair["ddi"]["status"] == "partial"
    assert expected in report["rows"][0]["route_note"] and expected in pair["ddi"]["reasons"][0]
    assert pair["ddi"]["interactions"][0]["rule_id"] == "demo-rule"
    assert pair["duplicate"]["status"] == "potential"
    with closing(sqlite3.connect(refs[1])) as db:
        db.execute("DELETE FROM atc_member WHERE rule_id='demo-rule'")
        db.commit()
    pair, = run(request)["pairs"]
    assert pair["ddi"]["status"] == "unassessed"


def test_absent_route_is_explicit_and_form_mapping_gaps_are_human_readable(refs):
    request = body(("101", "202", "303"))
    result = run(request)
    assert "Actual route is missing" in result["rows"][0]["route_note"]
    pair = result["pairs"][1]
    assert pair["ddi"]["status"] == "unassessed"
    assert "exact ingredients, form and catalogue route" in pair["ddi"]["reasons"][0]


def test_structured_component_route_controls_the_gap(refs):
    request = body(("101", "202"))
    row = request["rows"][0]
    ref = row["sources"][0]
    row["verification"]["regimens"] = [{
        "basis": "verified", "component_id": "current-use", "directions_text": "ophthalmic",
        "parse_status": "complete", "route": "ophthalmic",
        "evidence": {"directions_text": ref, "route": ref},
    }]
    assert run(request)["pairs"][0]["ddi"]["status"] == "partial"
    component = row["verification"]["regimens"][0]
    component.update(route="oral", directions_text="oral")
    result = run(request)
    assert result["pairs"][0]["ddi"]["status"] == "potential"
    assert result["rows"][0]["route_note"] is None


@pytest.mark.parametrize("release", [None, "tmt-legacy"])
def test_exact_historical_identity_without_clinical_changes_resolves_current_reference(refs, release):
    request = body(("101", "202"))
    verification = request["rows"][0]["verification"]
    verification.update(tmt_release=release)
    verification["identity"]["value"] = "Blue original presentation"
    report = run(request)
    assert report["rows"][0]["tpu"] == "101" and report["rows"][0]["label"] == "Demo Blue tablet"
    assert report["pairs"][0]["ddi"]["status"] == "potential"
    assert report["pairs"][0]["duplicate"]["status"] == "potential"


@pytest.mark.parametrize("release,label,status", [
    ("tmt-test", "Blue original presentation", "unchanged"),
    ("tmt-legacy", "Demo Blue tablet", "unchanged"),
    ("tmt-legacy", "Pink original presentation", "unchanged"),
    (None, "Blue original", "unchanged"),
    (None, "Blue original presentation", "clinical_fields_changed"),
    ("tmt-legacy", "Blue original presentation", "clinical_fields_changed"),
    ("tmt-legacy", "Blue original presentation", "new_to_legacy"),
    (None, "Blue original presentation", "absent_in_snapshot"),
])
def test_wrong_release_label_or_changed_legacy_selection_remains_unassessed(refs, release, label, status):
    with closing(sqlite3.connect(refs[0])) as db:
        db.execute("UPDATE product SET legacy_status=? WHERE tpu='101'", (status,))
        db.commit()
    request = body(("101", "202"))
    verification = request["rows"][0]["verification"]
    verification.update(tmt_release=release)
    verification["identity"]["value"] = label
    report = run(request)
    assert report["rows"][0]["tpu"] is None and report["rows"][0]["reason"]
    assert report["pairs"][0]["ddi"]["status"] == report["pairs"][0]["duplicate"]["status"] == "unassessed"
