from zipfile import ZipFile

from build_ingredient_routes import explicitly_oral_atcs, ingredient_routes, main_ingredient_links, unii_aliases


def test_complete_same_route_evidence_includes_all_documented_classifications():
    names = {
        "single": {"one"}, "conflicting": {"two"}, "incomplete": {"three"},
        "ambiguous": {"five", "six"}, "combination only": {"seven"},
    }
    formulations = {
        (("one",), "53", "53"): {("t2", (("one", "A01AA01"),)), ("t1", (("one", "A01AA01"),))},
        (("one",), "721", "52"): {("e1", (("one", "S01AA01"),))},
        (("two",), "53", "53"): {("t1", (("two", "B01AA01"),))},
        (("two",), "891", "53"): {("t2", (("two", "B01AA02"),))},
        (("three",), "53", "53"): {("t1", (("three", "C01AA01"),))},
        (("three",), "891", "53"): {("t2", ())},
        (("five",), "53", "53"): {("t1", (("five", "D01AA01"),))},
        (("one", "seven"), "53", "53"): {("combo", (("one", "A01AA02"), ("seven", "D01AA01")))},
    }
    ingredients, blocked = ingredient_routes(names, formulations)
    assert ingredients == {
        "single": {"53": {"A01AA01": {"53": "t1"}}, "52": {"S01AA01": {"721": "e1"}}},
        "conflicting": {"53": {"B01AA01": {"53": "t1"}, "B01AA02": {"891": "t2"}}},
    }
    assert blocked == {"ambiguous": ["*"], "incomplete": ["53"]}


def test_therapeutic_links_require_one_explicit_unambiguous_target():
    names = {
        "full ingredient": {"full"}, "main ingredient": {"main"},
        "ambiguous parent": {"other1", "other2"}, "other full ingredient": {"otherfull"},
    }
    assert main_ingredient_links(names, {
        "full": {"main"}, "otherfull": {"main", "other1"}, "other1": {"main"}, "main": {"main"},
    }) == {
        "full ingredient": {"target": "main ingredient", "precise_id": "full", "parent_id": "main"},
    }


def test_unii_aliases_reject_ambiguous_names_and_distinct_substances(tmp_path):
    archive = tmp_path / "UNIIs.zip"
    with ZipFile(archive, "w") as data:
        data.writestr("UNII_Names_fixture.txt", "NAME\tTYPE\tUNII\n"
                      "ingredient\tof\tAA\n"
                      "Common Name\tcn\tAA\n"
                      "ingredient sodium\tof\tBB\n"
                      "ambiguous name\tcn\tAA\n"
                      "ambiguous name\tsy\tBB\n"
                      "other ingredient\tof\tCC\n"
                      "different ingredient\tsy\tCC\n"
                      "ambiguous destination\tcn\tCC\n")
    aliases, release = unii_aliases(archive, {
        "ingredient": {"1"}, "other ingredient": {"2"}, "different ingredient": {"3"},
    })
    assert release == "fixture"
    assert aliases == {"common name": {"target": "ingredient", "unii": "AA"}}


def test_codebook_route_requires_a_unique_exact_leaf_in_an_explicit_oral_group():
    names = {"one": {"id1"}, "two": {"id2"}, "three": {"id3"}, "four": {"id4", "id5"}}
    codebook = {
        "A01AA": {"fixture group, oral preparations"},
        "A01AA01": {"one"}, "A01AA02": {"two"}, "A01AA03": {"four"},
        "B01AA": {"fixture group, parenteral preparations"},
        "B01AA01": {"two"}, "B01AA02": {"three"},
    }
    assert explicitly_oral_atcs(names, codebook) == {"one": {"atc": "A01AA01", "group": "A01AA"}}
