"""Atomically reconcile confirmed intake rows with their assigned admission encounter."""
from base64 import b64decode, b64encode
from binascii import Error as Base64Error
from copy import deepcopy
from hashlib import sha256

from app.ai.client import EvidenceImage
from app.schemas.admission import NewEncounter, Photo, SourceEntry
from app.schemas.admission_intake import IntakeSubmission
from app.schemas.analysis import FollowUp
from app.schemas.evidence import EvidenceSource, PHOTO_KINDS, REPORT_KINDS
from app.services.catalogue_identity import supported_intake_identity
from app.services.admission_intake_evidence import prepare_sources
from app.services.admissions import capture_orientation, new_encounter, new_row, now, require, unresolved_photo


def _prepare_images(request, existing, medicines):
    attachments = {s.attachment_id for row in medicines for s in row.sources if s.kind in PHOTO_KINDS}
    require(None not in attachments and request.originals.keys() <= attachments, "Unexpected attachment.")
    images = dict(existing)
    orientations = {}
    for aid in attachments:
        incoming = request.originals.get(aid)
        if incoming:
            try:
                data = b64decode(incoming.data, validate=True)
            except Base64Error:
                require(False, "Invalid image encoding.")
            require(len(data) <= 4_000_000, "Photo exceeds the upload limit.", 413)
            image = EvidenceImage(aid, incoming.media_type, data)
            require(aid not in existing or existing[aid] == image, "Attachment IDs identify immutable originals.", 409)
            images[aid] = image
        require(aid in images, "Supply the original for every new photo.")
        orientations[aid] = capture_orientation(images[aid].media_type, images[aid].content)
    return images, orientations


def _entries(medicine, encoded, images, by_source, names_by_source):
    """Build ordinary admission source entries. Keep the exact suggestion alongside its citations."""
    result = []
    row = medicine.row
    refs = {ref.source_id: ref for ref in row.sources}
    require(len(refs) == len(row.sources), "Use a distinct logical source for each located region.")
    require(set(refs) == {s.id for s in medicine.sources}, "Supply exactly the cited row sources.")
    items = {(i.source_id, i.id): i for i in medicine.items}
    photo_regions = {i.id for i in medicine.items if i.kind != "record_excerpt"}
    require(set(medicine.regions) == set(medicine.physical_items) == photo_regions, "Supply the cited image regions.")
    require(set(medicine.notes) == {s.id for s in medicine.sources if s.kind not in PHOTO_KINDS},
            "Preserve the wording of every cited note.")
    front_ids = {s.id for s in medicine.sources if s.kind in {"label_photo", "additional_photo"}}
    front = {medicine.physical_items[i.id] for i in medicine.items if i.source_id in front_ids}
    for src in medicine.sources:
        reference = refs[src.id]
        names = names_by_source.get(src.id, set())
        name = next(iter(names)) if len(names) == 1 else None
        fields = by_source.get(src.id, {})
        attrs = {}
        for key in ("strength", "form", "dose", "directions", "indication"):
            if key in fields and fields[key].value:
                attrs[key] = fields[key].value
        picture = None
        item = items.get((src.id, reference.item_id))
        if src.kind in PHOTO_KINDS:
            require(item is not None and item.id in medicine.regions, "A photo must cite an exact region.")
            image = images[src.attachment_id]
            bounds = medicine.regions[item.id]
            appearance = item.kind == "pill_crop"
            picture = Photo(media_type=image.media_type, data=encoded[src.attachment_id],
                            region=(bounds.x, bounds.y, bounds.width, bounds.height), bag=row.id,
                            pairing="matched" if src.kind == "reverse_photo" and medicine.physical_items[item.id] in front else "uncertain",
                            front_attributed=src.kind == "label_photo" and not appearance,
                            appearance=(row.unknown_label or "Appearance") if appearance else None)
            wording = name or attrs.get("directions") or next((o.value for o in fields.values() if o.value), None)
            wording = wording or row.unknown_label or "Located medication image"
        else:
            wording = medicine.notes[src.id]
        # The source's actual words remain intact. A staff-entered product selection is a separate record.
        documented_name = name if name and name.casefold() in wording.casefold() else None
        transcribed = {key: value for key, value in attrs.items()
                       if value.casefold() in wording.casefold() and src.kind not in REPORT_KINDS}
        additional_label = src.kind == "additional_photo" and item and item.kind == "label_region"
        entry = SourceEntry(source=src, wording=wording, name=None if additional_label else documented_name,
                            photo=picture, **({} if additional_label else transcribed))
        saved = entry.model_dump(mode="json")
        if additional_label:
            saved.update(intake_additional_label=True, name=documented_name, **transcribed)
        saved["product"] = documented_name
        saved["label_overrides"] = []
        saved["intake_item_id"] = reference.item_id
        # The original field and field-level citation are part of MedicationSuggestion.
        saved["intake_observations"] = {key: value.model_dump(mode="json") for key, value in fields.items()}
        result.append(saved)
        if name and not documented_name:
            require(medicine.origin == "manual" and src.kind not in PHOTO_KINDS | REPORT_KINDS,
                    "Reconcile a suggested name with its original source before admission.")
            selection = SourceEntry(source=EvidenceSource(id="intake-choice-" + row.id, kind="reviewer_record"),
                                    wording=name, name=name).model_dump(mode="json")
            selection["product"] = name
            result.append(selection)
    ids = [e["source"]["id"] for e in result]
    require(len(ids) == len(set(ids)), "Use distinct IDs for document evidence and staff selection.")
    return result


def _display_identity(medicine, current_views):
    """A display hint is independent of the clinical identity, verification and import."""
    if not medicine.catalogue_identity or {"name", "form", "strength"} & medicine.corrections.keys():
        return None
    if medicine.origin != "analysis" or medicine.row.discrepancies:
        return None
    checked = []
    for part in (medicine, *medicine.linked):
        if (part.row.identity_status != "named" or part.row.discrepancies
                or any(s.kind == "label_photo" and current_views.get("front", s.attachment_id) != s.attachment_id
                       for s in part.sources)):
            return None
        identity = supported_intake_identity(part.catalogue_identity, part.row, part.items, part.sources)
        if not identity or not identity.candidate_tpus:
            return None
        if part.catalogue and (part.catalogue.release != identity.release
                               or part.catalogue.product.tpu not in identity.candidate_tpus):
            return None
        checked.append(identity)
    primary = checked[0]
    if any((entry.ingredient, entry.trade_name, entry.release) !=
           (primary.ingredient, primary.trade_name, primary.release) for entry in checked[1:]):
        return None
    candidates = set(primary.candidate_tpus).intersection(*(entry.candidate_tpus for entry in checked[1:]))
    if not candidates or (medicine.catalogue and medicine.catalogue.product.tpu not in candidates):
        return None
    refs = {(ref.source_id, ref.item_id): ref for identity in checked for ref in identity.evidence}
    return primary.model_copy(update={"evidence": list(refs.values()),
                                      "candidate_tpus": sorted(candidates)}).model_dump(mode="json")


def _reserved_evidence(case):
    """Reserve sources owned by clinical activity or retired in an earlier revision."""
    reserved = set(case.get("retired_capture_sources", ())) | set(case.get("unavailable_sources", ()))
    current = set()
    for row in case["rows"].values():
        intake_ids = set(row.get("intake_entry_ids", ()))
        reserved.update(row["superseded"])
        current.update(intake_ids)
        reserved.update(e["source"]["id"] for e in row["entries"] if e["source"]["id"] not in intake_ids)
    for event in case["events"]:
        reserved.update(set(event.get("sources", ())) - current)
    return reserved


def _used(row, intake_entry_ids):
    return (row["verified"] or row["interview"] or row["proposal"] or row["confirmed"] or row["referred"]
            or row["superseded"] or row.get("imported_at") or row.get("screening_attestation")
            or any(e["source"]["id"] not in intake_entry_ids for e in row["entries"]))


def save_intake(store, actor, request: IntakeSubmission):
    require(actor.role in {"doctor", "nurse", "pharmacist"}, "Clinical reviewer required.", 403)
    case_id = "admission-" + request.case_id.hex
    by_id = {medicine.row.id: medicine for medicine in request.rows}
    require(len(by_id) == len(request.rows), "Duplicate medicine row.")
    display_identities = {rid: _display_identity(m, request.current_views) for rid, m in by_id.items()}
    prepared = {rid: prepare_sources(medicine, case_id) for rid, medicine in by_id.items()}
    medicines = [part for part, _, _ in prepared.values()]
    # Evidence identifiers may be reused only for the same source, including its original wording.
    registry = {}
    for item in medicines:
        for source in item.sources:
            value = (source, item.notes.get(source.id))
            require(source.id not in registry or registry[source.id] == value, "A source was edited after confirmation.")
            registry[source.id] = value
    digests = {rid: sha256(m.model_dump_json().encode()).hexdigest() for rid, m in by_id.items()}
    with store.lock:
        previous = store.records.get(case_id)
        if previous:
            store.get(actor, case_id)
        for side, aid in request.current_views.items():
            kind = "label_photo" if side == "front" else "reverse_photo"
            require(any(s.kind == kind and s.attachment_id == aid for m in medicines for s in m.sources),
                    "A current view must cite a supplied original on the same side.")
        images, orientations = _prepare_images(request, store.originals.get(case_id, {}), medicines)
        if previous and previous.get("intake_digests") == digests and previous.get("intake_current_views", {}) == request.current_views:
            return previous
        require(request.revision == (previous["revision"] if previous else 0),
                "Encounter changed. Refresh before sending this draft.", 409)
        if previous:
            require(previous["status"] == "In progress", "Intake has finished for this encounter.", 409)
        case = deepcopy(previous) if previous else new_encounter(case_id, actor, NewEncounter(
            patient_alias="Encounter " + request.case_id.hex[:8], assigned_roles={"nurse", "doctor", "pharmacist"}), revision=0)
        old = case.get("intake_digests", {})
        changed = {rid for rid in old.keys() | by_id.keys() if old.get(rid) != digests.get(rid)}
        encoded = {aid: b64encode(im.content).decode("ascii") for aid, im in images.items() if aid in orientations}
        reserved = _reserved_evidence(case)
        generated = {}
        for rid in sorted(changed):
            row = case["rows"].get(rid)
            if row:
                require(rid in old and not _used(row, set(row["intake_entry_ids"])),
                        "This row already has clinical activity. Amend it in clinical review.", 409)
            if rid not in by_id:
                del case["rows"][rid]
                continue
            medicine, source_fields, source_names = prepared[rid]
            entries = _entries(medicine, encoded, images, source_fields, source_names)
            crop = medicine.row.reverse_crop
            if crop and not any(e["source"]["id"] == crop.source_id and e["photo"] and
                                e["photo"]["pairing"] == "matched" for e in entries):
                medicine.row.reverse_crop = None
                medicine.row.follow_ups.append(FollowUp(field="photo_match",
                    question="Can the reviewer match the reverse photo to this item?"))
            for entry in entries:
                sid = entry["source"]["id"]
                require(sid not in reserved, "Use new source IDs for independent, retired or unavailable evidence.", 409)
                if sid not in {source.id for source in medicine.sources}:
                    require(sid not in registry and generated.setdefault(sid, rid) == rid,
                            "Use distinct IDs for staff selection and documentary evidence.")
            unknown = medicine.row.identity_status != "named" or not any(e["name"] for e in entries)
            if any(unresolved_photo(e) for e in entries):
                unknown |= all(e["source"]["kind"] in REPORT_KINDS for e in entries if e["name"])
            prior = row
            original = by_id[rid]
            unknown |= (original.corrections.get("name") == "" or
                        any(scan.row.identity_status != "named" for scan in original.linked))
            row = new_row(rid, unknown=unknown or bool(prior and prior["unknown"]))
            if prior and prior["unknown"]:
                row["unknown_capture_attachments"] = sorted({
                    *(prior.get("unknown_capture_attachments") or ()),
                    *(e["source"]["attachment_id"] for e in prior["entries"] if e["photo"])
                })
            row.update(entries=entries, intake=medicine.row.model_dump(mode="json"),
                       intake_entry_ids=[e["source"]["id"] for e in entries],
                       intake_catalogue=medicine.catalogue.model_dump(mode="json") if medicine.catalogue else None)
            display_identity = display_identities[rid]
            if display_identity:
                row["intake_catalogue_identity"] = display_identity
            if original.linked or original.corrections:
                row["intake_sources"] = [part.row.model_dump(mode="json") for part in [original, *original.linked]]
                row["intake_corrections"] = original.corrections.copy()
            case["rows"][rid] = row
        from app.services.admission_intake_capture import sync_capture
        sync_capture(case, medicines, orientations, request.current_views)
        if previous and previous.get("intake_capture_fingerprint"):
            require(sha256(repr(previous.get("capture")).encode()).hexdigest() == previous["intake_capture_fingerprint"]
                    or case.get("capture") == previous.get("capture"), "The package layout changed. Refresh before updating intake.", 409)
        if case.get("capture"):
            case["intake_capture_fingerprint"] = sha256(repr(case["capture"]).encode()).hexdigest()
        case.update(intake_digests=digests, intake_attachments=sorted(images), intake_current_views=request.current_views)
        case["revision"] += 1
        case["events"].append(dict(action="intake", actor=actor.model_dump(), at=now(), revision=case["revision"],
                                   rows=sorted(changed), sources=sorted(registry)))
        store.originals[case_id] = images
        store.records[case_id] = case
        return case
