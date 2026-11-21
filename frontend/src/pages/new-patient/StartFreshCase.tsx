import { useId, useRef } from 'react'
import { messages, type Language } from '../../i18n/messages'
import { Button } from '../../components/ui/Button'

export function StartFreshCase({ language, hasWork, onStartFresh }: {
  language: Language
  hasWork: boolean
  onStartFresh: () => void
}) {
  const t = messages[language]
  const dialog = useRef<HTMLDialogElement>(null)
  const id = useId()
  return <>
    <Button variant="text" className="workspace-reset" onClick={() => {
      if (hasWork) dialog.current?.showModal()
      else onStartFresh()
    }}>{t.freshCase}</Button>
    <dialog ref={dialog} aria-labelledby={id} aria-describedby={id + '-description'}
      className="m-auto w-[min(26rem,90vw)] rounded-sm border border-line bg-2 p-6 text-1 shadow-xl backdrop:bg-black/45">
      <h2 id={id} className="text-xl font-semibold">{t.discardTitle}</h2>
      <p id={id + '-description'} className="mt-2 text-2">{t.discardDescription}</p>
      <div className="mt-5 flex flex-wrap justify-end gap-2">
        <Button autoFocus onClick={() => dialog.current?.close()}>{t.keepCase}</Button>
        <Button variant="primary" onClick={() => {
          dialog.current?.close()
          onStartFresh()
        }}>{t.discardCase}</Button>
      </div>
    </dialog>
  </>
}
