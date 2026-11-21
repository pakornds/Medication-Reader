"""Build an attributed preview from a transient form submission."""

import json
import re
from collections.abc import Callable, Sequence

from pydantic import Field, ValidationError, model_validator
from pydantic.json_schema import SkipJsonSchema

from app.ai.client import EvidenceImage, OpenAIClient, ProviderError
from app.ai.prompts import FORM_ANALYSIS
from app.schemas.analysis import (
    AnalysisRequest,
    AnalysisResult,
    DispensingFacility,
    FollowUp,
    LabelField,
    LabelMedicationSuggestion,
    MedicationSuggestion,
    documented_dispensing_refs,
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
from app.services.labels import LabelPhotoError, _matches_media_type, crop_label, read_label
from app.services.regimens import parse_directions


class FormAnalysisInput(AnalysisRequest):
    photo_source_ids: list[Text] = Field(default_factory=list, max_length=16)
    region_locations: dict[Text, dict[Text, Text]] = Field(default_factory=dict)
    patient_report_row_ids: dict[Text, Text] = Field(default_factory=dict)


class AnalysisPreview(AnalysisResult):
    dispensing_facilities: dict[Text, DispensingFacility] = Field(default_factory=dict)
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


def quote_pattern(value: str) -> str:
    # Keep a strength such as 5 mg distinct from 15 mg or 0.5 mg.
    start = r"(?<!\w)"
    if value[0].isdigit():
        start += r"(?<!\d[.,])"
    end = r"(?!\w)"
    if value[-1].isdigit():
        end += r"(?![.,]\d)"
    return start + re.escape(value) + end


def note_statements(text: str) -> list[str]:
    return [part.strip() for part in re.split(r"[;；。!?！？\r\n]+|\.(?=\s|$)", text) if part.strip()]


def directly_attributed(statement: str, name: str, field: str, value: str) -> bool:
    if field == "identity" and value == name:
        return True
    # Keep a quote inside a clause even if the proposal omits the next drug.
    # Commas between decimal digits remain part of the source number.
    clauses = re.split(r"(?<!\d),|,(?!\d)|\s+(?:and|but|while)\s+|และ(?=\s)", statement, flags=re.I)
    field_label = re.escape(field.replace("_", " "))
    separator = rf"\s*[:=–—-]?\s*(?:(?i:{field_label})\b\s*[:=]?\s*)?"
    # A label strength can stand between the name and the directions.
    strength = r"(?:\s+\d+(?:[.,]\d+)?\s*(?i:mg|mcg|g|ml|%|มก\.|กรัม)\s*)?" if field == "directions" else ""
    phrase = rf"(?i:{quote_pattern(name)}){strength}{separator}{quote_pattern(value)}"
    return any(re.search(phrase, clause) for clause in clauses)


def validate_form_input(
    form: FormAnalysisInput, photos: Sequence[EvidenceImage]
) -> dict[str, list[str]]:
    photo_ids = [photo.evidence_id for photo in photos]
    available_photos = {
        source.id: source for source in form.evidence.sources
        if source.kind in PHOTO_KINDS and source.availability == "available"
    }
    if photo_ids != form.photo_source_ids or len(photo_ids) != len(set(photo_ids)):
        raise FormAnalysisError("Associate each uploaded photo with a distinct case source.")
    if set(photo_ids) - available_photos.keys():
        raise FormAnalysisError("Each upload must identify an available photo source.")
    linked_sources = {}
    for photo_id in photo_ids:
        attachment = available_photos[photo_id].attachment_id
        linked_sources[photo_id] = [
            source.id for source in available_photos.values()
            if source.id == photo_id or (attachment is not None and source.attachment_id == attachment)
        ]
    seen_sources = [source_id for group in linked_sources.values() for source_id in group]
    if set(seen_sources) != available_photos.keys() or len(seen_sources) != len(set(seen_sources)):
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
    return linked_sources


class FormGrounding:
    def __init__(self, form: FormAnalysisInput, transcripts: dict[tuple[str, str], MedicationSuggestion]) -> None:
        self.transcripts = transcripts
        self.form = form
        self.sources = {source.id: source for source in form.evidence.sources}
        self.items = {(item.source_id, item.id): item for item in form.evidence.items}
        self.texts: dict[str, list[str]] = {}
        for field in [*form.patient_report, *form.other_source_notes]:
            self.texts.setdefault(field.evidence.source_id, []).append(field.value)
        self.statements: dict[str, list[str]] = {}
        for note in form.other_source_notes:
            self.statements.setdefault(note.evidence.source_id, []).extend(note_statements(note.value))

    def available_reference(self, ref: EvidenceRef, row_id: str) -> EvidenceSource | None:
        source = self.sources.get(ref.source_id)
        if source is None or source.availability != "available":
            return None
        if ref.item_id is not None:
            item = self.items.get((ref.source_id, ref.item_id))
            if item is None or item.row_id != row_id:
                return None
        return source

    def supports_fact(
        self, fact: SourcedValue, row: MedicationSuggestion, field: str = "identity",
        *, rows: Sequence[MedicationSuggestion] | None = None,
    ) -> bool:
        ref = fact.evidence
        source = self.available_reference(ref, row.id)
        if source is None:
            return False
        if source.kind in PHOTO_KINDS:
            transcript = self.transcripts.get((ref.source_id, ref.item_id))
            if transcript is None:
                return False
            if field == "identity":
                return fact in transcript.observed_names
            observation = transcript.label_fields.get(field)
            return observation is not None and observation.value == fact.value and observation.evidence == ref
        texts = self.texts.get(source.id, [])
        if source.kind in REPORT_KINDS:
            return any(fact.value in text for text in texts)
        if rows is None:
            # First pass grounds candidate names before using them to assign statements.
            return any(re.search(quote_pattern(fact.value), text) for text in texts)
        statements = self.statements.get(source.id, [])
        for statement in statements:
            quoted_value = quote_pattern(fact.value)
            if not re.search(quoted_value, statement):
                continue
            mentioned = {
                candidate.id for candidate in rows
                if any(re.search(quote_pattern(name.value), statement, re.I)
                       for name in candidate.observed_names)
            }
            if mentioned == {row.id}:
                # An unreturned medicine may also occur in this sentence.
                # Require a direct name/value phrase; seeing only one proposed
                # row is insufficient evidence for the entire sentence.
                if any(directly_attributed(statement, name.value, field, fact.value) for name in row.observed_names):
                    return True
            # A single located excerpt may document a different identity from
            # the label. Keep that discrepancy with its original physical row.
            if not mentioned and field == "identity" and len(statements) == 1 and ref.item_id:
                excerpts = [item for item in self.form.evidence.items if item.source_id == source.id]
                if len(excerpts) == 1 and ref.item_id == excerpts[0].id:
                    return True
        return False

    def supports_report(
        self, fact: SourcedValue, row: MedicationSuggestion, rows: Sequence[MedicationSuggestion]
    ) -> bool:
        source = self.available_reference(fact.evidence, row.id)
        if source is None or source.kind not in REPORT_KINDS or not self.supports_fact(fact, row):
            return False
        associated_row = self.form.patient_report_row_ids.get(source.id)
        if associated_row is not None:
            return associated_row == row.id
        for report in self.texts.get(source.id, []):
            if fact.value not in report:
                continue
            text = report.casefold()
            matching_rows = {
                item.id for item in rows
                if any(
                    re.search(r"(?<!\w)" + re.escape(name.value.casefold()) + r"(?!\w)", text)
                    for name in item.observed_names
                )
            }
            if matching_rows == {row.id}:
                return True
        return False

    def supports_crop(self, crop: EvidenceRef, row_id: str) -> bool:
        source = self.available_reference(crop, row_id)
        item = self.items.get((crop.source_id, crop.item_id))
        return (
            source is not None and source.kind == SourceKind.REVERSE_PHOTO
            and item is not None and item.kind == "pill_crop"
        )

    def supports_disputed_value(
        self, field: str, fact: SourcedValue, row: MedicationSuggestion, rows: Sequence[MedicationSuggestion]
    ) -> bool:
        if not self.supports_fact(fact, row, field, rows=rows):
            return False
        kind = self.sources[fact.evidence.source_id].kind
        if kind in REPORT_KINDS:
            return fact in row.reported_use
        if kind not in PHOTO_KINDS:
            return True
        if field == "identity":
            return fact in row.observed_names
        observation = row.label_fields.get(field)
        return (
            observation is not None
            and observation.value == fact.value
            and observation.evidence == fact.evidence
        )

    def ground_names(self, row: MedicationSuggestion) -> None:
        row.sources = [ref for ref in row.sources if self.available_reference(ref, row.id)]
        row.observed_names = [
            name for name in row.observed_names
            if self.supports_fact(name, row)
            and (
                name.evidence.source_id not in self.form.patient_report_row_ids
                or self.form.patient_report_row_ids[name.evidence.source_id] == row.id
            )
        ]
        # Co-occurrence in a note cannot establish that two names are aliases.
        # Reuse corroborated photo names, otherwise ask for row attribution.
        if len({name.value.casefold() for name in row.observed_names}) > 1:
            photo_names = {
                name.value.casefold() for transcript in self.transcripts.values() if transcript.id == row.id
                for name in transcript.observed_names
            }
            for name in row.observed_names:
                if name.evidence.source_id in self.statements and name.value.casefold() not in photo_names:
                    raise EvidenceValidationError("The note does not establish these names belong to one item.")

    def dispensing_reference(self, row: MedicationSuggestion) -> EvidenceRef | None:
        photo_refs = []
        for (source_id, item_id), transcript in self.transcripts.items():
            if transcript.id != row.id or transcript.dispensing_source_id != source_id:
                continue
            ref = EvidenceRef(source_id=source_id, item_id=item_id)
            if ref in documented_dispensing_refs(transcript, self.sources, self.items):
                photo_refs.append(ref)

        if photo_refs:
            return photo_refs[0] if len(photo_refs) == 1 else None

        source = self.sources.get(row.dispensing_source_id)
        if source is None or source.kind != SourceKind.PRESCRIPTION:
            return None
        return next(
            (ref for ref in documented_dispensing_refs(row, self.sources, self.items) if ref.item_id is not None),
            None,
        )

    def dispensing_facility(self, ref: EvidenceRef) -> DispensingFacility | None:
        transcript = self.transcripts.get((ref.source_id, ref.item_id))
        if isinstance(transcript, LabelMedicationSuggestion) and transcript.dispensing_facility is not None:
            return transcript.dispensing_facility

        source = self.sources[ref.source_id]
        if not source.organization:
            return None
        return DispensingFacility(
            evidence=ref,
            **source.model_dump(include=set(DispensingFacility.model_fields) - {"evidence"}),
        )

    def ground_row(
        self, row: MedicationSuggestion, rows: Sequence[MedicationSuggestion],
    ) -> DispensingFacility | None:
        refer_question = self.form.question and any(f.field == "treatment_referral" for f in row.follow_ups)
        row.follow_ups = []
        if refer_question:
            row.follow_ups.append(FollowUp(
                field="treatment_referral",
                question="Please discuss this treatment question with a pharmacist or doctor.",
            ))
        if not row.observed_names:
            if row.identity_status == "named":
                row.identity_status = "unreadable"
                row.unknown_label = f"Unknown medication {row.id}"
            row.follow_ups.append(
                FollowUp(field="identity", question="Does the patient have the original labeled package?")
            )
        row.reported_use = [
            report for report in row.reported_use if self.supports_report(report, row, rows)
        ]

        dispensing = self.dispensing_reference(row)
        facility = self.dispensing_facility(dispensing) if dispensing is not None else None
        row.dispensing_source_id = facility.evidence.source_id if facility is not None else None
        if facility is not None and facility.evidence not in row.sources:
            row.sources.append(facility.evidence)
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
                and (source.kind not in PHOTO_KINDS or (region is not None and region.supports_label(source.kind)))
                and (
                    observation.value is None
                    or self.supports_fact(
                        SourcedValue(value=observation.value, evidence=observation.evidence), row, field, rows=rows
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
            if all(self.supports_disputed_value(dispute.field, fact, row, rows) for fact in dispute.observed_values):
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
        return facility


def analyze_medication_form(
    form: FormAnalysisInput,
    photos: Sequence[EvidenceImage],
    get_provider: Callable[[], OpenAIClient],
) -> AnalysisPreview:
    linked_sources = validate_form_input(form, photos)
    provider_input = form.model_dump(mode="json")
    provider_input["uploaded_photo_sources"] = linked_sources
    sources = {s.id: s for s in form.evidence.sources}
    transcripts = {}
    other_images = []
    provider = get_provider()
    for photo in photos:
        linked = linked_sources[photo.evidence_id]
        items = [i for i in form.evidence.items if i.source_id in linked]
        labels = [i for i in items if i.supports_label(sources[i.source_id].kind)]
        if not labels:
            other_images.append(photo)
        for item in labels:
            location = form.region_locations.get(item.source_id, {}).get(item.id)
            if not location and (len(items) > 1 or len(linked) > 1):
                raise FormAnalysisError("Each item on a shared attachment needs a bounded region.")
            try:
                image = crop_label(photo, location, item.source_id) if location else photo
            except LabelPhotoError as exc:
                raise FormAnalysisError(str(exc)) from None
            result = read_label(
                form.evidence.case_id, sources[item.source_id], item, image, location, provider,
                extract_facility=True,
            )
            transcripts[item.source_id, item.id] = result.rows[0]
    provider_input["label_transcripts"] = [
        row.model_dump(mode="json", exclude={"dispensing_facility"}) for row in transcripts.values()
    ]
    if (len(transcripts) == 1 and len(form.evidence.sources) == 1 and
            len(form.evidence.items) == 1 and not form.question):
        proposed = AnalysisResult(case_id=form.evidence.case_id, rows=list(transcripts.values()))
    else:
        proposed = provider.generate(
            instructions=FORM_ANALYSIS.instructions,
            evidence_text=json.dumps(provider_input, ensure_ascii=False),
            output_type=FormProposal,
            images=other_images,
        )
    grounding = FormGrounding(form, transcripts)
    try:
        for row in proposed.rows:
            grounding.ground_names(row)
        facilities = {}
        for row in proposed.rows:
            facility = grounding.ground_row(row, proposed.rows)
            if facility is not None:
                facilities[row.id] = facility
        grounded = AnalysisResult.model_validate(proposed.model_dump())
        validate_analysis_result(grounded, form.evidence)
    except (ValidationError, EvidenceValidationError):
        raise ProviderError(
            "unsupported_form_evidence", "The preview could not be tied to the submitted evidence."
        ) from None
    physical_row_ids = {
        item.row_id for item in form.evidence.items if sources[item.source_id].kind in PHOTO_KINDS
    }
    # The validated item reference belongs to this row, even when several rows share a photo.
    covered_row_ids = {
        row.id for row in grounded.rows
        if any(ref.item_id is not None and sources[ref.source_id].kind in PHOTO_KINDS for ref in row.sources)
    }
    if physical_row_ids - covered_row_ids:
        raise ProviderError(
            "unsupported_form_evidence",
            "The preview omitted a located medication item or its photo evidence. Retry analysis or enter it manually.",
        )
    used_reports = [report for row in grounded.rows for report in row.reported_use]
    return AnalysisPreview(
        case_id=grounded.case_id,
        rows=grounded.rows,
        dispensing_facilities=facilities,
        unavailable_sources=[
            source for source in form.evidence.sources if source.availability == "unavailable"
        ],
        unassigned_reports=[
            report
            for report in form.patient_report
            if not any(
                used.evidence.source_id == report.evidence.source_id and used.value == report.value
                for used in used_reports
            )
        ],
    )
