import { NavLink, Outlet } from 'react-router-dom'
import { messages, type Language } from '../../i18n/messages'

import { stages } from './stages'

export function NewPatientLayout({ language }: { language: Language }) {
  const t = messages[language]
  return (
    <>
      <nav aria-label={t.stages} className="mb-6 grid grid-cols-3 border-b border-line">
        {stages.map((stage, index) => (
          <NavLink key={stage} to={stage} end aria-current="step"
            className="group flex min-h-12 flex-col items-center justify-center gap-1 border-b-2 border-transparent px-1 py-2 text-base text-2 sm:flex-row sm:gap-2 sm:text-lg hover:bg-hover aria-[current=step]:border-accent aria-[current=step]:font-semibold aria-[current=step]:text-accent">
            <span className="grid size-6 shrink-0 place-items-center rounded-full border border-line text-sm font-semibold group-aria-[current=step]:border-accent group-aria-[current=step]:bg-selected">
              {index + 1}
            </span>
            {t[stage]}
          </NavLink>
        ))}
      </nav>
      <Outlet />
    </>
  )
}
