import { useEffect, useRef, useState } from 'react'
import type { Encounter, AdmissionRow } from '../../api/admission'
import type { CandidateRequest, EvidenceSource } from '../../api/contracts'
import { mountCandidateComparison } from '../../../../src/components/candidates/candidate-comparison.mjs'
import { active, type Client, type Say } from './review'
import { entryCrop, rowRegions } from './locatedEvidence'

export function CandidateReview({ encounter, row, client, t }: {
  encounter: Encounter; row: AdmissionRow; client: Client; t: Say
}) {
  const [opened, setOpened] = useState(false)
  const [error, setError] = useState('')
  const root = useRef<HTMLDivElement>(null)
  const appearance = rowRegions(encounter, row).find(e => e.kind === 'appearance')
  const entry = active(row).find(e => e.photo?.appearance && e.photo.pairing === 'matched')
  const capture = encounter.capture
  const view = appearance && capture?.[appearance.region.side]
  const bounds = view?.regions?.find(r => r.id === appearance?.region.region_id)
  const visible = bounds && view?.visibility !== 'opaque' && bounds.visibility !== 'opaque'
  useEffect(() => {
    if (!opened || !root.current) return
    const panel = root.current
    let disposed = false
    let release: (() => void) | undefined
    let url: string | undefined
    async function load() {
      let source: EvidenceSource | undefined, itemId = row.id, cropUrl: string | null
      if (appearance && visible) {
        source = capture?.sources?.find(s => s.id === appearance.source_id)
        itemId = appearance.item_id
        const blob = await client.region(encounter.id, appearance.region)
        if (disposed) return
        url = URL.createObjectURL(blob)
        cropUrl = url
      } else if (entry) {
        source = entry.source
        cropUrl = await entryCrop(entry)
      } else return
      if (disposed || !source || !cropUrl) return
      const missing = { status: 'missing' as const }
      const request: CandidateRequest = {
        evidence: { case_id: encounter.id, sources: [source], items: [
          { id: itemId, source_id: source.id, row_id: row.id, kind: 'pill_crop' },
        ] },
        observation: { row_id: row.id, crop: { source_id: source.id, item_id: itemId },
          imprint: missing, shape: missing, form: missing, color: missing },
      }
      release = mountCandidateComparison(panel, { request, cropUrl, lookup: client.candidates })
    }
    void load().catch(e => { if (!disposed) setError(e instanceof Error ? e.message : String(e)) })
    return () => { disposed = true; release?.(); if (url) URL.revokeObjectURL(url) }
  }, [appearance, capture, client, encounter.id, entry, opened, row.id, visible])
  if (!entry && !visible) return null
  return <details className="clinical-card" onToggle={e => setOpened(e.currentTarget.open)}>
    <summary>{t('Compare pill appearance', 'เปรียบเทียบลักษณะเม็ดยา')}</summary>
    <div ref={root}/>{error && <p role="alert">{error}</p>}
  </details>
}
