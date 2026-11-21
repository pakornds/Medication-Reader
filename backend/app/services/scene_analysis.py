"""Analyze individual packages in unmarked whole scenes without equating opposite sides by position."""
import hashlib
from concurrent.futures import ThreadPoolExecutor
from functools import partial
from io import BytesIO
from typing import Literal

from PIL import Image

from app.ai.client import ProviderError
from app.schemas.analysis import AnalysisResult, LabelMedicationSuggestion, validate_analysis_result
from app.schemas.evidence import ContractModel, EvidenceItem, EvidenceRef, Text
from app.schemas.package_capture import RegionBounds
from app.services.labels import LabelPhotoError, crop_label
from app.services.located_label import read_located_label
from app.services.package_regions import propose_package_regions


class LocatedRegion(ContractModel):
    attachment_id: Text
    source_id: Text
    item_id: Text
    row_id: Text
    bounds: RegionBounds


class PhotoIssue(ContractModel):
    attachment_id: Text
    code: Literal["detection_unavailable", "no_regions", "unreadable_region"]
    item_id: Text | None = None
    provider_code: Text | None = None


def located_region(case_id, attachment, bounds):
    fingerprint = "|".join([case_id, attachment, *(str(round(v, 6)) for v in bounds.model_dump().values())])
    rid = "region-" + hashlib.sha256(fingerprint.encode()).hexdigest()[:24]
    return LocatedRegion(attachment_id=attachment, source_id=rid, item_id=rid, row_id=rid, bounds=bounds)


def _locations(form, photo, source, get_provider):
    from app.services.medication_analysis import FormAnalysisError

    try:
        with Image.open(BytesIO(photo.content)) as image:
            if image.width * image.height > 25_000_000:
                raise FormAnalysisError("The photo exceeds the decoded image size limit.")
    except (OSError, Image.DecompressionBombError):
        raise FormAnalysisError("The uploaded image could not be decoded.") from None
    aid = source.attachment_id or source.id
    try:
        bounds = propose_package_regions(photo, get_provider).regions
    except ProviderError as exc:
        return [], [PhotoIssue(attachment_id=aid, code="detection_unavailable", provider_code=exc.detail.code)]
    if len(bounds) > 48:
        return [], [PhotoIssue(attachment_id=aid, code="detection_unavailable")]
    regions = {}
    for box in bounds:
        link = located_region(form.evidence.case_id, aid, box)
        regions.setdefault(link.item_id, link)
    if not regions:
        return [], [PhotoIssue(attachment_id=aid, code="no_regions")]
    return list(regions.values()), []


def _unknown(reference, title, status):
    return LabelMedicationSuggestion(id=reference.source_id, identity_status=status, unknown_label=title,
                                    sources=[reference])


def _extract_region(form, photo, original, located, get_provider):
    from app.services.medication_analysis import FormGrounding

    reverse = original.kind == "reverse_photo"
    source = original.model_copy(update={"id":located.source_id, "attachment_id":located.attachment_id})
    item = EvidenceItem(id=located.item_id, source_id=source.id, row_id=located.row_id,
                        kind="pill_crop" if reverse else "label_region")
    reference = EvidenceRef(source_id=source.id, item_id=item.id)
    issue = None
    provider_code = None
    if reverse:
        row = _unknown(reference, "Unidentified package", "unlabeled")
    else:
        b = located.bounds
        coordinates = ",".join(f"{v*100:.12f}%" for v in (b.x,b.y,b.width,b.height))
        try:
            crop = crop_label(photo, coordinates, source.id)
        except LabelPhotoError:
            return None, None, PhotoIssue(attachment_id=located.attachment_id,
                                          item_id=item.id, code="unreadable_region")
        try:
            row = read_located_label(form.evidence.case_id, source, item, crop, get_provider())
        except ProviderError as exc:
            provider_code = exc.detail.code
            issue = "unreadable_region"
        if issue:
            row = _unknown(reference, "Unreadable label", "unreadable")
    # The exact single-crop transcript supplies extracted facts. Do not synthesize or merge adjacent rows.
    one = form.model_copy(update={"evidence":form.evidence.model_copy(update={"sources":[source],"items":[item]}),
                                  "patient_report":[], "other_source_notes":[]})
    grounding = FormGrounding(one, {(source.id,item.id):row})
    grounding.ground_names(row)
    facility = grounding.ground_row(row, [row])
    validate_analysis_result(AnalysisResult(case_id=form.evidence.case_id, rows=[row]), one.evidence)
    error = PhotoIssue(attachment_id=located.attachment_id, item_id=item.id, code=issue, provider_code=provider_code) if issue else None
    return row, facility, error


def analyze_scenes(form, photos, get_provider, linked_sources):
    from app.services.medication_analysis import AnalysisPreview, FormAnalysisError, analyze_medication_form

    selected = set(form.scene_photo_ids)
    if len(selected) != len(form.scene_photo_ids) or not selected <= set(form.photo_source_ids):
        raise FormAnalysisError("Identify unmarked scenes using their uploaded photo IDs.")
    scene_sources = {sid for pid in selected for sid in linked_sources[pid]}
    if any(item.source_id in scene_sources for item in form.evidence.items):
        raise FormAnalysisError("Use whole-scene analysis only for photos without marked items.")
    by_id = {s.id: s for s in form.evidence.sources}
    remaining = form.model_copy(deep=True)
    remaining.scene_photo_ids = []
    remaining.photo_source_ids = [pid for pid in form.photo_source_ids if pid not in selected]
    remaining.evidence.sources = [s for s in remaining.evidence.sources if s.id not in scene_sources]
    retained = [p for p in photos if p.evidence_id not in selected]
    preview = AnalysisPreview(case_id=form.evidence.case_id, rows=[], unassigned_reports=form.patient_report,
                              unavailable_sources=[s for s in remaining.evidence.sources if s.availability == "unavailable"])
    if retained or remaining.patient_report or remaining.other_source_notes:
        try:
            preview = analyze_medication_form(remaining, retained, get_provider)
        except ProviderError:
            preview.remaining_evidence_unassessed = True
            preview.unassessed_question = bool(form.question)
    elif form.question:
        preview.unassessed_question = True
    has_front = any(by_id[p.evidence_id].kind == "label_photo" for p in photos)
    for photo in photos:
        if photo.evidence_id not in selected:
            continue
        original = by_id[photo.evidence_id]
        regions, issues = _locations(form, photo, original, get_provider)
        preview.located_regions.extend(regions)
        preview.photo_issues.extend(issues)
        reverse = original.kind == "reverse_photo"
        if reverse and has_front:
            continue
        extract = partial(_extract_region, form, photo, original, get_provider=get_provider)
        with ThreadPoolExecutor(max_workers=3) as workers:
            for row, facility, issue in workers.map(extract, regions):
                if issue:
                    preview.photo_issues.append(issue)
                if row is not None:
                    preview.rows.append(row)
                    if facility:
                        preview.dispensing_facilities[row.id] = facility
    return preview
