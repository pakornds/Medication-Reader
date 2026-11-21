"""Propose editable bounds on one display-oriented synthetic encounter capture."""

from base64 import b64decode
from binascii import Error as Base64Error
from collections.abc import Callable
from io import BytesIO
from typing import Literal

from PIL import Image, ImageOps
from pydantic import Field

from app.ai.client import EvidenceImage, OpenAIClient
from app.ai.prompts.package_regions import PACKAGE_REGIONS
from app.schemas.evidence import ContractModel, Text
from app.schemas.package_capture import PackageCapture, RegionBounds, Revision, Side


class PackageRegionRequest(ContractModel):
    capture: PackageCapture
    side: Side
    attachment_id: Text
    revision: Revision
    media_type: Literal["image/png", "image/jpeg", "image/webp"]
    image_base64: str = Field(min_length=1, max_length=14_000_000)


class ProposedBounds(ContractModel):
    regions: list[RegionBounds]


class PackageRegionResult(ProposedBounds):
    case_id: Text
    side: Side
    attachment_id: Text
    revision: Revision


class SupersededView(ValueError):
    pass


def _display_image(request: PackageRegionRequest, orientation: int) -> EvidenceImage:
    try:
        data = b64decode(request.image_base64, validate=True)
        with Image.open(BytesIO(data), formats=["PNG", "JPEG", "WEBP"]) as original:
            if Image.MIME[original.format] != request.media_type:
                raise ValueError("The selected photo must match its declared image type.")
            if original.width * original.height > 25_000_000:
                raise ValueError("The selected photo exceeds the decoded image size limit.")
            if original.getexif().get(274, 1) != orientation:
                raise ValueError("The selected photo must match the revision's EXIF orientation.")
            display = ImageOps.exif_transpose(original).convert("RGB")
            display.thumbnail((2048, 2048))
            display.info.clear()
            output = BytesIO()
            display.save(output, "PNG")
    except (Base64Error, OSError, SyntaxError, Image.DecompressionBombError):
        raise ValueError("Provide a decodable photo for the selected view.") from None
    return EvidenceImage("scene", "image/png", output.getvalue())


def propose_package_regions(
    request: PackageRegionRequest, get_provider: Callable[[], OpenAIClient]
) -> PackageRegionResult:
    view = request.capture.front if request.side == "front" else request.capture.reverse
    if view is None or (view.attachment_id, view.revision) != (
        request.attachment_id, request.revision
    ):
        raise SupersededView("Select the current attachment revision before requesting boxes.")
    image = _display_image(request, view.exif_orientation)

    proposed = get_provider().generate(
        instructions=PACKAGE_REGIONS.instructions,
        evidence_text="Locate package bounds in this single displayed capture.",
        output_type=ProposedBounds,
        images=[image],
    )
    return PackageRegionResult(
        case_id=request.capture.case_id, side=request.side, attachment_id=view.attachment_id,
        revision=view.revision, regions=proposed.regions,
    )
