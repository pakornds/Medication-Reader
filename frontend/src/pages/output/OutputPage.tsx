import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { LuArrowLeft, LuCheck, LuHistory } from 'react-icons/lu'
import { ApiError, type createClient } from '../../api/client'
import type { Encounter } from '../../api/admission'
import type { ImportReceipt, RegimenComponent, ReviewerIdentity } from '../../api/contracts'
import { Button } from '../../components/ui/Button'
import { RegimenReadback } from '../new-patient/RegimenReadback'
import { regimenText } from '../../i18n/regimen'
import type { Language } from '../../i18n/messages'
import { exclusion, importRequestId, medicineName, saveReceipt } from './importSelection'
import { Handoff } from '../clinical/Handoff'
import { bilingual } from '../clinical/review'

const text = {
  en: {
    title: 'Output', select: 'Select medicines to import', empty: 'No medicines are ready to import.',
    ready: 'Ready for import', excluded: 'Excluded from this import', review: 'Clinical verification pending',
    identity: 'Medicine identity unresolved', ownership: 'Ownership unconfirmed', other: 'Belongs to someone else',
    imported: 'Already imported', current: 'Current medicine', stopped: 'Stopped · import as history',
    discontinued: 'Discontinued by order · import as history', unknown: 'Unidentified medicine',
    source: 'Verification source', verifier: 'Verified by', preview: 'Import selection', selected: 'Selected medicines',
    remaining: 'Other medicines remaining in this encounter', submit: 'Approve and import selected medicines',
    sending: 'Importing…', success: 'Import confirmed', time: 'Hospital receipt', history: 'Open import history',
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
    ready: 'พร้อมนำเข้า', excluded: 'รายการที่ไม่นำเข้า', review: 'รอการยืนยันทางคลินิก',
    identity: 'ยังไม่ยืนยันตัวยา', ownership: 'ยังไม่ยืนยันเจ้าของยา', other: 'เป็นยาของผู้อื่น',
    imported: 'นำเข้าแล้ว', current: 'ยาที่ใช้อยู่', stopped: 'หยุดใช้แล้ว · นำเข้าเป็นประวัติ',
    discontinued: 'มีคำสั่งหยุดยา · นำเข้าเป็นประวัติ', unknown: 'ยาที่ยังระบุไม่ได้',
    source: 'แหล่งข้อมูลที่ยืนยัน', verifier: 'ยืนยันโดย', preview: 'รายการที่จะนำเข้า', selected: 'ยาที่เลือก',
    remaining: 'ยาอื่นที่เหลือในเคสนี้', submit: 'อนุมัติและนำเข้ายาที่เลือก',
    sending: 'กำลังนำเข้า…', success: 'ยืนยันการนำเข้าแล้ว', time: 'ใบรับรายการจากโรงพยาบาล', history: 'เปิดประวัติการนำเข้า',
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
  onReviewRow?: (caseId: string, rowId: string) => void
}

type ErrorKey = 'failed' | 'conflict' | 'refreshFailed' | 'denied' | 'rejected' | 'noReceipt'

export function OutputPage(props: Props) {
  return <Output key={JSON.stringify([props.encounter.id, props.actor.id])} {...props} />
}

function Output({ language, client, actor, encounter, onEncounter, onReviewRow }: Props) {
  const t = text[language]
  const [selection, setSelection] = useState({ revision: encounter.revision, ids: [] as string[] })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<ErrorKey | null>(null)
  const [success, setSuccess] = useState<{ receipt: ImportReceipt; saved: boolean } | null>(null)
  const running = useRef(false)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

  const rows = Object.values(encounter.rows)
  const ready = rows.filter(row => !exclusion(row))
  const excluded = rows.filter(row => exclusion(row))
  const pharmacist = actor.role === 'pharmacist' && encounter.assigned.includes(actor.id)
  const selected = selection.revision === encounter.revision
    ? ready.filter(row => selection.ids.includes(row.id)) : []
  const remaining = rows.filter(row => !row.imported_at).length - selected.length

  function toggle(id: string) {
    setSelection({ revision: encounter.revision, ids: selected.some(row => row.id === id)
      ? selected.filter(row => row.id !== id).map(row => row.id)
      : [...selected.map(row => row.id), id] })
    setError(null)
  }

  async function submit() {
    if (!pharmacist || !selected.length || running.current) return
    running.current = true
    setBusy(true)
    setError(null)
    setSuccess(null)
    const ids = selected.map(row => row.id).sort()
    try {
      const updated = await client.action(encounter.id, {
        revision: encounter.revision,
        request_id: await importRequestId(encounter.id, actor.id, encounter.revision, ids),
        command: { action: 'import', row_ids: ids },
      })
      // A replay can include later imports. Read the event for this particular approval.
      const event = updated.events.find(event => event.action === 'import' && event.revision === encounter.revision + 1)
      const receipt = event?.action === 'import' && updated.receipts.find(item =>
        item.imported_at === event.imported_at && item.imported_row_ids.length === ids.length
        && ids.every(id => item.imported_row_ids.includes(id)))
      if (receipt) {
        const saved = saveReceipt(receipt)
        if (mounted.current) setSuccess({ receipt, saved })
      } else if (mounted.current) setError('noReceipt')
      if (mounted.current) onEncounter(updated)
    } catch (e) {
      if (!mounted.current) return
      if (e instanceof ApiError && e.status === 409) {
        try {
          const latest = await client.encounter(encounter.id)
          if (mounted.current) {
            onEncounter(latest)
            setSelection({ revision: latest.revision, ids: [] })
            setError('conflict')
          }
        } catch { if (mounted.current) setError('refreshFailed') }
      } else {
        setError(e instanceof ApiError && (e.status === 401 || e.status === 403)
          ? 'denied' : e instanceof ApiError && e.status < 500 ? 'rejected' : 'failed')
      }
    } finally {
      running.current = false
      if (mounted.current) setBusy(false)
    }
  }

  return <div className="intake stack">
    <div className="intake-title"><h1>{t.title}</h1><p>{encounter.patient_alias}</p></div>
    <div><Handoff encounter={encounter} client={client} t={bilingual(language)} /></div>
    {success && <section className="intake-panel stack" role="status">
      <h2 className="flex items-center gap-2"><LuCheck aria-hidden="true" />{t.success}</h2>
      <p>{t.time} · <time dateTime={success.receipt.imported_at}>{success.receipt.imported_at}</time></p>
      {!success.saved && <p>{t.noHistory}</p>}
      <Link className="text-action" to="/history"><LuHistory aria-hidden="true" />{t.history}</Link>
    </section>}
    <div className="intake-grid">
      <section className="intake-panel stack">
        <h2>{t.select}</h2>
        {!ready.length && <p>{t.empty}</p>}
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
              {onReviewRow && <Button variant="text" onClick={() => onReviewRow(encounter.id, row.id)}>
                {t.goReview} · {v.identity!.name}</Button>}
            </div>
          })}
        </fieldset>}
        {excluded.length > 0 && <div><h3>{t.excluded} · {excluded.length}</h3>
          <ul className="divide-y divide-line">{excluded.map(row => <li className="py-2" key={row.id}>
            <strong>{medicineName(row) || t.unknown}</strong> · {t[exclusion(row)!]}
            {onReviewRow && <Button variant="text" onClick={() => onReviewRow(encounter.id, row.id)}>
              {t.goReview} · {medicineName(row) || row.id}</Button>}
          </li>)}</ul>
        </div>}
        <Link className="text-action" to="/new-patient/review"><LuArrowLeft aria-hidden="true" />{t.goReview}</Link>
      </section>
      <section className="intake-panel stack">
        <h2>{t.preview}</h2>
        <dl className="grid gap-3">
          <div><dt>{t.destination}</dt><dd className="font-semibold">{t.hospital}</dd></div>
          <div><dt>{t.selected}</dt><dd className="font-semibold">{selected.length}</dd></div>
          <div><dt>{t.remaining}</dt><dd>{remaining}</dd></div>
        </dl>
        {!pharmacist && <p>{t.pharmacist}</p>}
        {error && <p role="alert">{t[error]}</p>}
        <Button variant="primary" disabled={!pharmacist || !selected.length || busy} onClick={() => void submit()}>{busy ? t.sending : t.submit}</Button>
      </section>
    </div>
  </div>
}
