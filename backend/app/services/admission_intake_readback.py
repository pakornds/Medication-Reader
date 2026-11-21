"""Carry original intake facts into an approved row while preserving their review basis."""
from app.schemas.analysis import Discrepancy
from app.schemas.evidence import Observation, SourcedValue
from app.schemas.regimen import RegimenComponent


def intake_discrepancies(row):
    active = {e["source"]["id"] for e in row["entries"]} - set(row["superseded"])
    return [d for d in (row.get("intake") or {}).get("discrepancies", [])
            if all(f["evidence"]["source_id"] in active for f in d["observed_values"])]


def carry_intake(row, citations, regimens, discrepancies, reports, label_fields):
    if not row.get("intake"):
        return
    for key, field in row["intake"]["label_fields"].items():
        if field["evidence"] is None:
            label_fields.setdefault(key, Observation.model_validate(field))
    for fact in row["intake"]["reported_use"]:
        source_id = fact["evidence"]["source_id"]
        if source_id in citations:
            reports.append(SourcedValue(value=fact["value"], evidence=citations[source_id]))
    for raw in row["intake"]["regimens"]:
        if all(ref["source_id"] in citations for ref in raw["evidence"].values()):
            component = RegimenComponent.model_validate(raw)
            component.evidence = {key: citations[ref.source_id] for key, ref in component.evidence.items()}
            regimens.append(component)
    known_ids = {d.id for d in discrepancies}
    for raw in intake_discrepancies(row):
        if raw["id"] in known_ids:
            continue
        discrepancy = Discrepancy.model_validate(raw)
        for fact in discrepancy.observed_values:
            fact.evidence = citations[fact.evidence.source_id]
        discrepancies.append(discrepancy)
