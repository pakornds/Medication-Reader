import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { renderMedicationHandoff } from '../../../../src/components/print/medication-handoff.mjs'
import '../../../../src/components/print/medication-handoff.css'
import type { Encounter } from '../../api/admission'
import type { EvidenceItem, EvidenceRef, RegimenComponent } from '../../api/contracts'
import { active, entryName, reported, supportsIdentity, type Entry, type Say } from './review'

function cited(rowId:string, entry:Entry, items:EvidenceItem[], original?:EvidenceRef) {
  const sid=entry.source.id
  const itemId=original?.item_id || (entry.photo ? 'selected' : entry.identity_basis ? 'record' : null)
  if(!itemId) return {source_id:sid}
  const kind = !entry.photo ? 'record_excerpt' : entry.source.kind==='reverse_photo' ?
    supportsIdentity(entry) ? 'matched_reverse_label' : 'pill_crop' : entry.photo.appearance ? 'pill_crop':'label_region'
  items.push({id:itemId,source_id:sid,row_id:rowId,kind})
  return {source_id:sid,item_id:itemId}
}

async function crop(entry:Entry) {
  if (!entry.photo) return null
  const image=new Image()
  image.src='data:'+entry.photo.media_type+';base64,'+entry.photo.data
  try {await image.decode()} catch {return null}
  const [x,y,w,h]=entry.photo.region
  const canvas=document.createElement('canvas')
  const width=w*image.naturalWidth, height=h*image.naturalHeight
  const scale=Math.min(1,420/Math.max(width,height))
  canvas.width=Math.max(1,Math.round(width*scale)); canvas.height=Math.max(1,Math.round(height*scale))
  const context=canvas.getContext('2d')
  if (!context) return null
  context.drawImage(image,x*image.naturalWidth,y*image.naturalHeight,width,height,0,0,canvas.width,canvas.height)
  return canvas.toDataURL()
}
export function Handoff({encounter,t}:{encounter:Encounter;t:Say}) {
  const [open,setOpen]=useState(false)
  const [ready,setReady]=useState(false)
  const [error,setError]=useState(false)
  const dialog=useRef<HTMLDialogElement>(null)
  const host=useRef<HTMLDivElement>(null)
  useEffect(()=>{
    if(!open || !dialog.current || !host.current) return
    const modal=dialog.current,target=host.current
    let live=true
    modal.showModal()
    async function render() {
      const sources=new Map<string,Entry['source']>(),items:EvidenceItem[]=[],crops=new Map<string,string>()
      const rows=await Promise.all(Object.values(encounter.rows).map(async row=>{
        const entries=active(row)
        const refs=new Map(entries.map(e=>{
          sources.set(e.source.id,e.source)
          return [e.source.id,cited(row.id,e,items,row.intake?.sources.find(r=>r.source_id===e.source.id))]
        }))
        const fact=(value:string,source:string)=>({value,evidence:refs.get(source)})
        const fields={...row.intake?.label_fields}
        for(const e of entries) {
          for(const k of ['strength','form','dose','directions','indication'] as const) {
            if(e[k] && !fields[k]) fields[k]={value:e[k],status:'readable',evidence:refs.get(e.source.id)}
          }
        }
        const v=row.verified as (typeof row.verified & {regimens?:RegimenComponent[]})|null
        const verified=v && {reviewer:v.actor,verified_at:v.at,status:v.answer.current_use==='current'?'current':
          ['reported_stopped','discontinued_order'].includes(v.answer.current_use)?'no_longer_current':'uncertain',
          identity:v.identity && fact(v.identity.name,v.identity.source_id),evidence:[refs.get(v.source_id)].filter(Boolean),
          dose:v.answer.dose && fact(v.answer.dose,v.source_id),route:v.answer.route && fact(v.answer.route,v.source_id),
          frequency:v.answer.schedule && fact(v.answer.schedule,v.source_id),regimens:v.regimens}
        const reverse=entries.find(e=>e.photo?.appearance && e.photo.pairing==='matched' && e.source.kind==='reverse_photo')
        if(reverse){const url=await crop(reverse);if(url)crops.set(reverse.source.id,url)}
        return {...row.intake,id:row.id,sources:[...refs.values()],identity_status:row.unknown?'unlabeled':'named',
          unknown_label:row.unknown?row.id:null,observed_names:entries.filter(supportsIdentity).map(e=>fact(entryName(e),e.source.id)),
          reported_use:entries.filter(reported).map(e=>fact(e.wording,e.source.id)),label_fields:fields,verification:verified,
          reverse_crop:reverse?refs.get(reverse.source.id):null}
      }))
      if(!live) return
      const referrals=encounter.events.filter(e=>e.action==='refer').map(e=>({...e,row_ids:e.rows.filter(id=>encounter.rows[id]?.referred)}))
      const decisions=encounter.events.filter(e=>e.action==='decide').map(e=>({...e,row_id:e.rows[0],source_id:e.sources[0]}))
      renderMedicationHandoff(target,{evidence:{sources:[...sources.values()],items},rows,datedAt:encounter.events.at(-1)?.at || encounter.created_at,
        mode:encounter.status==='Finished'?'reviewed':'worksheet',referrals,decisions,cropUrl:ref=>crops.get(ref.source_id)||null})
      setReady(true)
    }
    void render().catch(()=>{if(live)setError(true)})
    return ()=>{live=false;modal.close()}
  },[open,encounter])
  return <>
    <button type="button" className="btn" disabled={!Object.keys(encounter.rows).length} onClick={()=>{setReady(false);setError(false);setOpen(true)}}>{t('Dated handoff / print','ใบส่งต่อพร้อมวันที่ / พิมพ์')}</button>
    {open && createPortal(<dialog className="clinical-print" ref={dialog} aria-label={t('Dated medication handoff','ใบส่งต่อรายการยาพร้อมวันที่')} onCancel={()=>setOpen(false)}>
      <div className="clinical-print-tools"><button className="btn" onClick={()=>setOpen(false)}>{t('Close','ปิด')}</button>
        <button className="primary-btn" disabled={!ready} onClick={()=>window.print()}>{t('Print handoff','พิมพ์ใบส่งต่อ')}</button></div>
      {error && <p role="alert">{t('Could not prepare handoff. Close and retry.','จัดเตรียมใบส่งต่อไม่สำเร็จ กรุณาปิดแล้วลองใหม่')}</p>}
      <div ref={host}/></dialog>,document.body)}
  </>
}
