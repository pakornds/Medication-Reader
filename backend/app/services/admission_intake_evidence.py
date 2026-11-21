"""Combine staff-linked snapshots without losing a competing source or converting corrections to OCR."""
from app.schemas.analysis import AnalysisResult, Discrepancy, validate_analysis_result
from app.schemas.evidence import CaseEvidence, EvidenceRef, EvidenceSource, Observation, SourcedValue
from app.schemas.admission_intake import IntakePart
from app.services.admissions import require


def _extend_unique(target, values):
    for value in values:
        if value not in target:
            target.append(value)


def _merge_map(target, extra):
    for key, value in extra.items():
        require(key not in target or target[key] == value,
                "Reconcile different versions of the same evidence before continuing.")
        target[key] = value


def prepare_sources(medicine, case_id):
    """Validate each original against its own sources before binding the snapshots to one reviewed order."""
    rid = medicine.row.id
    combined = IntakePart.model_validate(medicine.model_dump(exclude={"linked", "corrections"}))
    by_source = {}
    names_by_source = {}
    parts = [combined.model_copy(deep=True), *medicine.linked]
    for part in parts:
        manifest = CaseEvidence(case_id=case_id, sources=part.sources, items=part.items)
        validate_analysis_result(AnalysisResult(case_id=case_id, rows=[part.row]), manifest)
        for fact in part.row.observed_names:
            names_by_source.setdefault(fact.evidence.source_id, set()).add(fact.value)
        for field, obs in part.row.label_fields.items():
            if obs.evidence:
                fields = by_source.setdefault(obs.evidence.source_id, {})
                _merge_map(fields, {field:obs})
    candidate = combined.row
    for part in medicine.linked:
        for source in part.sources:
            old = next((s for s in combined.sources if s.id == source.id), None)
            require(not old or old == source, "Linked documents disagree about their source metadata.")
        _extend_unique(combined.sources, part.sources)
        _extend_unique(combined.items, [item.model_copy(update={"row_id":rid}) for item in part.items])
        _merge_map(combined.notes, part.notes)
        _merge_map(combined.regions, part.regions)
        _merge_map(combined.physical_items, part.physical_items)
        _extend_unique(candidate.sources, part.row.sources)
        if candidate.identity_status == "named":
            _extend_unique(candidate.observed_names, part.row.observed_names)
        _extend_unique(candidate.reported_use, part.row.reported_use)
        _extend_unique(candidate.regimens, part.row.regimens)
        _extend_unique(candidate.discrepancies, part.row.discrepancies)
        _extend_unique(candidate.follow_ups, part.row.follow_ups)
        candidate.reverse_crop = candidate.reverse_crop or part.row.reverse_crop
        for key, value in part.row.label_fields.items():
            if key not in candidate.label_fields or candidate.label_fields[key].status != "readable":
                candidate.label_fields[key] = value
    # Corrections are statements by the intake reviewer. Keep original facts and their original source IDs.
    for key, corrected in medicine.corrections.items():
        sid = f"intake-correction-{rid}-{key}"
        require(not any(source.id == sid for source in combined.sources), "Correction source collides with a document ID.")
        source = EvidenceSource(id=sid, kind="reviewer_record")
        ref = EvidenceRef(source_id=sid)
        combined.sources.append(source)
        combined.notes[sid] = corrected or f"Intake reviewer cleared the draft {key} field."
        candidate.sources.append(ref)
        if not corrected:
            continue
        if key == "name":
            fact = SourcedValue(value=corrected, evidence=ref)
            names_by_source[sid] = {corrected}
            if candidate.identity_status == "named":
                prior = [item for item in candidate.observed_names if item.value.casefold() != corrected.casefold()]
                if prior:
                    candidate.discrepancies.append(Discrepancy(id=sid, field="identity", observed_values=[*prior,fact],
                                                              question="Confirm the corrected medicine name against its sources."))
                candidate.observed_names.append(fact)
        else:
            obs = Observation(status="readable", value=corrected, evidence=ref)
            by_source[sid] = {key:obs}
            candidate.label_fields[key] = obs
    require(len({c.component_id for c in candidate.regimens}) == len(candidate.regimens),
            "Linked schedules have the same component ID with different evidence.")
    case = CaseEvidence(case_id=case_id, sources=combined.sources, items=combined.items)
    validate_analysis_result(AnalysisResult(case_id=case_id, rows=[candidate]), case)
    return combined, by_source, names_by_source
