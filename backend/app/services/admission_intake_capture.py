"""Expose intake's located originals through the admission's standard crop and proposal endpoints."""
from collections import defaultdict

from app.schemas.package_capture import PackageCapture
from app.services.admissions import require


def sync_capture(case, medicines, orientations, current_views):
    by_side = defaultdict(dict)
    attachments = {}
    front_by_source = {}
    sources = {}
    for medicine in medicines:
        evidence = {s.id: s for s in medicine.sources}
        for item in medicine.items:
            source = evidence[item.source_id]
            if source.kind not in {"label_photo", "reverse_photo"}:
                continue
            side = "front" if source.kind == "label_photo" else "reverse"
            if side in current_views and current_views[side] != source.attachment_id:
                # Linked historical observations remain on their own located immutable original.
                continue
            require(attachments.setdefault(side, source.attachment_id) == source.attachment_id,
                    "Review the current front and reverse photos before continuing; multiple originals occupy one view.")
            sources[source.id] = source
            data = dict(id=item.id, bounds=medicine.regions[item.id].model_dump())
            require(by_side[side].setdefault(item.id, data) == data, "A located region was changed after confirmation.")
            if side == "front":
                front_by_source[item.source_id] = medicine.row.id

    previous = case.get("capture", {})
    if "front" not in attachments and not previous:
        return  # An unpaired additional or reverse item retains its located original on its entry.
    for side in ("front", "reverse"):
        old = previous.get(side)
        if old and side not in attachments:
            attachments[side] = old["attachment_id"]
            orientations.setdefault(old["attachment_id"], old["exif_orientation"])
    views = {}
    for side, attachment in attachments.items():
        old = previous.get(side) or {}
        regions = sorted(by_side[side].values(), key=lambda r: r["id"])
        changed = old.get("attachment_id") != attachment or {
            r["id"]: r["bounds"] for r in old.get("regions", [])
        } != {r["id"]: r["bounds"] for r in regions}
        views[side] = dict(attachment_id=attachment, revision=max(1, old.get("revision", 0) + changed),
                           exif_orientation=orientations[attachment], regions=regions)

    packages, matches = [], []
    links = {}
    for medicine in medicines:
        rid = medicine.row.id
        owned = {medicine.physical_items[i.id] for i in medicine.items if i.source_id in front_by_source}
        if not owned:
            continue
        require(len(owned) == 1, "Keep separate physical packages distinct.")
        package_id = "package-" + rid
        front, evidence = [], []
        for item in medicine.items:
            if item.source_id not in sources:
                continue
            side = "front" if item.source_id in front_by_source else "reverse"
            if medicine.physical_items[item.id] not in owned:
                continue  # A report about this row does not confirm the package on an unrelated photo.
            view = views[side]
            region = dict(case_id=case["id"], side=side, attachment_id=view["attachment_id"],
                          revision=view["revision"], region_id=item.id)
            if side == "front":
                front.append(region)
            else:
                matches.append(dict(package_id=package_id, region=region, status="confirmed"))
            evidence.append(dict(item_id=item.id, source_id=item.source_id,
                                 kind="appearance" if item.kind == "pill_crop" else "label", region=region))
        packages.append(dict(id=package_id, front_regions=front, items=[dict(row_id="capture-item-" + rid, kind="order", evidence=evidence)]))
        links["capture-item-" + rid] = rid
        case["rows"][rid].update(package_id=package_id, capture_item_id="capture-item-" + rid)
    manifest = PackageCapture(case_id=case["id"], **views, packages=packages, reverse_matches=matches,
                              sources=list(sources.values()))
    result = manifest.model_dump(mode="json")
    # A newly uploaded, unmarked scene is deliberately reusable for proposal -> confirmation.
    has_associations = bool(previous.get("packages") or previous.get("reverse_matches") or previous.get("sources"))
    if has_associations and not case.get("intake_capture") and previous != result:
        require(False, "The encounter already has a separately edited capture. Reconcile its associations first.", 409)
    case.update(capture=result, capture_rows=links, intake_capture=True)
