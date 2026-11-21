import { NavLink, Outlet } from 'react-router-dom'
import { messages, type Language } from '../../i18n/messages'

import { stages } from './stages'

export function NewPatientLayout({ language }: { language: Language }) {
  const t = messages[language]
  return (
    <>
      <nav aria-label={t.stages} className="mb-6 flex flex-wrap gap-2 border-b border-line">
        {stages.map(stage => (
          <NavLink key={stage} to={stage} end aria-current="step"
            className="border-b-2 border-transparent px-3 py-2 text-sm text-2 hover:bg-hover aria-[current=step]:border-accent aria-[current=step]:font-semibold aria-[current=step]:text-accent">
            {t[stage]}
          </NavLink>
        ))}
      </nav>
      <Outlet />
    </>
  )
}
