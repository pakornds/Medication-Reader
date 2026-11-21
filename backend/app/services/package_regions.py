"""Propose editable bounds on one original in a transient encounter."""

from collections.abc import Callable
from io import BytesIO

from PIL import Image, ImageOps

from app.ai.client import EvidenceImage, OpenAIClient
from app.ai.prompts.package_regions import PACKAGE_REGIONS
from app.schemas.admission import CaptureViewRequest
from app.schemas.evidence import ContractModel, Text
from app.schemas.package_capture import RegionBounds


class ProposedBounds(ContractModel):
    regions: list[RegionBounds]


class PackageRegionResult(CaptureViewRequest, ProposedBounds):
    case_id: Text


def propose_package_regions(
    original: EvidenceImage, get_provider: Callable[[], OpenAIClient]
) -> ProposedBounds:
    # The admission store validates size, format and EXIF orientation at upload.
    with Image.open(BytesIO(original.content)) as photo:
        display = ImageOps.exif_transpose(photo).convert("RGB")
        display.thumbnail((2048, 2048))
        display.info.clear()
        output = BytesIO()
        display.save(output, "PNG")

    return get_provider().generate(
        instructions=PACKAGE_REGIONS.instructions,
        evidence_text="Locate package bounds in this single displayed capture.",
        output_type=ProposedBounds,
        images=[EvidenceImage("scene", "image/png", output.getvalue())],
    )
