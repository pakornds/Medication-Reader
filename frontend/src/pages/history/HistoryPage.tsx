import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { LuClock3, LuFileCheck2 } from 'react-icons/lu'
import { readImportHistory } from '../../../../src/lib/history/import-history'
import { ApiError, type createClient } from '../../api/client'
import type { HospitalRecord } from '../../api/contracts'
import { Button } from '../../components/ui/Button'
import type { Language } from '../../i18n/messages'
import { intake } from '../../i18n/intake'
import { regimenText } from '../../i18n/regimen'
import { RegimenReadback } from '../new-patient/RegimenReadback'

const text = {
  en: {
    title: 'History', heading: 'Import history', subtitle: 'Successful import times saved on this device.',
    empty: 'No successful imports yet.', unavailable: 'This browser could not read its import history.',
    open: 'View receipt', close: 'Close receipt', loading: 'Reading the hospital receipt…',
    signIn: 'Sign in as the assigned pharmacist to open the hospital receipt.',
    denied: 'An assigned pharmacist must sign in to open this receipt.',
    missing: 'No matching receipt is available to this account on the current mock hospital.',
    failed: 'The hospital could not be reached.', retry: 'Retry receipt lookup',
    imported: 'Imported medicines', unknown: 'Unidentified medicine', current: 'Current medicine',
    stopped: 'No longer current', uncertain: 'Current use uncertain', verified: 'Verified by', approval: 'Approved by',
    documents: 'Recorded label fields', dose: 'Dose', route: 'Route', frequency: 'Frequency',
    review: 'Go to Review',
  },
  th: {
    title: 'ประวัติ', heading: 'ประวัติการนำเข้า', subtitle: 'เวลานำเข้าสำเร็จที่บันทึกไว้บนอุปกรณ์นี้',
    empty: 'ยังไม่มีประวัติการนำเข้าสำเร็จ', unavailable: 'เบราว์เซอร์นี้อ่านประวัติการนำเข้าไม่ได้',
    open: 'ดูใบรับรายการ', close: 'ปิดใบรับรายการ', loading: 'กำลังอ่านใบรับรายการจากโรงพยาบาล…',
    signIn: 'เข้าสู่ระบบด้วยบัญชีเภสัชกรผู้รับผิดชอบเพื่อเปิดใบรับรายการ',
    denied: 'ต้องเข้าสู่ระบบด้วยบัญชีเภสัชกรผู้รับผิดชอบเพื่อเปิดใบรับรายการ',
    missing: 'ไม่พบใบรับรายการที่บัญชีนี้เข้าถึงได้ในระบบโรงพยาบาลจำลองปัจจุบัน',
    failed: 'เชื่อมต่อระบบโรงพยาบาลไม่ได้', retry: 'ค้นหาใบรับรายการอีกครั้ง',
    imported: 'ยาที่นำเข้า', unknown: 'ยาที่ยังระบุไม่ได้', current: 'ยาที่ใช้อยู่',
    stopped: 'ไม่ได้ใช้แล้ว', uncertain: 'ยังไม่แน่ใจว่าใช้อยู่', verified: 'ยืนยันโดย', approval: 'อนุมัติโดย',
    documents: 'ข้อมูลบนฉลากที่บันทึกไว้', dose: 'ขนาดยา', route: 'ทางที่ให้ยา', frequency: 'ความถี่',
    review: 'ไปหน้าทบทวน',
  },
}

type Client = ReturnType<typeof createClient>
type Readback = { client: Client; stamp: string; records: HospitalRecord[]; error?: 'denied' | 'failed' }

function loadHistory() {
  try { return readImportHistory(window.localStorage) }
  catch { return null }
}

function localTime(stamp: string, language: Language) {
  return new Intl.DateTimeFormat(language === 'th' ? 'th-TH' : 'en-GB', {
    dateStyle: 'medium', timeStyle: 'medium',
  }).format(new Date(stamp))
}

function ReceiptDetails({ client, stamp, language }: { client: Client; stamp: string; language: Language }) {
  const t = text[language]
  const [data, setData] = useState<Readback | null>(null)
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    let active = true
    client.receipts(stamp).then(
      records => { if (active) setData({ client, stamp, records }) },
      (cause: unknown) => {
        if (active) setData({ client, stamp, records: [],
          error: cause instanceof ApiError && (cause.status === 401 || cause.status === 403) ? 'denied' : 'failed' })
      },
    )
    return () => { active = false }
  }, [client, stamp, attempt])

  if (data?.client !== client || data.stamp !== stamp) return <p role="status">{t.loading}</p>
  if (data.error) return <div className="stack">
    <p role="alert">{t[data.error]}</p>
    {data.error === 'failed' && <Button onClick={() => { setData(null); setAttempt(n => n + 1) }}>{t.retry}</Button>}
  </div>
  if (!data.records.length) return <p role="status">{t.missing}</p>
  return <div className="stack">
    {data.records.map(record => <section key={record.snapshot.evidence.case_id}>
      <h3>{t.imported} · {record.receipt.imported_row_ids.length}</h3>
      <ul className="divide-y divide-line">{record.snapshot.rows.map(row => {
        const v = row.verification
        const fields = Object.entries(row.label_fields ?? {})
        const product = v?.normalized_medication_id
        const directions = v?.regimens ?? []
        return <li key={row.id} className="grid gap-2 py-3">
          <strong>{v?.identity?.value || row.observed_names?.[0]?.value || row.unknown_label || t.unknown}</strong>
          {product && <small>TPU {product}{v?.tmt_release ? ' · ' + v.tmt_release : ''}</small>}
          {v && <>
            <p>{v.status === 'current' ? t.current : v.status === 'no_longer_current' ? t.stopped : t.uncertain}</p>
            {directions.length ? directions.map(c => <RegimenReadback key={c.component_id} component={c} t={regimenText[language]} />)
              : <dl className="flex flex-wrap gap-x-5 gap-y-1">
                {([[t.dose, v.dose], [t.route, v.route], [t.frequency, v.frequency]] as const).map(([label, fact]) => fact && <div key={label}>
                  <dt className="text-sm text-2">{label}</dt><dd>{fact.value}</dd></div>)}
              </dl>}
            <small>{t.verified} · {v.reviewer.name} · <time dateTime={v.verified_at}>{localTime(v.verified_at, language)}</time></small>
          </>}
          {row.approval && <small>{t.approval} · {row.approval.pharmacist_id}</small>}
          {fields.length > 0 && <details><summary>{t.documents}</summary>
            <dl className="grid gap-2 pt-2">{fields.map(([key, field]) => field && <div key={key}>
              <dt className="text-sm text-2">{intake[language][key as keyof typeof intake.en] || key}</dt>
              <dd>{field.value || (field.status === 'unreadable' ? intake[language].unreadable : intake[language].missing)}</dd>
            </div>)}</dl>
          </details>}
        </li>
      })}</ul>
    </section>)}
  </div>
}

export function HistoryPage({ language, client }: { language: Language; client: Client | null }) {
  const t = text[language]
  const [timestamps, setTimestamps] = useState(loadHistory)
  const [open, setOpen] = useState<string | null>(null)
  useEffect(() => {
    const refresh = () => setTimestamps(loadHistory())
    window.addEventListener('storage', refresh)
    window.addEventListener('medication-imported', refresh)
    return () => {
      window.removeEventListener('storage', refresh)
      window.removeEventListener('medication-imported', refresh)
    }
  }, [])

  return <div className="intake stack py-4">
    <div className="intake-title"><h1>{t.title}</h1><p>{t.subtitle}</p></div>
    <section aria-label={t.heading} className="intake-panel">
      {!timestamps?.length ? <div className="flex items-center gap-3 py-4">
        <LuClock3 aria-hidden="true" className="text-accent" /><p role="status">{timestamps ? t.empty : t.unavailable}</p>
      </div> : <ol className="divide-y divide-line">
        {timestamps.map(stamp => <li key={stamp} className="grid gap-4 py-3">
          <div className="spread">
            <div className="flex items-center gap-3">
              <LuFileCheck2 aria-hidden="true" className="text-accent" />
              <div><time className="block font-semibold" dateTime={stamp}>{localTime(stamp, language)}</time>
                <small>{stamp}</small></div>
            </div>
            <Button aria-expanded={open === stamp} onClick={() => setOpen(open === stamp ? null : stamp)}>
              {open === stamp ? t.close : t.open}
            </Button>
          </div>
          {open === stamp && (client
            ? <ReceiptDetails key={stamp} client={client} stamp={stamp} language={language} />
            : <div className="stack"><p>{t.signIn}</p><Link className="text-action" to="/new-patient/review">{t.review}</Link></div>)}
        </li>)}
      </ol>}
    </section>
  </div>
}
