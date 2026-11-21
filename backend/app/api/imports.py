from collections.abc import Callable

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
from app.services.import_eligibility import ApprovalLedger, EligibilityError, selected_evidence


class ApprovalRequest(ContractModel):
    evidence: CaseEvidence
    row: ReviewRow


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
    can_read_admission: Callable[[ReviewerIdentity, str], bool] = lambda actor, case_id: False,
) -> APIRouter:
    """Bind approval and import to the application's server-side reviewer dependency."""
    router = APIRouter(prefix="/imports", tags=["mock hospital import"])

    @router.post("/approvals", response_model=PharmacistApproval)
    def approve(
        request: ApprovalRequest, reviewer: ReviewerIdentity = Depends(resolve_reviewer)
    ) -> PharmacistApproval:
        if request.evidence.case_id.startswith("admission-"):
            raise HTTPException(403, "Approve admission rows in their assigned encounter.")
        try:
            return ledger.approve(reviewer, request.row, request.evidence)
        except EligibilityError as exc:
            raise _eligibility_response(exc) from None

    @router.post("", response_model=ImportReceipt)
    def import_approved(
        request: ImportRequest, reviewer: ReviewerIdentity = Depends(resolve_reviewer)
    ) -> ImportReceipt:
        if request.evidence.case_id.startswith("admission-"):
            raise HTTPException(403, "Import admission rows through the assigned encounter.")
        try:
            rows = ledger.eligible_rows(reviewer, request)
            return hospital.write(
                evidence=selected_evidence(request.evidence, rows),
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
            if _reviewer.role != "pharmacist":
                raise HTTPException(403, "Pharmacist required.")
            return [record for record in hospital.lookup(imported_at)
                    if not record.snapshot.evidence.case_id.startswith("admission-")
                    or can_read_admission(_reviewer, record.snapshot.evidence.case_id)]
        except HospitalError as exc:
            raise _hospital_response(exc) from None

    return router
