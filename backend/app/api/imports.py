from collections.abc import Callable, Sequence

from fastapi import APIRouter, Depends, HTTPException
from pydantic import AwareDatetime

from app.schemas.evidence import CaseEvidence, ContractModel
from app.schemas.review import (
    ImportReceipt,
    ImportRequest,
    PharmacistApproval,
    ReviewerIdentity,
    ReviewRow,
)
from app.services.hospital import HospitalError, HospitalRecord, MockHospital
from app.services.import_eligibility import ApprovalLedger, EligibilityError


class ApprovalRequest(ContractModel):
    evidence: CaseEvidence
    row: ReviewRow


def _selected_evidence(evidence: CaseEvidence, rows: Sequence[ReviewRow]) -> CaseEvidence:
    row_ids = {row.id for row in rows}
    source_ids = {reference.source_id for row in rows for reference in row.sources}
    for row in rows:
        verification = row.verification
        if verification is not None:
            source_ids.update(reference.source_id for reference in verification.evidence)
            for fact in (verification.identity, verification.dose, verification.route, verification.frequency):
                if fact is not None:
                    source_ids.add(fact.evidence.source_id)
        source_ids.update(
            follow_up.potential_source_id
            for follow_up in row.follow_ups
            if follow_up.potential_source_id is not None
        )
    return CaseEvidence(
        case_id=evidence.case_id,
        sources=[source for source in evidence.sources if source.id in source_ids],
        items=[
            item for item in evidence.items
            if item.row_id in row_ids and item.source_id in source_ids
        ],
    )


def _eligibility_response(error: EligibilityError) -> HTTPException:
    status = 403 if error.detail.code == "pharmacist_required" else 422
    return HTTPException(status_code=status, detail=error.detail.model_dump(mode="json"))


def _hospital_response(error: HospitalError) -> HTTPException:
    status = 409 if error.detail.code == "retry_conflict" else 503
    return HTTPException(status_code=status, detail=error.detail.model_dump(mode="json"))


def create_import_router(
    ledger: ApprovalLedger,
    hospital: MockHospital,
    resolve_reviewer: Callable[..., ReviewerIdentity],
) -> APIRouter:
    """Bind approval and import to the application's server-side reviewer dependency."""
    router = APIRouter(prefix="/imports", tags=["mock hospital import"])

    @router.post("/approvals", response_model=PharmacistApproval)
    def approve(
        request: ApprovalRequest, reviewer: ReviewerIdentity = Depends(resolve_reviewer)
    ) -> PharmacistApproval:
        try:
            return ledger.approve(reviewer, request.row, request.evidence)
        except EligibilityError as exc:
            raise _eligibility_response(exc) from None

    @router.post("", response_model=ImportReceipt)
    def import_approved(
        request: ImportRequest, reviewer: ReviewerIdentity = Depends(resolve_reviewer)
    ) -> ImportReceipt:
        try:
            rows = ledger.eligible_rows(reviewer, request)
            return hospital.write(
                evidence=_selected_evidence(request.evidence, rows),
                rows=rows,
                retry_token=request.retry_token,
            )
        except EligibilityError as exc:
            raise _eligibility_response(exc) from None
        except HospitalError as exc:
            raise _hospital_response(exc) from None

    @router.get("", response_model=list[HospitalRecord])
    def lookup(
        imported_at: AwareDatetime, _reviewer: ReviewerIdentity = Depends(resolve_reviewer)
    ) -> list[HospitalRecord]:
        try:
            return hospital.lookup(imported_at)
        except HospitalError as exc:
            raise _hospital_response(exc) from None

    return router
