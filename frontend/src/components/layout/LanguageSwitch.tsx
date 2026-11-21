import { messages, type Language } from '../../i18n/messages'

type Props = { language: Language; onChange: (value: Language) => void }

export function LanguageSwitch({ language, onChange }: Props) {
  const label = messages[language].language
  return (
    <button type="button" className="preference-button" aria-label={label} title={label}
      onClick={() => onChange(language === 'en' ? 'th' : 'en')}>
      <span className={language === 'th' ? 'font-bold underline' : ''}>TH</span>
      <span className="px-1" aria-hidden="true">/</span>
      <span className={language === 'en' ? 'font-bold underline' : ''}>EN</span>
    </button>
  )
}
