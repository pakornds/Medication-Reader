from collections.abc import Callable

from fastapi import APIRouter, Depends, HTTPException

from app.api.encounter_screening import ScreeningTarget
from app.schemas.local_screening import CatalogueScreeningRequest, LocalScreeningRequest, LocalScreeningResult
from app.schemas.review import ServiceError
from app.services.encounter_screening import encounter_rows
from app.services.local_screening import ReferenceUnavailable, screen_catalogue_list, screen_local


def create_local_screening_router(authorize: Callable) -> APIRouter:
    router = APIRouter(tags=["local medication screening"])

    @router.post("/checks/local", response_model=LocalScreeningResult)
    def check_local(request: ScreeningTarget, current=Depends(authorize)) -> LocalScreeningResult:
        case = current(request)
        if len(case["rows"]) > 100:
            raise HTTPException(422, "Local screening supports at most 100 encounter rows.")
        evidence, rows = encounter_rows(case)
        try:
            result = screen_local(LocalScreeningRequest(evidence=evidence, rows=rows), encounter=True)
        except ReferenceUnavailable as exc:
            detail = ServiceError(code="local_reference_unavailable", message=str(exc), recoverable=True)
            raise HTTPException(503, detail=detail.model_dump(mode="json")) from None
        current(request)
        return result

    @router.post("/checks/local/catalogue", response_model=LocalScreeningResult)
    def check_catalogue(request: CatalogueScreeningRequest) -> LocalScreeningResult:
        try:
            return screen_catalogue_list(request)
        except ReferenceUnavailable as exc:
            raise HTTPException(503, str(exc)) from None

    return router
