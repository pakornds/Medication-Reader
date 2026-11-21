"""Identify row evidence withdrawn by an edit to an attributed capture region."""
from base64 import b64decode, b64encode
from collections import defaultdict
from dataclasses import dataclass

from fastapi import HTTPException
from app.schemas.package_capture import PackageCapture


@dataclass(frozen=True)
class Attribution:
    package_id: str
    row_id: str
    source_id: str
    item_id: str
    kind: str
    side: str
    attachment: str
    region_id: str
    bounds: tuple[float, float, float, float]


def attributions(scene):
    records = set()
    for package in scene.packages:
        for item in package.items:
            for evidence in item.evidence:
                link = evidence.region
                box = scene.locate(link).bounds
                records.add(Attribution(package.id, item.row_id, evidence.source_id, evidence.item_id,
                                        evidence.kind, link.side, link.attachment_id, link.region_id,
                                        (box.x, box.y, box.width, box.height)))
    return records


def capture_retake_origin(case, originals, row, source_id):
    if source_id in row["superseded"] or not case.get("capture"):
        return None
    scene = PackageCapture.model_validate(case["capture"])
    refs = [ref for ref in attributions(scene)
            if ref.row_id == row.get("capture_item_id") and ref.source_id == source_id]
    if len(refs) != 1:
        return None
    ref, = refs
    return {
        "source": {"kind": "label_photo" if ref.side == "front" else "reverse_photo", "attachment_id": ref.attachment},
        "photo": {"bag": ref.package_id, "region": ref.bounds,
                  "data": b64encode(originals[ref.attachment].content).decode("ascii")},
    }


def changed_attributions(case, originals, previous, next_scene):
    old, new = attributions(previous), attributions(next_scene)
    removed = old - new
    affected = {ref.source_id for ref in removed}
    restricted = set(case.get("restricted_capture_sources", ())) | affected
    if any(ref.source_id in restricted for ref in new - old):
        raise HTTPException(422, "Review the changed region and cite it with a new source.")
    used = {ref.source_id for ref in new}
    retired = affected - used
    by_row = defaultdict(set)
    surviving = {(ref.row_id, ref.source_id) for ref in new}
    for ref in removed:
        row_id = case["capture_rows"][ref.row_id]
        row = case["rows"][row_id]
        for entry in row["entries"]:
            photo, source = entry.get("photo"), entry["source"]
            sid = source["id"]
            if sid in row["superseded"]:
                continue
            if sid == ref.source_id and (ref.row_id, sid) not in surviving:
                by_row[row_id].add(sid)
            elif (photo and source["kind"] == ("label_photo" if ref.side == "front" else "reverse_photo")
                  and tuple(photo["region"]) == ref.bounds
                  and (source["attachment_id"] == ref.attachment or b64decode(photo["data"]) == originals[ref.attachment].content)):
                by_row[row_id].add(sid)
        retired.update(by_row[row_id] - used)
    return by_row, retired, restricted & used
