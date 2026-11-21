import json
from copy import deepcopy
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


@pytest.fixture
def disputed_identity_body(request_body):
    row = request_body["rows"][0]
    original = row["observed_names"][0]
    row["sources"].append({"source_id": "ward-record"})
    row["discrepancies"] = [{
        "id": "possible-wrong-label",
        "field": "identity",
        "observed_values": [original, {"value": "Demo C", "evidence": {"source_id": "ward-record"}}],
        "question": "Which item did the pharmacy dispense?",
    }]
    request_body["evidence"]["sources"].append({"id": "dispensing-log", "kind": "reviewer_record"})
    request_body["evidence"]["items"].append({
        "id": "confirmation", "source_id": "dispensing-log", "row_id": row["id"], "kind": "record_excerpt",
    })
    confirmation = {"source_id": "dispensing-log", "item_id": "confirmation"}
    row["verification"].update({
        "identity": {"value": "Demo B", "evidence": confirmation},
        "resolved_discrepancies": ["possible-wrong-label"],
        "identity_resolutions": [{
            "discrepancy_id": "possible-wrong-label",
            "evidence": confirmation,
            "documented_name": "Demo B",
            "identity_basis": "dispensing_confirmation",
            "finding": "The pharmacist matched synthetic bag B-021 to Demo B in the dispensing log.",
        }],
    })
    return request_body


def use_second_crop(body):
    source = body["evidence"]["sources"][-1]
    item = body["evidence"]["items"][-1]
    source.update({"kind": "additional_photo", "attachment_id": "demo-photo-1"})
    item["kind"] = "label_region"
    resolution = body["rows"][0]["verification"]["identity_resolutions"][0]
    resolution.update({
        "identity_basis": "matched_original_package",
        "finding": "Read Demo B from a second crop of the original photo.",
    })


@pytest.mark.parametrize("problem, code", [
    ("shared_attachment", "independent_identity_evidence_required"),
    ("other_row", "invalid_evidence"),
    ("unavailable", "invalid_evidence"),
    ("different_verified_name", "independent_identity_evidence_required"),
    ("different_finding_name", "independent_identity_evidence_required"),
])
async def test_disputed_identity_requires_an_available_independent_item(transport, disputed_identity_body, problem, code):
    client, hospital, _ = transport
    body = disputed_identity_body
    if problem == "shared_attachment":
        use_second_crop(body)
    elif problem == "other_row":
        body["evidence"]["items"][-1]["row_id"] = "row-a"
    elif problem == "unavailable":
        body["evidence"]["sources"][-1].update({"availability": "unavailable", "unavailable_reason": "Pending"})
        body["evidence"]["items"].pop()
    elif problem == "different_verified_name":
        body["rows"][0]["verification"]["identity"]["value"] = "Demo C"
    else:
        resolution = body["rows"][0]["verification"]["identity_resolutions"][0]
        resolution["finding"] = "The pharmacist matched synthetic bag B-021 to Demo C in the dispensing log."
    approval = await client.post("/imports/approvals", json={"evidence": body["evidence"], "row": body["rows"][0]})
    assert approval.status_code == 422
    assert approval.json()["detail"]["code"] == code
    response = await client.post("/imports", json=body)
    assert response.status_code == 422
    assert response.json()["detail"]["code"] == "approval_required"
    assert hospital.lookup(STAMP) == []


async def test_independent_dispensing_confirmation_imports_only_the_approved_snapshot(transport, disputed_identity_body):
    client, hospital, _ = transport
    await approve_reviewed_row(client, disputed_identity_body)

    edited = deepcopy(disputed_identity_body)
    use_second_crop(edited)
    rejected = await client.post("/imports", json=edited)
    assert rejected.status_code == 422
    assert rejected.json()["detail"]["code"] == "approval_required"
    assert hospital.lookup(STAMP) == []

    imported = await client.post("/imports", json=disputed_identity_body)
    assert imported.status_code == 200
    assert imported.json() == {"imported_at": "2026-11-21T04:00:00Z", "imported_row_ids": ["row-b"]}
    [record] = hospital.lookup(STAMP)
    [row] = record.snapshot.rows
    assert row.verification.identity_resolutions[0].evidence.source_id == "dispensing-log"
    assert any(item.id == "confirmation" for item in record.snapshot.evidence.items)
