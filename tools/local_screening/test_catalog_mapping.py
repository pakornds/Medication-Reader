"""Small, self-contained regression cases for the offline catalogue builder."""

from zipfile import ZipFile

from build_catalog_mapping import legacy_outcome, load_fest, resolve, tmt_composition

A = "Ingredient A"
B = "Ingredient B"
TABLET = "film-coated tablet"


def test_complete_group_requires_agreement_of_master_and_all_tmt_links():
    graph = [{"tpu": {"gpu"}}, {"gpu": {"gp"}}, {"gp": {"vtm"}}, {"vtm": {"1", "2"}}]
    subs = {"1": A, "2": B}
    assert tmt_composition("tpu", A + " + " + B, graph, subs) == ("complete", list(subs.items()))
    assert tmt_composition("tpu", A, graph, subs)[0] == "master_graph_disagreement"
    assert tmt_composition("tpu", A, graph, {})[0] == "missing_substance_links"
    graph[2]["gp"].add("another-vtm")
    assert tmt_composition("tpu", A, graph, subs)[0] == "ambiguous_or_missing_product_chain"


def test_historical_release_gate_is_independent_of_current_mapping():
    assert legacy_outcome("unchanged", "complete", "mapped") == ("complete", "mapped")
    assert legacy_outcome("clinical_fields_changed", "complete", "mapped") == (
        "legacy_reconfirmation_required", "legacy_reconfirmation_required",
    )


def test_aggregate_single_code_does_not_establish_constituent_composition():
    graph = [{"tpu": {"gpu"}}, {"gpu": {"gp"}}, {"gp": {"vtm"}}, {"vtm": {"1"}}]
    for name in ("vitamin B complex", "factor ix complex", "ossein mineral complex", "amino acids",
                 "electrolytes", "carbohydrates", "lipids", "trace elements", "natural mixed carotenoids"):
        assert tmt_composition("tpu", name, graph, {"1": name}) == (
            "complex_substance_needs_review", [("1", name)],
        )


def test_conservative_mapping_never_strips_salts_or_picks_an_ambiguous_code():
    names = {A.lower(): {"a"}}
    index = {(("a",), "53", "53"): {("f1", (("a", "C10AA01"),)), ("f2", (("a", "D01AA01"),))}}
    assert resolve("complete", [("1", A)], TABLET, names, index)[0] == "ambiguous_atc"
    assert resolve("complete", [("1", A + " sulfate")], TABLET, names, index)[0] == "no_exact_fest_substance"
    assert resolve("complete", [("1", A)], "solution for injection", names, index)[0] == "form_route_unmapped"
    assert resolve("complete", [("1", A)], "eye drops, solution", names, index)[0] == "no_exact_fest_product_form_route"
    assert resolve("missing_substance_links", [("1", A)], TABLET, names, index)[0] == "composition_unresolved"
    names[A.lower()].add("different-source-id")
    assert resolve("complete", [("1", A)], TABLET, names, index)[0] == "fest_substance_ambiguous"


def drug(code, group, sid, ingredients, route="53", status="A"):
    refs = "".join(f"<SortertVirkestoffMedStyrke><RefVirkestoffMedStyrke>{ref}</RefVirkestoffMedStyrke>"
                   "</SortertVirkestoffMedStyrke>" for ref in ingredients)
    return (f'<OppfLegemiddelMerkevare><Status V="{status}"/><LegemiddelMerkevare><Id>{sid}</Id>'
            f'<Atc S="2.16.578.1.12.4.1.1.7180" V="{code}"/><LegemiddelformKort S="2.16.578.1.12.4.1.1.7448" V="{group}"/>'
            f'<AdministreringLegemiddel><Administrasjonsvei S="2.16.578.1.12.4.1.1.7477" V="{route}"/></AdministreringLegemiddel>'
            f'{refs}</LegemiddelMerkevare></OppfLegemiddelMerkevare>')


def fest_file(tmp_path, products, b_atc="C10AA02"):
    body = []
    terms = []
    for i, (name, code) in enumerate([(A, "C10AA01"), (B, b_atc)], 1):
        body.append(f'<OppfVirkestoff><Status V="A"/><Virkestoff><Id>i{i}</Id><NavnEngelsk>{name}</NavnEngelsk>'
                    f'</Virkestoff></OppfVirkestoff>')
        body.append(f'<OppfVirkestoff><Status V="A"/><VirkestoffMedStyrke><Id>s{i}</Id><RefVirkestoff>i{i}</RefVirkestoff>'
                    f'<AtcKombipreparat S="2.16.578.1.12.4.1.1.7180" V="{code}"/></VirkestoffMedStyrke></OppfVirkestoff>')
        terms.append(f'<Element><Kode>{code}</Kode><Term><Term>{name}</Term><Sprak V="EN"/></Term></Element>')
    terms.append('<Element><Kode>C10AA09</Kode><Term><Term>Other substances</Term><Sprak V="EN"/></Term></Element>')
    body.append('<OppfKodeverk><Status V="A"/><Info><Id>2.16.578.1.12.4.1.1.7180</Id></Info>'
                + "".join(terms) + "</OppfKodeverk>")
    z = tmp_path / "release.zip"
    with ZipFile(z, "w") as archive:
        archive.writestr("FEST.xml", "<FEST>" + "".join(body + products) + "</FEST>")
    return z


def test_exact_leaf_and_complete_combo_have_individual_source_records(tmp_path):
    example = fest_file(tmp_path, [
        drug("C10AA01", "53", "oral", ["s1"]),
        drug("C10AA09", "53", "retired", ["s1"], status="U"),
        drug("C10AA09", "53", "eye", ["s1"], route="52"),
        drug("X99CC99", "53", "combo", ["s1", "s2"]),
    ])
    names, idx, _ = load_fest(example)
    result = resolve("complete", [("thai-1", A)], TABLET, names, idx)
    assert result == ("mapped", ["C10AA01"], [("oral", (("i1", "C10AA01"),))])
    result = resolve("complete", [("thai-1", A), ("thai-2", B)], TABLET, names, idx)
    assert result == ("mapped", ["C10AA01", "C10AA02"], [("combo", (("i1", "C10AA01"), ("i2", "C10AA02")))])


def test_uncovered_leaf_class_or_partial_combination_remain_excluded(tmp_path):
    example = fest_file(tmp_path, [
        drug("C10AA09", "53", "other-agents-class", ["s1"]),
        drug("C10AA01", "53", "good", ["s1"]),
        drug("X99CC99", "53", "combo", ["s1", "s2"]),
    ], b_atc="C10AA")
    names, idx, _ = load_fest(example)
    assert resolve("complete", [("1", A)], TABLET, names, idx)[0] == "component_atc_unsupported"
    assert resolve("complete", [("1", A), ("2", B)], TABLET, names, idx)[0] == "component_atc_unsupported"


def test_generated_database_and_csv_separate_fresh_select_from_changed_legacy(tmp_path, monkeypatch):
    import csv
    import json
    import sqlite3
    from contextlib import closing
    import build_catalog_mapping as builder

    release = "TMTRF20261116"
    base = tmp_path / release
    bonus = base / (release + "_BONUS")
    stamp = release.removeprefix("TMTRF")
    data = {
        base / release / (release + "_SNAPSHOT.xls"): [{"TMTID(TPU)": "10", "FSN": "A tablet"}],
        bonus / ("MasterTMT_" + stamp + ".xls"): [
            {"TPUCode": "10", "FSN": "A tablet", "ActiveIngredient": A, "Dosageform": TABLET, "Strength": "20 mg"}
        ],
        bonus / "Concept" / ("SUBS" + stamp + ".xls"): [{"TMTID(SUBS)": "5", "FSN": A + " (SUBS)"}],
    }
    for parent, child, first, second in [("GPU", "TPU", "20", "10"), ("GP", "GPU", "30", "20"),
                                         ("VTM", "GP", "40", "30"), ("SUBS", "VTM", "5", "40")]:
        data[bonus / "Relationship" / (parent + "to" + child + stamp + ".xls")] = [{parent + "ID": first, child + "ID": second}]
    for path in data:
        path.parent.mkdir(exist_ok=True, parents=True)
        path.write_text("synthetic workbook loader fixture")
    monkeypatch.setattr(builder, "workbook", lambda path: data[path])
    legacy = tmp_path / "old.json"
    item = dict(tmt_id="10", generic_name=A, dosage_form=TABLET, strength="10 mg", label="A tablet old")
    legacy.write_text(json.dumps({"metadata": {"release": "TMTRF20200217"}, "medicines": [item, item | {"tmt_id": "11"}]}))
    fest = fest_file(tmp_path, [drug("C10AA01", "53", "f", ["s1"])])
    out = tmp_path / "results"
    report = builder.build(base, release, legacy, fest, out)
    with closing(sqlite3.connect(out / "tmt-fest-mapping.sqlite")) as db:
        assert db.execute("SELECT composition_status,ddi_status,legacy_status FROM product WHERE tpu='10'").fetchone() == (
            "complete", "mapped", "clinical_fields_changed",
        )
        assert db.execute("SELECT tpu,atc FROM product_atc").fetchall() == [("10", "C10AA01")]
        assert db.execute("SELECT label,legacy_label FROM product WHERE tpu='10'").fetchone() == (
            "A tablet", "A tablet old",
        )
        assert db.execute("SELECT key,value FROM metadata WHERE key='tmt_release'").fetchone() == ("tmt_release", release)
    assert report["counts"]["legacy"]["ddi"] == {"inactive_or_missing_tpu": 1, "legacy_reconfirmation_required": 1}
    assert report["counts"]["active"]["ddi"] == {"mapped": 1}
    with (out / "tmt-fest-products.csv").open() as file:
        fresh, missing = list(csv.DictReader(file))
    assert (fresh["ddi_status"], fresh["legacy_ddi_status"]) == ("mapped", "legacy_reconfirmation_required")
    assert missing["active_tmt"] == "0"
