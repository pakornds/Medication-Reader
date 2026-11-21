from fastapi import APIRouter, HTTPException

from app.schemas.evidence import EvidenceValidationError
from app.schemas.regimen import RegimenParseRequest, RegimenParseResult
from app.services.regimens import parse_directions

router = APIRouter(tags=["regimens"])


@router.post("/regimens/parse", response_model=RegimenParseResult)
def parse_regimen(request: RegimenParseRequest) -> RegimenParseResult:
    """Parse a transcribed or typed, row-assigned statement into suggested components."""
    try:
        return parse_directions(request)
    except EvidenceValidationError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from None
