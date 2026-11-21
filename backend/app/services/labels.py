"""Transcribe sourced facts from the label-side photo."""

import json
from base64 import b64decode
from binascii import Error as Base64Error
from collections.abc import Callable
from typing import Literal

from pydantic import Field

from app.ai.client import EvidenceImage, OpenAIClient, ProviderError
from app.ai.prompts import LABEL_EXTRACTION
from app.schemas.analysis import (
    AnalysisResult,
    EvidenceValidationError,
    LabelField,
    validate_analysis_result,
)
from app.schemas.evidence import CaseEvidence, ContractModel, Observation, SourceKind, Text


class LabelPhotoRequest(ContractModel):
    evidence: CaseEvidence
    source_id: Text
    media_type: Literal["image/png", "image/jpeg", "image/webp"]
    image_base64: str = Field(min_length=1, max_length=14_000_000)
    region_locations: dict[Text, Text] = Field(default_factory=dict)


class LabelPhotoError(ValueError):
    pass


def transcribe_label_photo(
    request: LabelPhotoRequest, get_provider: Callable[[], OpenAIClient]
) -> AnalysisResult:
    source = next((item for item in request.evidence.sources if item.id == request.source_id), None)
    if source is None or source.kind != SourceKind.LABEL_PHOTO or source.availability != "available":
        raise LabelPhotoError("Select an available label-side photo from the case.")
    items = [
        item for item in request.evidence.items
        if item.source_id == source.id and item.kind == "label_region"
    ]
    if request.region_locations.keys() - {item.id for item in items}:
        raise LabelPhotoError("Each region location must refer to a region of the selected photo.")
    try:
        content = b64decode(request.image_base64, validate=True)
    except (Base64Error, ValueError):
        raise LabelPhotoError("Provide a valid Base64 photo.") from None
    if not content:
        raise LabelPhotoError("The label-side photo is empty.")

    evidence = CaseEvidence(case_id=request.evidence.case_id, sources=[source], items=items)
    provider_input = evidence.model_dump(mode="json")
    provider_input["region_locations"] = request.region_locations
    result = get_provider().generate(
        instructions=LABEL_EXTRACTION.instructions,
        evidence_text=json.dumps(provider_input, ensure_ascii=False),
        output_type=AnalysisResult,
        images=[EvidenceImage(source.id, request.media_type, content)],
    )
    try:
        validate_analysis_result(result, evidence)
    except EvidenceValidationError:
        raise ProviderError(
            "unsupported_label_evidence", "A label transcription did not match the selected photo."
        ) from None
    for row in result.rows:
        for field in LabelField:
            row.label_fields.setdefault(field, Observation(status="missing"))
    return result
