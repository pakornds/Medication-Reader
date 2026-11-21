import { LuHistory, LuList, LuPill, LuPlus } from 'react-icons/lu'
import { NavLink } from 'react-router-dom'
import { messages, type Language } from '../../i18n/messages'
import { LanguageSwitch } from './LanguageSwitch'
import { ThemeToggle } from './ThemeToggle'
import { TopBarLink } from './TopBarLink'

type Props = {
  listWorkspace?: boolean
  language: Language
  onLanguage: (value: Language) => void
}

export function TopBar({ language, onLanguage, listWorkspace = false }: Props) {
  const t = messages[language]

  return (
    <header className="workspace-header">
      <div className="workspace-header-inner">
        <NavLink className="workspace-brand" to="/" end title={t.home}>
          <span className="workspace-mark">
            <LuPill aria-hidden="true" />
          </span>
          MedRec TH
        </NavLink>
        <nav aria-label={t.navigation} className="workspace-navigation">
          <TopBarLink to="/new-patient">
            {listWorkspace ? <LuList aria-hidden="true" /> : <LuPlus aria-hidden="true" />}
            {listWorkspace ? (language === 'th' ? 'รายการยา' : 'Medication list') : t.patient}
          </TopBarLink>
          <TopBarLink to="/history"><LuHistory aria-hidden="true" />{t.history}</TopBarLink>
        </nav>
        <div className="workspace-preferences">
          <LanguageSwitch language={language} onChange={onLanguage} />
          <ThemeToggle language={language} />
        </div>
      </div>
    </header>
  )
}
