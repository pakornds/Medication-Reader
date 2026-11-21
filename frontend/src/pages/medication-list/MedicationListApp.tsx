import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Link, Navigate, Route, Routes, useLocation, useNavigate, useNavigationType } from 'react-router-dom'
import { PageContainer } from '../../components/layout/PageContainer'
import { TopBar } from '../../components/layout/TopBar'
import { Button } from '../../components/ui/Button'
import { InputField } from '../../components/ui/InputField'
import { analyze, applyLocatedRegions } from '../../api/reconciliation'
import { intake } from '../../i18n/intake'
import { regimenText } from '../../i18n/regimen'
import type { Language } from '../../i18n/messages'
import { analysisErrorMessage, analysisProviderMessage } from '../new-patient/analysisError'
import { createDraft, newNote, replacePhoto, type Evidence, type Photo, type PhotoKind } from '../new-patient/draft'
import { FacilityDetails } from '../new-patient/FacilityDetails'
import { ManualMedicineEntry } from '../new-patient/ManualMedicineEntry'
import { createManualEntryDraft, hasManualEntryWork } from '../new-patient/manualEntryDraft'
import { StartFreshCase } from '../new-patient/StartFreshCase'
import { PhotoSlot } from '../new-patient/PhotoSlot'
import { MAX_BATCH_PHOTO_BYTES } from '../new-patient/preparePhoto'
import { canShare, exportRows, listName, manualRow, say, scannedRows, scheduleSummary, values, type ListRow } from './listData'
import { ListMedicine } from './ListMedicine'
import { ListChecks } from './ListChecks'
import { ScanHistory } from './ScanHistory'
import { readHandoffs, saveHandoff } from './handoffHistory'
import { recordAnalysis } from '../../../../src/lib/history/import-history'
import './medication-list.css'

export default function MedicationListApp() {
  const [language, setLanguage] = useState<Language>(() => {
    try { return localStorage.getItem('medrec.language') === 'th' ? 'th' : 'en' } catch { return 'en' }
  })
  const [draft, setDraft] = useState(createDraft)
  const [rows, setRows] = useState<ListRow[]>([])
  const [selection, setSelection] = useState<string[]>([])
  const [exported, setExported] = useState<ListRow[] | null>(null)
  const [historyUnavailable, setHistoryUnavailable] = useState(false)
  const [manualDraft, setManualDraft] = useState(createManualEntryDraft)
  const [inputMode, setInputMode] = useState<'photo' | 'manual' | 'text'>('photo')
  const [extraPhotos, setExtraPhotos] = useState(false)
  const [preparingPhotos, setPreparingPhotos] = useState(0)
  const [status, setStatus] = useState<'idle' | 'scanning'>('idle')
  const [scanError, setScanError] = useState('')
  const scan = useRef<AbortController | null>(null)
  const nav = useNavigate()
  const { pathname } = useLocation()
  const navigation = useNavigationType()
  const t = (en: string, th: string) => say(language, en, th)
  const labels = intake[language]
  const { evidence } = draft
  const picked = rows.filter(row => canShare(row) && selection.includes(row.row.id))
  const pending = rows.filter(row => !canShare(row))
  useEffect(() => {
    document.documentElement.lang = language
    document.title = 'MedRec TH'
    try { localStorage.setItem('medrec.language', language) } catch { /* Preference is optional. */ }
  }, [language])
  useEffect(() => () => scan.current?.abort(), [])
  useLayoutEffect(() => {
    if (navigation !== 'POP') window.scrollTo(0, 0)
  }, [navigation, pathname])

  function reset() {
    scan.current?.abort()
    setDraft(createDraft())
    setRows([])
    setSelection([])
    setExported(null)
    setManualDraft(createManualEntryDraft())
    setInputMode('photo')
    setExtraPhotos(false)
    setScanError('')
    setStatus('idle')
    nav('/new-patient/input')
  }

  const updateEvidence = useCallback((next: Evidence | ((previous: Evidence) => Evidence)) => {
    scan.current?.abort()
    setStatus('idle')
    setScanError('')
    setDraft(current => ({
      ...current, evidence: typeof next === 'function' ? next(current.evidence) : next, preview: null,
    }))
  }, [])

  function photoSlot(kind: PhotoKind, photo?: Photo) {
    return <PhotoSlot key={photo?.id ?? kind} kind={kind} photo={photo} photos={evidence.photos} t={labels}
      onPreparingChange={preparing => setPreparingPhotos(count => count + (preparing ? 1 : -1))}
      onReplace={next => {
        updateEvidence(current => replacePhoto(current, photo?.id, next))
        if (kind === 'additional_photo' && !photo) setExtraPhotos(false)
      }}
      onEdit={next => updateEvidence(current => replacePhoto(current, next.id, next))}/>
  }

  async function analyzeEvidence() {
    scan.current?.abort()
    const controller = new AbortController()
    scan.current = controller
    setStatus('scanning')
    setScanError('')
    try {
      const preview = await analyze(draft, controller.signal)
      const located = applyLocatedRegions(evidence, preview)
      const found = await scannedRows(preview, located, controller.signal)
      if (controller.signal.aborted) return
      setDraft(current => ({ ...current, evidence: located, preview }))
      if (found.length) {
        try {
          if (recordAnalysis(localStorage, new Date()) === 'saved') window.dispatchEvent(new Event('medication-analyzed'))
        } catch { /* A browser storage setting must not interrupt analysis. */ }
      }
      setRows(current => {
        const byId = new Map(found.map(row => [row.row.id, row]))
        const retained = current.map(row => {
          const next = byId.get(row.row.id)
          byId.delete(row.row.id)
          if (!next) return row
          const keepAsWritten = !row.match && row.manualName !== undefined
          const chosenMatch = row.suggested ? undefined : row.match
          return {
            ...next,
            edit: row.edit,
            manualName: row.manualName,
            manualStrength: row.manualStrength,
            manualForm: row.manualForm,
            match: keepAsWritten ? undefined : chosenMatch ?? next.match,
            suggested: !keepAsWritten && !chosenMatch && next.suggested,
          }
        })
        return [...retained, ...byId.values()]
      })
      setSelection(current => current.filter(id => !found.some(row => row.row.id === id)))
      setExported(null)
    } catch (error) {
      if (!controller.signal.aborted) setScanError(analysisErrorMessage(error, language))
    } finally {
      if (!controller.signal.aborted) setStatus('idle')
    }
  }

  function changeRow(next: ListRow) {
    setRows(current => current.map(row => row.row.id === next.row.id ? next : row))
    if (!canShare(next)) setSelection(current => current.filter(id => id !== next.row.id))
    setExported(null)
  }

  function removeRow(id: string) {
    setRows(current => current.filter(row => row.row.id !== id))
    setSelection(current => current.filter(value => value !== id))
    setExported(null)
  }

  function select(ids: string[]) {
    setSelection(ids)
    setExported(null)
  }

  function approve() {
    if (!picked.length || status === 'scanning') return
    setHistoryUnavailable(!saveHandoff(picked, language))
    setExported(picked)
    nav('/new-patient/output')
  }

  const hasPhotos = evidence.photos.length > 0
  const hasText = evidence.notes.some(note => note.text.trim())
  const hasEvidence = hasPhotos || hasText
  const tooLarge = evidence.photos.length > 16
    || evidence.photos.reduce((sum, photo) => sum + photo.file.size, 0) > MAX_BATCH_PHOTO_BYTES
  const canScan = hasEvidence && !tooLarge && !preparingPhotos
  const hasWork = rows.length > 0 || hasEvidence || hasManualEntryWork(manualDraft)
  const handoffs = pathname === '/' ? readHandoffs() : []
  const latest = handoffs?.[0]
  const modes = [
    { mode: 'photo', label: t('Upload photos', 'อัปโหลดภาพ'), count: evidence.photos.length,
      detail: t('Labels on bags, boxes or blister packs', 'ฉลากบนถุง กล่อง หรือแผงยา') },
    { mode: 'manual', label: labels.manual, count: 0,
      detail: t('Search the Thai medicine catalogue', 'ค้นหาในบัญชียาไทย') },
    { mode: 'text', label: t('Paste text', 'วางข้อความ'), count: evidence.notes.filter(note => note.text.trim()).length,
      detail: t('A medicine list or transfer note', 'รายการยาหรือบันทึกส่งต่อ') },
  ] as const

  return <>
    <TopBar language={language} onLanguage={setLanguage} listWorkspace />
    <main className="med-workspace"><PageContainer><Routes key={draft.caseId}>
      <Route path="/" element={<section className="med-list intake list-home">
        <header className="list-page-heading spread">
          <h1>{t('Medication reconciliation', 'การทบทวนรายการยา')}</h1>
          {hasWork && <Link className="primary-btn" to="/new-patient/input">
            {t('Return to your draft', 'กลับไปที่ฉบับร่าง')}
          </Link>}
        </header>
        <div className="list-home-columns">
          <section aria-labelledby="home-intake">
            <h2 id="home-intake">{t('Start from', 'เริ่มจาก')}</h2>
            <nav className="list-home-methods" aria-labelledby="home-intake">
              {modes.map(({ mode, label, detail }) => <Link key={mode} to="/new-patient/input"
                aria-labelledby={`home-label-${mode}`} aria-describedby={`home-description-${mode}`}
                onClick={() => setInputMode(mode)}>
                <span id={`home-label-${mode}`}>{label}</span>
                <small id={`home-description-${mode}`}>{detail}</small>
              </Link>)}
            </nav>
          </section>
          <section className="list-home-history" aria-labelledby="home-handoff">
            <h2 id="home-handoff">{t('Latest handoff', 'รายการส่งต่อล่าสุด')}</h2>
            {latest ? <>
              <time dateTime={latest.createdAt}>{new Intl.DateTimeFormat(language === 'th' ? 'th-TH' : 'en-GB', {
                dateStyle: 'medium', timeStyle: 'short',
              }).format(new Date(latest.createdAt))}</time>
              <p>{latest.medicines.length} {t(latest.medicines.length === 1 ? 'medicine' : 'medicines', 'รายการยา')}</p>
              <Link className="text-action" to="/history">{t('Open history', 'เปิดประวัติ')}</Link>
            </> : <p>{handoffs === null
              ? t('History is unavailable in this browser.', 'เบราว์เซอร์นี้เปิดประวัติไม่ได้')
              : t('No completed handoffs on this device.', 'ยังไม่มีรายการส่งต่อที่เสร็จแล้วบนอุปกรณ์นี้')}</p>}
          </section>
        </div>
      </section>}/>
      <Route path="/new-patient">
        <Route index element={<Navigate to="input" replace/>}/>
        <Route path="input" element={<div className="med-list intake stack list-input-page">
          <header className="list-page-heading spread">
            <h1>{t('Add medicines', 'เพิ่มรายการยา')}</h1>
            <StartFreshCase language={language} hasWork={hasWork} onStartFresh={reset}/>
          </header>
          <div className="list-input-workspace">
            <section className="intake-panel stack list-input-source" aria-label={t('Add medicines', 'เพิ่มรายการยา')}>
              <div className="input-modes list-input-modes" role="group" aria-label={t('Input method', 'วิธีป้อนข้อมูล')}>
                {modes.map(({ mode, label, count }) => <button key={mode} type="button"
                  aria-pressed={inputMode === mode} aria-controls={`${mode}-input`} onClick={() => setInputMode(mode)}>
                  {label}{count > 0 && <small>({count})</small>}
                </button>)}
              </div>
              <div id="photo-input" hidden={inputMode !== 'photo'}><div className="stack">
              {!evidence.photos.length && <p className="hint">{t('Put all packages in one photo with labels facing up.', 'ถ่ายยาทั้งหมดในภาพเดียวโดยหันฉลากขึ้น')}</p>}
              {evidence.photos.some(photo => photo.kind === 'label_photo') && rows.length > 0
                ? <details><summary>{t('View or replace label photo', 'ดูหรือเปลี่ยนภาพฉลาก')}</summary>
                    {photoSlot('label_photo', evidence.photos.find(photo => photo.kind === 'label_photo'))}
                  </details>
                : photoSlot('label_photo', evidence.photos.find(photo => photo.kind === 'label_photo'))}
              <details><summary>{t('Add reverse photo', 'เพิ่มภาพด้านหลัง')}</summary>
                {photoSlot('reverse_photo', evidence.photos.find(photo => photo.kind === 'reverse_photo'))}</details>
              {evidence.photos.filter(photo => photo.kind === 'additional_photo').map(photo => photoSlot(photo.kind, photo))}
              {extraPhotos ? photoSlot('additional_photo') : <Button variant="text" className="self-start" onClick={() => setExtraPhotos(true)}>{labels.addPhoto}</Button>}
              </div></div>
              <div id="manual-input" hidden={inputMode !== 'manual'}>
                <ManualMedicineEntry t={labels} rt={regimenText[language]} caseId={draft.caseId} handoff
                  draft={manualDraft} setDraft={setManualDraft}
                  onAdd={(medicine, statements) => {
                    setRows(current => [...current, manualRow(medicine, statements)])
                    setExported(null)
                  }}/>
              </div>
              <div id="text-input" hidden={inputMode !== 'text'}>
                <div className="stack">{[...evidence.notes].sort((left, right) => Number(right.kind === 'other_record') - Number(left.kind === 'other_record')).map(note => {
                  function patch(change: Partial<typeof note>) {
                    updateEvidence({ ...evidence, notes: evidence.notes.map(item => item.id === note.id ? { ...item, ...change } : item) })
                  }
                  return <div key={note.id} className="stack">
                    <label>{note.kind === 'other_record' ? t('Medication list or record', 'รายการยาหรือเอกสาร') : labels.account}
                      <textarea value={note.text} rows={note.kind === 'other_record' ? 4 : 2}
                        placeholder={note.kind === 'other_record' ? t('Paste medication names and directions here.', 'วางชื่อยาและวิธีใช้ที่นี่') : labels.reportHint} onChange={e => patch({ text: e.target.value })}/>
                    </label>
                    {note.kind === 'other_record' && <details><summary>{t('Source details', 'รายละเอียดแหล่งข้อมูล')}</summary>
                      <div className="field-pair">
                        <InputField label={labels.organization} value={note.author} onChange={e => patch({ author: e.target.value })}/>
                        <InputField label={labels.date} type="date" value={note.date} onChange={e => patch({ date: e.target.value })}/>
                      </div>
                      <FacilityDetails value={note.facilityContact} t={labels} onChange={facilityContact => patch({ facilityContact })}/>
                    </details>}
                  </div>
                })}
                  <Button variant="text" className="self-start" onClick={() => updateEvidence({
                    ...evidence, notes: [...evidence.notes, newNote('other_record')],
                  })}>{t('Add another record', 'เพิ่มเอกสารอื่น')}</Button>
                </div>
              </div>
              {inputMode !== 'manual' && <div className="actions">
                <Button variant="primary" disabled={!canScan || status === 'scanning'} aria-busy={status === 'scanning'} onClick={() => void analyzeEvidence()}>
                  {status === 'scanning' ? labels.analyzing : t('Analyze evidence', 'วิเคราะห์หลักฐาน')}
                </Button>
                {hasPhotos && hasText && <small>{t('Includes photos and text', 'รวมภาพและข้อความ')}</small>}
              </div>}
              {tooLarge && <p role="alert">{labels.tooLarge}</p>}
              {scanError && <p role="alert">{scanError}</p>}
              {draft.preview?.photo_issues?.map(issue => <p role="status" key={[issue.attachment_id, issue.item_id, issue.code].join(':')}>
                {labels[issue.code]} {issue.provider_code && analysisProviderMessage(issue.provider_code, language)}
              </p>)}
              {draft.preview?.unassigned_reports.map((fact, index) => <p key={index}>
                <strong>{t('Note without a matched medicine', 'คำบอกเล่าที่ยังไม่ตรงกับรายการยา')}</strong> · {fact.value}
              </p>)}
            </section>
            <section aria-labelledby="draft-list-heading" className="list-draft med-list-rows">
              <header className="list-section-heading">
                <div>
                  <h2 id="draft-list-heading">{t('Draft medicine list', 'ฉบับร่างรายการยา')}</h2>
                  <small>{rows.length} {t(rows.length === 1 ? 'medicine' : 'medicines', 'รายการยา')}</small>
                </div>
                {rows.length > 0 && <Link to="/new-patient/review" className="primary-btn">
                  {t('Continue to Review', 'ไปที่ทบทวน')}
                </Link>}
              </header>
              {rows.length > 0 ? <>
                <div className="list-medicine-columns" aria-hidden="true">
                  <span>{t('Medicine', 'ยา')}</span>
                  <span>{t('Directions', 'วิธีใช้')}</span>
                </div>
                {rows.map(row => <ListMedicine key={row.row.id} row={row} language={language} onChange={changeRow} onRemove={() => removeRow(row.row.id)}/>)}
                <div className="list-draft-footer">
                  <small>{t('Kept in this tab until you close or reload it', 'เก็บไว้ในแท็บนี้จนกว่าจะปิดหรือโหลดใหม่')}</small>
                </div>
              </> : <div className="list-empty">
                <p>{t('No medicines added yet.', 'ยังไม่มีรายการยา')}</p>
              </div>}
            </section>
          </div>
        </div>}/>
        <Route path="review" element={<div className="med-list intake stack">
          <header className="list-page-heading"><h1>{t('Review medicines', 'ทบทวนรายการยา')}</h1></header>
          {!rows.length ? <Link to="/new-patient/input" className="primary-btn self-start">{t('Add medicines', 'เพิ่มรายการยา')}</Link> : <>
            <div className="spread list-selection-bar">
              <p role="status">{picked.length} {t('selected', 'รายการที่เลือก')}{pending.length > 0 && (' · ' + pending.length + ' ' + t('need a medicine name', 'รายการที่ต้องระบุชื่อยา'))}</p>
              <div className="actions">
                <Button disabled={!rows.some(canShare)} onClick={() => select(rows.filter(canShare).map(row => row.row.id))}>{t('Select all ready', 'เลือกทุกรายการที่พร้อม')}</Button>
                <Button variant="text" disabled={!picked.length} onClick={() => select([])}>{t('Clear selection', 'ล้างรายการที่เลือก')}</Button>
              </div>
            </div>
            <section className="med-list-rows">
              <div className="list-medicine-columns list-medicine-columns--review" aria-hidden="true">
                <span />
                <span>{t('Medicine', 'ยา')}</span>
                <span>{t('Directions', 'วิธีใช้')}</span>
              </div>
              {rows.map(row => <ListMedicine key={row.row.id} row={row} language={language} onChange={changeRow}
                selected={selection.includes(row.row.id)} onSelect={() => select(selection.includes(row.row.id)
                  ? selection.filter(id => id !== row.row.id) : [...selection, row.row.id])}/>)}
            </section>
            <ListChecks key={rows.map(row => [row.row.id, row.match?.product.tpu, row.match?.release].join(':')).join('|')}
              rows={rows} language={language}/>
            <div className="spread list-stage-actions">
              <Link className="text-action" to="/new-patient/input">{t('Back to Input', 'กลับไปป้อนข้อมูล')}</Link>
              <Button variant="primary" disabled={!picked.length || status === 'scanning'} onClick={approve}>
                {t('Prepare handoff', 'จัดทำรายการส่งต่อ')}
              </Button>
            </div>
          </>}
        </div>}/>
        <Route path="output" element={exported ? <Handoff rows={exported} remaining={rows.length - exported.length} historyUnavailable={historyUnavailable}
          language={language} onReset={() => {
            if (rows.length === exported.length || window.confirm(t('Clear this list, including rows still in Review?', 'ล้างรายการทั้งหมด รวมถึงรายการที่ยังอยู่ในหน้าทบทวนหรือไม่'))) reset()
          }}/> : <div className="med-list intake stack">
          <h1>{t('Handoff', 'รายการส่งต่อ')}</h1>
          <Link className="primary-btn self-start" to="/new-patient/review">{t('Review medicines', 'ทบทวนรายการยา')}</Link>
        </div>}/>
      </Route>
      <Route path="/history" element={<ScanHistory language={language}/>}/>
      <Route path="*" element={<Navigate to="/" replace/>}/>
    </Routes></PageContainer></main>
  </>
}

function spreadsheetCell(value: string) {
  const clean = value.replace(/[\t\r\n]+/g, ' ')
  return /^[=+@-]/.test(clean.trimStart()) ? "'" + clean : clean
}

function Handoff({ rows, remaining, language, onReset, historyUnavailable }: {
  rows: ListRow[]; remaining: number; language: Language; onReset: () => void; historyUnavailable: boolean
}) {
  const t = (en: string, th: string) => say(language, en, th)
  const [copy, setCopy] = useState<'idle' | 'done' | 'error'>('idle')
  const columns = rows.map(row => {
    const edit = values(row)
    const name = listName(row, language)
    const presentation = [row.match?.product.strength ?? row.manualStrength ?? row.row.label_fields.strength?.value,
      row.match?.product.dose_form ?? row.manualForm ?? row.row.label_fields.form?.value]
      .filter(value => value && !name.toLowerCase().includes(value.toLowerCase()))
    return [[name, ...presentation].join(' · '), row.match?.product.tpu ?? '',
      edit.schedules.map(schedule => scheduleSummary(schedule, language)).filter(Boolean).join(' / '),
      edit.wording, edit.quantity, edit.basis === 'reported' ? t('Patient report', 'ผู้ป่วยบอก')
        : row.evidence.photos.length || row.evidence.notes.some(note => note.text.trim())
          ? t('Documented', 'ตามเอกสาร') : t('Manual entry', 'กรอกเอง'),
      (edit.facility ?? row.facility)?.organization ?? '']
  })
  const clipboard = [columns[0] && [
    t('Medicine', 'ยา'), 'TPU', t('Schedule', 'วิธีใช้'), t('Original or edited wording', 'ข้อความต้นฉบับหรือที่แก้ไข'),
    t('Quantity', 'จำนวน'), t('Directions source', 'แหล่งข้อมูลวิธีใช้'), t('Organization', 'สถานพยาบาล'),
  ], ...columns].filter(Boolean).map(line => line.map(value => spreadsheetCell(value)).join('\t')).join('\n')
  async function copyList() {
    try { await navigator.clipboard.writeText(clipboard); setCopy('done') } catch { setCopy('error') }
  }
  function download() {
    const url = URL.createObjectURL(new Blob([JSON.stringify({ medicines: exportRows(rows) }, null, 2)], { type: 'application/json' }))
    const link = document.createElement('a')
    link.href = url
    link.download = 'medication-list.json'
    link.click()
    window.setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
  return <div className="med-list intake stack">
    <header className="list-page-heading"><h1>{rows.length} {t('medicines ready to hand off', 'รายการพร้อมส่งต่อ')}</h1>
      <p>{t('Copy the list for entry into the hospital system.', 'คัดลอกรายการเพื่อนำไปกรอกในระบบโรงพยาบาล')}</p>
    </header>
    <div className="actions list-handoff-actions">
      <Button variant="primary" onClick={() => void copyList()}>{t('Copy medicine list', 'คัดลอกรายการยา')}</Button>
      <Button onClick={download}>{t('Download JSON', 'ดาวน์โหลด JSON')}</Button>
    </div>
    {historyUnavailable && <p role="status">{t('This browser could not save a history entry.', 'เบราว์เซอร์บันทึกประวัติไม่ได้')}</p>}
    {copy === 'done' && <p role="status">{t('Copied', 'คัดลอกแล้ว')}</p>}
    {copy === 'error' && <label>{t('Select and copy the list', 'เลือกและคัดลอกรายการ')}
      <textarea rows={6} readOnly value={clipboard} onFocus={e => e.target.select()}/></label>}
    <section className="med-list-rows">
      {columns.map(([name, code, schedule, wording, quantity, source, organization], i) => <article className="list-medicine" key={rows[i].row.id}>
        <h3>{name}</h3>
        <p>{[schedule, quantity].filter(Boolean).join(' · ')}</p>
        {wording && <p className="hint">{wording}</p>}
        <small>{[code ? 'TPU ' + code : t('Without TMT code', 'ไม่มีรหัส TMT'), source, organization].filter(Boolean).join(' · ')}</small>
      </article>)}
    </section>
    {remaining > 0 && <p>{remaining} {t('rows remain in Review', 'รายการยังอยู่ในหน้าทบทวน')}</p>}
    <div className="spread list-stage-actions">
      <Link className="text-action" to="/new-patient/review">{t('Back to Review', 'กลับไปทบทวน')}</Link>
      <Button onClick={onReset}>{t('Start next list', 'เริ่มรายการใหม่')}</Button>
    </div>
  </div>
}
