"""Versioned metadata for packages located in two shared encounter photos.

Store image data separately. Coordinates use the displayed image after applying
EXIF orientation once, with the origin at its top left and both axes normalized
to the displayed dimensions. A region link names the exact view revision.
"""

from typing import Annotated, Literal

from pydantic import Field, model_validator

from .evidence import (
    CaseEvidence,
    ContractModel,
    EvidenceItem,
    EvidenceRef,
    EvidenceSource,
    PHOTO_KINDS,
    SourceKind,
    Text,
)

Side = Literal["front", "reverse"]
Revision = Annotated[int, Field(strict=True, ge=1)]
Coordinate = Annotated[float, Field(strict=True, ge=0, lt=1)]
Size = Annotated[float, Field(strict=True, gt=0, le=1)]


class RegionBounds(ContractModel):
    x: Coordinate
    y: Coordinate
    width: Size
    height: Size

    @model_validator(mode="after")
    def within_display(self) -> "RegionBounds":
        if self.x + self.width > 1 or self.y + self.height > 1:
            raise ValueError("Region bounds must fit inside the displayed image")
        return self


class PhotoRegion(ContractModel):
    id: Text
    bounds: RegionBounds
    visibility: Literal["visible", "opaque"] = "visible"


class PhotoView(ContractModel):
    attachment_id: Text
    revision: Revision
    exif_orientation: Annotated[int, Field(strict=True, ge=1, le=8)] = 1
    coordinate_space: Literal["exif_transposed_display"] = "exif_transposed_display"
    visibility: Literal["visible", "opaque"] = "visible"
    regions: list[PhotoRegion] = Field(default_factory=list)


class RegionLink(ContractModel):
    case_id: Text
    side: Side
    attachment_id: Text
    revision: Revision
    region_id: Text


class PackageEvidence(ContractModel):
    item_id: Text
    source_id: Text
    kind: Literal["label", "appearance"]
    region: RegionLink


class PackageItem(ContractModel):
    row_id: Text
    kind: Literal["order", "pending_appearance"]
    evidence: list[PackageEvidence] = Field(min_length=1)


class PhysicalPackage(ContractModel):
    id: Text
    front_regions: list[RegionLink] = Field(min_length=1)
    items: list[PackageItem] = Field(default_factory=list)


class ReverseMatch(ContractModel):
    package_id: Text
    region: RegionLink
    status: Literal["candidate", "confirmed"]


class PackageCapture(ContractModel):
    version: Literal["1"] = "1"
    case_id: Text
    front: PhotoView
    reverse: PhotoView | None = None
    packages: list[PhysicalPackage] = Field(default_factory=list)
    reverse_matches: list[ReverseMatch] = Field(default_factory=list)
    sources: list[EvidenceSource] = Field(default_factory=list)

    def _view(self, side: Side) -> PhotoView | None:
        return self.front if side == "front" else self.reverse

    def locate(self, link: RegionLink) -> PhotoRegion:
        view = self._view(link.side)
        if link.case_id != self.case_id:
            raise ValueError("Region link belongs to a different encounter")
        if view is None or (link.attachment_id, link.revision) != (view.attachment_id, view.revision):
            raise ValueError("Region link does not cite the current attachment revision")
        for region in view.regions:
            if region.id == link.region_id:
                return region
        raise ValueError("Region link does not cite a region in the selected view")

    @model_validator(mode="after")
    def check_graph(self) -> "PackageCapture":
        views = (self.front,) if self.reverse is None else (self.front, self.reverse)
        if len({view.attachment_id for view in views}) != len(views):
            raise ValueError("Front and reverse views require distinct attachments")
        region_ids = [region.id for view in views for region in view.regions]
        if len(set(region_ids)) != len(region_ids):
            raise ValueError("Duplicate case-local region ID")
        if self.front.visibility == "opaque":
            raise ValueError("An opaque view can be recorded on the reverse side")

        package_ids = [package.id for package in self.packages]
        rows = [item.row_id for package in self.packages for item in package.items]
        sources = {source.id: source for source in self.sources}
        identifiers = package_ids + rows + [source.id for source in self.sources]
        if len(set(identifiers)) != len(identifiers):
            raise ValueError("Package, row and source IDs must be distinct")

        self._check_photo_sources()

        front_owners: dict[str, str] = {}
        for package in self.packages:
            for link in package.front_regions:
                self.locate(link)
                if link.side != "front" or link.region_id in front_owners:
                    raise ValueError("A front region can be assigned to one package")
                front_owners[link.region_id] = package.id

        confirmed = self._check_reverse_matches(set(package_ids))
        self._check_evidence(sources, front_owners, confirmed)
        return self

    def _check_photo_sources(self) -> None:
        attachments = {self.front.attachment_id}
        reverse_attachment = self.reverse.attachment_id if self.reverse is not None else None
        if reverse_attachment is not None:
            attachments.add(reverse_attachment)

        for source in self.sources:
            if source.kind not in PHOTO_KINDS or source.availability != "available":
                continue
            if (
                source.attachment_id not in attachments
                or (source.kind == SourceKind.LABEL_PHOTO and source.attachment_id != self.front.attachment_id)
                or (source.kind == SourceKind.REVERSE_PHOTO and source.attachment_id != reverse_attachment)
            ):
                raise ValueError("An available photo source requires the corresponding capture view")

    def _check_reverse_matches(self, packages: set[str]) -> dict[str, str]:
        confirmed: dict[str, str] = {}
        proposed: set[tuple[str, str]] = set()
        for match in self.reverse_matches:
            self.locate(match.region)
            region_id = match.region.region_id
            pair = (match.package_id, region_id)
            if match.region.side != "reverse" or match.package_id not in packages or pair in proposed:
                raise ValueError("A reverse match requires a distinct package and reverse-region pair")
            proposed.add(pair)
            if match.status == "confirmed":
                if region_id in confirmed:
                    raise ValueError("A reverse region can be confirmed for only one package")
                confirmed[region_id] = match.package_id
        return confirmed

    def _check_evidence(
        self,
        sources: dict[str, EvidenceSource],
        front_owners: dict[str, str],
        reverse_owners: dict[str, str],
    ) -> None:
        evidence_ids: set[tuple[str, str]] = set()
        source_packages: dict[str, str] = {}
        for package in self.packages:
            for item in package.items:
                for evidence in item.evidence:
                    link = evidence.region
                    region = self.locate(link)
                    owners = front_owners if link.side == "front" else reverse_owners
                    if owners.get(region.id) != package.id:
                        raise ValueError("Evidence must cite an assigned front region or confirmed reverse region")
                    view = self._view(link.side)
                    if view is None or view.visibility == "opaque" or region.visibility == "opaque":
                        raise ValueError("Opaque photo regions cannot supply label or appearance evidence")

                    source = sources.get(evidence.source_id)
                    expected_kind = SourceKind.LABEL_PHOTO if link.side == "front" else SourceKind.REVERSE_PHOTO
                    if (
                        source is None
                        or source.kind != expected_kind
                        or source.availability != "available"
                        or source.attachment_id != view.attachment_id
                    ):
                        raise ValueError("Region evidence requires an available photo source on the same attachment")
                    if source_packages.setdefault(source.id, package.id) != package.id:
                        raise ValueError("A photo source cannot be shared across physical packages")
                    if item.kind == "pending_appearance" and evidence.kind != "appearance":
                        raise ValueError("Pending appearances can only cite appearance evidence")

                    key = (source.id, evidence.item_id)
                    if key in evidence_ids:
                        raise ValueError("Duplicate evidence item ID within a source")
                    evidence_ids.add(key)

    def to_case_evidence(self) -> CaseEvidence:
        """Project the capture's sources and item IDs into the existing evidence manifest."""
        items = [
            EvidenceItem(
                id=evidence.item_id,
                source_id=evidence.source_id,
                row_id=item.row_id,
                kind=(
                    "pill_crop" if evidence.kind == "appearance"
                    else "matched_reverse_label" if evidence.region.side == "reverse"
                    else "label_region"
                ),
            )
            for package in self.packages
            for item in package.items
            for evidence in item.evidence
        ]
        return CaseEvidence(case_id=self.case_id, sources=self.sources, items=items)

    def origin_for(self, ref: EvidenceRef) -> RegionLink:
        """Recover the revisioned attachment and region for a projected evidence item."""
        for package in self.packages:
            for item in package.items:
                for evidence in item.evidence:
                    if (ref.source_id, ref.item_id) == (evidence.source_id, evidence.item_id):
                        return evidence.region
        raise ValueError("Evidence reference does not identify a located item in this capture")