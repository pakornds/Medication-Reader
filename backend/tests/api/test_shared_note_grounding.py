"""Exercise the real form endpoint with controlled provider proposals for a shared note."""

import json

import pytest
from fastapi.testclient import TestClient

from app.main import create_app


def submit_note(note, strengths, *, discrepancy=None, names=("Demo A", "Demo B"), field="strength"):
    reference = {"source_id": "ward"}
    form = {
        "evidence": {"case_id": "transfer", "sources": [{"id": "ward", "kind": "transfer_record"}]},
        "other_source_notes": [{"value": note, "evidence": reference}],
    }
    rows = [
        {
            "id": f"row-{index}", "identity_status": "named", "sources": [reference],
            "observed_names": [{"value": name, "evidence": reference}],
            "label_fields": {field: {"status": "readable", "value": strength, "evidence": reference}},
        }
        for index, (name, strength) in enumerate(zip(names, strengths, strict=True))
    ]
    if discrepancy:
        rows[0]["discrepancies"] = [{
            "id": "ward-comparison", "field": "strength", "question": "Which is supported?",
            "observed_values": [{"value": value, "evidence": reference} for value in discrepancy],
        }]

    class FixtureProvider:
        def generate(self, *, output_type, evidence_text, **kwargs):
            assert json.loads(evidence_text)["other_source_notes"][0]["value"] == note
            return output_type.model_validate({"case_id": "transfer", "rows": rows})

    with TestClient(create_app(get_provider=FixtureProvider)) as client:
        result = client.post("/medication-analysis", files={"form": (None, json.dumps(form), "application/json")})
    assert result.status_code == 200, result.text
    return result.json()["rows"]


@pytest.mark.parametrize(("proposed", "expected"), [
    (("5 mg", "10 mg"), ["5 mg", "10 mg"]),
    (("10 mg", "5 mg"), [None, None]),
])
def test_two_strengths_in_shared_note(proposed, expected):
    rows = submit_note("Demo A 5 mg. Demo B 10 mg.", proposed)
    assert [row["label_fields"]["strength"]["value"] for row in rows] == expected
    for row, value in zip(rows, expected, strict=True):
        if value is None:
            assert any(item["field"] == "strength" for item in row["follow_ups"])
        else:
            assert row["label_fields"]["strength"]["evidence"]["source_id"] == "ward"


@pytest.mark.parametrize("note", [
    "Demo A and Demo B: 5 mg or 10 mg.",
    "Demo A. Demo B. Strengths were 5 mg and 10 mg.",
])
def test_ambiguous_statements_require_clarification(note):
    rows = submit_note(note, ("5 mg", "10 mg"))
    assert all(row["label_fields"]["strength"]["status"] == "missing" for row in rows)


def test_repeated_name_and_partial_numeric_matches():
    rows = submit_note("Demo A 5 mg; Demo A 10 mg", ("5 mg", "10 mg"), names=("Demo A", "Demo A"))
    assert all(row["label_fields"]["strength"]["status"] == "missing" for row in rows)
    rows = submit_note("Demo A 0.5 mg\nDemo B 15 mg", ("5 mg", "5 mg"))
    assert all(row["label_fields"]["strength"]["status"] == "missing" for row in rows)


def test_discrepancies_require_both_values_on_the_same_medicine():
    note = "Demo A 5 mg. Demo A 7 mg. Demo B 10 mg."
    good = submit_note(note, ("5 mg", "10 mg"), discrepancy=("5 mg", "7 mg"))
    crossed = submit_note(note, ("5 mg", "10 mg"), discrepancy=("5 mg", "10 mg"))
    assert [item["value"] for item in good[0]["discrepancies"][0]["observed_values"]] == ["5 mg", "7 mg"]
    assert crossed[0]["discrepancies"] == []
    assert any(item["field"] == "strength" for item in crossed[0]["follow_ups"])


@pytest.mark.parametrize("separator", [", ", " and ", " "])
def test_unreturned_medicine_cannot_supply_fields_or_discrepancy_values(separator):
    note = f"Demo A 5 mg{separator}Demo B 10 mg."
    row, = submit_note(note, ["10 mg"], names=["Demo A"], discrepancy=["5 mg", "10 mg"])
    assert row["label_fields"]["strength"]["status"] == "missing"
    assert row["discrepancies"] == []
    row, = submit_note(note, ["5 mg"], names=["Demo A"])
    assert row["label_fields"]["strength"]["value"] == "5 mg"


def test_directions_belong_to_the_named_medicine_even_when_one_row_is_returned():
    note = "Demo A directions: once daily and Demo B directions: every evening."
    good, = submit_note(note, ["once daily"], field="directions", names=["Demo A"])
    crossed, = submit_note(note, ["every evening"], field="directions", names=["Demo A"])
    assert good["label_fields"]["directions"]["value"] == "once daily"
    assert crossed["label_fields"]["directions"]["status"] == "missing"
    assert not crossed["regimens"]
    merged, = submit_note(note, ["once daily and Demo B directions: every evening"],
                          field="directions", names=["Demo A"])
    assert merged["label_fields"]["directions"]["status"] == "missing"


def test_directions_after_a_documented_strength_keep_their_sources():
    rows = submit_note("Demo A 5 mg once daily. Demo B 10 mg each evening.",
                       ["once daily", "each evening"], field="directions")
    assert [r["label_fields"]["directions"]["value"] for r in rows] == ["once daily", "each evening"]
