import json
from pathlib import Path

import pytest
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient

from app.api.checks import router
from app.schemas.checks import CheckSummary

FIXTURE = Path(__file__).parents[1] / "fixtures" / "contracts" / "transfer_case.json"

pytestmark = pytest.mark.anyio


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture
async def client():
    app = FastAPI()
    app.include_router(router)
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as http:
        yield http


@pytest.fixture
def transfer():
    return json.loads(FIXTURE.read_text(encoding="utf-8"))


@pytest.fixture
def rows(transfer):
    result = transfer["response"]
    demo_rows = result["rows"]
    for row in demo_rows:
        row["revision"] = 1
    for row, medication_id in zip(demo_rows, ("demo-a", "demo-b")):
        observed_name = row["observed_names"][0]
        identity = {**observed_name, "evidence": observed_name["evidence"].copy()}
        source = identity["evidence"]
        row["verification"] = {
            "reviewer": {"id": "doctor-fixture", "name": "Demo doctor", "role": "doctor"},
            "verified_at": "2026-11-21T04:00:00Z",
            "status": "current",
            "identity": identity,
            "normalized_medication_id": medication_id,
            "dose": {"value": "fixture dose", "evidence": source},
            "route": {"value": "fixture route", "evidence": source},
            "frequency": {"value": "fixture schedule", "evidence": source},
            "evidence": [source],
            "resolved_discrepancies": [item["id"] for item in row.get("discrepancies", [])],
        }
    return demo_rows


async def run(client, transfer, *, kind, rows, enabled=True, context=None):
    response = await client.post(
        "/checks",
        json={
            "kind": kind, "enabled": enabled, "rows": rows, "context": context or {},
            "evidence": transfer["request"]["evidence"],
        },
    )
    assert response.status_code == 200, response.text
    return CheckSummary.model_validate(response.json())


async def test_supported_pair_plus_unknown_is_partial(client, transfer, rows):
    result = await run(client, transfer, kind="DDI", rows=rows)
    assert result.status == "partial"
    assert result.ran_at is not None
    assert result.simulated is True
    assert result.source.version == "demo-v1"
    assert [scope.row_ids for scope in result.evaluated] == [["row-a", "row-b"]]
    assert all("row-c" in item.scope.row_ids for item in result.excluded)
    assert all("Current use" in item.reason for item in result.excluded)
    assert result.findings[0].scope == result.evaluated[0]


async def test_drp_skips_rule_without_context(client, transfer, rows):
    result = await run(client, transfer, kind="DRP", rows=rows[:1])
    assert result.status == "unavailable"
    assert result.ran_at is None
    assert result.evaluated == []
    assert result.excluded[0].scope.rule_id == "synthetic-regimen-review"
    assert "context is missing" in result.excluded[0].reason


async def test_drp_with_fixture_context_can_complete_without_findings(client, transfer, rows):
    result = await run(client, transfer, kind="DRP", rows=rows[:1], context={"fixture_context": "present"})
    assert result.status == "complete"
    assert result.findings == []
    assert len(result.evaluated) == 1


async def test_disabled_check_has_no_evaluated_scope(client, transfer, rows):
    result = await run(client, transfer, kind="DDI", rows=rows, enabled=False)
    assert result.status == "not_run"
    assert result.ran_at is None
    assert result.evaluated == []
    assert result.excluded == []


@pytest.mark.parametrize(("invalid_rows", "code"), [("duplicate", "duplicate_row"), ("empty", "empty_scope")])
async def test_invalid_scope_is_rejected(client, transfer, rows, invalid_rows, code):
    response = await client.post("/checks", json={
        "kind": "DDI", "enabled": True, "rows": rows[:1] * 2 if invalid_rows == "duplicate" else [],
        "evidence": transfer["request"]["evidence"],
    })
    assert response.status_code == 422
    assert response.json()["detail"]["code"] == code


@pytest.mark.parametrize("reference", [
    {"source_id": "reverse-photo", "item_id": "pill-c"},
    {"source_id": "label-photo", "item_id": "label-b"},
])
async def test_ddi_excludes_identity_from_wrong_item_or_appearance(client, transfer, rows, reference):
    rows[0]["verification"]["identity"]["evidence"] = reference
    result = await run(client, transfer, kind="DDI", rows=rows[:2])
    assert result.status == "unavailable"
    assert result.evaluated == result.findings == []
    assert "evidence" in result.excluded[0].reason


async def test_drp_excludes_dose_with_unknown_source(client, transfer, rows):
    rows[0]["verification"]["dose"]["evidence"] = {"source_id": "unknown"}
    result = await run(client, transfer, kind="DRP", rows=rows[:1], context={"fixture_context": "present"})
    assert result.status == "unavailable"
    assert "traceable evidence" in result.excluded[0].reason
