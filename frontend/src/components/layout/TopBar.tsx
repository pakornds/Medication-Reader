import { LuFolderOpen, LuPill, LuPlus } from 'react-icons/lu'
import { messages, type Language } from '../../i18n/messages'
import { LanguageSwitch } from './LanguageSwitch'
import { ThemeToggle } from './ThemeToggle'
import { TopBarLink } from './TopBarLink'

type Props = {
  canResume: boolean
  language: Language
  onLanguage: (value: Language) => void
}

export function TopBar({ language, onLanguage, canResume }: Props) {
  const t = messages[language]

  return (
    <header className="border-b border-line bg-2">
      <div className="flex min-h-[4.1875rem] flex-wrap items-center gap-x-6 gap-y-2 px-4 py-2 sm:px-5 xl:px-8">
        <span className="flex items-center gap-2.5 font-bold">
          <span className="grid size-8 place-items-center rounded-lg bg-brand text-white">
            <LuPill aria-hidden="true" className="size-4 rotate-45" />
          </span>
          MedRec TH
        </span>
        <nav aria-label={t.navigation} className="order-last flex w-full flex-wrap gap-1 sm:order-none sm:w-auto">
          <TopBarLink to="/">{t.home}</TopBarLink>
          <TopBarLink to="/new-patient">
            {canResume ? <LuFolderOpen aria-hidden="true" /> : <LuPlus aria-hidden="true" />}
            {canResume ? t.resumeCase : t.patient}
          </TopBarLink>
          <TopBarLink to="/history">{t.history}</TopBarLink>
        </nav>
        <div className="ml-auto flex gap-2">
          <LanguageSwitch language={language} onChange={onLanguage} />
          <ThemeToggle language={language} />
        </div>
      </div>
    </header>
  )
}
