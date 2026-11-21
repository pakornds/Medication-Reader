"""Describe visible attributes of separately selected pill crops."""

import json
from base64 import b64decode
from collections.abc import Callable
from typing import Literal

from pydantic import Field

from app.ai.client import EvidenceImage, OpenAIClient, ProviderError
from app.ai.prompts import PILL_OBSERVATION
from app.schemas.evidence import CaseEvidence, ContractModel, EvidenceRef
from app.schemas.pills import PillObservation


class PillCropUpload(ContractModel):
    crop: EvidenceRef
    media_type: Literal["image/png", "image/jpeg", "image/webp"]
    image_base64: str = Field(min_length=1, max_length=14_000_000)


class PillObservationRequest(ContractModel):
    evidence: CaseEvidence
    crops: list[PillCropUpload] = Field(min_length=1, max_length=16)


class PillCropError(ValueError):
    pass


def _crop_content(upload: PillCropUpload) -> bytes:
    try:
        content = b64decode(upload.image_base64, validate=True)
    except ValueError:
        raise PillCropError("Provide each crop as a valid Base64 image.") from None
    if upload.media_type == "image/png":
        valid = content.startswith(b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR") and content.endswith(
            b"\x00\x00\x00\x00IEND\xaeB\x60\x82"
        )
    elif upload.media_type == "image/jpeg":
        valid = content.startswith(b"\xff\xd8\xff") and content.endswith(b"\xff\xd9")
    else:
        valid = (
            len(content) >= 20
            and content[:4] == b"RIFF"
            and content[8:12] == b"WEBP"
            and int.from_bytes(content[4:8], "little") + 8 == len(content)
        )
    if not valid:
        raise PillCropError("The crop bytes must match their declared image type.")
    return content


def observe_pill_crops(
    request: PillObservationRequest, get_provider: Callable[[], OpenAIClient]
) -> list[PillObservation]:
    if sum(len(upload.image_base64) for upload in request.crops) > 14_000_000:
        raise PillCropError("The combined crop images exceed the size limit.")
    items = {
        (item.source_id, item.id): item
        for item in request.evidence.items
        if item.kind == "pill_crop"
    }
    selected = set()
    prepared = []
    for upload in request.crops:
        key = (upload.crop.source_id, upload.crop.item_id)
        item = items.get(key)
        if item is None or key in selected:
            raise PillCropError("Select distinct pill crops from the case.")
        selected.add(key)
        image = EvidenceImage(item.source_id, upload.media_type, _crop_content(upload))
        evidence_text = json.dumps(
            {
                "case_id": request.evidence.case_id,
                "row_id": item.row_id,
                "crop": upload.crop.model_dump(mode="json"),
            },
            ensure_ascii=False,
        )
        prepared.append((item.row_id, upload.crop, image, evidence_text))

    provider = get_provider()
    results = []
    for row_id, crop, image, evidence_text in prepared:
        result = provider.generate(
            instructions=PILL_OBSERVATION.instructions,
            evidence_text=evidence_text,
            output_type=PillObservation,
            images=[image],
        )
        fields = (result.imprint, result.shape, result.form, result.color)
        if result.row_id != row_id or result.crop != crop or any(
            field.evidence is not None and field.evidence != crop for field in fields
        ):
            raise ProviderError(
                "unsupported_pill_evidence", "A pill observation did not match its selected crop."
            )
        if result.overlapping or any(field.status == "unreadable" for field in fields):
            result.follow_up = "Take a clearer photo with the items separated and the imprint visible."
        elif result.imprint.status == "missing":
            result.follow_up = "If the other side has an imprint, capture it in a separate photo."
        else:
            result.follow_up = None
        results.append(result)
    return results
