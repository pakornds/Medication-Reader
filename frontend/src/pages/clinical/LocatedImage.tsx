import { useEffect, useState } from 'react'
import { entryCrop } from './locatedEvidence'
import type { PackageEvidence } from '../../api/contracts'
import { type Client, type Entry, type Say } from './review'

export function LocatedImage({entry,region,client,caseId,t}:{entry?:Entry;region?:PackageEvidence;client:Client;caseId:string;t:Say}) {
  const [open,setOpen]=useState(false)
  const [url,setUrl]=useState('')
  const [error,setError]=useState(false)
  useEffect(()=>{
    if(!open)return
    let live=true, objectUrl=''
    async function load(){
      let imageUrl:string|null=null
      if(region){
        const blob=await client.region(caseId,region.region)
        if(!live)return
        objectUrl=URL.createObjectURL(blob);imageUrl=objectUrl
      } else if(entry) imageUrl=await entryCrop(entry)
      if(live){setUrl(imageUrl || '');setError(!imageUrl)}
    }
    void load().catch(()=>{if(live)setError(true)})
    return ()=>{live=false;if(objectUrl)URL.revokeObjectURL(objectUrl)}
  },[open,entry,region,client,caseId])
  const title=(region?.kind==='appearance'||entry?.photo?.appearance)
    ? t('View appearance crop','ดูภาพลักษณะยา') : t('View label crop','ดูภาพบริเวณฉลาก')
  return <div><button className="text-action" type="button" aria-expanded={open} onClick={()=>{setOpen(!open);setUrl('');setError(false)}}>
    {open ? t('Hide crop','ซ่อนภาพ') : title}</button>
    {open && (error ? <p role="alert">{t('Crop unavailable','ไม่พบภาพบริเวณที่ระบุ')}</p> : url ?
      <img className="clinical-crop" alt={title} src={url}/> : <p role="status">{t('Loading crop…','กำลังโหลดภาพ…')}</p>)}
  </div>
}
