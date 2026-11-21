from datetime import date
from enum import StrEnum
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

Text = Annotated[str, Field(min_length=1, pattern=r"\S")]


class ContractModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class EvidenceValidationError(ValueError):
    """A field cites evidence outside its supported case or item."""


class SourceKind(StrEnum):
    LABEL_PHOTO = "label_photo"
    REVERSE_PHOTO = "reverse_photo"
    ADDITIONAL_PHOTO = "additional_photo"
    PRESCRIPTION = "prescription"
    TRANSFER_RECORD = "transfer_record"
    PATIENT_REPORT = "patient_report"
    CAREGIVER_REPORT = "caregiver_report"
    REVIEWER_RECORD = "reviewer_record"
    OTHER_RECORD = "other_record"


PHOTO_KINDS = frozenset(
    {SourceKind.LABEL_PHOTO, SourceKind.REVERSE_PHOTO, SourceKind.ADDITIONAL_PHOTO}
)
REPORT_KINDS = frozenset({SourceKind.PATIENT_REPORT, SourceKind.CAREGIVER_REPORT})


class EvidenceSource(ContractModel):
    id: Text
    kind: SourceKind
    attachment_id: Text | None = None
    organization: Text | None = None
    organization_type: Literal["clinic", "hospital", "community_pharmacy", "other"] | None = None
    organization_address: Text | None = None
    organization_phone: Text | None = None
    organization_phone_extension: Text | None = None
    organization_email: Text | None = None
    department_or_ward: Text | None = None
    reporter: Text | None = None
    collector: Text | None = None
    contact: Text | None = None
    source_date: date | None = None
    availability: Literal["available", "unavailable"] = "available"
    unavailable_reason: Text | None = None

    @model_validator(mode="after")
    def check_availability(self) -> "EvidenceSource":
        if (self.availability == "unavailable") != (self.unavailable_reason is not None):
            raise ValueError("An unavailable source must carry a reason")
        return self


class EvidenceRef(ContractModel):
    source_id: Text
    item_id: Text | None = None


class EvidenceItem(ContractModel):
    """An item or crop located by the application, scoped to one source and row."""

    id: Text
    source_id: Text
    row_id: Text
    kind: Literal["label_region", "matched_reverse_label", "pill_crop", "record_excerpt"]

    def supports_label(self, source_kind: SourceKind) -> bool:
        if source_kind == SourceKind.REVERSE_PHOTO:
            return self.kind == "matched_reverse_label"
        return self.kind == "label_region"


class QuotedEvidenceItem(EvidenceItem):
    """A staff-selected statement kept with its row-specific reference."""

    kind: Literal["record_excerpt"]
    excerpt: Text


class CaseEvidence(ContractModel):
    case_id: Text
    sources: list[EvidenceSource]
    items: list[QuotedEvidenceItem | EvidenceItem] = Field(default_factory=list)

    @model_validator(mode="after")
    def check_manifest(self) -> "CaseEvidence":
        sources = {source.id: source for source in self.sources}
        if len(sources) != len(self.sources):
            raise ValueError("Duplicate case source ID")

        item_keys = {(item.source_id, item.id) for item in self.items}
        if len(item_keys) != len(self.items):
            raise ValueError("Duplicate item ID within a source")
        for item in self.items:
            source = sources.get(item.source_id)
            if source is None or source.availability != "available":
                raise ValueError(f"Item {item.id} has no available source")
            if item.kind == "matched_reverse_label" and source.kind != SourceKind.REVERSE_PHOTO:
                raise ValueError("Matched reverse label requires a reverse photo")
            if (item.kind in {"label_region", "matched_reverse_label", "pill_crop"}) != (source.kind in PHOTO_KINDS):
                raise ValueError(f"Item {item.id} has the wrong source type")
        return self


class Observation(ContractModel):
    status: Literal["readable", "missing", "unreadable"]
    value: Text | None = None
    evidence: EvidenceRef | None = None

    @model_validator(mode="after")
    def check_value(self) -> "Observation":
        if self.status == "readable":
            if self.value is None or self.evidence is None:
                raise ValueError("Readable observations require a value and evidence")
        elif self.value is not None:
            raise ValueError("Missing and unreadable observations must leave the value blank")
        return self


class SourcedValue(ContractModel):
    value: Text
    evidence: EvidenceRef
