import { useState } from 'react'
import type { RegimenComponent, ReviewerIdentity } from '../../api/contracts'
import type { Language } from '../../i18n/messages'
import { regimenText } from '../../i18n/regimen'
import { intake } from '../../i18n/intake'
import { ScheduleEditor } from '../new-patient/DirectionsEditor'
import { MedicinePicker } from '../new-patient/MedicinePicker'
import type { CatalogueMatch } from '../new-patient/draft'
import { emptySchedule, fromComponent, toComponents, type Schedule } from '../new-patient/regimen'
import { active, entryName, needsIdentity, reported, sourceLabel, supportsIdentity, type ReviewRow, type Save, type Say } from './review'

export function VerifyForm({row, actor, save, t, language}:{
  row:ReviewRow;actor:ReviewerIdentity;save:Save;t:Say;language:Language
}) {
  const answer = row.interview!
  const entries = active(row)
  const source = entries.find(e=>e.source.id===answer.source_id)
  const named = entries.filter(supportsIdentity)
  const initial = row.verified?.identity?.source_id
  const uniqueProduct = new Set(named.map(e=>entryName(e).toLowerCase())).size === 1
  const [identity,setIdentity] = useState(initial || (uniqueProduct ? named.at(-1)?.source.id : '') || '')
  const [resolution,setResolution] = useState(row.verified?.resolution || '')
  const prior = row.verified as (NonNullable<ReviewRow['verified']> & {regimens?:RegimenComponent[]}) | null
  const [structured,setStructured] = useState(Boolean(prior?.regimens?.length))
  const [schedules,setSchedules] = useState<Schedule[]>(()=>prior?.regimens?.map(fromComponent) || [emptySchedule()])
  const [product,setProduct] = useState<CatalogueMatch>()
  const [query,setQuery] = useState('')
  const [match,setMatch] = useState(false)
  if (!source) return <p role="alert">{t('The interview source has changed. Record a new interview.','แหล่งสัมภาษณ์เปลี่ยนไป กรุณาบันทึกการสัมภาษณ์ใหม่')}</p>

  const notPatient = answer.ownership==='other'
  const consistent = answer.ownership!=='uncertain' && answer.current_use!=='uncertain' && notPatient === (answer.current_use==='not_owned')
  const readySchedules = schedules.length>0 && schedules.every(s=>s.complete && s.amount && s.unit.trim() && s.route.trim() && s.mode &&
    s.period && s.periodUnit && (s.mode==='interval' || s.count))
  const readyUse = answer.current_use!=='current' || (structured ? readySchedules : Boolean(answer.dose && answer.route && answer.schedule))
  const canVerify = consistent && readyUse && !needsIdentity(row) && (row.unknown || identity) && (!match || product)
  function verify(event:React.FormEvent) {
    event.preventDefault()
    if(!canVerify || !source) return
    const components = structured ? toComponents({
      note:{id:source.source.id,kind:reported(source) ? source.source.kind==='patient_report'?'patient_report':'caregiver_report' : 'other_record',
        text:source.wording,author:'',date:''},schedules,boundWording:source.wording,
    }).map(c=>({...c,basis:'verified' as const})) : []
    const command = {action:'verify' as const,row_id:row.id,source_id:answer.source_id,
      identity_source_id:row.unknown ? null : identity,resolution:resolution.trim()||null,
      ...(components.length ? {regimens:components}:{}),
      ...(match && product ? {confirmed_product:{tpu:product.product.tpu,tmt_release:product.release}} : {}),
    }
    void save(command)
  }
  return <form className="clinical-form" onSubmit={verify}>
    <h4>{t('Clinical verification','ยืนยันโดยบุคลากรทางการแพทย์')}</h4>
    <p>{sourceLabel(source,t)} · {source.wording}</p>
    {!row.unknown && <label>{t('Supported medicine identity','หลักฐานยืนยันตัวยา')}<select value={identity} required onChange={e=>{setIdentity(e.target.value);setMatch(false);setProduct(undefined);setQuery('')}}>
      <option value="">{t('Choose an identity source','เลือกหลักฐานระบุชนิดยา')}</option>
      {named.map(e=><option key={e.source.id} value={e.source.id}>{entryName(e)} · {sourceLabel(e,t)} · {e.wording}</option>)}</select></label>}
    {row.unknown && <p>{row.confirmed ? row.confirmed.name : t('Identity unresolved','ยังไม่ยืนยันชนิดยา')}</p>}
    <label>{t('Resolution of conflicting evidence','คำอธิบายการแก้ข้อมูลขัดแย้ง')}<textarea value={resolution} onChange={e=>setResolution(e.target.value)}/></label>
    {answer.current_use==='current' && <>
      <label className="clinical-check"><input type="checkbox" checked={structured} onChange={e=>setStructured(e.target.checked)}/>
        {t('Verify a structured dosing schedule','ยืนยันตารางใช้ยาแบบแยกช่อง')}</label>
      {structured && <div className="clinical-form">
        {(row.intake?.regimens || []).filter(c=>c.evidence.directions_text?.source_id===source.source.id).length>0 &&
          <button className="text-action" type="button" onClick={()=>setSchedules(row.intake!.regimens!
            .filter(c=>c.evidence.directions_text?.source_id===source.source.id).map(c=>({...fromComponent(c),complete:false})))}>
            {t('Use the schedule recorded from this interview','ใช้ตารางที่บันทึกจากการสัมภาษณ์นี้')}</button>}
        {schedules.map((s,i)=><div className="clinical-schedule" key={s.id}>
          <ScheduleEditor s={s} t={regimenText[language]} onChange={next=>setSchedules(list=>list.map(v=>s.id===v.id?next:v))}/>
          {schedules.length>1 && <button className="text-action" type="button" onClick={()=>setSchedules(schedules.filter((_,n)=>n!==i))}>{t('Remove this schedule','ลบตารางนี้')}</button>}
        </div>)}
        <button className="text-action" type="button" onClick={()=>setSchedules([...schedules,emptySchedule()])}>{t('Add another schedule','เพิ่มตารางใช้ยา')}</button>
      </div>}
    </>}
    <label className="clinical-check"><input type="checkbox" checked={match} onChange={e=>setMatch(e.target.checked)}/>
      {t('Confirm an exact TMT product','ยืนยันผลิตภัณฑ์ที่ตรงกับบัญชี TMT')}</label>
    {match && <div className="clinical-form">
      {row.intake_catalogue && <button className="text-action" type="button" onClick={()=>{setProduct(row.intake_catalogue!);setQuery(row.intake_catalogue!.product.label)}}>
        {t('Use the intake selection','ใช้รายการที่เลือกตอนรับข้อมูล')} · {row.intake_catalogue.product.label}</button>}
      <MedicinePicker t={intake[language]} name={query} selected={product}
        onChange={value=>{setQuery(value);setProduct(undefined)}} onSelect={v=>{setProduct(v);setQuery(v.product.label)}}/>
      {product && <small>TPU {product.product.tpu} · {product.release}</small>}
    </div>}
    <div className="clinical-actions">
      <button className="primary-btn" disabled={!canVerify}>{t('Verify this medicine','ยืนยันรายการยานี้')}</button>
      {actor.role!=='nurse' && actor.role!=='staff' && answer.current_use==='current' && answer.ownership==='patient' && !needsIdentity(row) &&
        <button type="button" className="btn" onClick={()=>void save({action:'attest_current_use',row_id:row.id,source_id:source.source.id})}>
          {t('Attest current use for screening','ยืนยันการใช้อยู่เพื่อการคัดกรอง')}</button>}
    </div>
    {!consistent && <p className="hint">{t('Clarify ownership and current use in the interview.','ระบุเจ้าของยาและสถานะการใช้ยาในข้อมูลสัมภาษณ์')}</p>}
    {consistent && !readyUse && <p className="hint">{t('Current use requires a sourced dose, route and schedule.','ยาที่ใช้อยู่ต้องมีข้อมูลขนาดยา ทางให้ยา และตารางใช้ยาที่มีแหล่งอ้างอิง')}</p>}
    {row.screening_attestation && <p role="status">{t('Current-use attestation recorded','บันทึกการยืนยันสถานะการใช้ยาแล้ว')} · {row.screening_attestation.actor.name}</p>}
  </form>
}
