from datetime import UTC, datetime
from typing import Annotated, Literal

from pydantic import AwareDatetime, Field, field_validator, model_validator

from .regimen import RegimenComponent, validate_component_list
from .analysis import MedicationSuggestion
from .evidence import CaseEvidence, ContractModel, EvidenceRef, SourcedValue, Text

Revision = Annotated[int, Field(ge=1)]


class ReviewerIdentity(ContractModel):
    id: Text
    name: Text
    role: Literal["pharmacist", "doctor", "nurse", "staff"]


class IdentityResolutionEvidence(ContractModel):
    """Document how an independent source establishes the verified identity."""

    discrepancy_id: Text
    evidence: EvidenceRef
    documented_name: Text
    identity_basis: Literal["matched_original_package", "dispensing_confirmation", "item_specific_record"]
    finding: Text


class CurrentUseVerification(ContractModel):
    reviewer: ReviewerIdentity
    verified_at: AwareDatetime
    status: Literal["current", "no_longer_current", "uncertain"]
    identity: SourcedValue | None = None
    normalized_medication_id: Text | None = None
    tmt_release: Text | None = None
    dose: SourcedValue | None = None
    route: SourcedValue | None = None
    frequency: SourcedValue | None = None
    regimens: list[RegimenComponent] = Field(default_factory=list)
    evidence: list[EvidenceRef] = Field(min_length=1)
    resolved_discrepancies: list[Text] = Field(default_factory=list)
    identity_resolutions: list[IdentityResolutionEvidence] = Field(default_factory=list)

    @model_validator(mode="after")
    def validate_regimens(self) -> "CurrentUseVerification":
        validate_component_list(self.regimens, verified=True)
        if self.regimens and any(field is not None for field in (self.dose, self.route, self.frequency)):
            raise ValueError("Choose one verified regimen representation per row")
        return self

    def has_complete_regimen(self) -> bool:
        if self.regimens:
            return all(component.has_verified_regimen() for component in self.regimens)
        return all((self.dose, self.route, self.frequency))

    def regimen_references(self) -> list[EvidenceRef]:
        if self.regimens:
            return [ref for component in self.regimens for ref in component.evidence.values()]
        return [field.evidence for field in (self.dose, self.route, self.frequency) if field is not None]


class PharmacistApproval(ContractModel):
    pharmacist_id: Text
    approved_at: AwareDatetime
    row_revision: Revision


class ReviewRow(MedicationSuggestion):
    revision: Revision
    verification: CurrentUseVerification | None = None
    approval: PharmacistApproval | None = None


class ImportRequest(ContractModel):
    evidence: CaseEvidence
    retry_token: Text
    selected_row_ids: list[Text] = Field(min_length=1)
    rows: list[ReviewRow] = Field(min_length=1)


class ImportReceipt(ContractModel):
    imported_at: AwareDatetime
    imported_row_ids: list[Text] = Field(min_length=1)

    @field_validator("imported_at")
    @classmethod
    def normalize_timestamp(cls, value: datetime) -> datetime:
        return value.astimezone(UTC)


class ServiceError(ContractModel):
    code: Text
    message: Text
    recoverable: bool
    row_ids: list[Text] = Field(default_factory=list)
