import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { readAnalysisHistory, readImportHistory } from '../../../../src/lib/history/import-history'
import type { Language } from '../../i18n/messages'
import { say } from './listData'
import { readHandoffs } from './handoffHistory'

function loadHistory() {
  try {
    return { analyses: readAnalysisHistory(localStorage), imports: readImportHistory(localStorage), handoffs: readHandoffs() }
  } catch {
    return { analyses: null, imports: null, handoffs: null }
  }
}

function timeFormatter(language: Language) {
  return new Intl.DateTimeFormat(language === 'th' ? 'th-TH' : 'en-GB', {
    dateStyle: 'medium', timeStyle: 'medium',
  })
}

function Times({ timestamps, language }: { timestamps: string[]; language: Language }) {
  const format = timeFormatter(language)
  return <ol className="divide-y divide-line">
    {timestamps.map(stamp => <li key={stamp} className="py-3">
      <time dateTime={stamp}>{format.format(new Date(stamp))}</time>
    </li>)}
  </ol>
}

export function ScanHistory({ language }: { language: Language }) {
  const [history, setHistory] = useState(loadHistory)
  const t = (en: string, th: string) => say(language, en, th)
  const format = timeFormatter(language)
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
      <p>{t('Reviewed medicine lists from this device.', 'รายการยาที่ทบทวนแล้วบนอุปกรณ์นี้')}</p>
    </header>
    <section className="intake-panel stack" aria-labelledby="handoff-history">
      <h2 id="handoff-history">{t('Completed handoffs', 'รายการที่จัดทำเพื่อส่งต่อแล้ว')}</h2>
      {history.handoffs?.length ? <div className="stack">
        {history.handoffs.map(entry => <details className="list-check-pair" key={entry.key}>
          <summary>
            <time dateTime={entry.createdAt}>{format.format(new Date(entry.createdAt))}</time>
            {' · '}{entry.medicines.length} {t(entry.medicines.length === 1 ? 'medicine' : 'medicines', 'รายการยา')}
          </summary>
          <ul className="divide-y divide-line">
            {entry.medicines.map((medicine, index) => <li key={index} className="py-3">
              <strong>{medicine.name}</strong>
              <p>{[
                ...[medicine.strength, medicine.form].filter(value => value && !medicine.name.toLowerCase().includes(value.toLowerCase())),
                medicine.tpu ? 'TPU ' + medicine.tpu : t('Without TMT code', 'ไม่มีรหัส TMT'),
              ].join(' · ')}</p>
              {medicine.schedule[language].map((line, index) => <p key={index}>{line}</p>)}
              {medicine.quantity && <p>{t('Quantity', 'จำนวนที่ระบุ')} · {medicine.quantity}</p>}
            </li>)}
          </ul>
        </details>)}
      </div> : <p>{history.handoffs
        ? t('Prepare a handoff in Review to see it here.', 'จัดทำรายการส่งต่อในหน้าทบทวนเพื่อดูประวัติที่นี่')
        : t('History is unavailable in this browser.', 'เบราว์เซอร์นี้เปิดประวัติไม่ได้')}</p>}
    </section>
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
