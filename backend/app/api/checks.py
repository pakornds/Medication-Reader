from collections.abc import Callable
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import Field

from app.api.encounter_screening import ScreeningTarget
from app.schemas.checks import CheckSummary
from app.schemas.review import ServiceError
from app.services.checks import CoverageRequest, run_checks
from app.services.encounter_screening import encounter_rows


class EncounterCheck(ScreeningTarget):
    kind: Literal["DDI", "DRP"]
    enabled: bool = True
    context: dict[Literal["fixture_context"], Literal["present", "flagged"]] = Field(default_factory=dict)


def create_checks_router(authorize: Callable) -> APIRouter:
    router = APIRouter(tags=["checks"])

    @router.post("/checks", response_model=CheckSummary)
    def simulate_checks(request: EncounterCheck, current=Depends(authorize)) -> CheckSummary:
        case = current(request)
        evidence, rows = encounter_rows(case)
        if request.enabled and not rows:
            error = ServiceError(code="empty_scope", message="No encounter rows to check.", recoverable=True)
            raise HTTPException(422, error.model_dump(mode="json"))
        result = run_checks(CoverageRequest(
            kind=request.kind, enabled=request.enabled, context=request.context, evidence=evidence, rows=rows,
        ))
        current(request)
        return result

    return router
