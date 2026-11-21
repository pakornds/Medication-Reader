import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { renderMedicationHandoff } from '../../../../src/components/print/medication-handoff.mjs'
import '../../../../src/components/print/medication-handoff.css'
import { entryCrop, rowRegions } from './locatedEvidence'
import { handoffFields } from './handoffFields'
import type { Encounter } from '../../api/admission'
import type { EvidenceItem, EvidenceRef, RegimenComponent } from '../../api/contracts'
import {
  active,
  entryName,
  reported,
  rowName,
  currentUseLabels,
  supportsIdentity,
  type Client,
  type Entry,
  type Say,
} from './review'

function cited(rowId: string, entry: Entry, items: EvidenceItem[], original?: EvidenceRef) {
  const sid = entry.source.id
  const document = ['prescription', 'transfer_record', 'reviewer_record', 'other_record'].includes(
    entry.source.kind,
  )
  const itemId = original?.item_id || (entry.photo ? 'selected' : document ? rowId : null)
  if (!itemId) return { source_id: sid }
  const kind = !entry.photo
    ? 'record_excerpt'
    : entry.source.kind === 'reverse_photo'
      ? supportsIdentity(entry)
        ? 'matched_reverse_label'
        : 'pill_crop'
      : entry.photo.appearance
        ? 'pill_crop'
        : 'label_region'
  items.push({ id: itemId, source_id: sid, row_id: rowId, kind })
  return { source_id: sid, item_id: itemId }
}

export function Handoff({ encounter, client, t }: { encounter: Encounter; client: Client; t: Say }) {
  const [open, setOpen] = useState(false)
  const [ready, setReady] = useState(false)
  const [error, setError] = useState(false)
  const dialog = useRef<HTMLDialogElement>(null)
  const host = useRef<HTMLDivElement>(null)
  const unavailable = Object.values(encounter.unavailable_sources || {})
  useEffect(() => {
    if (!open || !dialog.current || !host.current) return
    const modal = dialog.current,
      target = host.current
    let live = true
    const objectUrls: string[] = []
    modal.showModal()
    async function render() {
      const sources = new Map<string, Entry['source']>(),
        items: EvidenceItem[] = [],
        crops = new Map<string, string>()
      const rows = await Promise.all(
        Object.values(encounter.rows).map(async (row) => {
          const entries = active(row)
          const refs = new Map(
            entries.map((e) => {
              sources.set(e.source.id, e.source)
              return [
                e.source.id,
                cited(
                  row.id,
                  e,
                  items,
                  row.intake?.sources.find((r) => r.source_id === e.source.id),
                ),
              ]
            }),
          )
          const regions = rowRegions(encounter, row)
          for (const link of regions) {
            const source = encounter.capture?.sources?.find((s) => s.id === link.source_id)
            if (!source || row.superseded.includes(source.id)) continue
            sources.set(source.id, source)
            const kind =
              link.kind === 'appearance'
                ? 'pill_crop'
                : link.region.side === 'reverse'
                  ? 'matched_reverse_label'
                  : 'label_region'
            if (
              !items.some((i) => i.row_id === row.id && i.id === link.item_id && i.source_id === source.id)
            ) {
              items.push({ id: link.item_id, source_id: source.id, row_id: row.id, kind })
            }
            if (!refs.has(source.id)) refs.set(source.id, { source_id: source.id, item_id: link.item_id })
          }
          const fact = (value: string, source: string) => ({ value, evidence: refs.get(source) })
          const fields = handoffFields(row, entries, refs, items)
          const v = row.verified as (typeof row.verified & { regimens?: RegimenComponent[] }) | null
          const verified = v && {
            reviewer: v.actor,
            verified_at: v.at,
            status:
              ['reported_stopped', 'discontinued_order'].includes(v.answer.current_use)
                ? 'no_longer_current'
                : v.answer.current_use,
            identity: v.identity && fact(v.identity.name, v.identity.source_id),
            evidence: [refs.get(v.source_id)].filter(Boolean),
            dose: v.answer.dose && fact(v.answer.dose, v.source_id),
            route: v.answer.route && fact(v.answer.route, v.source_id),
            frequency: v.answer.schedule && fact(v.answer.schedule, v.source_id),
            regimens: v.regimens,
          }
          const reverse = entries.find(
            (e) => e.photo?.appearance && e.photo.pairing === 'matched' && e.source.kind === 'reverse_photo',
          )
          const linkedCrop = regions.find(
            (r) =>
              r.region.side === 'reverse' && r.kind === 'appearance' && !row.superseded.includes(r.source_id),
          )
          const reverseRef = linkedCrop
            ? { source_id: linkedCrop.source_id, item_id: linkedCrop.item_id }
            : reverse
              ? refs.get(reverse.source.id)
              : null
          if (reverseRef) {
            let url: string | null = null
            if (linkedCrop) {
              const blob = await client.region(encounter.id, linkedCrop.region).catch(() => null)
              if (blob && live) {
                url = URL.createObjectURL(blob)
                objectUrls.push(url)
              }
            } else if (reverse) url = await entryCrop(reverse).catch(() => null)
            if (url) crops.set(JSON.stringify([reverseRef.source_id, reverseRef.item_id]), url)
          }
          return {
            ...row.intake,
            id: row.id,
            sources: [...refs.values()],
            identity_status: row.unknown ? 'unlabeled' : 'named',
            unknown_label: row.unknown
              ? row.intake?.unknown_label || t('Unidentified medicine', 'ยาที่ยังระบุไม่ได้')
              : null,
            observed_names: entries.filter(supportsIdentity).map((e) => fact(entryName(e), e.source.id)),
            reported_use: entries.filter(reported).map((e) => fact(e.wording, e.source.id)),
            label_fields: fields,
            verification: verified,
            reverse_crop: reverseRef,
          }
        }),
      )
      if (!live) return
      const referrals = encounter.events
        .filter((e) => e.action === 'refer')
        .map((e) => ({ ...e, row_ids: e.rows.filter((id) => encounter.rows[id]?.referred) }))
      const decisions = encounter.events
        .filter((e) => e.action === 'decide')
        .map((e) => ({ ...e, row_id: e.rows[0], source_id: e.sources[0] }))
      renderMedicationHandoff(target, {
        evidence: { sources: [...sources.values()], items },
        rows,
        datedAt: encounter.events.at(-1)?.at || encounter.created_at,
        mode: encounter.status === 'Finished' ? 'reviewed' : 'worksheet',
        referrals,
        decisions,
        cropUrl: (ref) => crops.get(JSON.stringify([ref.source_id, ref.item_id])) || null,
      })
      const reverse = encounter.capture?.reverse
      const packageFigures = await Promise.all((encounter.capture?.reverse_matches || []).map(async match => {
        const region = reverse?.regions?.find(region => region.id === match.region.region_id)
        if (match.status !== 'confirmed' || !region || !reverse || match.region.case_id !== encounter.id ||
          match.region.side !== 'reverse' || match.region.attachment_id !== reverse.attachment_id ||
          match.region.revision !== reverse.revision) return null
        const members = Object.values(encounter.rows).filter(row => row.package_id === match.package_id)
        if (!members.length || members.every(row => rowRegions(encounter, row).some(e =>
          e.kind === 'appearance' && e.region.side === 'reverse' && e.region.region_id === region.id &&
          !row.superseded.includes(e.source_id)))) return null
        const figure = document.createElement('figure')
        const label = [t('Confirmed reverse package region', 'บริเวณด้านหลังบรรจุภัณฑ์ที่ยืนยันแล้ว'),
          match.package_id, region.id].join(' · ')
        const caption = document.createElement('figcaption')
        caption.textContent = label + ' · ' + members.map(row => row.id).join(', ')
        figure.append(caption)
        if (reverse.visibility === 'opaque' || region.visibility === 'opaque') {
          caption.append(' · ' + t('Opaque', 'ทึบแสง'))
        } else {
          const blob = await client.region(encounter.id, match.region).catch(() => null)
          if (blob && live) {
            const image = document.createElement('img')
            image.alt = label
            image.src = URL.createObjectURL(blob)
            objectUrls.push(image.src)
            figure.append(image)
            await image.decode().catch(() => image.remove())
          }
          if (!figure.querySelector('img')) caption.append(' · ' + t('Crop unavailable', 'ไม่มีภาพเฉพาะบริเวณ'))
        }
        return figure
      }))
      if (!live) return
      const figures = packageFigures.filter(figure => figure !== null)
      if (figures.length) {
        const heading = document.createElement('h2')
        heading.textContent = t('Package reference photos', 'ภาพอ้างอิงบรรจุภัณฑ์')
        target.querySelector('.medication-handoff')?.append(heading, ...figures)
      }
      setReady(true)
    }
    void render().catch(() => {
      if (live) setError(true)
    })
    return () => {
      live = false
      for (const url of objectUrls) URL.revokeObjectURL(url)
      modal.close()
    }
  }, [open, encounter, client, t])
  return (
    <>
      <button
        type="button"
        className="btn"
        disabled={!Object.keys(encounter.rows).length}
        onClick={() => {
          setReady(false)
          setError(false)
          setOpen(true)
        }}
      >
        {t('Dated handoff / print', 'ใบส่งต่อพร้อมวันที่ / พิมพ์')}
      </button>
      {open &&
        createPortal(
          <dialog
            className="clinical-print"
            ref={dialog}
            aria-label={t('Dated medication handoff', 'ใบส่งต่อรายการยาพร้อมวันที่')}
            onCancel={() => setOpen(false)}
          >
            <div className="clinical-print-tools">
              <button className="btn" onClick={() => setOpen(false)}>
                {t('Close', 'ปิด')}
              </button>
              <button className="primary-btn" disabled={!ready} onClick={() => window.print()}>
                {t('Print handoff', 'พิมพ์ใบส่งต่อ')}
              </button>
            </div>
            {error && (
              <p role="alert">
                {t(
                  'Could not prepare handoff. Close and retry.',
                  'จัดเตรียมใบส่งต่อไม่สำเร็จ กรุณาปิดแล้วลองใหม่',
                )}
              </p>
            )}
            <div ref={host} />
            {!!unavailable.length && <section>
              <h2>{t('Unavailable sources', 'แหล่งข้อมูลที่ยังไม่ได้รับ')}</h2>
              {unavailable.map(({source, follow_up}) => <p key={source.id}>
                <strong>{[source.organization, source.department_or_ward, source.reporter, source.id].filter(Boolean).join(' · ')}</strong>
                {' · '}{[source.unavailable_reason, source.contact, follow_up].filter(Boolean).join(' · ')}
              </p>)}
            </section>}
            {Object.values(encounter.rows).some(
              (r) => r.interview?.note || r.interview?.ownership === 'other',
            ) && (
              <section>
                <h2>{t('Recorded interview notes', 'บันทึกการสัมภาษณ์')}</h2>
                {Object.values(encounter.rows)
                  .filter((r) => r.interview?.note || r.interview?.ownership === 'other')
                  .map((r) => (
                    <p key={r.id}>
                      <strong>{rowName(r, t)}</strong> ·{' '}
                      {[currentUseLabels(t)[r.interview!.current_use], r.interview!.note]
                        .filter(Boolean)
                        .join(' · ')}
                    </p>
                  ))}
              </section>
            )}
          </dialog>,
          document.body,
        )}
    </>
  )
}
