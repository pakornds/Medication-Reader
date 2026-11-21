import { useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import type { Encounter } from '../api/admission'
import { ApiError } from '../api/client'
import type { Language } from '../i18n/messages'
import type { Draft } from '../pages/new-patient/draft'
import type { StaffSession } from './StaffAccess'
import { admitDraft } from './admitDraft'

export const caseText = {
  en: {
    heading: 'Clinical review', start: 'Save draft and open clinical review', update: 'Save revised draft',
    needsLogin: 'Sign in to verify medicines and save this encounter.',
    empty: 'Add a medicine to the draft to start clinical review.', input: 'Go to Input',
    goReview: 'Open Review', needsReview: 'Save and review the medicine list before import.',
    dirty: 'The intake draft has changes. Save it to continue clinical review.',
    saveFailed: 'Could not save the draft. Your entries are still here.', stale: 'Another staff member updated this encounter. Reload the current revision before retrying.',
    reload: 'Reload encounter', queueError: 'Could not open this encounter.',
    saved: 'This encounter is open for clinical review.', changeCase: 'Leave this draft and open the selected encounter?',
    leave: 'Sign out and clear this case from the screen?', syncedInput: 'You reopened a saved encounter. Its recorded sources and medicines are available in Review.',
    pending: 'There are still unconfirmed scan suggestions in Input.', saving: 'Saving…',
  },
  th: {
    heading: 'ทบทวนทางคลินิก', start: 'บันทึกฉบับร่างและเปิดทบทวน', update: 'บันทึกฉบับร่างที่แก้ไข',
    needsLogin: 'เข้าสู่ระบบเพื่อยืนยันรายการยาและบันทึกเคสนี้',
    empty: 'เพิ่มรายการยาในฉบับร่างเพื่อเริ่มทบทวน', input: 'ไปที่ป้อนข้อมูล',
    goReview: 'เปิดทบทวน', needsReview: 'บันทึกและทบทวนรายการยาก่อนนำเข้า',
    dirty: 'ฉบับร่างมีการแก้ไข กรุณาบันทึกก่อนทบทวนต่อ',
    saveFailed: 'บันทึกไม่สำเร็จ ข้อมูลที่กรอกยังอยู่', stale: 'เจ้าหน้าที่คนอื่นอัปเดตเคสนี้แล้ว กรุณาโหลดข้อมูลล่าสุดก่อนลองอีกครั้ง',
    reload: 'โหลดเคสล่าสุด', queueError: 'เปิดเคสนี้ไม่ได้', saved: 'เคสนี้เปิดสำหรับการทบทวนแล้ว',
    changeCase: 'ออกจากฉบับร่างนี้และเปิดเคสที่เลือกหรือไม่', leave: 'ออกจากระบบและนำข้อมูลเคสออกจากหน้าจอหรือไม่',
    syncedInput: 'คุณเปิดเคสที่บันทึกไว้ ดูแหล่งข้อมูลและรายการยาได้ที่หน้าทบทวน',
    pending: 'ยังมีรายการจากการสแกนที่รอยืนยันในหน้าป้อนข้อมูล', saving: 'กำลังบันทึก…',
  },
}
export type CaseState = { encounter:Encounter; synced:Draft | null; captureOnly?:boolean }

export function CaseHandoff({draft,language,session,record,onSaved,onRefresh}: {
  draft:Draft; language:Language; session:StaffSession | null; record:CaseState | null;
  onSaved:(value:Encounter,draft:Draft)=>void; onRefresh:(id:string)=>Promise<void>
}) {
  const t=caseText[language]
  const [status,setStatus]=useState<'idle'|'busy'|'error'|'conflict'>('idle')
  const [detail,setDetail]=useState('')
  const pending=useRef(false)
  const dirty=record?.synced != null && draft.medicines!==record.synced.medicines
  const actionable = (draft.medicines.length>0 || dirty) && (!record || record.captureOnly || dirty)
  async function save() {
    if (!session || pending.current) return
    pending.current=true
    setStatus('busy');setDetail('')
    try {
      const encounter=await admitDraft(session.client,draft,record?.encounter ?? null)
      onSaved(encounter,draft);setStatus('idle')
    } catch (e) {
      setStatus(e instanceof ApiError && e.status===409 ? 'conflict':'error')
      if (e instanceof Error) setDetail(e.message)
    } finally { pending.current=false }
  }
  return <section className="intake-panel stack">
    <h2>{t.heading}</h2>
    {draft.preview?.rows.length ? <p>{t.pending} <Link className="text-action" to="/new-patient/input">{t.input}</Link></p> : null}
    {!session && <p>{t.needsLogin}</p>}
    {!record && !draft.medicines.length && <p>{t.empty} <Link className="text-action" to="/new-patient/input">{t.input}</Link></p>}
    {dirty && <p>{t.dirty}</p>}
    {session && actionable && <button className="primary-btn" disabled={status==='busy'} onClick={save}>
      {status==='busy'?t.saving:record?t.update:t.start}</button>}
    {(status==='error'||status==='conflict') && <div role="alert"><p>{status==='conflict'?t.stale:t.saveFailed}</p>{detail && <p>{detail}</p>}
      {status==='conflict' && record && <button className="btn" onClick={()=>void onRefresh(record.encounter.id)}>{t.reload}</button>}</div>}
  </section>
}
