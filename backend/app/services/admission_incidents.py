"""Encounter-local records for disputed, initially named physical items."""

from uuid import uuid4

from app.schemas.review import ReviewerIdentity


def record_identity_incident(
    case: dict,
    row_id: str,
    conflicting_entries: list[dict],
    corroboration: dict,
    reviewer: ReviewerIdentity,
    resolution: str,
    recorded_at: str,
) -> str:
    conflicts = [
        {"source_id": entry["source"]["id"], "name": entry["name"]}
        for entry in conflicting_entries
    ]
    source_id = corroboration["source"]["id"]
    identity = corroboration["product"]
    incidents = case["identity_incidents"]
    for incident_id, incident in incidents.items():
        if (
            incident["row_id"] == row_id
            and incident["conflicting_sources"] == conflicts
            and incident["corroborating_source_id"] == source_id
            and incident["identity"] == identity
        ):
            return incident_id

    incident_id = f"identity-incident-{uuid4().hex}"
    original_name = conflicting_entries[0]["name"]
    same_name = original_name.strip().casefold() == corroboration["name"].strip().casefold()
    decision = "confirmed" if same_name else "corrected"
    incidents[incident_id] = {
        "id": incident_id,
        "encounter_id": case["id"],
        "row_id": row_id,
        "conflicting_sources": conflicts,
        "corroborating_source_id": source_id,
        "identity": identity,
        "decision": decision,
        "resolution": resolution,
        "reviewer": reviewer.model_dump(),
        "recorded_at": recorded_at,
        "pharmacy_assessments": [],
    }
    return incident_id