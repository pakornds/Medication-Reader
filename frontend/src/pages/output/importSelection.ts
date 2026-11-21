import type { AdmissionRow } from '../../api/admission'
import type { ImportReceipt } from '../../api/contracts'
import { recordImportReceipt } from '../../../../src/lib/history/import-history'

/** Match the admission service's verified-identity, ownership and imported-revision checks. */
export function exclusion(row: AdmissionRow) {
  if (row.imported_at) return 'imported'
  if (row.interview?.ownership === 'other' || row.interview?.current_use === 'not_owned') return 'other'
  if (row.unknown && !row.confirmed) return 'identity'
  const review = row.verified
  if (!review?.identity) return 'review'
  if (review.answer.ownership !== 'patient' || review.answer.current_use === 'not_owned') return 'ownership'
  return null
}

export function medicineName(row: AdmissionRow) {
  const entry = row.entries.findLast(entry => !row.superseded.includes(entry.source.id) && entry.name)
  return row.verified?.identity?.name || row.confirmed?.name || (!row.unknown && entry?.name) || null
}

export async function importRequestId(caseId: string, actorId: string, revision: number, sortedRows: string[]) {
  const data = new TextEncoder().encode(JSON.stringify(['admission-import', caseId, actorId, revision, sortedRows]))
  const hash = await crypto.subtle.digest('SHA-256', data)
  return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('')
}

export function saveReceipt(receipt: ImportReceipt) {
  try {
    return recordImportReceipt(window.localStorage, receipt) === 'saved'
  } catch {
    return false
  }
}
