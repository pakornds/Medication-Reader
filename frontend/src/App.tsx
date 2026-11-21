import { useEffect, useState } from 'react'
import { Navigate, Route, Routes, useMatch } from 'react-router-dom'
import { NewPatientLayout } from './pages/new-patient/NewPatientLayout'
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
  const [lastStage, setLastStage] = useState('input')
  const stage = useMatch('/new-patient/:stage')?.params.stage
  const t = messages[language]

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

  return (
    <>
      <TopBar language={language} onLanguage={changeLanguage} />
      <main className="pt-7">
        <PageContainer>
          <Routes>
            <Route path="/" element={<MockPage name={t.home} />} />
            <Route path="/new-patient" element={<NewPatientLayout language={language} />}>
              <Route index element={<Navigate to={lastStage} replace />} />
              {stages.map(item => (
                <Route key={item} path={item} element={<MockPage name={t[item]} />} />
              ))}
            </Route>
            <Route path="/history" element={<MockPage name={t.history} />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </PageContainer>
      </main>
    </>
  )
}
