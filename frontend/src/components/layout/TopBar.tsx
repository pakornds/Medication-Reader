import { NavLink, useMatch } from 'react-router-dom'
import { messages, type Language } from '../../i18n/messages'
import { LanguageSwitch } from './LanguageSwitch'
import { ThemeToggle } from './ThemeToggle'
import { TopBarLink } from './TopBarLink'
import { StageNavigation } from './StageNavigation'
import { PageContainer } from './PageContainer'

type Props = {
  listWorkspace?: boolean
  language: Language
  onLanguage: (value: Language) => void
}

export function TopBar({ language, onLanguage, listWorkspace = false }: Props) {
  const t = messages[language]
  const activeWorkspace = useMatch('/new-patient/*')
  const activeHistory = useMatch('/history')
  const showStages = listWorkspace && Boolean(activeWorkspace)

  return (
    <header className={listWorkspace ? 'workspace-header workspace-header--list' : 'workspace-header'}>
      <PageContainer>
        <div className="workspace-header-inner">
          <NavLink className="workspace-brand" to="/" end title={t.home}>
            MedRec TH
          </NavLink>
          {showStages && <StageNavigation language={language}/>}
          <nav aria-label={t.navigation} className="workspace-navigation">
            {(!listWorkspace || activeHistory) && <TopBarLink to="/new-patient">
              {listWorkspace ? (language === 'th' ? 'รายการยา' : 'Medicine list') : t.patient}
            </TopBarLink>}
            {(!listWorkspace || !activeHistory) && <TopBarLink to="/history">{t.history}</TopBarLink>}
          </nav>
          <div className="workspace-preferences">
            <LanguageSwitch language={language} onChange={onLanguage} />
            <ThemeToggle language={language} />
          </div>
        </div>
      </PageContainer>
    </header>
  )
}
