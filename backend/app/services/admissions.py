"""Revisioned, encounter-scoped mock review records shared by demo staff sessions."""
from copy import deepcopy
from datetime import UTC, datetime
from hashlib import sha256
from threading import RLock
from uuid import uuid4

from fastapi import HTTPException

from app.schemas.analysis import Discrepancy
from app.schemas.admission import (
    Action, AddEvidence, AddRow, Decision, Finish, Import, Interview, NewEncounter, Proposal, Refer, Verify,
)
from app.schemas.evidence import REPORT_KINDS, Observation, CaseEvidence, EvidenceItem, EvidenceRef, EvidenceSource, SourcedValue
from app.schemas.review import CurrentUseVerification, ImportRequest, ReviewRow
from app.schemas.regimen import RegimenParseRequest
from app.services.regimens import parse_directions
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


def conflicting_fields(row):
    entries = active(row)
    return [key for key in DOCUMENTED_FIELDS
            if len({e[key].casefold() for e in entries if e[key]}) > 1]


def reviewable_entry(entry):
    photo = entry["photo"]
    return not photo or (photo["pairing"] == "matched" and not photo["appearance"])


class AdmissionStore:
    def __init__(self, hospital):
        self.records = {}
        self.retries = {}
        self.hospital = hospital
        self.lock = RLock()

    def create(self, actor, request: NewEncounter):
        require(actor.role in {"nurse", "doctor", "pharmacist"}, "Clinical reviewer required.", 403)
        assigned = {actor.id, "demo-pharmacist", *("demo-" + role for role in request.assigned_roles)}
        case = dict(id="admission-" + uuid4().hex, patient_alias=request.patient_alias,
                    assigned=sorted(assigned), revision=1, status="In progress", created_at=now(),
                    rows={}, events=[], receipts=[])
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
            fingerprint = sha256(request.model_dump_json().encode()).hexdigest()
            if key in self.retries:
                require(self.retries[key] == fingerprint, "Request ID already used.", 409)
                return original
            require(original["revision"] == request.revision, "Encounter changed. Reload before saving.", 409)
            cmd = request.command
            if isinstance(cmd, (Import, Decision)) or original["status"] == "Awaiting pharmacist review":
                require(actor.role == "pharmacist", "Pharmacist required.", 403)
            require(original["status"] != "Finished" or isinstance(cmd, Import), "Review is finished.", 409)
            case = deepcopy(original)
            details = self.transition(case, actor, cmd, request.request_id)
            case["revision"] += 1
            case["events"].append(dict(action=cmd.action, actor=actor.model_dump(), at=now(),
                                       revision=case["revision"], **details))
            self.records[case_id] = case
            self.retries[key] = fingerprint
            return case

    def transition(self, case, actor, cmd, request_id):
        rows = case["rows"]
        if isinstance(cmd, (AddRow, AddEvidence)):
            entry = cmd.entry.model_dump(mode="json")
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
                row = dict(id=rid, unknown=not bool(entry["name"]), entries=[], superseded=[],
                           proposal=None, confirmed=None, referred=False, interview=None, verified=None)
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
            receipt = self.import_rows(case, selected, actor, request_id)
            case["receipts"].append(receipt)
            return dict(rows=cmd.row_ids, imported_at=receipt["imported_at"])

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
                challenged = [row["entries"][0]]
                if row["proposal"] and not row["proposal"].get("independent_entry"):
                    challenged.extend(e for e in row["entries"] if e["source"]["id"] == row["proposal"]["reference"])
                require(not any(shares_origin(entry, other) for other in challenged),
                        "A second crop of the same challenged source cannot confirm identity.")
                require(cmd.name and entry["name"] and cmd.name.casefold() == entry["product"].casefold()
                        and entry["identity_basis"] and entry != row["entries"][0] and reviewable_entry(entry)
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
            require((len(variants) <= 1 and not conflicting_fields(row)) or cmd.resolution,
                    "Document the resolution of conflicting evidence.")
            identity = row["confirmed"]
            if not row["unknown"]:
                require(len(variants) <= 1 or cmd.identity_source_id, "Choose the supported identity source.")
                chosen = entry_for(row, cmd.identity_source_id) if cmd.identity_source_id else named[-1]
                require(chosen in named, "Choose a source that documents this identity.")
                identity = dict(name=chosen["product"], source_id=chosen["source"]["id"])
            row["verified"] = dict(actor=actor.model_dump(), at=now(), source_id=cmd.source_id,
                                   identity=identity, resolution=cmd.resolution, answer=deepcopy(answer))
            return dict(**details, verification=row["verified"], sources=[cmd.source_id] +
                        ([identity["source_id"]] if identity else []))
        row["verified"] = None
        return details

    @staticmethod
    def row(rows, row_id):
        require(row_id in rows, "Unknown encounter row.", 404)
        return rows[row_id]

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
            reports = []
            conflicts = conflicting_fields(row)
            regimens = []
            manifest = CaseEvidence(case_id=case["id"], sources=sources, items=items)
            for entry in active(row):
                source_id = entry["source"]["id"]
                citation = refs[source_id]
                reported = entry["source"]["kind"] in REPORT_KINDS
                if reported:
                    reports.append(SourcedValue(value=entry["wording"], evidence=citation))
                for key in DOCUMENTED_FIELDS:
                    if key in {"strength", "form"} and source_id != identity["source_id"]:
                        same_product = not entry["name"] or entry["name"].casefold() == identity_entry["name"].casefold()
                        if identity_entry[key] or key in conflicts or not same_product:
                            continue
                    if key in conflicts and key not in {"strength", "form"}:
                        continue
                    if entry[key]:
                        label_fields[key] = Observation(status="readable", value=entry[key], evidence=citation)
                wording = entry["wording"] if reported else entry["directions"]
                if wording:
                    regimens.extend(parse_directions(RegimenParseRequest(
                        evidence=manifest, row_id=row["id"], component_id=source_id,
                        basis="reported" if reported else "documented", directions_text=wording,
                        source=citation)).regimens)
            discrepancies = [Discrepancy(
                id=key, field=key, question="Which documented value applies to this item?",
                observed_values=[SourcedValue(value=e[key], evidence=refs[e["source"]["id"]])
                                 for e in active(row) if e[key]]) for key in conflicts]
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
