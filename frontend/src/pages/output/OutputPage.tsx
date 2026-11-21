import { useEffect, useEffectEvent, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { LuArrowLeft, LuCheck, LuHistory } from 'react-icons/lu'
import { ApiError, type createClient } from '../../api/client'
import type { Encounter } from '../../api/admission'
import type { RegimenComponent, ReviewerIdentity } from '../../api/contracts'
import { Button } from '../../components/ui/Button'
import { RegimenReadback } from '../new-patient/RegimenReadback'
import { regimenText } from '../../i18n/regimen'
import type { Language } from '../../i18n/messages'
import { exclusion, importRequestId, medicineName, receiptForApproval, saveReceipt } from './importSelection'

const text = {
  en: {
    title: 'Output', select: 'Select medicines to import', empty: 'No medicines are ready to import.',
    ready: 'Ready for import', pending: 'Pending medicines', excluded: 'Excluded medicines', review: 'Clinical verification pending',
    identity: 'Medicine identity unresolved', ownership: 'Ownership unconfirmed', other: 'Belongs to someone else',
    imported: 'Imported medicines', current: 'Current medicine', stopped: 'Stopped · import as history',
    discontinued: 'Discontinued by order · import as history', unknown: 'Unidentified medicine',
    source: 'Verification source', verifier: 'Verified by', preview: 'Import selection', selected: 'Selected medicines',
    remaining: 'Other medicines remaining in this encounter', submit: 'Approve and import selected medicines',
    sending: 'Importing…', success: 'Import confirmed', time: 'Hospital receipt', receiptRows: 'Medicines on receipt', history: 'Open import history',
    goReview: 'Back to Review', pharmacist: 'An assigned pharmacist must approve the import.',
    destination: 'Destination', hospital: 'Mock hospital', failed: 'Import could not be confirmed. Retry the same selection.',
    conflict: 'The encounter changed. Review the latest rows and select again.',
    refreshFailed: 'The encounter changed. Reload the encounter before retrying.',
    denied: 'The server denied this import. Check your assigned pharmacist session.',
    rejected: 'The server rejected the selection. Review the medicine records before importing.',
    noHistory: 'Import succeeded. Browser history could not be saved.',
    noReceipt: 'The server responded without a matching receipt. Check the encounter before retrying.',
  },
  th: {
    title: 'ส่งออก', select: 'เลือกยาที่ต้องการนำเข้า', empty: 'ยังไม่มียาที่พร้อมนำเข้า',
    ready: 'พร้อมนำเข้า', pending: 'รายการยาที่รอดำเนินการ', excluded: 'รายการที่ไม่นำเข้า', review: 'รอการยืนยันทางคลินิก',
    identity: 'ยังไม่ยืนยันตัวยา', ownership: 'ยังไม่ยืนยันเจ้าของยา', other: 'เป็นยาของผู้อื่น',
    imported: 'รายการยาที่นำเข้าแล้ว', current: 'ยาที่ใช้อยู่', stopped: 'หยุดใช้แล้ว · นำเข้าเป็นประวัติ',
    discontinued: 'มีคำสั่งหยุดยา · นำเข้าเป็นประวัติ', unknown: 'ยาที่ยังระบุไม่ได้',
    source: 'แหล่งข้อมูลที่ยืนยัน', verifier: 'ยืนยันโดย', preview: 'รายการที่จะนำเข้า', selected: 'ยาที่เลือก',
    remaining: 'ยาอื่นที่เหลือในเคสนี้', submit: 'อนุมัติและนำเข้ายาที่เลือก',
    sending: 'กำลังนำเข้า…', success: 'ยืนยันการนำเข้าแล้ว', time: 'ใบรับรายการจากโรงพยาบาล', receiptRows: 'รายการยาในใบรับ', history: 'เปิดประวัติการนำเข้า',
    goReview: 'กลับไปทบทวน', pharmacist: 'เภสัชกรที่รับผิดชอบเคสต้องเป็นผู้อนุมัติการนำเข้า',
    destination: 'ปลายทาง', hospital: 'ระบบโรงพยาบาลจำลอง', failed: 'ยังยืนยันผลนำเข้าไม่ได้ ลองส่งรายการเดิมอีกครั้ง',
    conflict: 'เคสมีการเปลี่ยนแปลง กรุณาทบทวนรายการล่าสุดแล้วเลือกอีกครั้ง',
    refreshFailed: 'เคสมีการเปลี่ยนแปลง กรุณาโหลดข้อมูลเคสใหม่ก่อนลองอีกครั้ง',
    denied: 'เซิร์ฟเวอร์ไม่อนุญาตให้นำเข้า กรุณาตรวจสอบสิทธิ์ของเภสัชกรผู้รับผิดชอบ',
    rejected: 'เซิร์ฟเวอร์ไม่รับรายการนี้ กรุณาทบทวนข้อมูลยาก่อนนำเข้า',
    noHistory: 'นำเข้าสำเร็จ แต่บันทึกประวัติในเบราว์เซอร์ไม่ได้',
    noReceipt: 'ยังไม่พบใบรับรายการที่ตรงกับการนำเข้านี้ กรุณาตรวจสอบเคสก่อนลองอีกครั้ง',
  },
}

type Props = {
  language: Language
  client: ReturnType<typeof createClient>
  actor: ReviewerIdentity
  encounter: Encounter
  onEncounter: (value: Encounter) => void
}

type ErrorKey = 'failed' | 'conflict' | 'refreshFailed' | 'denied' | 'rejected' | 'noReceipt'

export function OutputPage(props: Props) {
  return <Output key={JSON.stringify([props.encounter.id, props.actor.id])} {...props} />
}

function Output({ language, client, actor, encounter, onEncounter }: Props) {
  const t = text[language]
  const [selection, setSelection] = useState({ revision: encounter.revision, ids: [] as string[] })
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<{ key: ErrorKey; revision: number; ids: string[] } | null>(null)
  const [historyUnavailable, setHistoryUnavailable] = useState(false)
  const running = useRef(false)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

  const { id: caseId, receipts } = encounter
  const updateEncounter = useEffectEvent(onEncounter)
  useEffect(() => {
    let active = true
    void client.encounter(caseId).then(latest => {
      if (active) updateEncounter(latest)
    }, () => { /* The open encounter remains available for an idempotent retry. */ })
    return () => { active = false }
  }, [client, caseId])

  useEffect(() => {
    for (const receipt of receipts) saveReceipt(receipt)
  }, [receipts])

  const rows = Object.values(encounter.rows)
  const imported = rows.filter(row => row.imported_at)
  const ready = rows.filter(row => !exclusion(row))
  const pending = rows.filter(row => {
    const reason = exclusion(row)
    return reason === 'identity' || reason === 'review' || reason === 'ownership'
  })
  const excluded = rows.filter(row => exclusion(row) === 'other')
  const outcomes = [[t.imported, imported], [t.pending, pending], [t.excluded, excluded]] as const
  const pharmacist = actor.role === 'pharmacist' && encounter.assigned.includes(actor.id)
  const selected = selection.revision === encounter.revision
    ? ready.filter(row => selection.ids.includes(row.id)) : []
  const remaining = rows.length - imported.length - selected.length
  const error = failure && !receiptForApproval(encounter, failure.revision, actor.id, failure.ids)
    ? failure.key : null

  function toggle(id: string) {
    setSelection({ revision: encounter.revision, ids: selected.some(row => row.id === id)
      ? selected.filter(row => row.id !== id).map(row => row.id)
      : [...selected.map(row => row.id), id] })
    setFailure(null)
  }

  async function submit() {
    if (!pharmacist || !selected.length || running.current) return
    running.current = true
    setBusy(true)
    setFailure(null)
    const ids = selected.map(row => row.id).sort()
    const fail = (key: ErrorKey) => setFailure({ key, revision: encounter.revision, ids })
    try {
      const updated = await client.action(encounter.id, {
        revision: encounter.revision,
        request_id: await importRequestId(encounter.id, actor.id, encounter.revision, ids),
        command: { action: 'import', row_ids: ids },
      })
      // A replay can include later imports. Read the event for this particular approval.
      const receipt = receiptForApproval(updated, encounter.revision, actor.id, ids)
      if (receipt) {
        const saved = saveReceipt(receipt)
        if (mounted.current) setHistoryUnavailable(!saved)
      } else if (mounted.current) fail('noReceipt')
      onEncounter(updated)
    } catch (e) {
      if (!mounted.current) return
      if (e instanceof ApiError && e.status === 409) {
        try {
          const latest = await client.encounter(encounter.id)
          if (mounted.current) {
            onEncounter(latest)
            setSelection({ revision: latest.revision, ids: [] })
            fail('conflict')
          }
        } catch { if (mounted.current) fail('refreshFailed') }
      } else {
        fail(e instanceof ApiError && (e.status === 401 || e.status === 403)
          ? 'denied' : e instanceof ApiError && e.status < 500 ? 'rejected' : 'failed')
      }
    } finally {
      running.current = false
      if (mounted.current) setBusy(false)
    }
  }

  return <div className="intake stack">
    <div className="intake-title"><h1>{t.title}</h1><p>{encounter.patient_alias}</p></div>
    {receipts.length > 0 && <section className="intake-panel stack" role="status">
      <h2 className="flex items-center gap-2"><LuCheck aria-hidden="true" />{t.success}</h2>
      <ul>{[...receipts].reverse().map(receipt => <li key={JSON.stringify([receipt.imported_at, receipt.imported_row_ids])}>
        {t.time} · <time dateTime={receipt.imported_at}>{receipt.imported_at}</time> · {t.receiptRows} · {receipt.imported_row_ids.length}
      </li>)}</ul>
      {historyUnavailable && <p>{t.noHistory}</p>}
      <Link className="text-action" to="/history"><LuHistory aria-hidden="true" />{t.history}</Link>
    </section>}
    <div className="intake-grid">
      <section className="intake-panel stack">
        {ready.length > 0 && <h2>{t.select}</h2>}
        {!ready.length && !imported.length && <p>{t.empty}</p>}
        {ready.length > 0 && <fieldset disabled={busy || !pharmacist}>
          <legend className="mb-2 font-semibold">{t.ready} · {ready.length}</legend>
          {ready.map(row => {
            const v = row.verified as NonNullable<typeof row.verified> & { regimens?: RegimenComponent[] }
            const entry = row.entries.find(e => e.source.id === v.source_id)
            const regimen = [v.answer.dose, v.answer.route, v.answer.schedule].filter(Boolean).join(' · ')
            return <div key={row.id} className="border-t border-line py-3"><label className="flex gap-3">
              <input type="checkbox" className="mt-1 size-5 shrink-0 accent-accent" checked={selected.some(item => item.id === row.id)} onChange={() => toggle(row.id)} />
              <span className="min-w-0">
                <strong className="block">{v.identity!.name}</strong>
                <span className="block">{v.answer.current_use === 'current' ? t.current : v.answer.current_use === 'discontinued_order' ? t.discontinued : t.stopped}</span>
                {!v.regimens?.length && regimen && <span className="block">{regimen}</span>}
                <small className="block">{t.verifier} · {v.actor.name}</small>
                {entry && <small className="block">{t.source} · {entry.source.organization || entry.wording}</small>}
              </span>
            </label>
              {v.regimens?.map(component => <RegimenReadback key={component.component_id} component={component} t={regimenText[language]} />)}
            </div>
          })}
        </fieldset>}
        {outcomes.map(([label, group]) => group.length > 0 &&
          <div key={label}><h3>{label} · {group.length}</h3>
          <ul className="divide-y divide-line">{group.map(row => {
            const reason = exclusion(row)
            const name = medicineName(row)
            return <li className="py-2" key={row.id}>
              <strong>{name || t.unknown}</strong>
              {reason && reason !== 'imported' && ' · ' + t[reason]}
            </li>
          })}</ul>
        </div>)}
        <Link className="text-action" to="/new-patient/review"><LuArrowLeft aria-hidden="true" />{t.goReview}</Link>
      </section>
      {(ready.length > 0 || error) && <section className="intake-panel stack">
        {ready.length > 0 && <>
          <h2>{t.preview}</h2>
          <dl className="grid gap-3">
            <div><dt>{t.destination}</dt><dd className="font-semibold">{t.hospital}</dd></div>
            <div><dt>{t.selected}</dt><dd className="font-semibold">{selected.length}</dd></div>
            <div><dt>{t.remaining}</dt><dd>{remaining}</dd></div>
          </dl>
          {!pharmacist && <p>{t.pharmacist}</p>}
        </>}
        {error && <p role="alert">{t[error]}</p>}
        {ready.length > 0 && <Button variant="primary" disabled={!pharmacist || !selected.length || busy} onClick={() => void submit()}>{busy ? t.sending : t.submit}</Button>}
      </section>}
    </div>
  </div>
}
