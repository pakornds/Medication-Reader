import type { Dispatch, SetStateAction } from 'react'
import { knownOrder, linkScan, scanEvidence, type Draft, type Preview } from './draft'

function remainingPreview(preview: Preview, rows: Preview['rows']): Preview | null {
  const issues = preview.photo_issues?.filter(issue => !issue.item_id
    || rows.some(row => row.sources.some(source => source.item_id === issue.item_id)))
  return rows.length || preview.unassigned_reports.length || issues?.length || preview.remaining_evidence_unassessed || preview.unassessed_question
    ? { ...preview, rows, photo_issues: issues } : null
}

export function scanActions(setDraft: Dispatch<SetStateAction<Draft>>) {
  function confirm(preview: Preview, placements: ReadonlyMap<string, string | null>) {
    setDraft((d) => {
      if (d.preview !== preview) return d
      const medicines = [...d.medicines]
      const remaining = preview.rows.filter((row) => {
        const target = placements.get(row.id)
        if (target === undefined) return true
        const priorOrder = knownOrder(medicines, row.id)
        const scan = scanEvidence(preview, row, d.evidence)
        if (target === null) {
          if (priorOrder) return true
          medicines.push({ ...scan, origin: 'analysis' })
          return false
        }
        const index = medicines.findIndex((medicine) => medicine.row.id === target)
          if (index < 0) return true
        medicines[index] = linkScan(medicines[index], scan)
        return false
      })
      return {
        ...d,
        medicines,
        preview: remainingPreview(preview, remaining),
      }
    })
  }
  function dismiss(preview: Preview, id: string) {
    setDraft((d) => {
      if (d.preview !== preview) return d
      const rows = preview.rows.filter((row) => row.id !== id)
      return {
        ...d,
        preview: remainingPreview(preview, rows),
      }
    })
  }
  return { onConfirm: confirm, onDismiss: dismiss }
}
