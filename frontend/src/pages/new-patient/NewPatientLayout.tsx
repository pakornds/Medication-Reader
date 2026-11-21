import { useRef } from 'react'
import { NavLink, Outlet } from 'react-router-dom'
import { messages, type Language } from '../../i18n/messages'
import { Button } from '../../components/ui/Button'

import { stages } from './stages'

export function NewPatientLayout({ language, hasWork, onStartFresh }: {
  language: Language
  hasWork: boolean
  onStartFresh: () => void
}) {
  const t = messages[language]
  const dialog = useRef<HTMLDialogElement>(null)
  return (
    <>
      <div className="mb-2 flex justify-end">
        <Button onClick={() => {
          if (hasWork) dialog.current?.showModal()
          else onStartFresh()
        }}>{t.freshCase}</Button>
      </div>
      <dialog ref={dialog} aria-labelledby="discard-case-title" aria-describedby="discard-case-description"
        className="m-auto w-[min(26rem,90vw)] rounded-xl border border-line bg-2 p-6 text-1 shadow-xl backdrop:bg-black/45">
        <h2 id="discard-case-title" className="text-xl font-semibold">{t.discardTitle}</h2>
        <p id="discard-case-description" className="mt-2 text-2">{t.discardDescription}</p>
        <div className="mt-5 flex flex-wrap justify-end gap-2">
          <Button autoFocus onClick={() => dialog.current?.close()}>{t.keepCase}</Button>
          <Button variant="primary" onClick={onStartFresh}>{t.discardCase}</Button>
        </div>
      </dialog>
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
