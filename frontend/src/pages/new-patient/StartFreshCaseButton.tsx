import { useRef } from 'react'
import { Button } from '../../components/ui/Button'
import { messages, type Language } from '../../i18n/messages'

type Props = {
  language: Language
  hasWork: boolean
  onStartFresh: () => void
  variant?: 'primary' | 'secondary'
}

export function StartFreshCaseButton({ language, hasWork, onStartFresh, variant = 'secondary' }: Props) {
  const t = messages[language]
  const dialog = useRef<HTMLDialogElement>(null)
  return (
    <>
      <Button variant={variant} onClick={() => {
        if (hasWork) dialog.current?.showModal()
        else onStartFresh()
      }}>{t.freshCase}</Button>
      <dialog ref={dialog} aria-labelledby="discard-case-title" aria-describedby="discard-case-description"
        className="m-auto w-[min(26rem,90vw)] rounded-xl border border-line bg-2 p-6 text-1 shadow-xl backdrop:bg-black/45">
        <h2 id="discard-case-title" className="text-xl font-semibold">{t.discardTitle}</h2>
        <p id="discard-case-description" className="mt-2 text-2">{t.discardDescription}</p>
        <div className="mt-5 flex flex-wrap justify-end gap-2">
          <Button autoFocus onClick={() => dialog.current?.close()}>{t.keepCase}</Button>
          <Button variant="primary" onClick={() => {
            dialog.current?.close()
            onStartFresh()
          }}>{t.discardCase}</Button>
        </div>
      </dialog>
    </>
  )
}
