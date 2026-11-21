import type { EvidenceItem, EvidenceRef, LabelField, Observation } from '../../api/contracts'
import type { AdmissionRow } from '../../api/admission'

export function handoffFields(row: AdmissionRow, entries: AdmissionRow['entries'], refs: Map<string, EvidenceRef>, items: EvidenceItem[]) {
  const fields: Partial<Record<LabelField, Observation>> = { ...row.intake?.label_fields }
  for (const field of Object.keys(fields) as LabelField[]) {
    const observation = fields[field]!
    const ref = observation.evidence
    const current = ref && refs.has(ref.source_id) && (!ref.item_id || items.some(item =>
      item.row_id === row.id && item.id === ref.item_id && item.source_id === ref.source_id))
    if (!current && (ref || observation.status !== 'missing')) delete fields[field]
  }
  for (const entry of entries) {
    for (const field of ['strength', 'form', 'dose', 'directions', 'indication'] as const) {
      if (entry[field] && !fields[field])
        fields[field] = { value: entry[field], status: 'readable', evidence: refs.get(entry.source.id) }
    }
  }
  return fields
}
