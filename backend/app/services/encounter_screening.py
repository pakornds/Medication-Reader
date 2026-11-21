"""Read the active admission evidence used by the two legacy screening engines."""

from pydantic import Field

from app.schemas.evidence import CaseEvidence, EvidenceItem, EvidenceRef, SourcedValue
from app.schemas.review import CurrentUseVerification, ReviewRow
from app.services.admissions import active, needs_identity, reviewable_entry
from app.services.checks import DEMO_IDS


class EncounterScreeningRow(ReviewRow):
    # Capture intake can create a placeholder before any source is attributed.
    sources: list[EvidenceRef] = Field(default_factory=list)


def encounter_rows(case: dict) -> tuple[CaseEvidence, list[ReviewRow]]:
    sources, items, rows = [], [], []
    for row in case["rows"].values():
        refs = {}
        for entry in active(row):
            source = entry["source"]
            sources.append(source)
            kind = "record_excerpt"
            if entry["photo"]:
                kind = "pill_crop"
                if reviewable_entry(entry):
                    kind = "matched_reverse_label" if source["kind"] == "reverse_photo" else "label_region"
            ref = EvidenceRef(source_id=source["id"], item_id=row["id"])
            refs[source["id"]] = ref
            items.append(EvidenceItem(id=row["id"], source_id=ref.source_id, row_id=row["id"], kind=kind))
        verification = row["verified"] or {}
        decision = verification.get("identity") or {}
        identity = None
        if decision.get("source_id") in refs and not needs_identity(row):
            identity = SourcedValue(value=decision["name"], evidence=refs[decision["source_id"]])
        current = None
        if verification.get("source_id") in refs:
            cited = refs[verification["source_id"]]
            answer = verification["answer"]
            use = answer.get("current_use")
            status = "uncertain"
            if answer["ownership"] == "patient":
                if use == "current":
                    status = "current"
                elif use in {"reported_stopped", "discontinued_order"}:
                    status = "no_longer_current"
            demo_id = identity.value.casefold().replace(" ", "-") if identity else None

            def sourced(field):
                value = answer.get(field)
                return SourcedValue(value=value, evidence=cited) if value else None

            current = CurrentUseVerification(
                reviewer=verification["actor"], verified_at=verification["at"], status=status,
                identity=identity, normalized_medication_id=demo_id if demo_id in DEMO_IDS else None,
                dose=sourced("dose"), route=sourced("route"), frequency=sourced("schedule"), evidence=[cited],
            )
        rows.append(EncounterScreeningRow(
            id=row["id"], revision=case["revision"], sources=list(refs.values()), verification=current,
            identity_status="named" if identity else "unlabeled",
            unknown_label=None if identity else "Unresolved medication",
            observed_names=[identity] if identity else [],
        ))
    return CaseEvidence(case_id=case["id"], sources=sources, items=items), rows
