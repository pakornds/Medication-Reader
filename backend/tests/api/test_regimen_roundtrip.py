from copy import deepcopy

import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.regimen_demo import create_app

LABEL = {"source_id": "label", "item_id": "region"}
REPORT = {"source_id": "interview", "item_id": "statement"}
EVIDENCE = {
    "case_id": "synthetic-regimen",
    "sources": [
        {"id": "label", "kind": "label_photo"},
        {"id": "interview", "kind": "patient_report"},
    ],
    "items": [
        {"source_id": "label", "id": "region", "row_id": "r1", "kind": "label_region"},
        {"source_id": "interview", "id": "statement", "row_id": "r1", "kind": "record_excerpt"},
    ],
}


def parse_request(text, *, basis="documented", source=LABEL):
    return dict(evidence=EVIDENCE, row_id="r1", component_id=basis,
                basis=basis, directions_text=text, source=source)


def parsed(client, text, **kwargs):
    response = client.post("/regimens/parse", json=parse_request(text, **kwargs))
    assert response.status_code == 200, response.text
    return response.json()["regimens"][0]


def test_parser_keeps_unstated_fields_blank_and_original_wording():
    with TestClient(app) as client:
        component = parsed(client, "1 tablet each morning")
        assert component["parse_status"] == "complete"
        assert (component["dose_amount"], component["dose_unit"]) == (1, "tablet")
        assert (component["frequency_count"], component["period_value"], component["period_unit"]) == (1, 1, "day")
        assert component["time_of_day"] == ["morning"]
        assert component["route"] is component["meal_relation"] is component["as_needed"] is None
        assert component["evidence"]["time_of_day"] == LABEL
        ambiguous = parsed(client, "follow the attached plan")
        assert ambiguous["parse_status"] == "unparsed"
        assert ambiguous["unparsed_text"] == ambiguous["directions_text"] == "follow the attached plan"
        assert ambiguous["dose_amount"] is None


@pytest.mark.parametrize("change", [
    {"row_id": "other-row"},
    {"source": {"source_id": "label"}},
    {"basis": "reported"},
    {"basis": "verified"},
])
def test_invalid_source_or_basis_cannot_seed_a_regimen(change):
    with TestClient(app) as client:
        body = parse_request("1 tablet each morning") | change
        assert client.post("/regimens/parse", json=body).status_code == 422


def test_edit_verify_approve_and_read_back_the_exact_regimen():
    with TestClient(create_app()) as client:
        documented = parsed(client, "1 tablet each morning")
        reported = parsed(client, "1 tablet each evening", basis="reported", source=REPORT)
        verified = deepcopy(documented)
        verified.update(component_id="actual", basis="verified", directions_text="1 tablet each evening",
                        time_of_day=["evening"], route="oral")
        verified["evidence"].update(directions_text=REPORT, time_of_day=REPORT, route=REPORT)
        identity = {"value": "Demo tablet", "evidence": LABEL}
        row = dict(id="r1", revision=2, identity_status="named", sources=[LABEL, REPORT],
                   observed_names=[identity], regimens=[documented, reported],
                   verification=dict(reviewer={"id": "dr", "name": "Fixture reviewer", "role": "doctor"},
                                     verified_at="2026-11-21T08:00:00Z", status="current",
                                     identity=identity, evidence=[LABEL, REPORT], regimens=[verified]))
        approval_request = {"row": row, "evidence": EVIDENCE}
        incomplete = deepcopy(approval_request)
        incomplete_component = incomplete["row"]["verification"]["regimens"][0]
        incomplete_component["route"] = None
        del incomplete_component["evidence"]["route"]
        assert client.post("/imports/approvals", json=incomplete).json()["detail"]["code"] == "regimen_required"
        approval = client.post("/imports/approvals", json=approval_request)
        assert approval.status_code == 200, approval.text
        row["approval"] = approval.json()
        request = dict(evidence=EVIDENCE, rows=[row], selected_row_ids=["r1"], retry_token="first")
        stale = deepcopy(request)
        stale["rows"][0]["verification"]["regimens"][0]["time_of_day"] = ["noon"]
        assert client.post("/imports", json=stale).json()["detail"]["code"] == "approval_required"
        receipt = client.post("/imports", json=request)
        assert receipt.status_code == 200, receipt.text
        assert client.post("/imports", json=request).json() == receipt.json()
        records = client.get("/imports", params={"imported_at": receipt.json()["imported_at"]}).json()
        assert len(records) == 1
        stored = records[0]["snapshot"]
        assert stored["rows"][0]["regimens"] == [documented, reported]
        assert stored["rows"][0]["verification"]["regimens"] == [verified]
        assert stored["evidence"]["items"] == EVIDENCE["items"]
