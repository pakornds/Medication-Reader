import { useState } from 'react'
import type { Interview } from '../../api/contracts'
import type { Encounter } from '../../api/admission'
import { active, interviewSource, ownerLabels, sourceLabel, currentUseLabels, type Save, type Say, type ReviewRow } from './review'

type Answers = Omit<Interview,'action'|'row_id'>
export function InterviewForm({ row, encounter, save, t }: { row: ReviewRow; encounter: Encounter; save: Save; t: Say }) {
  const sources = active(row).filter(interviewSource)
  const [source, setSource] = useState(row.interview?.source_id || sources[0]?.source.id || '')
  const [kind,setKind] = useState<'patient_report'|'caregiver_report'>('patient_report')
  const [wording,setWording] = useState('')
  const [answers,setAnswers] = useState<Answers>(() => row.interview || {ownership:'uncertain',current_use:'uncertain',source_id:''})
  const [newId,setNewId] = useState(() => crypto.randomUUID())
  const [saved,setSaved] = useState(false)
  const update = (patch: Partial<Answers>) => { setSaved(false); setAnswers(a => ({...a,...patch})) }
  const chosen = sources.find(e => e.source.id === source)
  async function submit(event: React.FormEvent) {
    event.preventDefault()
    let caseState = encounter
    let sourceId = source
    if (!sourceId) {
      sourceId = newId
      const linked = await save({action:'link',row_id:row.id,confirmed:true,
        entry:{source:{id:sourceId,kind},wording:wording.trim()}}, caseState)
      if (!linked) return
      caseState = linked
      setSource(sourceId)
      setWording('')
      setNewId(crypto.randomUUID())
    }
    const result = await save({action:'interview',row_id:row.id,...answers,source_id:sourceId,ownership_source_id:sourceId,
      dose:answers.dose?.trim() || null,route:answers.route?.trim() || null,schedule:answers.schedule?.trim() || null,
      reason:answers.reason?.trim() || null,note:answers.note?.trim() || null}, caseState)
    if (result) setSaved(true)
  }
  return <form className="clinical-form" onSubmit={submit}>
    <h4>{t('Medication interview','สัมภาษณ์การใช้ยา')}</h4>
    <label>{t('Interview source','แหล่งข้อมูลการสัมภาษณ์')}<select value={source} onChange={e=>{setSource(e.target.value);setSaved(false)}}>
      <option value="">{t('Record a new account','บันทึกคำบอกเล่าใหม่')}</option>
      {sources.map(entry=><option key={entry.source.id} value={entry.source.id}>{sourceLabel(entry,t)} · {entry.wording}</option>)}
    </select></label>
    {source ? <blockquote>{chosen?.wording}</blockquote> : <>
      <label>{t('Account from','ผู้ให้ข้อมูล')}<select value={kind} onChange={e=>setKind(e.target.value as typeof kind)}>
        <option value="patient_report">{t('Patient','ผู้ป่วย')}</option><option value="caregiver_report">{t('Caregiver','ผู้ดูแล')}</option></select></label>
      <label>{t('Original interview wording','คำบอกเล่าตามจริง')}<textarea required value={wording} onChange={e=>setWording(e.target.value)}/></label>
    </>}
    <div className="clinical-fields">
      <label>{t('Whose medicine?','ยาของใคร')}<select value={answers.ownership} onChange={e=>update({ownership:e.target.value as Answers['ownership']})}>
        {Object.entries(ownerLabels(t)).map(([key,label])=><option key={key} value={key}>{label}</option>)}</select></label>
      <label>{t('Current use','สถานะการใช้ยา')}<select value={answers.current_use} onChange={e=>update({current_use:e.target.value as Answers['current_use']})}>
        {Object.entries(currentUseLabels(t)).map(([key,label])=><option key={key} value={key}>{label}</option>)}</select></label>
      <label>{t('Actual dose','ขนาดยาที่ใช้จริง')}<input value={answers.dose || ''} onChange={e=>update({dose:e.target.value})}/></label>
      <label>{t('Actual route','ทางที่ใช้ยาจริง')}<input value={answers.route || ''} onChange={e=>update({route:e.target.value})}/></label>
      <label>{t('Actual schedule','เวลาหรือความถี่ที่ใช้จริง')}<input value={answers.schedule || ''} onChange={e=>update({schedule:e.target.value})}/></label>
      <label>{t('Reported reason for use','เหตุผลที่ใช้ยาตามคำบอกเล่า')}<input value={answers.reason || ''} onChange={e=>update({reason:e.target.value})}/></label>
    </div>
    <label>{t('Handoff note','บันทึกสำหรับส่งต่อ')}<textarea value={answers.note || ''} onChange={e=>update({note:e.target.value})}/></label>
    <div className="clinical-actions"><button className="btn" disabled={!source && !wording.trim()}>{t('Save interview','บันทึกการสัมภาษณ์')}</button>
      {saved && <span role="status">{t('Interview saved','บันทึกการสัมภาษณ์แล้ว')}</span>}</div>
  </form>
}
