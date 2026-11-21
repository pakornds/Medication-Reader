from collections.abc import Callable
from email import policy
from email.parser import BytesParser

from fastapi import APIRouter, HTTPException, Request
from pydantic import ValidationError
from starlette.concurrency import run_in_threadpool

from app.ai.client import EvidenceImage, OpenAIClient, ProviderError
from app.schemas.review import ServiceError
from app.services.medication_analysis import (
    AnalysisPreview,
    FormAnalysisError,
    FormAnalysisInput,
    analyze_medication_form,
)

MAX_FORM_BYTES = 16_000_000
PHOTO_TYPES = frozenset({"image/png", "image/jpeg", "image/webp"})
FORM_BODY = {
    "requestBody": {
        "required": True,
        "content": {
            "multipart/form-data": {
                "schema": {
                    "type": "object",
                    "required": ["form"],
                    "properties": {
                        "form": {"type": "string", "description": "JSON form metadata and sourced text."},
                        "photos": {"type": "array", "items": {"type": "string", "format": "binary"}},
                    },
                },
                "encoding": {"form": {"contentType": "application/json"}},
            }
        },
    }
}


async def _read_multipart(request: Request) -> tuple[FormAnalysisInput, list[EvidenceImage]]:
    content_type = request.headers.get("content-type", "")
    if (
        not content_type.lower().startswith("multipart/form-data;")
        or len(content_type) > 512
        or "\r" in content_type
        or "\n" in content_type
    ):
        raise FormAnalysisError("Submit a multipart form with JSON metadata and optional photos.")
    body = bytearray()
    async for chunk in request.stream():
        if len(body) + len(chunk) > MAX_FORM_BYTES:
            raise FormAnalysisError("The form and photos exceed the size limit.")
        body.extend(chunk)
    mime_header = f"Content-Type: {content_type}\r\nMIME-Version: 1.0\r\n\r\n".encode("latin-1")
    message = BytesParser(policy=policy.default).parsebytes(mime_header + body)
    if message.defects or not message.is_multipart():
        raise FormAnalysisError("The multipart form could not be read.")

    form_bytes = None
    uploads = []
    for part in message.iter_parts():
        if part.defects or part.is_multipart() or part.get_content_disposition() != "form-data":
            raise FormAnalysisError("Each form part must contain plain data.")
        name = part.get_param("name", header="Content-Disposition")
        payload = part.get_payload(decode=True)
        if name == "form" and form_bytes is None and payload is not None:
            form_bytes = payload
        elif name == "photos" and part.get_content_type() in PHOTO_TYPES and payload:
            uploads.append((part.get_content_type(), payload))
        else:
            raise FormAnalysisError("Use one form part and supported, nonempty photo parts.")
    if form_bytes is None:
        raise FormAnalysisError("The JSON form metadata is required.")
    try:
        form = FormAnalysisInput.model_validate_json(form_bytes)
    except ValidationError:
        raise FormAnalysisError("The case evidence or form metadata is invalid.") from None
    if len(uploads) != len(form.photo_source_ids):
        raise FormAnalysisError("Associate each uploaded photo with a case source in upload order.")
    photos = [
        EvidenceImage(source_id, media_type, data)
        for source_id, (media_type, data) in zip(form.photo_source_ids, uploads)
    ]
    return form, photos


def create_medication_analysis_router(
    get_provider: Callable[[], OpenAIClient] = OpenAIClient.from_environment,
) -> APIRouter:
    router = APIRouter(tags=["medication analysis"])

    @router.post("/medication-analysis", response_model=AnalysisPreview, openapi_extra=FORM_BODY)
    async def analyze(request: Request) -> AnalysisPreview:
        try:
            form, photos = await _read_multipart(request)
            return await run_in_threadpool(analyze_medication_form, form, photos, get_provider)
        except FormAnalysisError as exc:
            detail = ServiceError(code="invalid_analysis_form", message=str(exc), recoverable=True)
            raise HTTPException(422, detail=detail.model_dump(mode="json")) from None
        except ProviderError as exc:
            status = 502 if exc.detail.code in {
                "provider_invalid_output", "unsupported_form_evidence", "unsupported_label_evidence"
            } else 503
            raise HTTPException(status, detail=exc.detail.model_dump(mode="json")) from None

    return router
