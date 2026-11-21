from enum import StrEnum
from typing import Literal

from pydantic import Field, model_validator

from .regimen import RegimenComponent, validate_component_list, validate_regimen_evidence
from .evidence import (
    EvidenceValidationError,
    PHOTO_KINDS,
    REPORT_KINDS,
    CaseEvidence,
    ContractModel,
    EvidenceRef,
    Observation,
    SourceKind,
    SourcedValue,
    Text,
)


class LabelField(StrEnum):
    DOSE = "dose"
    INDICATION = "indication"
    DIRECTIONS = "directions"
    AMOUNT_PRESCRIBED = "amount_prescribed"
    PRESCRIBER = "prescriber"
    PRESCRIBER_CONTACT = "prescriber_contact"
    STRENGTH = "strength"
    FORM = "form"
    EXPIRY = "expiry"


class Discrepancy(ContractModel):
    id: Text
    field: LabelField | Literal["identity", "reported_use"]
    observed_values: list[SourcedValue] = Field(min_length=2)
    question: Text


class FollowUp(ContractModel):
    question: Text
    field: LabelField | Literal["identity", "reported_use", "source", "photo_match"]
    potential_source_id: Text | None = None


class MedicationSuggestion(ContractModel):
    id: Text
    identity_status: Literal["named", "unlabeled", "unreadable"]
    unknown_label: Text | None = None
    sources: list[EvidenceRef] = Field(min_length=1)
    dispensing_source_id: Text | None = None
    observed_names: list[SourcedValue] = Field(default_factory=list)
    label_fields: dict[LabelField, Observation] = Field(default_factory=dict)
    reported_use: list[SourcedValue] = Field(default_factory=list)
    regimens: list[RegimenComponent] = Field(default_factory=list)
    reverse_crop: EvidenceRef | None = None
    discrepancies: list[Discrepancy] = Field(default_factory=list)
    follow_ups: list[FollowUp] = Field(default_factory=list)

    @model_validator(mode="after")
    def check_identity(self) -> "MedicationSuggestion":
        validate_component_list(self.regimens, verified=False)
        named = self.identity_status == "named"
        if bool(self.observed_names) != named or (self.unknown_label is None) != named:
            raise ValueError("Use sourced names for named rows and a placeholder for unknown rows")
        if len({item.id for item in self.discrepancies}) != len(self.discrepancies):
            raise ValueError("Duplicate discrepancy ID within a row")
        return self


class AnalysisResult(ContractModel):
    case_id: Text
    rows: list[MedicationSuggestion]

    @model_validator(mode="after")
    def check_row_ids(self) -> "AnalysisResult":
        if len({row.id for row in self.rows}) != len(self.rows):
            raise ValueError("Duplicate analysis row ID")
        return self


class AnalysisRequest(ContractModel):
    evidence: CaseEvidence
    patient_report: list[SourcedValue] = Field(default_factory=list)
    other_source_notes: list[SourcedValue] = Field(default_factory=list)
    question: Text | None = None

    @model_validator(mode="after")
    def check_form_sources(self) -> "AnalysisRequest":
        sources = {source.id: source for source in self.evidence.sources}
        for values, is_report in ((self.patient_report, True), (self.other_source_notes, False)):
            for field in values:
                source = sources.get(field.evidence.source_id)
                if (
                    source is None
                    or source.availability != "available"
                    or field.evidence.item_id is not None
                    or source.kind in PHOTO_KINDS
                    or (source.kind in REPORT_KINDS) != is_report
                ):
                    raise ValueError("Form evidence must cite an available source of the matching type")
        return self


def validate_analysis_result(result: AnalysisResult, evidence: CaseEvidence) -> AnalysisResult:
    if result.case_id != evidence.case_id:
        raise EvidenceValidationError("Analysis result belongs to a different case")

    sources = {source.id: source for source in evidence.sources}
    items = {(item.source_id, item.id): item for item in evidence.items}

    def check_reference(
        reference: EvidenceRef,
        row_id: str,
        *,
        field_claim: bool = False,
    ) -> SourceKind:
        source = sources.get(reference.source_id)
        if source is None or source.availability != "available":
            raise EvidenceValidationError(f"Row {row_id} cites an unavailable or unknown source")
        if reference.item_id is not None:
            item = items.get((reference.source_id, reference.item_id))
            if item is None or item.row_id != row_id:
                raise EvidenceValidationError(f"Evidence item does not belong to row {row_id}")
        elif field_claim and source.kind in PHOTO_KINDS:
            raise EvidenceValidationError(f"A photo claim for row {row_id} requires a located item")
        return source.kind

    for row in result.rows:
        for reference in row.sources:
            check_reference(reference, row.id)
        row_source_ids = {reference.source_id for reference in row.sources}

        def check_field(reference: EvidenceRef) -> SourceKind:
            kind = check_reference(reference, row.id, field_claim=True)
            if reference.source_id not in row_source_ids:
                raise EvidenceValidationError(f"Row {row.id} is missing a field's source")
            return kind

        def check_label_region(reference: EvidenceRef, kind: SourceKind) -> None:
            if kind in PHOTO_KINDS and not items[(reference.source_id, reference.item_id)].supports_label(kind):
                raise EvidenceValidationError("Documented photo fields require a label region")

        if row.dispensing_source_id is not None:
            dispensing = sources.get(row.dispensing_source_id)
            if (
                row.dispensing_source_id not in row_source_ids
                or dispensing is None
                or dispensing.organization is None
                or dispensing.kind in REPORT_KINDS
                or dispensing.kind == SourceKind.REVERSE_PHOTO
            ):
                raise EvidenceValidationError("Dispensing provenance requires a documented source")
        for observed in row.observed_names:
            check_label_region(observed.evidence, check_field(observed.evidence))
        for field in row.label_fields.values():
            if field.evidence is not None:
                kind = check_field(field.evidence)
                if kind in REPORT_KINDS:
                    raise EvidenceValidationError("Documented fields require label or record evidence")
                check_label_region(field.evidence, kind)
        for component in row.regimens:
            validate_regimen_evidence(component, row.id, evidence)
            if any(ref.source_id not in row_source_ids for ref in component.evidence.values()):
                raise EvidenceValidationError("Row is missing a regimen source")
        for observed in row.reported_use:
            if check_field(observed.evidence) not in REPORT_KINDS:
                raise EvidenceValidationError("Reported use requires a patient or caregiver source")
        for discrepancy in row.discrepancies:
            for observed in discrepancy.observed_values:
                check_field(observed.evidence)
        if row.reverse_crop is not None:
            kind = check_field(row.reverse_crop)
            key = (row.reverse_crop.source_id, row.reverse_crop.item_id)
            if kind != SourceKind.REVERSE_PHOTO or key not in items or items[key].kind != "pill_crop":
                raise EvidenceValidationError("A reverse crop requires a matched reverse-side pill crop")
        for follow_up in row.follow_ups:
            if follow_up.potential_source_id is not None and follow_up.potential_source_id not in sources:
                raise EvidenceValidationError("Follow-up refers to a source outside the case")

    return result
