import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { readAnalysisHistory, readImportHistory } from '../../../../src/lib/history/import-history'
import type { Language } from '../../i18n/messages'
import { say } from './listData'

function loadHistory() {
  try {
    return { analyses: readAnalysisHistory(localStorage), imports: readImportHistory(localStorage) }
  } catch {
    return { analyses: null, imports: null }
  }
}

function Times({ timestamps, language }: { timestamps: string[]; language: Language }) {
  const format = new Intl.DateTimeFormat(language === 'th' ? 'th-TH' : 'en-GB', {
    dateStyle: 'medium', timeStyle: 'medium',
  })
  return <ol className="divide-y divide-line">
    {timestamps.map(stamp => <li key={stamp} className="py-3">
      <time dateTime={stamp}>{format.format(new Date(stamp))}</time>
    </li>)}
  </ol>
}

export function ScanHistory({ language }: { language: Language }) {
  const [history, setHistory] = useState(loadHistory)
  const t = (en: string, th: string) => say(language, en, th)
  useEffect(() => {
    const refresh = () => setHistory(loadHistory())
    window.addEventListener('storage', refresh)
    window.addEventListener('medication-analyzed', refresh)
    return () => {
      window.removeEventListener('storage', refresh)
      window.removeEventListener('medication-analyzed', refresh)
    }
  }, [])

  return <div className="med-list intake stack">
    <header className="intake-title">
      <h1>{t('History', 'ประวัติ')}</h1>
      <p>{t('This device keeps timestamps only.', 'อุปกรณ์นี้บันทึกเฉพาะเวลา')}</p>
    </header>
    <section className="intake-panel stack" aria-labelledby="analysis-history">
      <h2 id="analysis-history">{t('Photo and text analysis', 'การวิเคราะห์ภาพและข้อความ')}</h2>
      {history.analyses?.length ? <Times timestamps={history.analyses} language={language} />
        : <p>{history.analyses
          ? t('No completed analyses yet.', 'ยังไม่มีการวิเคราะห์ที่เสร็จแล้ว')
          : t('History is unavailable in this browser.', 'เบราว์เซอร์นี้เปิดประวัติไม่ได้')}</p>}
    </section>
    {Boolean(history.imports?.length) && <section className="intake-panel stack" aria-labelledby="previous-imports">
      <h2 id="previous-imports">{t('Previous demo imports', 'การนำเข้าจากระบบสาธิตเดิม')}</h2>
      <Times timestamps={history.imports ?? []} language={language} />
    </section>}
    <Link to="/new-patient/input" className="primary-btn self-start">
      {t('Back to Input', 'กลับไปป้อนข้อมูล')}
    </Link>
  </div>
}
