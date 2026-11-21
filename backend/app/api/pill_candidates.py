from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse

from app.schemas.pills import CandidateRequest, CandidateResult
from app.schemas.review import ServiceError
from app.services.catalog import rank_candidates, reference_image

router = APIRouter(tags=["pill candidates"])


@router.post("/pill-candidates", response_model=CandidateResult)
def pill_candidates(request: CandidateRequest) -> CandidateResult:
    try:
        return rank_candidates(request)
    except ValueError as exc:
        error = ServiceError(code="invalid_crop", message=str(exc), recoverable=True)
        raise HTTPException(status_code=422, detail=error.model_dump(mode="json")) from None


@router.get("/pill-candidates/references/{reference_id}", response_class=FileResponse)
def pill_reference(reference_id: str) -> FileResponse:
    path = reference_image(reference_id)
    if path is None:
        raise HTTPException(status_code=404, detail="Unknown synthetic reference.")
    return FileResponse(path, media_type="image/png")
