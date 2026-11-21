import { useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import type { Encounter } from '../api/admission'
import { ApiError } from '../api/client'
import type { Language } from '../i18n/messages'
import type { Draft } from '../pages/new-patient/draft'
import type { StaffSession } from './StaffAccess'
import { admitDraft, selectedExcerpt, sharedDocuments, type DocumentExcerpts } from './admitDraft'
import { SharedDocumentExcerpts } from './SharedDocumentExcerpts'

import { caseText } from './caseText'
export type CaseState = { encounter:Encounter; synced:Draft | null; captureOnly?:boolean; savedRevision?:number }

export function CaseHandoff({draft,language,session,record,onSaved,onRefresh}: {
  draft:Draft; language:Language; session:StaffSession | null; record:CaseState | null;
  onSaved:(value:Encounter,draft:Draft)=>void; onRefresh:(id:string)=>Promise<void>
}) {
  const t=caseText[language]
  const [status,setStatus]=useState<'idle'|'busy'|'error'|'conflict'>('idle')
  const [detail,setDetail]=useState('')
  const [excerpts,setExcerpts]=useState<DocumentExcerpts>({})
  const shared=sharedDocuments(draft.medicines)
  const missingExcerpt=shared.some(({note,rows}) => [...rows].some(medicine => {
    const text=selectedExcerpt(excerpts,record?.encounter,medicine.row.id,note.id)
    return !text.trim() || !note.text.includes(text)
  }))
  const pending=useRef(false)
  const dirty=record?.synced != null && draft.medicines!==record.synced.medicines
  const remoteEdits = record?.savedRevision !== undefined && record.encounter.events.some(event => event.action === 'intake' && event.revision > record.savedRevision!)
  const conflict = remoteEdits || status === 'conflict'
  const actionable = (draft.medicines.length>0 || dirty) && (!record || record.captureOnly || dirty)
  async function save() {
    if (!session || pending.current) return
    pending.current=true
    setStatus('busy');setDetail('')
    try {
      const encounter=await admitDraft(session.client,draft,record?.encounter ?? null,excerpts)
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
    {session && actionable && !conflict && <SharedDocumentExcerpts documents={shared} encounter={record?.encounter}
      excerpts={excerpts} language={language} onChange={(rid,sid,value) => setExcerpts(old => ({
        ...old, [rid]: {...old[rid], [sid]:value},
      }))}/>}
    {session && actionable && !conflict && <button className="primary-btn" disabled={missingExcerpt || status==='busy'} onClick={save}>
      {status==='busy'?t.saving:record?t.update:t.start}</button>}
    {(status==='error'||conflict) && <div role="alert"><p>{conflict?t.stale:t.saveFailed}</p>{detail && <p>{detail}</p>}
      {conflict && record && <button className="btn" onClick={()=>void onRefresh(record.encounter.id)}>{t.reload}</button>}</div>}
  </section>
}
