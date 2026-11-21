import { NavLink } from 'react-router-dom'
import { messages, type Language } from '../../i18n/messages'
import { stages } from '../../pages/new-patient/stages'

export function StageNavigation({ language }: { language: Language }) {
  const t = messages[language]
  return <nav className="stage-navigation" aria-label={t.stages}>
    {stages.map((stage, index) => <NavLink key={stage} to={`/new-patient/${stage}`} end aria-current="step">
      <span aria-hidden="true">{index + 1}</span>
      {t[stage]}
    </NavLink>)}
  </nav>
}
