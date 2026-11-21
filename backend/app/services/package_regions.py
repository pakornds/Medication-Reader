"""Propose editable bounds on one display-oriented synthetic encounter capture."""

from base64 import b64decode
from binascii import Error as Base64Error
from collections.abc import Callable

from pydantic import Field

from app.ai.client import EvidenceImage, OpenAIClient
from app.ai.prompts.package_regions import PACKAGE_REGIONS
from app.schemas.evidence import ContractModel, Text
from app.schemas.package_capture import PackageCapture, RegionBounds, Revision, Side
from app.services.labels import _matches_media_type


class PackageRegionRequest(ContractModel):
    capture: PackageCapture
    side: Side
    attachment_id: Text
    revision: Revision
    display_png_base64: str = Field(
        min_length=1, max_length=14_000_000,
        description="PNG rendered from the specified revision after applying EXIF orientation.",
    )


class ProposedBounds(ContractModel):
    regions: list[RegionBounds]


class PackageRegionResult(ProposedBounds):
    case_id: Text
    side: Side
    attachment_id: Text
    revision: Revision


class SupersededView(ValueError):
    pass


def propose_package_regions(
    request: PackageRegionRequest, get_provider: Callable[[], OpenAIClient]
) -> PackageRegionResult:
    view = request.capture.front if request.side == "front" else request.capture.reverse
    if view is None or (view.attachment_id, view.revision) != (
        request.attachment_id, request.revision
    ):
        raise SupersededView("Select the current attachment revision before requesting boxes.")
    try:
        image = b64decode(request.display_png_base64, validate=True)
    except (ValueError, Base64Error):
        raise ValueError("Provide a valid display-oriented PNG.") from None
    if not _matches_media_type(image, "image/png"):
        raise ValueError("Provide a valid display-oriented PNG.")

    proposed = get_provider().generate(
        instructions=PACKAGE_REGIONS.instructions,
        evidence_text="Locate package bounds in this single displayed capture.",
        output_type=ProposedBounds,
        images=[EvidenceImage("scene", "image/png", image)],
    )
    return PackageRegionResult(
        case_id=request.capture.case_id, side=request.side, attachment_id=view.attachment_id,
        revision=view.revision, regions=proposed.regions,
    )
