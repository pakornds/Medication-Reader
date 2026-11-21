from fastapi import APIRouter, HTTPException

from app.schemas.local_screening import LocalScreeningRequest, LocalScreeningResult
from app.schemas.review import ServiceError
from app.services.local_screening import ReferenceUnavailable, screen_local

router = APIRouter(tags=["local medication screening"])


@router.post("/checks/local", response_model=LocalScreeningResult)
def check_local(request: LocalScreeningRequest) -> LocalScreeningResult:
    try:
        return screen_local(request)
    except ReferenceUnavailable as exc:
        detail = ServiceError(code="local_reference_unavailable", message=str(exc), recoverable=True)
        raise HTTPException(status_code=503, detail=detail.model_dump()) from None
