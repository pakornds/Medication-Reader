"""Combine staff-linked snapshots without losing a competing source or converting corrections to OCR."""
import re
from collections import defaultdict
from hashlib import sha256

from app.schemas.admission import DOCUMENT_KINDS
from app.schemas.analysis import AnalysisResult, Discrepancy, validate_analysis_result
from app.schemas.evidence import CaseEvidence, EvidenceRef, EvidenceSource, Observation, SourcedValue
from app.schemas.admission_intake import IntakePart
from app.services.admissions import check_document_id, require
from app.services.medication_analysis import quote_pattern


def _extend_unique(target, values):
    for value in values:
        if value not in target:
            target.append(value)


def _merge_map(target, extra):
    for key, value in extra.items():
        require(key not in target or target[key] == value,
                "Reconcile different versions of the same evidence before continuing.")
        target[key] = value


def intake_documents(case, submitted, prepared, reserved):
    """Use the same immutable encounter documents as the clinical excerpt actions."""
    owners = defaultdict(set)
    for medicine in submitted.values():
        row_documents = set()
        for part in (medicine, *medicine.linked):
            for source in part.sources:
                if source.kind in DOCUMENT_KINDS:
                    owners[source.id].add(medicine.row.id)
                    row_documents.add(source.id)
        require(medicine.document_excerpts.keys() <= row_documents,
                "Choose a document cited by this medication row.")
    documents = case.setdefault("documents", {})
    excerpts = {}
    for sid, row_ids in owners.items():
        names_by_row = {rid: {fact.value for fact in prepared[rid][0].row.observed_names} for rid in row_ids}
        for rid in row_ids:
            combined, fields, names = prepared[rid]
            source = next(s for s in combined.sources if s.id == sid).model_dump(mode="json")
            require(sid in combined.notes, "Provide the original wording for this document.")
            full_text = combined.notes[sid]
            record = {"source": source, "wording": full_text}
            existing = documents.get(sid)
            require(existing == record if existing else sid not in reserved,
                    "Use a new source ID when the document or its wording changes.", 409)
            check_document_id(case, source)
            documents[sid] = record
            excerpt = submitted[rid].document_excerpts.get(sid)
            if not excerpt:
                require(len(row_ids) == 1, "Select a verbatim excerpt for each medication citing the shared document.")
                continue
            require(excerpt in full_text, "Select a verbatim excerpt from the registered document.")
            cited = set(names.get(sid, ()))
            cited.update(obs.value for obs in fields.get(sid, {}).values() if obs.value)
            cited.update(c.directions_text for c in combined.row.regimens
                         if c.evidence["directions_text"].source_id == sid)
            # Manual staff selection may cite a reference instead of quoting a drug name.
            # Only words actually present in the document can identify a source statement.
            quotes = [quote_pattern(q) for q in cited]
            require(all(not re.search(q, full_text, re.I) or re.search(q, excerpt, re.I) for q in quotes),
                    "The selected excerpt must contain this row's cited medication wording.")
            own_names = names_by_row[rid]
            other_names = {name for other, values in names_by_row.items() if other != rid for name in values} - own_names
            own_spans = [match.span() for name in own_names for match in re.finditer(quote_pattern(name), excerpt, re.I)]
            competitors = [match for name in other_names for match in re.finditer(quote_pattern(name), excerpt, re.I)]
            require(all(any(start <= match.start() and match.end() <= end for start, end in own_spans)
                        for match in competitors),
                    "Select the excerpt for this medication separately from the other medication.")
            excerpts[rid, sid] = excerpt
    return excerpts, set(owners)


def prepare_sources(medicine, case_id):
    """Validate each original against its own sources before binding the snapshots to one reviewed order."""
    rid = medicine.row.id
    combined = IntakePart.model_validate(medicine.model_dump(exclude={"linked", "corrections", "document_excerpts"}))
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
        for component in part.row.regimens:
            if component in candidate.regimens:
                continue
            if any(existing.component_id == component.component_id for existing in candidate.regimens):
                # Parser IDs are row-local. A linked scan can also call its first schedule "form-1".
                digest = sha256(component.model_dump_json().encode()).hexdigest()[:24]
                component = component.model_copy(update={"component_id": "linked-regimen-" + digest})
            _extend_unique(candidate.regimens, [component])
        _extend_unique(candidate.discrepancies, part.row.discrepancies)
        _extend_unique(candidate.follow_ups, part.row.follow_ups)
        candidate.reverse_crop = candidate.reverse_crop or part.row.reverse_crop
        for key, value in part.row.label_fields.items():
            if key not in candidate.label_fields or candidate.label_fields[key].status != "readable":
                candidate.label_fields[key] = value
    dispensing = {part.row.dispensing_source_id for part in parts if part.row.dispensing_source_id}
    candidate.dispensing_source_id = next(iter(dispensing)) if len(dispensing) == 1 else None
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
