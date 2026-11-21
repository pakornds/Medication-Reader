import { Outlet } from 'react-router-dom'
import type { Language } from '../../i18n/messages'
import { StageNavigation } from '../../components/layout/StageNavigation'
import { StartFreshCase } from './StartFreshCase'

export function NewPatientLayout({ language, hasWork, onStartFresh }: {
  language: Language
  hasWork: boolean
  onStartFresh: () => void
}) {
  return (
    <>
      <div className="workspace-stages">
        <StageNavigation language={language}/>
        <StartFreshCase language={language} hasWork={hasWork} onStartFresh={onStartFresh}/>
      </div>
      <Outlet />
    </>
  )
}
