import { useState } from 'react'
import type { Language } from '../../i18n/messages'
import type { Draft, Photo, Region, Suggestion } from './draft'
import { parseRegimen } from '../../api/reconciliation'

const copy = {
  en: { action:'Record what I can read', region:'Label region', name:'Name as written', directions:'Directions as written', quantity:'Quantity as written', unknown:'Keep identity unresolved', submit:'Use this label in draft', failed:'Could not prepare these directions. Your transcription is still here.', used:'Already in the draft', source:'Photograph', noName:'Unidentified medicine' },
  th: { action:'บันทึกข้อมูลที่อ่านได้', region:'ตำแหน่งฉลาก', name:'ชื่อยาตามฉลาก', directions:'วิธีใช้ยาตามฉลาก', quantity:'จำนวนยาตามฉลาก', unknown:'ยังไม่ทราบชนิดยา', submit:'ใช้ข้อมูลจากฉลากในฉบับร่าง', failed:'เตรียมวิธีใช้ยาไม่ได้ ข้อความยังอยู่', used:'อยู่ในฉบับร่างแล้ว', source:'รูปถ่าย', noName:'ยาไม่ทราบชื่อ' },
}

export function LabelTranscription({draft,language,onUse}: {draft:Draft;language:Language;onUse:(row:Suggestion)=>void}) {
  const t=copy[language]
  const choices=draft.evidence.photos.flatMap((p,pi)=>p.kind==='reverse_photo'?[]:p.regions.map((r,i)=>({p,r,label:t.source+' '+(pi+1)+' · '+t.region+' '+(i+1)})))
  const [choice,setChoice]=useState('')
  const [name,setName]=useState(''),[directions,setDirections]=useState(''),[qty,setQty]=useState('')
  const [unknown,setUnknown]=useState(false),[status,setStatus]=useState<'idle'|'busy'|'error'>('idle')
  const selected=choices.find(c=>c.r.id===choice) ?? choices[0]
  if(!selected) return null
  const used=draft.medicines.some(m=>m.row.id===selected.r.rowId)
  function reset() {setName('');setDirections('');setQty('');setUnknown(false);setStatus('idle')}
  async function add(p:Photo,r:Region) {
    if(used||(!unknown&&!name.trim())) return
    setStatus('busy')
    const ref={source_id:r.id,item_id:r.id}
    const back=draft.evidence.photos.filter(photo=>photo.kind==='reverse_photo').flatMap(photo=>photo.regions).find(region=>region.rowId===r.rowId)
    const backRef=back?{source_id:back.id,item_id:back.id}:null
    const row:Suggestion={id:r.rowId,identity_status:unknown?'unreadable':'named',unknown_label:unknown?t.noName:null,
      sources:backRef?[ref,backRef]:[ref],observed_names:unknown?[]:[{value:name.trim(),evidence:ref}],
      label_fields:{},reported_use:[],regimens:[],reverse_crop:backRef,discrepancies:[],follow_ups:[]}
    if(qty.trim())row.label_fields.amount_prescribed={status:'readable',value:qty.trim(),evidence:ref}
    try {
      if(directions.trim()){
        row.label_fields.directions={status:'readable',value:directions.trim(),evidence:ref}
        const parsed=await parseRegimen({row_id:r.rowId,component_id:crypto.randomUUID(),basis:'documented',
          directions_text:directions.trim(),source:ref,evidence:{case_id:draft.caseId,sources:[{id:r.id,kind:p.kind,attachment_id:p.id}],
            items:[{id:r.id,source_id:r.id,row_id:r.rowId,kind:'label_region'}]}})
        row.regimens=parsed.regimens
      }
      onUse(row);reset()
    } catch {setStatus('error')}
  }
  return <details className="label-transcription"><summary>{t.action}</summary>
    <form className="stack" onSubmit={e=>{e.preventDefault();void add(selected.p,selected.r)}}>
      <fieldset className="stack" disabled={status==='busy'}>
        <label>{t.region}<select value={selected.r.id} onChange={e=>{setChoice(e.target.value);reset()}}>{choices.map(c=><option key={c.r.id} value={c.r.id}>{c.label}</option>)}</select></label>
        {used ? <p>{t.used}</p> : <>
          <label className="field-label">{t.name}<input disabled={unknown} required={!unknown} value={name} onChange={e=>setName(e.target.value)} /></label>
          <label className="label-unknown"><input type="checkbox" checked={unknown} onChange={e=>setUnknown(e.target.checked)}/>{t.unknown}</label>
          <label className="field-label">{t.directions}<input value={directions} onChange={e=>setDirections(e.target.value)}/></label>
          <label className="field-label">{t.quantity}<input value={qty} onChange={e=>setQty(e.target.value)}/></label>
          <button className="btn" disabled={!unknown&&!name.trim()}>{t.submit}</button>
        </>}
      </fieldset>
      {status==='error' && <p role="alert">{t.failed}</p>}
    </form>
  </details>
}
