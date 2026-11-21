from collections.abc import Callable

from fastapi import APIRouter, HTTPException

from app.ai.client import OpenAIClient, ProviderError
from app.schemas.analysis import AnalysisResult
from app.schemas.review import ServiceError
from app.services.labels import LabelPhotoError, LabelPhotoRequest, transcribe_label_photo


def create_labels_router(
    get_provider: Callable[[], OpenAIClient] = OpenAIClient.from_environment,
) -> APIRouter:
    router = APIRouter(tags=["label transcription"])

    @router.post("/labels/transcribe", response_model=AnalysisResult)
    def transcribe(request: LabelPhotoRequest) -> AnalysisResult:
        try:
            return transcribe_label_photo(request, get_provider)
        except LabelPhotoError as exc:
            detail = ServiceError(code="invalid_label_photo", message=str(exc), recoverable=True)
            raise HTTPException(422, detail=detail.model_dump(mode="json")) from None
        except ProviderError as exc:
            status = 502 if exc.detail.code in {
                "provider_invalid_output", "unsupported_label_evidence"
            } else 503
            raise HTTPException(status, detail=exc.detail.model_dump(mode="json")) from None

    return router
