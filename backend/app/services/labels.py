"""Transcribe sourced facts from the label-side photo."""

import json
import re
from base64 import b64decode
from binascii import Error as Base64Error
from collections.abc import Callable
from io import BytesIO
from typing import Literal

from PIL import Image, ImageOps
from pydantic import Field

from app.ai.client import EvidenceImage, OpenAIClient, ProviderError
from app.ai.prompts import LABEL_EXTRACTION
from app.schemas.analysis import (
    AnalysisResult,
    EvidenceValidationError,
    LabelAnalysisResult,
    LabelField,
    LabelMedicationSuggestion,
    validate_analysis_result,
)
from app.schemas.evidence import CaseEvidence, ContractModel, EvidenceItem, EvidenceRef, EvidenceSource, Observation, SourceKind, Text
from app.schemas.regimen import RegimenParseRequest
from app.services.regimens import parse_directions
from app.services.located_label import read_located_label
from app.services.label_directions import extract_transcribed_directions


class LabelPhotoRequest(ContractModel):
    evidence: CaseEvidence
    source_id: Text
    media_type: Literal["image/png", "image/jpeg", "image/webp"]
    image_base64: str = Field(min_length=1, max_length=14_000_000)
    region_locations: dict[Text, Text] = Field(default_factory=dict)


class LabelPhotoError(ValueError):
    pass


def _matches_media_type(content: bytes, media_type: str) -> bool:
    if media_type == "image/png":
        return content.startswith(b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR") and content.endswith(
            b"\x00\x00\x00\x00IEND\xaeB\x60\x82"
        )
    if media_type == "image/jpeg":
        return content.startswith(b"\xff\xd8\xff") and content.endswith(b"\xff\xd9")
    return (
        len(content) >= 20
        and content[:4] == b"RIFF"
        and content[8:12] == b"WEBP"
        and int.from_bytes(content[4:8], "little") + 8 == len(content)
    )


def crop_label(photo: EvidenceImage, location: str, source_id: str) -> EvidenceImage:
    """Coordinates refer to the displayed (EXIF-oriented) original attachment."""
    parts = [part.strip() for part in location.split(",")]
    if len(parts) != 4 or not all(
        re.fullmatch(r"(?:[0-9]+(?:\.[0-9]+)?|\.[0-9]+)%", part) for part in parts
    ):
        raise LabelPhotoError("Provide x, y, width and height as percentages for each label region.")
    x, y, w, h = [float(p[:-1]) / 100 for p in parts]
    if not (0 <= x < 1 and 0 <= y < 1 and 0 < w and 0 < h and x + w <= 1 + 1e-12 and y + h <= 1 + 1e-12):
        raise LabelPhotoError("Select a nonempty region inside the original attachment.")
    try:
        with Image.open(BytesIO(photo.content), formats=["PNG", "JPEG", "WEBP"]) as original:
            if original.width * original.height > 25_000_000:
                raise LabelPhotoError("The photo exceeds the decoded image size limit.")
            image = ImageOps.exif_transpose(original)
            width, height = image.size
            box = (round(x * width), round(y * height), round((x + w) * width), round((y + h) * height))
            if box[2] <= box[0] or box[3] <= box[1]:
                raise LabelPhotoError("Select a region at least one pixel wide and high.")
            crop = image.crop(box).convert("RGB")
            crop.info.clear()
            output = BytesIO()
            crop.save(output, "PNG")
    except (OSError, SyntaxError, Image.DecompressionBombError):
        raise LabelPhotoError("The selected photo could not be decoded.") from None
    return EvidenceImage(source_id, "image/png", output.getvalue())


def read_label(
    case_id: str, source: EvidenceSource, item: EvidenceItem | None,
    image: EvidenceImage, location: str | None, provider: OpenAIClient,
    *, extract_facility: bool = False,
) -> AnalysisResult:
    evidence = CaseEvidence(case_id=case_id, sources=[source], items=[item] if item else [])
    manifest = evidence.model_dump(mode="json")
    manifest["region_locations"] = {item.id: location} if item and location else {}
    if location:
        manifest["image_view"] = "The supplied image is already cropped to this region."
    used_scoped_transcript = False
    try:
        result = provider.generate(
            instructions=LABEL_EXTRACTION.instructions,
            evidence_text=json.dumps(manifest, ensure_ascii=False),
            output_type=LabelAnalysisResult if extract_facility else AnalysisResult,
            images=[image],
        )
    except ProviderError as exc:
        if exc.detail.code != "provider_invalid_output" or not item or not item.supports_label(source.kind):
            raise
        # Older clients request full row proposals. Retry a malformed response with the located-facts
        # contract so the server alone assigns evidence references and clinical regimen fields.
        row = read_located_label(case_id, source, item, image, provider, repair=False)
        result = LabelAnalysisResult(case_id=case_id, rows=[row])
        used_scoped_transcript = True
    for row in result.rows:
        if not used_scoped_transcript:
            row.regimens = []
        # A label transcription has no staff question to refer.
        row.follow_ups = [follow_up for follow_up in row.follow_ups if follow_up.field != "treatment_referral"]
        facility = row.dispensing_facility if isinstance(row, LabelMedicationSuggestion) else None
        if facility is not None:
            ref = EvidenceRef(source_id=source.id, item_id=item.id) if item else None
            if item is None or row.id != item.row_id or facility.evidence != ref or not item.supports_label(source.kind):
                row.dispensing_facility = None
                row.dispensing_source_id = None
            else:
                row.dispensing_source_id = source.id
                if ref not in row.sources:
                    row.sources.append(ref)
        elif row.dispensing_source_id == source.id and not source.organization:
            row.dispensing_source_id = None
    try:
        validate_analysis_result(result, evidence)
        if item and [row.id for row in result.rows] != [item.row_id]:
            raise EvidenceValidationError("Expected the selected row.")
    except EvidenceValidationError:
        raise ProviderError(
            "unsupported_label_evidence", "A label transcription did not match the selected region."
        ) from None
    if extract_facility and item and not used_scoped_transcript:
        row = result.rows[0]
        directions = row.label_fields.get(LabelField.DIRECTIONS)
        if directions and directions.status == "readable":
            component = extract_transcribed_directions(provider, directions.value, directions.evidence)
            if component:
                row.regimens = [component]
    return result


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
    if not _matches_media_type(content, request.media_type):
        raise LabelPhotoError("The photo bytes must match their declared image type.")

    evidence = CaseEvidence(case_id=request.evidence.case_id, sources=[source], items=items)
    photo = EvidenceImage(source.id, request.media_type, content)
    shared_sources = {s.id for s in request.evidence.sources if s.id == source.id or (
        source.attachment_id and s.attachment_id == source.attachment_id
    )}
    shared = sum(i.source_id in shared_sources for i in request.evidence.items) > 1 or len(shared_sources) > 1
    if shared and not items:
        raise LabelPhotoError("Select an attributed label region on this shared attachment.")
    rows = []
    provider = get_provider()
    for item in items or [None]:
        location = request.region_locations.get(item.id) if item else None
        if item and shared and not location:
            raise LabelPhotoError("Each item on a shared attachment needs a bounded region.")
        image = crop_label(photo, location, source.id) if location else photo
        rows.extend(read_label(evidence.case_id, source, item, image, location, provider).rows)
    if len({row.id for row in rows}) != len(rows):
        raise LabelPhotoError("Use form analysis to reconcile multiple label regions for one row.")
    result = AnalysisResult(case_id=evidence.case_id, rows=rows)
    for row in result.rows:
        for field in LabelField:
            row.label_fields.setdefault(field, Observation(status="missing"))
        # The validated transcript is the source for structured directions on scan rows.
        directions = row.label_fields[LabelField.DIRECTIONS]
        row.regimens = []
        if directions.status == "readable":
            row.regimens = parse_directions(RegimenParseRequest(
                evidence=evidence, row_id=row.id, component_id="label-directions",
                basis="documented", directions_text=directions.value, source=directions.evidence,
            )).regimens
    return result
