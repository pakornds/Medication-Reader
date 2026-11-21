import { useEffect, useRef, useState } from 'react'
import { Link, Navigate, Route, Routes, useMatch, useNavigate } from 'react-router-dom'
import { HomePage } from './pages/home/HomePage'
import { NewPatientLayout } from './pages/new-patient/NewPatientLayout'
import { InputPage } from './pages/new-patient/InputPage'
import { DraftReview } from './pages/new-patient/AnalysisPreview'
import { createDraft, type Draft } from './pages/new-patient/draft'
import { stages } from './pages/new-patient/stages'
import { PageContainer } from './components/layout/PageContainer'
import { TopBar } from './components/layout/TopBar'
import { messages, type Language } from './i18n/messages'
import { ClinicalReview } from './pages/clinical/ClinicalReview'
import { OutputPage } from './pages/output/OutputPage'
import { HistoryPage } from './pages/history/HistoryPage'
import { StaffAccess, EncounterQueue, type StaffSession } from './workflow/StaffAccess'
import { CaseHandoff, type CaseState } from './workflow/ConnectedCase'
import { proposePhotoRegions } from './workflow/proposePhotoRegions'
import type { Photo } from './pages/new-patient/draft'
import { caseText } from './workflow/caseText'
import type { Encounter } from './api/admission'

export default function App() {
  const [language, setLanguage] = useState<Language>(() => {
    try { return localStorage.getItem('medrec.language') === 'th' ? 'th' : 'en' } catch { return 'en' }
  })
  const [draft,setDraft] = useState(createDraft)
  const [session,setSession] = useState<StaffSession | null>(null)
  const [record,setRecord] = useState<CaseState | null>(null)
  const [requestError,setRequestError] = useState(false)
  const generation = useRef(0)
  const openRequest = useRef(0)
  const navigate = useNavigate()
  const [lastStage,setLastStage] = useState('input')
  const stage = useMatch('/new-patient/:stage')?.params.stage
  const t = messages[language], w = caseText[language]
  if (stage && stage !== lastStage && stages.some(item=>item===stage)) setLastStage(stage)
  useEffect(()=>{document.documentElement.lang=language},[language])
  useEffect(()=>{if(stages.some(s=>s===stage)) document.title=t[stage as typeof stages[number]]+' · MedRec TH'},[stage,t])
  function changeLanguage(next:Language) {
    setLanguage(next)
    try {localStorage.setItem('medrec.language',next)} catch { /* In-memory preference remains usable. */ }
  }
  function changeSession(next:StaffSession | null) {
    if (!next && (record || draft.medicines.length || draft.evidence.photos.length || draft.evidence.notes.some(n=>n.text.trim())) && !window.confirm(w.leave)) return
    generation.current++
    setRequestError(false)
    setSession(next)
    if (!next) {setRecord(null);setDraft(createDraft());setLastStage('input')}
  }
  async function openEncounter(id:string) {
    if(!session) return
    const replacing=record?.encounter.id!==id
    const unsaved=(!record || (record.synced && record.synced!==draft)) &&
      (draft.medicines.length || draft.evidence.photos.length || draft.evidence.notes.some(n=>n.text.trim()))
    if (replacing && unsaved && !window.confirm(w.changeCase)) return
    const token=++openRequest.current, before=generation.current
    setRequestError(false)
    try {
      const encounter=await session.client.encounter(id)
      if (token!==openRequest.current || before!==generation.current) return
      if(replacing) {
        generation.current++
        setDraft(createDraft());setRecord({encounter,synced:null})
      } else setRecord(prev => prev && encounter.revision>=prev.encounter.revision ? {...prev,encounter} : prev)
      navigate('/new-patient/review')
    } catch { if (before===generation.current && token===openRequest.current) setRequestError(true) }
  }
  const generationAtRender=generation.current
  function onEncounter(encounter:Encounter) {
    if (generation.current!==generationAtRender) return
    setRecord(prev=>prev && prev.encounter.id===encounter.id && encounter.revision>=prev.encounter.revision ? {...prev,encounter}:prev)
  }
  function onSaved(encounter:Encounter,synced:Draft) {
    if (generation.current!==generationAtRender) return
    setRecord(prev=>prev && prev.encounter.id===encounter.id && prev.encounter.revision>encounter.revision ? prev : {encounter,synced})
  }
  const current=record && !record.captureOnly && (!record.synced || record.synced.medicines === draft.medicines)
  async function proposePhoto(photo:Photo) {
    if(!session) throw new Error(w.needsLogin)
    return proposePhotoRegions(session.client, draft, record?.encounter ?? null, photo, encounter => {
      if(generation.current!==generationAtRender) return
      setRecord(prev => prev && prev.encounter.id===encounter.id
        ? (encounter.revision>=prev.encounter.revision ? {...prev,encounter} : prev)
        : { encounter, synced:null, captureOnly:true })
    })
  }
  const access=<StaffAccess language={language} session={session} onSession={changeSession}/>
  const error=requestError && <p role="alert">{w.queueError}</p>
  const placeholderOutput=<section className="intake stack"><h1>{t.output}</h1><p>{w.needsReview}</p><Link className="text-action" to="/new-patient/review">{w.goReview}</Link></section>
  return <>
    <TopBar language={language} onLanguage={changeLanguage}/>
    <main className="pt-7"><PageContainer><Routes>
      <Route path="/" element={<><HomePage language={language}/><div className="staff-desk intake stack">
        {access}{error}{session && <EncounterQueue key={session.actor.id} session={session} language={language} onOpen={id=>void openEncounter(id)}/>}
      </div></>}/>
      <Route path="/new-patient" element={<NewPatientLayout language={language}/>}>
        <Route index element={<Navigate to={lastStage} replace/>}/>
        <Route path="input" element={(record?.synced===null && !record.captureOnly) ?
          <div className="intake stack"><h1>{t.input}</h1><p>{w.syncedInput}</p><Link className="text-action" to="/new-patient/review">{w.goReview}</Link></div> :
          <><details className="input-access"><summary>{session ? session.actor.name : language==='th'?'สิทธิ์เจ้าหน้าที่':'Staff access'}</summary>{access}</details><InputPage key={draft.caseId} draft={draft} setDraft={setDraft} language={language} proposePhoto={session?proposePhoto:undefined}/></>}/>
        <Route path="review" element={<div className="connected-workspace stack">
          {current || (record?.synced===null && !record.captureOnly) ? <h1 className="page-heading">{t.review}</h1> : <DraftReview draft={draft} language={language} onCatalogue={(medicine,match)=>setDraft(d=>({...d,medicines:d.medicines.map(m=>m===medicine?{...m,catalogue:match}:m)}))}/>}
          {access}{error}
          {(!current || draft.preview?.rows.length) ? <CaseHandoff key={draft.caseId} draft={draft} language={language} session={session} record={record} onSaved={onSaved} onRefresh={openEncounter}/> : null}
          {session && record && current && <ClinicalReview key={record.encounter.id+session.actor.id} language={language} client={session.client} actor={session.actor} encounter={record.encounter} onEncounter={onEncounter}/>}
          {current && record?.synced && <details className="intake intake-panel"><summary>{language==='th'?'ดูฉบับร่างและหลักฐานต้นทาง':'Intake draft and source evidence'}</summary><DraftReview embedded draft={draft} language={language} onCatalogue={(medicine,match)=>setDraft(d=>({...d,medicines:d.medicines.map(m=>m===medicine?{...m,catalogue:match}:m)}))}/></details>}
        </div>}/>
        <Route path="output" element={<div className="connected-workspace stack">
          {session && record && current ? <OutputPage key={record.encounter.id+session.actor.id} language={language} client={session.client} encounter={record.encounter} actor={session.actor} onEncounter={onEncounter}/> : placeholderOutput}{access}
        </div>}/>
      </Route>
      <Route path="/history" element={<div className="connected-workspace stack">
        <HistoryPage language={language} client={session?.client ?? null}/>{access}
      </div>}/>
      <Route path="*" element={<Navigate to="/" replace/>}/>
    </Routes></PageContainer></main>
  </>
}
