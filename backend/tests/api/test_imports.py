import json
from datetime import UTC, datetime
from pathlib import Path

import pytest
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient

from app.api.imports import create_import_router
from app.schemas.review import ReviewerIdentity
from app.services.hospital import HospitalError, MockHospital
from app.services.import_eligibility import ApprovalLedger

FIXTURE = Path(__file__).parents[1] / "fixtures" / "contracts" / "transfer_case.json"
PHARMACIST = ReviewerIdentity(id="demo-pharmacist", name="Demo pharmacist", role="pharmacist")
DOCTOR = ReviewerIdentity(id="demo-doctor", name="Demo doctor", role="doctor")
STAMP = datetime(2026, 11, 21, 4, 0, tzinfo=UTC)

pytestmark = pytest.mark.anyio


class DemoStore(MockHospital):
    fail_next_write = False

    def write(self, **kwargs):
        if self.fail_next_write:
            self.fail_next_write = False
            raise HospitalError("hospital_unavailable", "Simulated write failure.")
        return super().write(**kwargs)


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture
async def transport():
    hospital = DemoStore(clock=lambda: STAMP)
    reviewer = {"current": PHARMACIST}

    def current_reviewer() -> ReviewerIdentity:
        return reviewer["current"]

    app = FastAPI()
    app.include_router(create_import_router(ApprovalLedger(), hospital, current_reviewer))
    try:
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            yield client, hospital, reviewer
    finally:
        hospital.close()


@pytest.fixture
def request_body():
    fixture = json.loads(FIXTURE.read_text(encoding="utf-8"))
    reviewed, pending = fixture["response"]["rows"][1:]
    identity = reviewed["observed_names"][0]
    reviewed["revision"] = pending["revision"] = 1
    reviewed["verification"] = {
        "reviewer": DOCTOR.model_dump(mode="json"),
        "verified_at": STAMP.isoformat(),
        "status": "no_longer_current",
        "identity": identity,
        "evidence": [identity["evidence"]],
    }
    return {
        "evidence": fixture["request"]["evidence"],
        "retry_token": "demo-retry",
        "selected_row_ids": ["row-b"],
        "rows": [reviewed, pending],
    }


async def approve_reviewed_row(client, body):
    response = await client.post(
        "/imports/approvals", json={"evidence": body["evidence"], "row": body["rows"][0]}
    )
    assert response.status_code == 200, response.text
    body["rows"][0]["approval"] = response.json()


async def test_approved_selected_row_imports_and_can_be_found(transport, request_body):
    client, hospital, _ = transport
    await approve_reviewed_row(client, request_body)
    response = await client.post("/imports", json=request_body)
    assert response.status_code == 200
    receipt = response.json()
    assert receipt == {"imported_at": "2026-11-21T04:00:00Z", "imported_row_ids": ["row-b"]}
    assert len(hospital.lookup(STAMP)) == 1

    lookup = await client.get("/imports", params={"imported_at": receipt["imported_at"]})
    assert lookup.status_code == 200
    snapshot = lookup.json()[0]["snapshot"]
    assert [row["id"] for row in snapshot["rows"]] == ["row-b"]
    assert [source["id"] for source in snapshot["evidence"]["sources"]] == ["label-photo"]
    assert [item["id"] for item in snapshot["evidence"]["items"]] == ["label-b"]


async def test_selecting_the_pending_row_rejects_the_whole_write(transport, request_body):
    client, hospital, _ = transport
    await approve_reviewed_row(client, request_body)
    request_body["selected_row_ids"].append("row-c")
    response = await client.post("/imports", json=request_body)
    assert response.status_code == 422
    assert response.json()["detail"]["row_ids"] == ["row-c"]
    assert hospital.lookup(STAMP) == []


async def test_doctor_cannot_approve_or_import(transport, request_body):
    client, hospital, reviewer = transport
    reviewer["current"] = DOCTOR
    approval = await client.post(
        "/imports/approvals", json={"evidence": request_body["evidence"], "row": request_body["rows"][0]}
    )
    assert approval.status_code == 403
    response = await client.post("/imports", json=request_body)
    assert response.status_code == 403
    assert hospital.lookup(STAMP) == []


async def test_failed_import_is_recoverable_and_retries_return_one_receipt(transport, request_body):
    client, hospital, _ = transport
    await approve_reviewed_row(client, request_body)
    hospital.fail_next_write = True
    failed = await client.post("/imports", json=request_body)
    assert failed.status_code == 503
    assert failed.json()["detail"]["recoverable"] is True
    assert hospital.lookup(STAMP) == []

    first = await client.post("/imports", json=request_body)
    second = await client.post("/imports", json=request_body)
    assert first.status_code == second.status_code == 200
    assert first.json() == second.json()
    assert len(hospital.lookup(STAMP)) == 1
