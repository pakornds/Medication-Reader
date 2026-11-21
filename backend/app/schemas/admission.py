"""Commands accepted by the admission workspace. Review identity and timestamps are server-owned."""
from base64 import b64decode
from datetime import date
from typing import Annotated, Literal

from pydantic import Field, model_validator

from .analysis import LabelField
from .evidence import Observation, PHOTO_KINDS, ContractModel, EvidenceSource, Text
from app.services.labels import _matches_media_type

Role = Literal["nurse", "doctor", "pharmacist"]
Use = Literal["current", "reported_stopped", "discontinued_order", "not_owned", "uncertain"]


class NewEncounter(ContractModel):
    patient_alias: Text
    assigned_roles: set[Role] = Field(default_factory=set)


class Photo(ContractModel):
    media_type: Literal["image/jpeg", "image/png", "image/webp"]
    data: str = Field(max_length=5_500_000)
    region: tuple[float, float, float, float]
    bag: Text
    pairing: Literal["matched", "uncertain"]
    appearance: Text | None = None

    @model_validator(mode="after")
    def validate_photo(self):
        x, y, w, h = self.region
        if not (0 <= x < 1 and 0 <= y < 1 and 0 < w <= 1-x+1e-8 and 0 < h <= 1-y+1e-8):
            raise ValueError("Select a region inside the image")
        if not _matches_media_type(b64decode(self.data, validate=True), self.media_type):
            raise ValueError("Invalid image")
        return self


class SourceEntry(ContractModel):
    source: EvidenceSource
    wording: Text
    name: Text | None = None
    strength: Text | None = None
    form: Text | None = None
    dose: Text | None = None
    record_basis: Literal["documented_interview", "discontinuation_order"] | None = None
    scan_fields: dict[LabelField, Observation] = Field(default_factory=dict)
    identity_basis: Literal["matched_original_package", "dispensing_confirmation", "item_specific_record"] | None = None
    label_owner: Text | None = None
    directions: Text | None = None
    indication: Text | None = None
    directions_status: Literal["missing", "unreadable"] = "missing"
    photo: Photo | None = None

    @model_validator(mode="after")
    def attributable(self):
        if self.source.availability != "available":
            raise ValueError("A review entry requires available evidence")
        if (self.source.kind in PHOTO_KINDS) != bool(self.photo):
            raise ValueError("Photo sources require a located image")
        if self.photo and (self.photo.pairing == "uncertain" or self.photo.appearance):
            if any((self.name, self.label_owner, self.directions, self.indication, self.strength, self.form, self.dose, self.scan_fields)):
                raise ValueError("Unmatched views and appearance crops cannot supply label fields")
        if self.source.kind in {"patient_report", "caregiver_report"} and any(
            (self.label_owner, self.directions, self.indication)
        ):
            raise ValueError("Enter reported use and indication in the interview")
        if self.record_basis:
            if self.source.kind not in {"transfer_record", "reviewer_record", "prescription"}:
                raise ValueError("Interview and order excerpts require a documented record")
            if self.name and self.wording.strip().casefold() == self.name.strip().casefold():
                raise ValueError("Preserve the actual interview or order excerpt")
        for observed in self.scan_fields.values():
            if not self.photo or (observed.evidence and (
                observed.evidence.source_id != self.source.id or observed.evidence.item_id != "selected"
            )):
                raise ValueError("A scanned field must cite the selected region of its source")
        if self.identity_basis:
            if not self.name or self.wording.strip().casefold() == self.name.strip().casefold():
                raise ValueError("Document how the independent evidence identifies this physical item")
            if self.source.kind not in {"label_photo", "reverse_photo", "additional_photo", "prescription",
                                        "transfer_record", "reviewer_record"}:
                raise ValueError("Use an item-specific package, dispensing confirmation or documented record")
        for value in (self.name, self.label_owner, self.directions, self.indication, self.strength, self.form, self.dose):
            if value and value.casefold() not in self.wording.casefold():
                raise ValueError("Transcribed fields must occur in the original wording")
        return self


class AddRow(ContractModel):
    action: Literal["add"]
    entry: SourceEntry


class AddEvidence(ContractModel):
    action: Literal["link"]
    row_id: Text
    entry: SourceEntry
    confirmed: Literal[True]
    replaces: Text | None = None


class Interview(ContractModel):
    action: Literal["interview"]
    row_id: Text
    source_id: Text
    ownership_source_id: Text | None = None
    ownership: Literal["patient", "other", "uncertain"]
    current_use: Use
    dose: Text | None = None
    route: Text | None = None
    schedule: Text | None = None
    reason: Text | None = None
    note: Text | None = None


class Verify(ContractModel):
    action: Literal["verify"]
    row_id: Text
    source_id: Text
    identity_source_id: Text | None = None
    resolution: Text | None = None


class Proposal(ContractModel):
    action: Literal["propose"]
    row_id: Text
    name: Text
    reference: Text


class Decision(ContractModel):
    action: Literal["decide"]
    row_id: Text
    outcome: Literal["confirm", "correct", "reject", "pending"]
    source_id: Text
    finding: Text
    name: Text | None = None


class Refer(ContractModel):
    action: Literal["refer"]
    row_ids: list[Text] = Field(min_length=1)
    checked: Text
    reason: Text


class Finish(ContractModel):
    action: Literal["finish"]


class Import(ContractModel):
    action: Literal["import"]
    row_ids: list[Text] = Field(min_length=1)


class Action(ContractModel):
    revision: int = Field(ge=1)
    request_id: Text
    command: Annotated[AddRow | AddEvidence | Interview | Verify | Proposal | Decision | Refer | Finish | Import,
                       Field(discriminator="action")]
