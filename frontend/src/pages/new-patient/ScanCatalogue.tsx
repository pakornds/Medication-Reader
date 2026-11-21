import { useState } from 'react'
import type { Language } from '../../i18n/messages'
import { intake } from '../../i18n/intake'
import { MedicinePicker } from './MedicinePicker'
import { currentCatalogueIdentity, type CatalogueMatch, type Medicine } from './draft'

const labels = {
  en:{open:'Compare label with catalogue', source:'On the label', product:'Catalogue product', ingredients:'Ingredient text', strength:'Strength', form:'Form', confirm:'Confirm this catalogue product', clear:'Remove catalogue selection', conflict:'The catalogue and label differ. Check the cited label before confirming.', unmatched:'The observed name does not appear in the selected catalogue label or ingredient text. Check the original before confirming.', empty:'Unspecified'},
  th:{open:'เทียบฉลากกับบัญชียา', source:'ข้อความบนฉลาก', product:'ผลิตภัณฑ์ในบัญชี', ingredients:'ตัวยาสำคัญ', strength:'ความแรง', form:'รูปแบบยา', confirm:'ยืนยันผลิตภัณฑ์ที่เลือก', clear:'ยกเลิกผลิตภัณฑ์ที่เลือก', conflict:'ข้อมูลบัญชียากับฉลากต่างกัน ตรวจสอบหลักฐานก่อนยืนยัน', unmatched:'ไม่พบชื่อที่อ่านได้ในชื่อผลิตภัณฑ์หรือข้อความตัวยาสำคัญ กรุณาตรวจต้นฉบับก่อนยืนยัน', empty:'ไม่ระบุ'},
}
const normalize = (value: string) => value.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{M}\p{N}]+/gu, ' ').trim()

function Comparison({ medicine, language, onChange }: Props) {
  const t=labels[language], row=medicine.row
  const strength=row.label_fields.strength?.value?.trim(),form=row.label_fields.form?.value?.trim()
  const verbatim=row.observed_names.map(n=>n.value)
  const identity = currentCatalogueIdentity(medicine)
  const seed = identity?.trade_name || identity?.ingredient || (verbatim.length === 1 ? verbatim[0] : '')
  const [query,setQuery]=useState([seed,...[strength,form].filter(v=>v&&!seed.toLowerCase().includes(v.toLowerCase()))].filter(Boolean).join(' ').slice(0,120))
  const [choice,setChoice]=useState<CatalogueMatch>()
  const p=choice?.product
  const corroborated = identity && choice && identity.release === choice.release && identity.candidate_tpus.includes(choice.product.tpu)
  const differs=(source:string|null|undefined,option:string)=>Boolean(source && option && normalize(source)!==normalize(option))
  return <div className="stack">
    <div><strong>{t.source}</strong>{verbatim.map((s,i)=><p key={i}>{s}</p>)}
      <small>{[strength,form].filter(Boolean).join(' · ')}</small></div>
    <MedicinePicker t={intake[language]} name={query} autoFocus selected={choice}
      onChange={value=>{setQuery(value);setChoice(undefined)}} onSelect={value=>{setChoice(value);setQuery(value.product.label)}}/>
    {p && choice && <section className="catalogue-comparison">
      <h3>{t.product}</h3><p>{p.label}</p>
      <dl>{[[t.ingredients,p.source_generic],[t.strength,p.strength],[t.form,p.dose_form]].map(([k,v])=>
        <div key={k}><dt>{k}</dt><dd>{v || t.empty}</dd></div>)}</dl>
      <small>TPU {p.tpu} · {choice.release}</small>
      {!corroborated && verbatim.some(name => normalize(name) && ![p.label, p.source_generic ?? ''].some(text => (' ' + normalize(text) + ' ').includes(' ' + normalize(name) + ' '))) && <p role="status">{t.unmatched}</p>}
      {(differs(strength,p.strength)||differs(form,p.dose_form)) && <p role="status">{t.conflict}</p>}
      <button className="btn" onClick={()=>{onChange(choice);setChoice(undefined)}}>{t.confirm}</button>
    </section>}
    {medicine.catalogue && <div><p>{medicine.catalogue.product.label} · TPU {medicine.catalogue.product.tpu} · {medicine.catalogue.release}</p>
      <button className="text-action" onClick={()=>onChange(undefined)}>{t.clear}</button></div>}
  </div>
}
type Props={medicine:Medicine;language:Language;onChange:(match:CatalogueMatch|undefined)=>void}
export function ScanCatalogue(props:Props) {
  const [open,setOpen]=useState(false)
  return <details className="scan-catalogue" open={open} onToggle={e=>setOpen(e.currentTarget.open)}>
    <summary>{labels[props.language].open}</summary>{open && <Comparison {...props}/>}
  </details>
}
