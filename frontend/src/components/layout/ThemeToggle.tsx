import { Button } from '../ui/Button'
import { useEffect, useState } from 'react'
import { LuMoon, LuSun } from 'react-icons/lu'
import { messages, type Language } from '../../i18n/messages'

type Theme = 'light' | 'dark'

export function ThemeToggle({ language }: { language: Language }) {
  const [theme, setTheme] = useState<Theme>(() => document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light')
  const [followsDevice, setFollowsDevice] = useState(() => !document.documentElement.hasAttribute('data-saved-theme'))

  useEffect(() => {
    document.documentElement.dataset.theme = theme
  }, [theme])

  useEffect(() => {
    if (!followsDevice) return
    const media = matchMedia('(prefers-color-scheme: dark)')
    const sync = () => setTheme(media.matches ? 'dark' : 'light')
    sync()
    media.addEventListener('change', sync)
    return () => media.removeEventListener('change', sync)
  }, [followsDevice])

  function toggle() {
    const next = theme === 'dark' ? 'light' : 'dark'
    setFollowsDevice(false)
    setTheme(next)
    try {
      localStorage.setItem('medrec.theme', next)
      document.documentElement.setAttribute('data-saved-theme', '')
    } catch {
      // The in-memory choice still works when browser storage is unavailable.
    }
  }

  const label = theme === 'dark' ? messages[language].light : messages[language].dark
  return (
    <Button variant="preference" onClick={toggle} aria-label={label} title={label}>
      {theme === 'dark' ? <LuSun aria-hidden="true" /> : <LuMoon aria-hidden="true" />}
    </Button>
  )
}
