"""Revisioned, encounter-scoped mock review records shared by demo staff sessions."""
from base64 import b64decode
from collections import defaultdict
from copy import deepcopy
from datetime import UTC, datetime
from hashlib import sha256
from io import BytesIO
from json import dumps
from threading import RLock
from uuid import uuid4

from fastapi import HTTPException
from PIL import Image

from app.ai.client import EvidenceImage
from app.schemas.package_capture import PackageCapture
from app.services.labels import LabelPhotoError, crop_label

from app.schemas.analysis import Discrepancy
from app.schemas.admission import (
    Action, AddEvidence, AddRow, AssessIdentityIncident, Decision, Finish, Import, Interview, NewEncounter, Proposal, Refer, Verify,
)
from app.schemas.evidence import REPORT_KINDS, Observation, CaseEvidence, EvidenceItem, EvidenceRef, EvidenceSource, SourcedValue
from app.schemas.review import CurrentUseVerification, ImportRequest, ReviewRow
from app.schemas.regimen import RegimenParseRequest
from app.services.regimens import parse_directions
from app.services.admission_incidents import record_identity_incident
from app.services.hospital import HospitalError
from app.services.import_eligibility import ApprovalLedger, EligibilityError, selected_evidence


def now():
    return datetime.now(UTC).isoformat()


def require(condition, message, status=422):
    if not condition:
        raise HTTPException(status, message)


def active(row):
    return [entry for entry in row["entries"] if entry["source"]["id"] not in row["superseded"]]


def entry_for(row, source_id):
    entry = next((e for e in active(row) if e["source"]["id"] == source_id), None)
    require(entry is not None, "Select an active source linked to this item.")
    return entry


def needs_identity(row):
    if not row["unknown"] or row["confirmed"]:
        return False
    return bool(row["proposal"] or row["referred"] or
                (row["interview"] or {}).get("current_use") in {"current", "uncertain"})


def shares_origin(entry, other):
    attachment = entry["source"]["attachment_id"]
    if attachment and attachment == other["source"]["attachment_id"]:
        return True
    if entry["photo"] and other["photo"]:
        return entry["photo"]["data"] == other["photo"]["data"]
    return False


DOCUMENTED_FIELDS = ("strength", "form", "dose", "directions", "indication")
LABEL_OVERRIDE_FIELDS = frozenset((*DOCUMENTED_FIELDS, "directions_status"))


def label_overrides(entry):
    return sorted(entry.model_fields_set & LABEL_OVERRIDE_FIELDS)


def entry_observations(entry):
    observations = {
        key: (field["status"], field["value"])
        for key, field in entry.get("scan_fields", {}).items()
    }
    overrides = entry.get("label_overrides", LABEL_OVERRIDE_FIELDS)
    for key in DOCUMENTED_FIELDS:
        if entry[key]:
            observations[key] = ("readable", entry[key])
        elif key in observations:
            cleared = key in overrides and observations[key][0] == "readable"
            if key == "directions" and (cleared or "directions_status" in overrides):
                observations[key] = (entry["directions_status"], None)
            elif cleared:
                del observations[key]
    return observations


def conflicting_fields(row):
    values = defaultdict(set)
    for entry in active(row):
        for key, (status, value) in entry_observations(entry).items():
            if status == "readable":
                values[key].add(value.casefold())
    return [key for key, seen in values.items() if len(seen) > 1]


def reviewable_entry(entry):
    photo = entry["photo"]
    front = entry["source"]["kind"] == "label_photo" and photo and photo.get("front_attributed")
    return not photo or ((front or photo["pairing"] == "matched") and not photo["appearance"])


def unresolved_photo(entry):
    return bool(entry["photo"] and (not entry["name"] or not reviewable_entry(entry)))


def hold_report_identity(case, row):
    """Keep a report-based name as a proposal once a physical unknown is linked."""
    if row["unknown"]:
        return
    named = [entry for entry in active(row) if entry["name"] and reviewable_entry(entry)]
    if not named or named[0]["source"]["kind"] not in REPORT_KINDS:
        return
    if any(entry["photo"] or entry["identity_basis"] for entry in named):
        return

    entry = named[0]
    source_id = entry["source"]["id"]
    added = next(event for event in reversed(case["events"])
                 if event["action"] in {"add", "link"} and source_id in event["sources"])
    row["unknown"] = True
    row["verified"] = None
    row.pop("imported_at", None)
    row["proposal"] = dict(name=entry["product"], reference=source_id, proposer=added["actor"]["id"],
                           independent_entry=False)


def new_row(row_id, unknown):
    return dict(id=row_id, unknown=unknown, entries=[], superseded=[], proposal=None,
                confirmed=None, referred=False, interview=None, verified=None)


def import_snapshot_key(row):
    verified = row["verified"]
    # Keep the verified identity, use, regimen and their selected citations.
    # Audit metadata and incidental evidence do not change the clinical snapshot.
    answer = verified["answer"]
    review = [verified["identity"], verified["source_id"], answer["ownership"],
              answer["current_use"], answer["dose"], answer["route"], answer["schedule"]]
    return sha256(dumps(review, sort_keys=True).encode()).hexdigest()


def capture_orientation(media_type, data):
    expected = {"image/jpeg": "JPEG", "image/png": "PNG", "image/webp": "WEBP"}[media_type]
    try:
        with Image.open(BytesIO(data), formats=[expected]) as image:
            require(image.width * image.height <= 25_000_000, "Image exceeds the decoded size limit.")
            orientation = image.getexif().get(274, 1)
            require(isinstance(orientation, int) and 1 <= orientation <= 8, "Invalid original orientation.")
            image.load()
            return orientation
    except (OSError, SyntaxError, ValueError, Image.DecompressionBombError):
        raise HTTPException(422, "Invalid capture image.") from None


class AdmissionStore:
    def __init__(self, hospital):
        self.records = {}
        self.originals = {}
        self.retries = {}
        self.imported_rows = {}
        self.hospital = hospital
        self.lock = RLock()

    def create(self, actor, request: NewEncounter):
        require(actor.role in {"nurse", "doctor", "pharmacist"}, "Clinical reviewer required.", 403)
        assigned = {actor.id, "demo-pharmacist", *("demo-" + role for role in request.assigned_roles)}
        case = dict(id="admission-" + uuid4().hex, patient_alias=request.patient_alias,
                    assigned=sorted(assigned), revision=1, status="In progress", created_at=now(),
                    rows={}, events=[], receipts=[], identity_incidents={})
        with self.lock:
            self.records[case["id"]] = case
        return case

    def get(self, actor, case_id):
        with self.lock:
            case = self.records.get(case_id)
            require(case and actor.id in case["assigned"] and actor.role in {"nurse", "doctor", "pharmacist"},
                    "Encounter unavailable.", 404)
            return case

    def list(self, actor):
        with self.lock:
            return [dict(id=c["id"], patient_alias=c["patient_alias"], status=c["status"],
                         updated_at=c["events"][-1]["at"] if c["events"] else c["created_at"])
                    for c in self.records.values() if actor.id in c["assigned"]]

    def can_read(self, actor, case_id):
        with self.lock:
            return actor.id in self.records.get(case_id, {}).get("assigned", [])

    def candidates(self, actor, case_id):
        case = self.get(actor, case_id)
        choices = [{"name": e["name"], "id": e["source"]["id"], "origin": "Encounter record"}
                   for row in case["rows"].values() for e in active(row) if e["name"]
                   and e["source"]["kind"] in {"prescription", "transfer_record"}]
        for receipt in case["receipts"]:
            stamp = datetime.fromisoformat(receipt["imported_at"])
            for record in self.hospital.lookup(stamp):
                if record.snapshot.evidence.case_id == case_id:
                    choices.extend({"name": r.verification.identity.value, "id": r.id + "/" + stamp.isoformat(),
                                    "origin": "Mock hospital"} for r in record.snapshot.rows)
        return choices

    def apply(self, actor, case_id, request: Action):
        with self.lock:
            original = self.get(actor, case_id)
            key = (case_id, actor.id, request.request_id)
            cmd = request.command
            fingerprint = sha256(request.model_dump_json().encode())
            if isinstance(cmd, (AddRow, AddEvidence)) and cmd.entry.scan_fields:
                fingerprint.update(b"\0" + ",".join(label_overrides(cmd.entry)).encode())
            digest = fingerprint.hexdigest()
            if key in self.retries:
                require(self.retries[key] == digest, "Request ID already used.", 409)
                return original
            require(original["revision"] == request.revision, "Encounter changed. Reload before saving.", 409)
            if isinstance(cmd, (Import, Decision, AssessIdentityIncident)) or original["status"] == "Awaiting pharmacist review":
                require(actor.role == "pharmacist", "Pharmacist required.", 403)
            require(original["status"] != "Finished" or isinstance(cmd, (Import, AssessIdentityIncident)),
                    "Review is finished.", 409)
            case = deepcopy(original)
            details = self.transition(case, actor, cmd, request.request_id)
            for row_id in details["rows"]:
                row = case["rows"][row_id]
                imported_at = self.row_imported_at(case_id, row)
                if imported_at:
                    row["imported_at"] = imported_at
                else:
                    row.pop("imported_at", None)
            case["revision"] += 1
            case["events"].append(dict(action=cmd.action, actor=actor.model_dump(), at=now(),
                                       revision=case["revision"], **details))
            self.records[case_id] = case
            self.retries[key] = digest
            return case

    def capture(self, actor, case_id, command, images):
        manifest = command.manifest.model_copy(deep=True)
        with self.lock:
            original = self.get(actor, case_id)
            require(manifest.case_id == case_id, "Capture belongs to another encounter.")
            key = (case_id, actor.id, command.request_id)
            fingerprint = sha256(command.model_dump_json().encode())
            for side, (media_type, data) in sorted(images.items()):
                fingerprint.update(side.encode() + media_type.encode() + sha256(data).digest())
            digest = fingerprint.hexdigest()
            if key in self.retries:
                require(self.retries[key] == digest, "Request ID already used.", 409)
                return original
            require(original["revision"] == command.revision, "Encounter changed. Reload before saving.", 409)
            require(original["status"] != "Finished", "Review is finished.", 409)
            if original["status"] == "Awaiting pharmacist review":
                require(actor.role == "pharmacist", "Pharmacist required.", 403)

            originals = self.originals.get(case_id, {}).copy()
            previous = PackageCapture.model_validate(original["capture"]) if "capture" in original else None
            for side in ("front", "reverse"):
                view = getattr(manifest, side)
                old = getattr(previous, side) if previous else None
                if old:
                    require(view and old.attachment_id == view.attachment_id,
                            "Use the retake workflow to replace an existing original.", 409)
                    old_regions = {r.id: r for r in old.regions}
                    new_regions = {r.id: r for r in view.regions}
                    changed = (any(new_regions.get(rid) != region for rid, region in old_regions.items())
                               or old.visibility != view.visibility)
                    require(view.revision >= old.revision + int(changed), "The view revision is stale.", 409)
                if not view:
                    require(side not in images, "Unexpected original without a capture view.")
                    continue
                if view.attachment_id in originals:
                    require(side not in images, "Reference the existing original without uploading it again.")
                    require(old, "Original is already bound to a different view.")
                    orientation = old.exif_orientation
                else:
                    require(side in images, "Supply the original for each new view.")
                    media_type, data = images[side]
                    orientation = capture_orientation(media_type, data)
                    originals[view.attachment_id] = EvidenceImage(view.attachment_id, media_type, data)
                require("exif_orientation" not in view.model_fields_set or view.exif_orientation == orientation,
                        "Original orientation differs from the manifest.")
                view.exif_orientation = orientation

            case = deepcopy(original)
            links = case.setdefault("capture_rows", {})
            items = {item.row_id: (package.id, item) for package in manifest.packages for item in package.items}
            require(command.existing_rows.keys() <= items.keys(), "Link an item from the current capture.")
            for removed in links.keys() - items.keys():
                row = case["rows"][links.pop(removed)]
                row.pop("package_id", None)
                row.pop("capture_item_id", None)
            for item_id, (package_id, item) in items.items():
                target = command.existing_rows.get(item_id)
                if target:
                    require(target in original["rows"], "Referenced admission row is unavailable.")
                    require(links.get(item_id, target) == target, "An item cannot move to another row.")
                    require(target not in (rid for iid, rid in links.items() if iid != item_id),
                            "Keep separate capture items on separate rows.")
                if item_id not in links:
                    if not target:
                        target = "item-" + str(len(case["rows"]) + 1)
                        case["rows"][target] = new_row(target, unknown=True)
                    links[item_id] = target
                row = case["rows"][links[item_id]]
                require(row.get("package_id", package_id) == package_id, "An item cannot move between packages.")
                row["package_id"] = package_id
                row["capture_item_id"] = item_id
                if all(evidence.kind == "appearance" for evidence in item.evidence):
                    hold_report_identity(case, row)
                    attachments = set(row.get("unknown_capture_attachments", []))
                    attachments.update(evidence.region.attachment_id for evidence in item.evidence)
                    row["unknown_capture_attachments"] = sorted(attachments)

            case["capture"] = manifest.model_dump(mode="json")
            case["revision"] += 1
            case["events"].append(dict(action="capture", actor=actor.model_dump(), at=now(),
                                       revision=case["revision"], rows=list(links.values()),
                                       sources=[s.id for s in manifest.sources]))
            self.records[case_id] = case
            self.originals[case_id] = originals
            self.retries[key] = digest
            return case

    def view(self, actor, case_id, ref):
        with self.lock:
            case = self.get(actor, case_id)
            metadata = case.get("capture", {}).get(ref.side)
            require(metadata and metadata["attachment_id"] == ref.attachment_id
                    and metadata["revision"] == ref.revision, "Capture view unavailable.", 404)
            return self.originals[case_id][ref.attachment_id]

    def region(self, actor, case_id, link):
        with self.lock:
            image = self.view(actor, case_id, link)
            manifest = PackageCapture.model_validate(self.records[case_id]["capture"])
            try:
                bounds = manifest.locate(link).bounds
            except ValueError:
                raise HTTPException(404, "Capture region unavailable.") from None
        location = ",".join(f"{n * 100:.15f}%" for n in (bounds.x, bounds.y, bounds.width, bounds.height))
        try:
            return crop_label(image, location, image.evidence_id)
        except LabelPhotoError as exc:
            raise HTTPException(422, str(exc)) from None

    def transition(self, case, actor, cmd, request_id):
        rows = case["rows"]
        if isinstance(cmd, (AddRow, AddEvidence)):
            entry = cmd.entry.model_dump(mode="json")
            if cmd.entry.scan_fields:
                # Keep explicit reviewer overrides separate from omitted defaults and the raw scan.
                entry["label_overrides"] = label_overrides(cmd.entry)
            if entry["name"]:
                parts = [entry["name"]]
                for field in ("strength", "form"):
                    if entry[field] and entry[field].casefold() not in entry["name"].casefold():
                        parts.append(entry[field])
                entry["product"] = " ".join(parts)
            sid = entry["source"]["id"]
            require(not any(sid == e["source"]["id"] for r in rows.values() for e in r["entries"]),
                    "Use a new logical source ID.")
            if isinstance(cmd, AddRow):
                rid = "item-" + str(len(rows) + 1)
                row = new_row(rid, unknown=not bool(entry["name"]))
                rows[rid] = row
            else:
                row = self.row(rows, cmd.row_id)
                if cmd.replaces:
                    old = entry_for(row, cmd.replaces)
                    require(old["photo"] and entry["photo"] and old["photo"]["bag"] == entry["photo"]["bag"],
                            "Retake the same bag or item.")
                    row["superseded"].append(cmd.replaces)
                    if row["confirmed"] and row["confirmed"]["source_id"] == cmd.replaces:
                        row["confirmed"] = None
            if unresolved_photo(entry):
                hold_report_identity(case, row)
            if isinstance(cmd, AddEvidence) and row["unknown"] and entry["name"]:
                if row["confirmed"] and row["confirmed"]["name"].casefold() != entry["product"].casefold():
                    row["confirmed"] = None
                if not row["confirmed"] and not row["proposal"]:
                    row["proposal"] = dict(name=entry["product"], reference=sid, proposer=actor.id,
                                           independent_entry=bool(entry["identity_basis"]))
            row["entries"].append(entry)
            row["verified"] = None
            return dict(rows=[row["id"]], sources=[sid], replaces=getattr(cmd, "replaces", None))

        if isinstance(cmd, (Finish, Refer, Import)):
            if isinstance(cmd, Finish):
                require(rows and all(r["verified"] and not needs_identity(r) for r in rows.values()),
                        "Complete each routine review and resolve required pharmacist reviews.")
                case["status"] = "Finished"
                return dict(rows=list(rows), sources=[r["verified"]["source_id"] for r in rows.values()])
            selected = [self.row(rows, rid) for rid in cmd.row_ids]
            require(len(set(cmd.row_ids)) == len(selected), "Select each row once.")
            if isinstance(cmd, Refer):
                require(case["status"] == "In progress", "Referral already sent.", 409)
                require(all(r["unknown"] and not r["confirmed"] for r in selected), "Select unresolved items.")
                require(all(not needs_identity(r) or r in selected for r in rows.values()),
                        "Include each outstanding required identity review.")
                for r in selected:
                    r["referred"] = True
                case["status"] = "Awaiting pharmacist review"
                return dict(rows=cmd.row_ids, sources=[e["source"]["id"] for r in selected for e in active(r)],
                            checked=cmd.checked, reason=cmd.reason)
            already_imported = [r["id"] for r in selected if self.row_imported_at(case["id"], r)]
            require(not already_imported,
                    "Already imported: " + ", ".join(already_imported) + ". Select only eligible rows.", 409)
            receipt = self.import_rows(case, selected, actor, request_id)
            case["receipts"].append(receipt)
            for row in selected:
                history = self.imported_rows.setdefault((case["id"], row["id"]), {})
                history[import_snapshot_key(row)] = receipt["imported_at"]
            return dict(rows=cmd.row_ids, imported_at=receipt["imported_at"])

        if isinstance(cmd, AssessIdentityIncident):
            incident = case["identity_incidents"].get(cmd.incident_id)
            require(incident is not None, "Identity incident unavailable.", 404)
            assessment = dict(outcome=cmd.outcome, assessment=cmd.assessment,
                              recorder=actor.model_dump(), recorded_at=now())
            incident["pharmacy_assessments"].append(assessment)
            return dict(rows=[incident["row_id"]], identity_incident_id=cmd.incident_id,
                        pharmacy_assessment=assessment)

        row = self.row(rows, cmd.row_id)
        details = dict(rows=[row["id"]])
        if isinstance(cmd, Interview):
            src = entry_for(row, cmd.source_id)
            kind = src["source"]["kind"]
            require(kind in {"patient_report", "caregiver_report", "transfer_record", "reviewer_record", "prescription"},
                    "Cite the interview, prior interview record or documented order.")
            if cmd.ownership_source_id and cmd.ownership_source_id != cmd.source_id:
                owner_entry = entry_for(row, cmd.ownership_source_id)
                require(cmd.ownership == "patient" and owner_entry["label_owner"] and
                        owner_entry["label_owner"].casefold() == case["patient_alias"].casefold(),
                        "Ownership prefill must cite the matching patient name.")
            if cmd.current_use == "discontinued_order":
                require(kind in {"transfer_record", "prescription"} and src["record_basis"] == "discontinuation_order",
                        "Cite the documented discontinuation order.")
            else:
                require(kind in REPORT_KINDS or src["record_basis"] == "documented_interview",
                        "Cite an actual report or the documented prior interview excerpt.")
            row["interview"] = cmd.model_dump(exclude={"row_id", "action"})
            details.update(answer=row["interview"], sources=[cmd.source_id])
        elif isinstance(cmd, Proposal):
            require(row["unknown"], "Proposals belong to previously unknown items.")
            row["proposal"] = dict(name=cmd.name, reference=cmd.reference, proposer=actor.id)
            row["confirmed"] = None
            details.update(proposal=row["proposal"])
        elif isinstance(cmd, Decision):
            require(row["unknown"], "Select an original unknown item.")
            entry = entry_for(row, cmd.source_id)
            if cmd.outcome in {"confirm", "correct"}:
                challenged = [other for other in row["entries"] if unresolved_photo(other)]
                if row["proposal"] and not row["proposal"].get("independent_entry"):
                    challenged.extend(e for e in row["entries"] if e["source"]["id"] == row["proposal"]["reference"])
                capture_attachments = row.get("unknown_capture_attachments", ())
                capture_originals = self.originals.get(case["id"], {})
                photo_bytes = b64decode(entry["photo"]["data"]) if entry["photo"] and capture_attachments else None
                require(entry["source"]["attachment_id"] not in capture_attachments
                        and not any(capture_originals[attachment].content == photo_bytes
                                    for attachment in capture_attachments if attachment in capture_originals)
                        and not any(shares_origin(entry, other) for other in challenged),
                        "A second crop of the same challenged source cannot confirm identity.")
                require(cmd.name and entry["name"] and cmd.name.casefold() == entry["product"].casefold()
                        and entry["identity_basis"] and reviewable_entry(entry)
                        and entry["source"]["kind"] in {"prescription", "reviewer_record", "transfer_record",
                                                      "label_photo", "additional_photo", "reverse_photo"}
                        and (not row["proposal"] or row["proposal"]["reference"] != cmd.source_id
                             or row["proposal"].get("independent_entry")),
                        "Cite separate item-specific documentation of this identity.")
                row["confirmed"] = dict(name=cmd.name, source_id=cmd.source_id, reviewer=actor.id)
                row["proposal"] = None
                row["referred"] = False
            else:
                row["confirmed"] = None
                if cmd.outcome == "reject":
                    row["proposal"] = None
                    row["referred"] = (row["interview"] or {}).get("current_use") not in {
                        "not_owned", "reported_stopped", "discontinued_order"}
            details.update(outcome=cmd.outcome, name=cmd.name, finding=cmd.finding, sources=[cmd.source_id])
        elif isinstance(cmd, Verify):
            answer = row["interview"]
            require(answer and cmd.source_id == answer["source_id"], "Review the sourced interview first.")
            entry_for(row, cmd.source_id)
            require(answer["ownership"] != "uncertain" and answer["current_use"] != "uncertain",
                    "Clarify ownership and current use.")
            require((answer["ownership"] == "other") == (answer["current_use"] == "not_owned"),
                    "Resolve conflicting ownership and use.")
            if answer["current_use"] == "current":
                require(all(answer[k] for k in ("dose", "route", "schedule")), "Record the actual regimen.")
            require(not needs_identity(row), "Identity requires pharmacist review.")
            named = [e for e in active(row) if e["name"] and reviewable_entry(e)]
            require(row["unknown"] or named, "Review the current identity evidence.")
            variants = {e["product"].casefold() for e in named}
            conflicts = conflicting_fields(row)
            require((len(variants) <= 1 and not conflicts) or cmd.resolution,
                    "Document the resolution of conflicting evidence.")
            verified_at = now()
            identity = row["confirmed"]
            if not row["unknown"]:
                identity_conflict = len(variants) > 1 or any(key in {"strength", "form"} for key in conflicts)
                require(not identity_conflict or cmd.identity_source_id, "Choose the supported identity source.")
                chosen = entry_for(row, cmd.identity_source_id) if cmd.identity_source_id else named[-1]
                require(chosen in named, "Choose a source that documents this identity.")
                documented = [entry for entry in named if entry["source"]["kind"] not in REPORT_KINDS]
                if documented and len({entry["name"].strip().casefold() for entry in named}) > 1:
                    conflicting = [entry for entry in named if entry is not chosen]
                    require(chosen in documented and chosen["identity_basis"],
                            "Cite separate item-specific documentation to resolve the disputed identity.")
                    require(not any(shares_origin(chosen, entry) for entry in conflicting),
                            "A second crop of the same challenged source cannot confirm identity.")
                    details["identity_incident_id"] = record_identity_incident(
                        case, row["id"], conflicting, chosen, actor, cmd.resolution, verified_at,
                    )
                identity = dict(name=chosen["product"], source_id=chosen["source"]["id"])
            row["verified"] = dict(actor=actor.model_dump(), at=verified_at, source_id=cmd.source_id,
                                   identity=identity, resolution=cmd.resolution, answer=deepcopy(answer))
            return dict(**details, verification=row["verified"], sources=[cmd.source_id] +
                        ([identity["source_id"]] if identity else []))
        row["verified"] = None
        return details

    @staticmethod
    def row(rows, row_id):
        require(row_id in rows, "Unknown encounter row.", 404)
        return rows[row_id]

    def row_imported_at(self, case_id, row):
        history = self.imported_rows.get((case_id, row["id"]))
        if history and row["verified"]:
            return history.get(import_snapshot_key(row))
        return None

    def import_rows(self, case, selected, actor, request_id):
        sources, items, importable = [], [], []
        for row in selected:
            verified = row["verified"]
            require(verified and verified["identity"] and not needs_identity(row),
                    "Select verified rows with a resolved identity.")
            answer = verified["answer"]
            require(answer["ownership"] == "patient" and answer["current_use"] != "not_owned",
                    "Only medicines verified as belonging to this patient can be imported.")
            refs = {}
            for entry in active(row):
                source = EvidenceSource.model_validate(entry["source"])
                sources.append(source)
                kind = "record_excerpt"
                if entry["photo"]:
                    kind = "label_region" if reviewable_entry(entry) else "pill_crop"
                if kind == "label_region" and source.kind == "reverse_photo":
                    kind = "matched_reverse_label"
                item = EvidenceItem(id=row["id"], source_id=source.id, row_id=row["id"], kind=kind)
                items.append(item)
                refs[source.id] = EvidenceRef(source_id=source.id, item_id=item.id)
            ref = refs[verified["source_id"]]
            identity = verified["identity"]
            name = SourcedValue(value=identity["name"], evidence=refs[identity["source_id"]])
            def sourced(key):
                return SourcedValue(value=answer[key], evidence=ref) if answer[key] else None
            verification = CurrentUseVerification(
                reviewer=verified["actor"], verified_at=verified["at"], identity=name, evidence=[ref],
                status="current" if answer["current_use"] == "current" else "no_longer_current",
                dose=sourced("dose"), route=sourced("route"), frequency=sourced("schedule"))
            label_fields = {}
            identity_entry = entry_for(row, identity["source_id"])
            identity_observations = entry_observations(identity_entry)
            reports = []
            conflicts = conflicting_fields(row)
            regimens = []
            manifest = CaseEvidence(case_id=case["id"], sources=sources, items=items)
            observations_by_source = {}
            for entry in active(row):
                source_id = entry["source"]["id"]
                citation = refs[source_id]
                observations = entry_observations(entry)
                observations_by_source[source_id] = observations
                reported = entry["source"]["kind"] in REPORT_KINDS
                if reported:
                    reports.append(SourcedValue(value=entry["wording"], evidence=citation))
                for key, (status, value) in observations.items():
                    if key in {"strength", "form"} and source_id != identity["source_id"]:
                        same_product = not entry["name"] or entry["name"].casefold() == identity_entry["name"].casefold()
                        identity_status, _ = identity_observations.get(key, (None, None))
                        if identity_status == "readable" or key in conflicts or not same_product:
                            continue
                    if key in conflicts and key not in {"strength", "form"}:
                        continue
                    previous = label_fields.get(key)
                    if previous and (status == "missing" or (status == "unreadable" and previous.status == "readable")):
                        continue
                    label_fields[key] = Observation(status=status, value=value, evidence=citation)
                _, directions = observations.get("directions", (None, None))
                wording = entry["wording"] if reported else directions
                if wording:
                    regimens.extend(parse_directions(RegimenParseRequest(
                        evidence=manifest, row_id=row["id"], component_id=source_id,
                        basis="reported" if reported else "documented", directions_text=wording,
                        source=citation)).regimens)
            discrepancies = [Discrepancy(
                id=key, field=key, question="Which documented value applies to this item?",
                observed_values=[
                    SourcedValue(value=observations[key][1], evidence=refs[source_id])
                    for source_id, observations in observations_by_source.items()
                    if key in observations and observations[key][0] == "readable"
                ]) for key in conflicts]
            verification.resolved_discrepancies = conflicts
            importable.append(ReviewRow(
                id=row["id"], identity_status="unlabeled" if row["unknown"] else "named",
                unknown_label=row["id"] if row["unknown"] else None,
                observed_names=[] if row["unknown"] else [name], reported_use=reports,
                label_fields=label_fields, regimens=regimens, discrepancies=discrepancies, sources=list(refs.values()),
                revision=case["revision"], verification=verification))
        evidence = CaseEvidence(case_id=case["id"], sources=sources, items=items)
        ledger = ApprovalLedger()
        try:
            for row in importable:
                row.approval = ledger.approve(actor, row, evidence)
            req = ImportRequest(evidence=evidence, retry_token=case["id"] + "/" + request_id,
                                rows=importable, selected_row_ids=[r.id for r in importable])
            approved = ledger.eligible_rows(actor, req)
            return self.hospital.write(evidence=selected_evidence(evidence, approved), rows=approved,
                                       retry_token=req.retry_token).model_dump(mode="json")
        except EligibilityError as exc:
            raise HTTPException(422, exc.detail.message) from None
        except HospitalError as exc:
            raise HTTPException(409 if exc.detail.code == "retry_conflict" else 503, exc.detail.message) from None
