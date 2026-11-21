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
  const capture = encounter.capture
  const appearance = rowRegions(encounter, row).find(e => {
    const view = capture?.[e.region.side]
    const region = view?.regions?.find(value => value.id === e.region.region_id)
    return e.kind === 'appearance' && view?.attachment_id === e.region.attachment_id &&
      view.revision === e.region.revision && view.visibility !== 'opaque' && region && region.visibility !== 'opaque'
  })
  // An assigned front retake has a row-specific replacement event even when the package has no reverse match.
  const retakes = new Set(encounter.events.flatMap(event =>
    event.action === 'link' && event.replaces && event.rows.includes(row.id) ? event.sources : []))
  const entries = active(row).filter(e => {
    const photo = e.photo
    if (!photo?.appearance) return false
    const view = [capture?.front, capture?.reverse].find(v => v && v.attachment_id === e.source.attachment_id)
    if (view?.visibility === 'opaque') return false
    const [x, y, width, height] = photo.region
    if (view?.regions?.some(r => r.visibility === 'opaque' && x < r.bounds.x + r.bounds.width &&
      x + width > r.bounds.x && y < r.bounds.y + r.bounds.height && y + height > r.bounds.y)) return false
    return photo.pairing === 'matched' || (e.source.kind === 'label_photo' &&
      (photo.front_attributed || retakes.has(e.source.id)))
  })
  const replacement = entries.findLast(e => retakes.has(e.source.id))
  const entry = replacement || entries[0]
  useEffect(() => {
    if (!opened || !root.current) return
    const panel = root.current
    let disposed = false
    let release: (() => void) | undefined
    let url: string | undefined
    async function load() {
      let source: EvidenceSource | undefined, itemId = row.id, cropUrl: string | null
      if (!replacement && appearance) {
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
  }, [appearance, capture, client, encounter.id, entry, opened, replacement, row.id])
  if (!entry && !appearance) return null
  return <details className="clinical-card" onToggle={e => setOpened(e.currentTarget.open)}>
    <summary>{t('Compare pill appearance', 'เปรียบเทียบลักษณะเม็ดยา')}</summary>
    <div ref={root}/>{error && <p role="alert">{error}</p>}
  </details>
}
