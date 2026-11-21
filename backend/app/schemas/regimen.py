"""Source-attributed directions for one schedule component of one medication row."""

from typing import Annotated, Literal, get_args

from pydantic import Field, model_validator

from .evidence import (
    PHOTO_KINDS, REPORT_KINDS, CaseEvidence, ContractModel, EvidenceRef,
    EvidenceValidationError, SourceKind, Text,
)

RegimenBasis = Literal['documented', 'reported', 'verified']
ClinicalField = Literal[
    'directions_text', 'dose_amount', 'dose_unit', 'schedule_type', 'frequency_count',
    'period_value', 'period_unit', 'time_of_day', 'route', 'meal_relation', 'as_needed',
]
TimeOfDay = Annotated[str, Field(pattern=r'^(morning|noon|afternoon|evening|night|bedtime|([01][0-9]|2[0-3]):[0-5][0-9])$')]
Amount = Annotated[float, Field(gt=0, allow_inf_nan=False, strict=True)]


class RegimenComponent(ContractModel):
    component_id: Text
    basis: RegimenBasis
    parse_status: Literal['complete', 'partial', 'unparsed']
    unparsed_text: Text | None = None
    directions_text: Text
    dose_amount: Amount | None = None
    dose_unit: Text | None = None
    schedule_type: Literal['frequency', 'interval'] | None = None
    frequency_count: Annotated[int, Field(gt=0, strict=True)] | None = None
    period_value: Amount | None = None
    period_unit: Literal['hour', 'day', 'week', 'month'] | None = None
    time_of_day: list[TimeOfDay] = Field(default_factory=list)
    route: Text | None = None
    meal_relation: Text | None = None
    as_needed: Annotated[bool, Field(strict=True)] | None = None
    evidence: dict[ClinicalField, EvidenceRef]

    @model_validator(mode='after')
    def validate_component(self) -> 'RegimenComponent':
        # False is a documented value for as_needed. An empty timing list carries no claim.
        clinical = get_args(ClinicalField)
        populated = {key for key in clinical if getattr(self, key) is not None and getattr(self, key) != []}
        if self.evidence.keys() != populated:
            raise ValueError('Each populated clinical field must have exactly one source reference')
        if (self.parse_status == 'complete') != (self.unparsed_text is None):
            raise ValueError('Preserve unrepresented text for partial or unparsed directions')
        if self.unparsed_text is not None and self.unparsed_text not in self.directions_text:
            raise ValueError('Unrepresented wording must come from the original directions')
        if self.parse_status == 'unparsed' and self.unparsed_text != self.directions_text:
            raise ValueError('An unparsed component must retain the complete original statement')
        if self.parse_status == 'unparsed' and populated != {'directions_text'}:
            raise ValueError('Unparsed directions cannot assert structured fields')
        if self.parse_status != 'unparsed' and populated == {'directions_text'}:
            raise ValueError('Use unparsed when no structured fields can be represented')
        if self.schedule_type is None and any(v is not None for v in (self.period_unit, self.period_value, self.frequency_count)):
            raise ValueError('Period and frequency values require an explicit schedule type')
        if self.schedule_type is not None and (self.period_unit is None or self.period_value is None):
            raise ValueError('Frequency and interval schedules require a period value and unit')
        if (self.schedule_type == 'frequency') != (self.frequency_count is not None):
            raise ValueError('Only a frequency schedule has a count per period')
        if self.basis != 'verified' and any(ref != self.evidence['directions_text'] for ref in self.evidence.values()):
            raise ValueError('Each extracted schedule component must come from one source statement')
        return self

    def has_verified_regimen(self) -> bool:
        return self.basis == 'verified' and self.parse_status == 'complete' and all(
            value is not None for value in (self.dose_amount, self.dose_unit, self.route, self.schedule_type)
        )


def validate_component_list(components: list[RegimenComponent], *, verified: bool) -> None:
    if len({item.component_id for item in components}) != len(components):
        raise ValueError('Regimen component IDs must be unique within their list')
    if any((component.basis == 'verified') != verified for component in components):
        raise ValueError('Only clinician verification can hold verified regimen components')


def validate_regimen_evidence(component: RegimenComponent, row_id: str, evidence: CaseEvidence) -> None:
    sources = {source.id: source for source in evidence.sources}
    items = {(item.source_id, item.id): item for item in evidence.items}
    for reference in component.evidence.values():
        source = sources.get(reference.source_id)
        if source is None or source.availability != 'available':
            raise EvidenceValidationError('Regimen source is missing or unavailable')
        item = items.get((reference.source_id, reference.item_id))
        if reference.item_id is not None and (item is None or item.row_id != row_id):
            raise EvidenceValidationError('Regimen evidence item must belong to this medication row')
        if source.kind in PHOTO_KINDS and (
            item is None or not item.supports_label(source.kind)
        ):
            raise EvidenceValidationError('Photo directions require a located label region')
        if component.basis != 'verified' and (component.basis == 'reported') != (source.kind in REPORT_KINDS):
            raise EvidenceValidationError('Regimen basis must match its source type')


class RegimenParseRequest(ContractModel):
    evidence: CaseEvidence
    row_id: Text
    component_id: Text
    basis: Literal['documented', 'reported']
    directions_text: Text
    source: EvidenceRef


class RegimenParseResult(ContractModel):
    row_id: Text
    regimens: list[RegimenComponent]
