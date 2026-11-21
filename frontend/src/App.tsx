import { useEffect, useState } from 'react'
import { Navigate, Route, Routes, useMatch, useNavigate } from 'react-router-dom'
import { HomePage } from './pages/home/HomePage'
import { NewPatientLayout } from './pages/new-patient/NewPatientLayout'
import { InputPage } from './pages/new-patient/InputPage'
import { DraftReview } from './pages/new-patient/AnalysisPreview'
import { createDraft, hasCaseWork } from './pages/new-patient/draft'
import { stages } from './pages/new-patient/stages'
import { PageContainer } from './components/layout/PageContainer'
import { TopBar } from './components/layout/TopBar'
import { messages, type Language } from './i18n/messages'

function MockPage({ name }: { name: string }) {
  useEffect(() => {
    document.title = name + ' · MedRec TH'
  }, [name])

  return <h1 className="text-2xl font-bold">{name}</h1>
}

export default function App() {
  const [language, setLanguage] = useState<Language>(() => {
    try {
      return localStorage.getItem('medrec.language') === 'th' ? 'th' : 'en'
    } catch {
      return 'en'
    }
  })
  const [draft, setDraft] = useState(createDraft)
  const navigate = useNavigate()
  const [lastStage, setLastStage] = useState('input')
  const stage = useMatch('/new-patient/:stage')?.params.stage
  const t = messages[language]

  useEffect(() => {
    if (stage === 'input' || stage === 'review') document.title = t[stage] + ' · MedRec TH'
  }, [stage, t])

  if (stage && stage !== lastStage && stages.some(item => item === stage)) {
    setLastStage(stage)
  }

  useEffect(() => {
    document.documentElement.lang = language
  }, [language])

  function changeLanguage(next: Language) {
    setLanguage(next)
    try {
      localStorage.setItem('medrec.language', next)
    } catch {
      // The switch still works for this session when storage is unavailable.
    }
  }

  function startFreshCase() {
    setDraft(createDraft())
    setLastStage('input')
    navigate('/new-patient/input', { replace: true })
  }

  return (
    <>
      <TopBar language={language} onLanguage={changeLanguage} />
      <main className="pt-7">
        <PageContainer>
          <Routes>
            <Route path="/" element={<HomePage language={language} />} />
            <Route path="/new-patient" element={
              <NewPatientLayout key={draft.caseId} language={language} hasWork={hasCaseWork(draft)} onStartFresh={startFreshCase} />
            }>
              <Route index element={<Navigate to={lastStage} replace />} />
              <Route path="input" element={<InputPage draft={draft} setDraft={setDraft} language={language} />} />
              <Route path="review" element={<DraftReview draft={draft} language={language} />} />
              <Route path="output" element={<MockPage name={t.output} />} />
            </Route>
            <Route path="/history" element={<MockPage name={t.history} />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </PageContainer>
      </main>
    </>
  )
}
