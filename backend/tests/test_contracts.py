import json
from pathlib import Path

import pytest
from pydantic import ValidationError

from app.schemas.analysis import (
    AnalysisRequest,
    AnalysisResult,
    EvidenceValidationError,
    validate_analysis_result,
)
from app.schemas.checks import CheckSummary
from app.schemas.openapi import contract_openapi
from app.schemas.pills import CandidateResult
from app.schemas.review import ImportReceipt, ImportRequest, ReviewerIdentity, ServiceError

FIXTURES = Path(__file__).parent / "fixtures" / "contracts"


@pytest.fixture
def transfer():
    return json.loads((FIXTURES / "transfer_case.json").read_text(encoding="utf-8"))


def test_transfer_preserves_independent_origins_and_unknowns(transfer):
    request = AnalysisRequest.model_validate(transfer["request"])
    result = validate_analysis_result(
        AnalysisResult.model_validate(transfer["response"]), request.evidence
    )
    sources = {source.id: source for source in request.evidence.sources}
    assert sources["label-photo"].organization == "ศักดาเวชการ"
    assert sources["label-photo"].contact == "075-356XXXX"
    assert sources["label-photo"].organization_phone == "075-356XXXX"
    assert sources["label-photo"].organization_phone_extension == "12"
    assert sources["label-photo"].organization_address == "99 ถนนตัวอย่าง เขตสมมติ"
    assert sources["ward-record"].organization_type == "hospital"
    assert sources["ward-record"].organization_email == "ward@example.invalid"
    assert sources["ward-record"].organization_phone is None
    assert sources["ward-record"].department_or_ward == "Demo Ward 2"
    assert sources["patient-account"].reporter == "Demo patient"
    assert sources["patient-account"].collector == "Demo intake nurse"
    assert sources["prior-clinic"].availability == "unavailable"

    row, _, unknown = result.rows
    assert [name.value for name in row.observed_names] == ["เดโมเอ", "Demo A"]
    assert row.label_fields["directions"].evidence.source_id == "label-photo"
    assert row.reported_use[0].evidence.source_id == "patient-account"
    assert row.label_fields["expiry"].value is None
    assert row.discrepancies[0].observed_values[1].evidence.source_id == "ward-record"
    assert unknown.identity_status == "unlabeled"
    assert unknown.reverse_crop.item_id == "pill-c"
    assert unknown.dispensing_source_id is None


def test_medication_name_requires_evidence(transfer):
    del transfer["response"]["rows"][0]["observed_names"][0]["evidence"]
    with pytest.raises(ValidationError, match="evidence"):
        AnalysisResult.model_validate(transfer["response"])


@pytest.mark.parametrize(
    ("reference", "message"),
    [
        ({"source_id": "another-case"}, "unavailable or unknown source"),
        ({"source_id": "prior-clinic"}, "unavailable or unknown source"),
        ({"source_id": "label-photo"}, "requires a located item"),
        ({"source_id": "label-photo", "item_id": "label-b"}, "does not belong to row"),
    ],
)
def test_rejects_unsupported_photo_claims(transfer, reference, message):
    request = AnalysisRequest.model_validate(transfer["request"])
    transfer["response"]["rows"][0]["label_fields"]["strength"]["evidence"] = reference
    result = AnalysisResult.model_validate(transfer["response"])
    with pytest.raises(EvidenceValidationError, match=message):
        validate_analysis_result(result, request.evidence)


def test_report_cannot_be_relabelled_as_printed_directions(transfer):
    request = AnalysisRequest.model_validate(transfer["request"])
    transfer["response"]["rows"][0]["label_fields"]["directions"]["evidence"] = {
        "source_id": "patient-account"
    }
    result = AnalysisResult.model_validate(transfer["response"])
    with pytest.raises(EvidenceValidationError, match="require label or record"):
        validate_analysis_result(result, request.evidence)


def test_mixed_photo_keeps_each_facility_contact_on_its_own_label(transfer):
    manifest = transfer["request"]["evidence"]
    manifest["sources"].append({
        "id": "hospital-label",
        "attachment_id": "demo-photo-1",
        "kind": "label_photo",
        "organization": "Demo Hospital",
        "organization_type": "hospital",
        "organization_phone": "02-XXX-XXXX",
    })
    label_b = next(item for item in manifest["items"] if item["id"] == "label-b")
    label_b["source_id"] = "hospital-label"
    row = transfer["response"]["rows"][1]
    hospital_ref = {"source_id": "hospital-label", "item_id": "label-b"}
    row["sources"] = [hospital_ref]
    row["dispensing_source_id"] = "hospital-label"
    row["observed_names"][0]["evidence"] = hospital_ref
    row["label_fields"]["strength"]["evidence"] = hospital_ref

    request = AnalysisRequest.model_validate(transfer["request"])
    result = validate_analysis_result(AnalysisResult.model_validate(transfer["response"]), request.evidence)
    sources = {source.id: source for source in request.evidence.sources}
    clinic, hospital = [sources[item.dispensing_source_id] for item in result.rows[:2]]
    assert clinic.attachment_id == hospital.attachment_id == "demo-photo-1"
    assert clinic.organization_phone == "075-356XXXX"
    assert hospital.organization_phone == "02-XXX-XXXX"
    assert hospital.organization_address is None
    assert result.rows[2].dispensing_source_id is None


def test_legacy_untyped_contact_is_preserved(transfer):
    transfer["request"]["evidence"]["sources"][0] = {
        "id": "label-photo", "kind": "label_photo", "contact": "ติดต่อห้องยา"
    }
    source = AnalysisRequest.model_validate(transfer["request"]).evidence.sources[0]
    assert source.contact == "ติดต่อห้องยา"
    assert source.organization_phone is None
    assert source.organization_address is None


def test_wrong_row_reverse_crop_is_rejected(transfer):
    request = AnalysisRequest.model_validate(transfer["request"])
    transfer["response"]["rows"][2]["reverse_crop"]["item_id"] = "label-b"
    result = AnalysisResult.model_validate(transfer["response"])
    with pytest.raises(EvidenceValidationError, match="does not belong to row"):
        validate_analysis_result(result, request.evidence)


@pytest.mark.parametrize(
    ("fixture_name", "model", "field", "expected"),
    [
        ("candidate_match", CandidateResult, "status", "unresolved"),
        ("candidate_no_match", CandidateResult, "candidates", []),
        ("reviewer", ReviewerIdentity, "role", "pharmacist"),
        ("import_success", ImportReceipt, "imported_row_ids", ["row-b"]),
        ("retry_conflict", ServiceError, "code", "retry_conflict"),
        ("provider_timeout", ServiceError, "recoverable", True),
        ("ddi_partial", CheckSummary, "status", "partial"),
        ("drp_unavailable", CheckSummary, "status", "unavailable"),
    ],
)
def test_synthetic_service_responses(fixture_name, model, field, expected):
    payloads = json.loads((FIXTURES / "service_responses.json").read_text(encoding="utf-8"))
    assert getattr(model.model_validate(payloads[fixture_name]), field) == expected


def test_import_retry_preserves_selected_rows_and_token(transfer):
    payloads = json.loads((FIXTURES / "service_responses.json").read_text(encoding="utf-8"))
    payload = {
        **payloads["import_retry"],
        "evidence": transfer["request"]["evidence"],
        "rows": [{**row, "revision": 1} for row in transfer["response"]["rows"]],
    }
    request = ImportRequest.model_validate(payload)
    retry = ImportRequest.model_validate_json(request.model_dump_json())
    assert retry == request
    assert retry.selected_row_ids == ["row-b"]
    assert retry.retry_token == "demo-retry-1"


def test_import_receipt_normalizes_to_utc():
    receipt = ImportReceipt.model_validate(
        {"imported_at": "2026-11-21T11:00:00+07:00", "imported_row_ids": ["row-b"]}
    )
    assert receipt.model_dump(mode="json")["imported_at"] == "2026-11-21T04:00:00Z"


def test_openapi_components_resolve_locally():
    document = contract_openapi()
    schemas = document["components"]["schemas"]
    assert document["openapi"] == "3.1.0"
    assert {"AnalysisRequest", "AnalysisResult", "ImportReceipt", "CheckSummary"} <= schemas.keys()

    def check_refs(value):
        if isinstance(value, dict):
            if "$ref" in value:
                prefix, component = value["$ref"].rsplit("/", 1)
                assert prefix == "#/components/schemas"
                assert component in schemas
            for nested in value.values():
                check_refs(nested)
        elif isinstance(value, list):
            for nested in value:
                check_refs(nested)

    check_refs(document)
