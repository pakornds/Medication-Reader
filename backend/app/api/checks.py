from fastapi import APIRouter, HTTPException

from app.schemas.checks import CheckRequest, CheckSummary
from app.schemas.review import ServiceError
from app.services.checks import run_checks

router = APIRouter(tags=["checks"])


@router.post("/checks", response_model=CheckSummary)
def simulate_checks(request: CheckRequest) -> CheckSummary:
    if len({row.id for row in request.rows}) != len(request.rows):
        error = ServiceError(
            code="duplicate_row", message="Check row IDs must be unique.", recoverable=True
        )
        raise HTTPException(status_code=422, detail=error.model_dump(mode="json"))
    return run_checks(request)
