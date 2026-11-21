import { useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import type { Language } from '../i18n/messages'
import { createClient } from '../api/client'
import type { ReviewerIdentity } from '../api/contracts'
import type { EncounterSummary } from '../api/admission'

export type StaffSession = { client: ReturnType<typeof createClient>; actor: ReviewerIdentity }
const text = {
  en: { staff: 'Staff access', token: 'Staff token', enter: 'Sign in', leave: 'Sign out', failed: 'Sign-in failed. Check the staff token and try again.', queue: 'Assigned encounters', empty: 'No assigned encounters yet.', refresh: 'Refresh list', resume: 'Open review', queueError: 'Could not load assigned encounters.', updated: 'Updated', nurse: 'Nurse', pharmacist: 'Pharmacist', doctor: 'Doctor', general: 'Staff' },
  th: { staff: 'สิทธิ์เจ้าหน้าที่', token: 'โทเคนเจ้าหน้าที่', enter: 'เข้าสู่ระบบ', leave: 'ออกจากระบบ', failed: 'เข้าสู่ระบบไม่สำเร็จ โปรดตรวจสอบโทเคนแล้วลองอีกครั้ง', queue: 'เคสที่ได้รับมอบหมาย', empty: 'ยังไม่มีเคสที่ได้รับมอบหมาย', refresh: 'โหลดรายการอีกครั้ง', resume: 'เปิดทบทวน', queueError: 'โหลดรายการเคสไม่สำเร็จ', updated: 'อัปเดต', nurse: 'พยาบาล', pharmacist: 'เภสัชกร', doctor: 'แพทย์', general: 'เจ้าหน้าที่' },
}
type Props = { language: Language; session: StaffSession | null; onSession: (session: StaffSession | null) => void }

export function StaffAccess({language, session, onSession}: Props) {
  const t = text[language]
  const [token, setToken] = useState('')
  const [status, setStatus] = useState<'ready'|'busy'|'error'>('ready')
  const mounted = useRef(false)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  async function signIn(e: FormEvent) {
    e.preventDefault()
    if (!token.trim() || status === 'busy') return
    setStatus('busy')
    const client = createClient(import.meta.env.VITE_API_BASE_URL, token.trim())
    try {
      const {actor} = await client.session()
      if (mounted.current) { setToken(''); setStatus('ready'); onSession({client, actor}) }
    } catch { if (mounted.current) setStatus('error') }
  }
  return <section className="staff-access" aria-label={t.staff}>
    {session ? <div className="staff-session"><strong>{session.actor.name}</strong>
      <span>{session.actor.role==='staff' ? t.general : t[session.actor.role]}</span>
      <button className="text-action" onClick={() => onSession(null)}>{t.leave}</button>
    </div> : <form onSubmit={signIn} className="staff-login">
      <label>{t.token}<input type="password" autoComplete="off" spellCheck={false} required value={token} onChange={e=>setToken(e.target.value)} /></label>
      <button className="btn" disabled={!token.trim() || status==='busy'}>{t.enter}</button>
      {status==='error' && <p role="alert">{t.failed}</p>}
    </form>}
  </section>
}

export function EncounterQueue({language,session,onOpen}: {language:Language;session:StaffSession;onOpen:(id:string)=>void}) {
  const t = text[language]
  const [entries,setEntries] = useState<EncounterSummary[]>([])
  const [status,setStatus] = useState<'loading'|'ready'|'error'>('loading')
  const [refresh,setRefresh] = useState(0)
  useEffect(()=>{
    let current=true
    session.client.encounters().then(rows=>{ if(current){setEntries(rows);setStatus('ready')} })
      .catch(()=>{ if(current) setStatus('error') })
    return ()=>{current=false}
  },[session,refresh])
  return <section className="intake-panel stack"><div className="staff-session">
    <h2>{t.queue}</h2><button className="text-action" onClick={()=>{setStatus('loading');setRefresh(n=>n+1)}}>{t.refresh}</button></div>
    {status==='error' && <p role="alert">{t.queueError}</p>}
    {status==='ready' && !entries.length && <p>{t.empty}</p>}
    <ul className="staff-queue" aria-busy={status==='loading'}>{entries.map(c=><li key={c.id}>
      <div><strong>{c.patient_alias}</strong><small>{c.status} · {t.updated} {new Date(c.updated_at).toLocaleString(language)}</small></div>
      <button className="btn" onClick={()=>onOpen(c.id)}>{t.resume}</button></li>)}</ul>
  </section>
}
