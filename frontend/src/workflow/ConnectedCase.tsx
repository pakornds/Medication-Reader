import { useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import type { Encounter } from '../api/admission'
import { ApiError } from '../api/client'
import type { Language } from '../i18n/messages'
import type { Draft } from '../pages/new-patient/draft'
import type { StaffSession } from './StaffAccess'
import { admitDraft } from './admitDraft'

import { caseText } from './caseText'
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
