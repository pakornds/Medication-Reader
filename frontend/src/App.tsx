import { useEffect, useRef, useState } from 'react'
import { Link, Navigate, Route, Routes, useMatch, useNavigate } from 'react-router-dom'
import { HomePage } from './pages/home/HomePage'
import { NewPatientLayout } from './pages/new-patient/NewPatientLayout'
import { InputPage } from './pages/new-patient/InputPage'
import { scanActions } from './pages/new-patient/scanActions'
import { createClient } from './api/client'
import { AnalysisPreview, DraftReview } from './pages/new-patient/AnalysisPreview'
import { createDraft, hasCaseWork, withDraftValues, type CatalogueMatch, type Draft, type DraftValues } from './pages/new-patient/draft'
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

const localDemo = Boolean(import.meta.env.MEDREC_LOCAL_DEMO)

export default function App() {
  const [language, setLanguage] = useState<Language>(() => {
    try { return localStorage.getItem('medrec.language') === 'th' ? 'th' : 'en' } catch { return 'en' }
  })
  const [draft,setDraft] = useState(createDraft)
  const [session,setSession] = useState<StaffSession | null>(null)
  const [demoFailed, setDemoFailed] = useState(false)
  const [demoAttempt, setDemoAttempt] = useState(0)
  useEffect(() => {
    if (!localDemo) return
    let active = true
    const client = createClient()
    client.session().then(({ actor }) => {
      if (actor.role !== 'pharmacist') throw new Error('Demo pharmacist unavailable')
      if (active) setSession({ client, actor })
    }).catch(() => { if (active) setDemoFailed(true) })
    return () => { active = false }
  }, [demoAttempt])
  const [record,setRecord] = useState<CaseState | null>(null)
  const [selectedRow,setSelectedRow] = useState('')
  const [requestError,setRequestError] = useState(false)
  const generation = useRef(0)
  const openRequest = useRef(0)
  const navigate = useNavigate()
  const [lastStage,setLastStage] = useState<string | null>(null)
  const stage = useMatch('/new-patient/:stage')?.params.stage
  const t = messages[language], w = caseText[language]
  if (stage && stage !== lastStage && stages.some(item=>item===stage)) setLastStage(stage)
  useEffect(()=>{document.documentElement.lang=language},[language])
  useEffect(()=>{if(stages.some(s=>s===stage)) document.title=t[stage as typeof stages[number]]+' · MedRec TH'},[stage,t])
  function changeLanguage(next:Language) {
    setLanguage(next)
    try {localStorage.setItem('medrec.language',next)} catch { /* In-memory preference remains usable. */ }
  }

  function saveDraftValues(id: string, values: DraftValues) {
    setDraft((current) => ({
      ...current,
      medicines: current.medicines.map((medicine) => (
        medicine.row.id === id ? withDraftValues(medicine, values) : medicine
      )),
    }))
  }

  function confirmCatalogue(id: string, catalogue?: CatalogueMatch) {
    setDraft(current => ({
      ...current,
      medicines: current.medicines.map(medicine => {
        if (medicine.row.id !== id) return medicine
        const originalCatalogue = medicine.originalCatalogue
          ?? (medicine.origin === 'manual' && !medicine.catalogue?.evidence ? medicine.catalogue : undefined)
        return { ...medicine, catalogue, originalCatalogue }
      }),
    }))
  }

  function startFreshCase() {
    setSelectedRow('')
    generation.current++
    openRequest.current++
    setRecord(null)
    setRequestError(false)
    setDraft(createDraft())
    setLastStage('input')
    navigate('/new-patient/input',{replace:true})
  }
  function changeSession(next:StaffSession | null) {
    if (!next && (record || draft.medicines.length || draft.evidence.photos.length || draft.evidence.notes.some(n=>n.text.trim())) && !window.confirm(w.leave)) return
    generation.current++
    setRequestError(false)
    setSession(next)
    if (!next) {setRecord(null);setSelectedRow('');setDraft(createDraft());setLastStage('input')}
  }
  async function openEncounter(id:string, reloadSaved = false, rowId?:string) {
    if(!session) return
    const replacing=record?.encounter.id!==id
    const unsaved=(!record || (record.synced && record.synced!==draft)) &&
      (draft.medicines.length || draft.evidence.photos.length || draft.evidence.notes.some(n=>n.text.trim()))
    if (reloadSaved && !window.confirm(w.discardLocal)) return
    if (!reloadSaved && replacing && unsaved && !window.confirm(w.changeCase)) return
    const token=++openRequest.current, before=generation.current
    setRequestError(false)
    try {
      const encounter=await session.client.encounter(id)
      if (token!==openRequest.current || before!==generation.current) return
      const remoteIntake = record && encounter.events.some(event => event.revision > record.encounter.revision && event.action === 'intake')
      if (!replacing && !reloadSaved && remoteIntake && unsaved && !window.confirm(w.discardLocal)) return
      if(replacing || reloadSaved || remoteIntake) {
        generation.current++
        setDraft(createDraft());setRecord({encounter,synced:null})
      } else setRecord(prev => prev && encounter.revision>=prev.encounter.revision ? {...prev,encounter} : prev)
      if (replacing || rowId !== undefined) setSelectedRow(rowId && encounter.rows[rowId] ? rowId : '')
      navigate('/new-patient/review')
    } catch { if (before===generation.current && token===openRequest.current) setRequestError(true) }
  }
  const generationAtRender=generation.current
  function reviewRow(caseId:string, rowId:string) {
    if (record?.encounter.id !== caseId) { void openEncounter(caseId, false, rowId); return }
    setSelectedRow(rowId)
    navigate('/new-patient/review')
  }
  function onEncounter(encounter:Encounter) {
    if (generation.current!==generationAtRender) return
    setRecord(prev=>prev && prev.encounter.id===encounter.id && encounter.revision>=prev.encounter.revision ? {...prev,encounter}:prev)
  }
  function onSaved(encounter:Encounter,synced:Draft) {
    if (generation.current!==generationAtRender) return
    setRecord(prev=>prev && prev.encounter.id===encounter.id && prev.encounter.revision>encounter.revision ? prev : {encounter,synced,savedRevision:encounter.revision})
  }
  const hasWork = Boolean(record) || hasCaseWork(draft)
  const canResume = lastStage !== null || hasWork
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
  const access = localDemo ? (demoFailed && <div role="alert">
    <p>{language === 'th' ? 'เชื่อมต่อระบบสาธิตไม่ได้' : 'Could not connect to the demo.'}</p>
    <button className="btn" onClick={() => {setDemoFailed(false); setDemoAttempt(value => value + 1)}}>{language === 'th' ? 'ลองอีกครั้ง' : 'Retry'}</button>
  </div>) : <StaffAccess language={language} session={session} onSession={changeSession}/>
  const error=requestError && <p role="alert">{w.queueError}</p>
  const placeholderOutput=<section className="intake stack"><h1>{t.output}</h1><p>{w.needsReview}</p><Link className="text-action" to="/new-patient/review">{w.goReview}</Link></section>
  return <>
    <TopBar language={language} onLanguage={changeLanguage} canResume={canResume}/>
    <main className="pt-7"><PageContainer><Routes>
      <Route path="/" element={<><HomePage language={language} canResume={canResume} hasWork={hasWork} onStartFresh={startFreshCase}/><div className="staff-desk intake stack">
        {access}{error}{session && <EncounterQueue key={session.actor.id} session={session} language={language} onOpen={id=>void openEncounter(id)}/>}
      </div></>}/>
      <Route path="/new-patient" element={<NewPatientLayout key={draft.caseId} language={language} hasWork={hasWork} onStartFresh={startFreshCase}/>}>
        <Route index element={<Navigate to={lastStage ?? 'input'} replace/>}/>
        <Route path="input" element={(record?.synced===null && !record.captureOnly) ?
          <div className="intake stack"><h1>{t.input}</h1><p>{w.syncedInput}</p><Link className="text-action" to="/new-patient/review">{w.goReview}</Link></div> :
          <>{localDemo ? access : <details className="input-access"><summary>{session ? session.actor.name : language==='th'?'สิทธิ์เจ้าหน้าที่':'Staff access'}</summary>{access}</details>}<InputPage key={draft.caseId} draft={draft} setDraft={setDraft} language={language} proposePhoto={session?proposePhoto:undefined}/></>}/>
        <Route path="review" element={<div className="connected-workspace stack">
          <h1 className="page-heading">{t.review}</h1>
          {draft.preview?.rows.length ? <AnalysisPreview draft={draft} language={language} {...scanActions(setDraft)}/> : null}
          {!current && draft.medicines.length > 0 && <DraftReview embedded onSave={saveDraftValues} draft={draft} language={language} onCatalogue={confirmCatalogue}/>}
          {!current && !draft.medicines.length && !draft.preview?.rows.length && <Link className="text-action" to="/new-patient/input">
            {draft.preview ? (language === 'th' ? 'ดูผลการอ่านภาพและบันทึก' : 'View results for your photos and notes') : (language === 'th' ? 'เพิ่มรายการยา' : 'Add medicines')}
          </Link>}
          {(draft.medicines.length > 0 || record || demoFailed) && access}{error}
          {!current && (!localDemo || session) && (draft.medicines.length > 0 || record?.synced) && <CaseHandoff key={draft.caseId} draft={draft} language={language} session={session} record={record} onSaved={onSaved} onRefresh={id => openEncounter(id, true)}/>}
          {session && record && current && <ClinicalReview key={record.encounter.id+session.actor.id} language={language} client={session.client} actor={session.actor} encounter={record.encounter} onEncounter={onEncounter} selectedRow={selectedRow} onSelectRow={setSelectedRow}/>}
          {current && record?.synced && <details className="intake intake-panel"><summary>{language==='th'?'ดูฉบับร่างและหลักฐานต้นทาง':'Intake draft and source evidence'}</summary><DraftReview onSave={saveDraftValues} embedded draft={draft} language={language} onCatalogue={confirmCatalogue}/></details>}
        </div>}/>
        <Route path="output" element={<div className="connected-workspace stack">
          {session && record && current ? <OutputPage key={record.encounter.id+session.actor.id} language={language} client={session.client} encounter={record.encounter} actor={session.actor} onEncounter={onEncounter} onReviewRow={reviewRow}/> : placeholderOutput}{access}
        </div>}/>
      </Route>
      <Route path="/history" element={<div className="connected-workspace stack">
        <HistoryPage language={language} client={session?.client ?? null} onReviewRow={reviewRow}/>{error}{access}
      </div>}/>
      <Route path="*" element={<Navigate to="/" replace/>}/>
    </Routes></PageContainer></main>
  </>
}
