from build_ingredient_routes import ingredient_routes


def test_only_unique_complete_same_route_evidence_is_exported():
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
    assert ingredients == {"single": {
        "53": {"atc": "A01AA01", "products_by_form": {"53": "t1"}},
        "52": {"atc": "S01AA01", "products_by_form": {"721": "e1"}},
    }}
    assert blocked == {"ambiguous": ["*"], "conflicting": ["53"], "incomplete": ["53"]}
