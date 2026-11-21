import json
from pathlib import Path

import pytest

from app.schemas.analysis import AnalysisRequest, Discrepancy
from app.schemas.review import IdentityResolutionEvidence, ImportRequest, ReviewerIdentity, ReviewRow
from app.services.import_eligibility import ApprovalLedger, EligibilityError

FIXTURE = Path(__file__).parents[1] / "fixtures" / "contracts" / "transfer_case.json"
PHARMACIST = ReviewerIdentity(id="pharmacist-1", name="Demo pharmacist", role="pharmacist")
DOCTOR = ReviewerIdentity(id="doctor-1", name="Demo doctor", role="doctor")


@pytest.fixture
def prepared_import():
    case = json.loads(FIXTURE.read_text(encoding="utf-8"))
    evidence = AnalysisRequest.model_validate(case["request"]).evidence
    row = case["response"]["rows"][1]
    identity = row["observed_names"][0]
    reviewed = ReviewRow.model_validate(
        {
            **row,
            "revision": 1,
            "verification": {
                "reviewer": DOCTOR,
                "verified_at": "2026-11-21T04:00:00Z",
                "status": "no_longer_current",
                "identity": identity,
                "evidence": [identity["evidence"]],
            },
        }
    )
    pending = ReviewRow.model_validate({**case["response"]["rows"][2], "revision": 1})
    return ImportRequest(
        evidence=evidence,
        retry_token="demo-retry",
        selected_row_ids=[reviewed.id],
        rows=[reviewed, pending],
    )


def test_doctor_verification_is_not_pharmacist_approval(prepared_import):
    ledger = ApprovalLedger()
    with pytest.raises(EligibilityError, match="A pharmacist"):
        ledger.approve(DOCTOR, prepared_import.rows[0], prepared_import.evidence)
    with pytest.raises(EligibilityError) as exc:
        ledger.eligible_rows(PHARMACIST, prepared_import)
    assert exc.value.detail.code == "approval_required"


def test_only_selected_approved_rows_are_eligible(prepared_import):
    ledger = ApprovalLedger()
    checked = prepared_import.rows[0]
    checked.approval = ledger.approve(PHARMACIST, checked, prepared_import.evidence)
    assert ledger.eligible_rows(PHARMACIST, prepared_import) == [checked]

    prepared_import.selected_row_ids.append(prepared_import.rows[1].id)
    with pytest.raises(EligibilityError) as exc:
        ledger.eligible_rows(PHARMACIST, prepared_import)
    assert exc.value.detail.row_ids == [prepared_import.rows[1].id]


def test_edit_without_revision_change_invalidates_approval(prepared_import):
    ledger = ApprovalLedger()
    checked = prepared_import.rows[0]
    checked.approval = ledger.approve(PHARMACIST, checked, prepared_import.evidence)
    checked.label_fields["strength"].value = "edited fixture"
    with pytest.raises(EligibilityError) as exc:
        ledger.eligible_rows(PHARMACIST, prepared_import)
    assert exc.value.detail.code == "approval_required"


def test_unregistered_claim_of_approval_is_rejected(prepared_import):
    ledger = ApprovalLedger()
    checked = prepared_import.rows[0]
    checked.approval = ledger.approve(PHARMACIST, checked, prepared_import.evidence)
    with pytest.raises(EligibilityError) as exc:
        ApprovalLedger().eligible_rows(PHARMACIST, prepared_import)
    assert exc.value.detail.code == "approval_required"


def test_wrong_image_item_cannot_support_review(prepared_import):
    row = prepared_import.rows[0]
    row.verification.identity.evidence.item_id = "label-a"
    with pytest.raises(EligibilityError) as exc:
        ApprovalLedger().approve(PHARMACIST, row, prepared_import.evidence)
    assert exc.value.detail.code == "invalid_evidence"


def test_unresolved_discrepancy_blocks_approval(prepared_import):
    row = prepared_import.rows[0]
    row.discrepancies = [Discrepancy.model_validate({
        "id": "discrepancy",
        "field": "identity",
        "observed_values": [
            row.observed_names[0],
            {"value": "Demo C", "evidence": {"source_id": "ward-record"}},
        ],
        "question": "Which identity can be verified?",
    })]
    with pytest.raises(EligibilityError) as exc:
        ApprovalLedger().approve(PHARMACIST, row, prepared_import.evidence)
    assert exc.value.detail.code == "unresolved_conflict"


@pytest.mark.parametrize("record_resolution", [False, True])
def test_disputed_identity_cannot_be_resolved_with_a_second_crop(prepared_import, record_resolution):
    row = prepared_import.rows[0]
    evidence = prepared_import.evidence
    original = row.observed_names[0]
    crop = evidence.items[1].model_copy(update={"id": "second-crop"})
    evidence.items.append(crop)
    second_crop = original.model_copy(deep=True)
    second_crop.evidence.item_id = crop.id
    row.sources.append(second_crop.evidence)
    row.discrepancies = [Discrepancy(
        id="discrepancy", field="identity", question="Which identity can be verified?",
        observed_values=[original, second_crop.model_copy(update={"value": "Demo C"})],
    )]
    row.verification.identity = second_crop
    row.verification.resolved_discrepancies = ["discrepancy"]
    if record_resolution:
        row.verification.identity_resolutions = [IdentityResolutionEvidence(
            discrepancy_id="discrepancy",
            evidence=second_crop.evidence,
            identity_basis="matched_original_package",
            finding="Read the name from the second crop of the bag.",
        )]

    with pytest.raises(EligibilityError) as exc:
        ApprovalLedger().approve(PHARMACIST, row, evidence)
    assert exc.value.detail.code == "independent_identity_evidence_required"
