from collections.abc import Callable
from typing import Annotated

from fastapi import Depends, HTTPException, Response
from pydantic import Field

from app.schemas.evidence import ContractModel, Text
from app.schemas.review import ReviewerIdentity
from app.services.admissions import AdmissionStore


class ScreeningTarget(ContractModel):
    case_id: Text
    admission_revision: Annotated[int, Field(strict=True, ge=1)]


def screening_case(
    admissions: AdmissionStore, resolve_reviewer: Callable[..., ReviewerIdentity],
) -> Callable:
    def authorize(response: Response, actor: ReviewerIdentity = Depends(resolve_reviewer)):
        response.headers["Cache-Control"] = "no-store"

        def current(target: ScreeningTarget) -> dict:
            case = admissions.get(actor, target.case_id)
            if actor.role not in {"doctor", "pharmacist"}:
                raise HTTPException(403, "A doctor or pharmacist is required for screening.")
            if case["revision"] != target.admission_revision:
                raise HTTPException(409, "Encounter changed. Reload before screening.")
            return case

        return current

    return authorize
