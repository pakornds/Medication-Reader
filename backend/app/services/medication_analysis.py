"""Build an attributed preview from a transient form submission."""

from collections.abc import Callable, Sequence

from pydantic import Field, ValidationError, model_validator
from pydantic.json_schema import SkipJsonSchema

from app.ai.client import EvidenceImage, OpenAIClient, ProviderError
from app.ai.prompts import FORM_ANALYSIS
from app.schemas.analysis import (
    AnalysisRequest,
    AnalysisResult,
    FollowUp,
    LabelField,
    MedicationSuggestion,
    validate_analysis_result,
)
from app.schemas.evidence import (
    PHOTO_KINDS,
    REPORT_KINDS,
    EvidenceRef,
    EvidenceSource,
    EvidenceValidationError,
    Observation,
    SourceKind,
    SourcedValue,
    Text,
)
from app.schemas.regimen import RegimenComponent, RegimenParseRequest
from app.services.labels import _matches_media_type
from app.services.regimens import parse_directions


class FormAnalysisInput(AnalysisRequest):
    photo_source_ids: list[Text] = Field(default_factory=list, max_length=16)
    region_locations: dict[Text, dict[Text, Text]] = Field(default_factory=dict)
    patient_report_row_ids: dict[Text, Text] = Field(default_factory=dict)


class AnalysisPreview(AnalysisResult):
    unavailable_sources: list[EvidenceSource] = Field(default_factory=list)
    unassigned_reports: list[SourcedValue] = Field(default_factory=list)


class ProposedMedication(MedicationSuggestion):
    # Fixed regimen fields are derived by the application from pass-through source text.
    regimens: SkipJsonSchema[list[RegimenComponent]] = Field(default_factory=list)

    @model_validator(mode="before")
    @classmethod
    def drop_inferred_regimens(cls, value):
        if isinstance(value, dict) and "regimens" in value:
            return {field: content for field, content in value.items() if field != "regimens"}
        return value


class FormProposal(AnalysisResult):
    rows: list[ProposedMedication]


class FormAnalysisError(ValueError):
    pass


def validate_form_input(form: FormAnalysisInput, photos: Sequence[EvidenceImage]) -> None:
    photo_ids = [photo.evidence_id for photo in photos]
    available_photos = {
        source.id for source in form.evidence.sources
        if source.kind in PHOTO_KINDS and source.availability == "available"
    }
    if photo_ids != form.photo_source_ids or len(photo_ids) != len(set(photo_ids)):
        raise FormAnalysisError("Associate each uploaded photo with a distinct case source.")
    if set(photo_ids) != available_photos:
        raise FormAnalysisError("Every available photo source needs its corresponding upload.")
    if any(not _matches_media_type(photo.content, photo.media_type) for photo in photos):
        raise FormAnalysisError("The uploaded photo bytes must match their declared image type.")
    if not (photo_ids or form.patient_report or form.other_source_notes):
        raise FormAnalysisError("Provide a medication photo or sourced text evidence.")
    report_ids = {report.evidence.source_id for report in form.patient_report}
    if form.patient_report_row_ids.keys() - report_ids:
        raise FormAnalysisError("A patient-account association requires a submitted account.")
    photo_items = {(item.source_id, item.id) for item in form.evidence.items}
    for source_id, locations in form.region_locations.items():
        if source_id not in available_photos or any(
            (source_id, item_id) not in photo_items for item_id in locations
        ):
            raise FormAnalysisError("Each region location must refer to an item in an uploaded photo.")


class FormGrounding:
    def __init__(self, form: FormAnalysisInput) -> None:
        self.form = form
        self.sources = {source.id: source for source in form.evidence.sources}
        self.items = {(item.source_id, item.id): item for item in form.evidence.items}
        self.texts: dict[str, list[str]] = {}
        for field in [*form.patient_report, *form.other_source_notes]:
            self.texts.setdefault(field.evidence.source_id, []).append(field.value)

    def available_reference(self, ref: EvidenceRef, row_id: str) -> EvidenceSource | None:
        source = self.sources.get(ref.source_id)
        if source is None or source.availability != "available":
            return None
        if ref.item_id is not None:
            item = self.items.get((ref.source_id, ref.item_id))
            if item is None or item.row_id != row_id:
                return None
        return source

    def supports_fact(self, fact: SourcedValue, row: MedicationSuggestion) -> bool:
        ref = fact.evidence
        source = self.available_reference(ref, row.id)
        if source is None:
            return False
        if source.kind in PHOTO_KINDS:
            item = self.items.get((ref.source_id, ref.item_id))
            return (
                source.kind != SourceKind.REVERSE_PHOTO
                and item is not None
                and item.kind == "label_region"
            )
        return any(fact.value in text for text in self.texts.get(source.id, []))

    def supports_report(self, fact: SourcedValue, row: MedicationSuggestion) -> bool:
        source = self.available_reference(fact.evidence, row.id)
        if source is None or source.kind not in REPORT_KINDS or not self.supports_fact(fact, row):
            return False
        associated_row = self.form.patient_report_row_ids.get(source.id)
        if associated_row is not None:
            return associated_row == row.id
        return any(
            name.value.casefold() in report.casefold()
            for name in row.observed_names
            for report in self.texts.get(source.id, [])
        )

    def supports_crop(self, crop: EvidenceRef, row_id: str) -> bool:
        source = self.available_reference(crop, row_id)
        item = self.items.get((crop.source_id, crop.item_id))
        return (
            source is not None and source.kind == SourceKind.REVERSE_PHOTO
            and item is not None and item.kind == "pill_crop"
        )

    def supports_disputed_value(
        self, field: str, fact: SourcedValue, row: MedicationSuggestion
    ) -> bool:
        if not self.supports_fact(fact, row):
            return False
        if self.sources[fact.evidence.source_id].kind not in PHOTO_KINDS:
            return True
        if field == "identity":
            return fact in row.observed_names
        observation = row.label_fields.get(field)
        return (
            observation is not None
            and observation.value == fact.value
            and observation.evidence == fact.evidence
        )

    def ground_row(self, row: MedicationSuggestion) -> None:
        row.sources = [ref for ref in row.sources if self.available_reference(ref, row.id)]
        row.follow_ups = []
        row.observed_names = [
            name for name in row.observed_names
            if self.supports_fact(name, row)
            and (
                name.evidence.source_id not in self.form.patient_report_row_ids
                or self.form.patient_report_row_ids[name.evidence.source_id] == row.id
            )
        ]
        if not row.observed_names:
            if row.identity_status == "named":
                row.identity_status = "unreadable"
                row.unknown_label = f"Unknown medication {row.id}"
            row.follow_ups.append(
                FollowUp(field="identity", question="Does the patient have the original labeled package?")
            )
        row.reported_use = [report for report in row.reported_use if self.supports_report(report, row)]

        dispensing = self.sources.get(row.dispensing_source_id)
        if (
            dispensing is None
            or not dispensing.organization
            or dispensing.kind not in {SourceKind.LABEL_PHOTO, SourceKind.ADDITIONAL_PHOTO, SourceKind.PRESCRIPTION}
            or not any(
                ref.source_id == dispensing.id and ref.item_id is not None
                for ref in row.sources
            )
        ):
            row.dispensing_source_id = None
        prior_clinic = next((
            source.id for source in self.form.evidence.sources
            if source.availability == "unavailable" and source.kind == SourceKind.PRESCRIPTION
        ), None)
        follow_up_source = row.dispensing_source_id or prior_clinic
        for field, observation in list(row.label_fields.items()):
            source = self.available_reference(observation.evidence, row.id) if observation.evidence else None
            region = (
                self.items.get((observation.evidence.source_id, observation.evidence.item_id))
                if observation.evidence else None
            )
            supported = observation.evidence is None or (
                source is not None and source.kind not in REPORT_KINDS
                and source.kind != SourceKind.REVERSE_PHOTO
                and (source.kind not in PHOTO_KINDS or (region is not None and region.kind == "label_region"))
                and (
                    observation.value is None
                    or self.supports_fact(
                        SourcedValue(value=observation.value, evidence=observation.evidence), row
                    )
                )
            )
            if not supported:
                row.label_fields[field] = Observation(status="missing")
            if field != LabelField.DIRECTIONS and row.label_fields[field].status != "readable":
                field_name = field.value.replace("_", " ")
                row.follow_ups.append(
                    FollowUp(
                        field=field,
                        question=f"Can the reviewer confirm {field_name} from a label or documented record?",
                        potential_source_id=follow_up_source,
                    )
                )

        directions = row.label_fields.get(LabelField.DIRECTIONS)
        if directions is None or directions.status != "readable":
            row.follow_ups.append(
                FollowUp(
                    field=LabelField.DIRECTIONS,
                    question="Can the dispensing clinic confirm the directions?",
                    potential_source_id=follow_up_source,
                )
            )
        if row.reverse_crop is not None and not self.supports_crop(row.reverse_crop, row.id):
            row.reverse_crop = None
            row.follow_ups.append(
                FollowUp(field="photo_match", question="Can the reviewer match the reverse photo to this item?")
            )

        disputes = []
        for dispute in row.discrepancies:
            row.follow_ups.append(
                FollowUp(
                    field=dispute.field,
                    question=f"Can the reviewer confirm {dispute.field.replace('_', ' ')} against independent evidence?",
                    potential_source_id=follow_up_source,
                )
            )
            if all(self.supports_disputed_value(dispute.field, fact, row) for fact in dispute.observed_values):
                dispute.question = row.follow_ups[-1].question
                disputes.append(dispute)
        row.discrepancies = disputes

        sources_to_show = [
            *(name.evidence for name in row.observed_names),
            *(report.evidence for report in row.reported_use),
            *(field.evidence for field in row.label_fields.values() if field.evidence),
            *(value.evidence for dispute in row.discrepancies for value in dispute.observed_values),
        ]
        if row.reverse_crop is not None:
            sources_to_show.append(row.reverse_crop)
        for source in sources_to_show:
            if source not in row.sources:
                row.sources.append(source)

        row.regimens = []
        facts = [("reported", report.value, report.evidence) for report in row.reported_use]
        if directions is not None and directions.status == "readable":
            facts.insert(0, ("documented", directions.value, directions.evidence))
        for index, (basis, text, source) in enumerate(facts, start=1):
            parsed = parse_directions(
                RegimenParseRequest(
                    evidence=self.form.evidence, row_id=row.id, component_id=f"form-{index}",
                    basis=basis, directions_text=text, source=source,
                )
            )
            row.regimens.extend(parsed.regimens)


def analyze_medication_form(
    form: FormAnalysisInput,
    photos: Sequence[EvidenceImage],
    get_provider: Callable[[], OpenAIClient],
) -> AnalysisPreview:
    validate_form_input(form, photos)
    proposed = get_provider().generate(
        instructions=FORM_ANALYSIS.instructions,
        evidence_text=form.model_dump_json(),
        output_type=FormProposal,
        images=photos,
    )
    grounding = FormGrounding(form)
    try:
        for row in proposed.rows:
            grounding.ground_row(row)
        grounded = AnalysisResult.model_validate(proposed.model_dump())
        validate_analysis_result(grounded, form.evidence)
    except (ValidationError, EvidenceValidationError):
        raise ProviderError(
            "unsupported_form_evidence", "The preview could not be tied to the submitted evidence."
        ) from None
    used_reports = [report for row in grounded.rows for report in row.reported_use]
    return AnalysisPreview(
        case_id=grounded.case_id,
        rows=grounded.rows,
        unavailable_sources=[
            source for source in form.evidence.sources if source.availability == "unavailable"
        ],
        unassigned_reports=[
            report
            for report in form.patient_report
            if not any(
                used.evidence.source_id == report.evidence.source_id and used.value in report.value
                for used in used_reports
            )
        ],
    )
