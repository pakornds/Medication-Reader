import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, Navigate, Route, Routes, useNavigate } from 'react-router-dom'
import { LuArrowRight, LuCamera, LuClipboard, LuDownload, LuFileText, LuPlus, LuScanLine } from 'react-icons/lu'
import { PageContainer } from '../../components/layout/PageContainer'
import { TopBar } from '../../components/layout/TopBar'
import { Button } from '../../components/ui/Button'
import { InputField } from '../../components/ui/InputField'
import { analyze, applyLocatedRegions } from '../../api/reconciliation'
import { intake } from '../../i18n/intake'
import type { Language } from '../../i18n/messages'
import { analysisErrorMessage, analysisProviderMessage } from '../new-patient/analysisError'
import { createDraft, newNote, replacePhoto, type Photo, type PhotoKind } from '../new-patient/draft'
import { FacilityDetails } from '../new-patient/FacilityDetails'
import { NewPatientLayout } from '../new-patient/NewPatientLayout'
import { PhotoSlot } from '../new-patient/PhotoSlot'
import { canShare, exportRows, listName, manualRow, say, scannedRows, scheduleSummary, values, type ListRow } from './listData'
import { ListMedicine, PickProduct } from './ListMedicine'
import { ListChecks } from './ListChecks'
import { ScanHistory } from './ScanHistory'
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
  const [adding, setAdding] = useState(false)
  const [inputMode, setInputMode] = useState<'photo' | 'text'>('photo')
  const [extraPhotos, setExtraPhotos] = useState(false)
  const [status, setStatus] = useState<'idle' | 'scanning'>('idle')
  const [scanError, setScanError] = useState('')
  const scan = useRef<AbortController | null>(null)
  const nav = useNavigate()
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

  function reset() {
    scan.current?.abort()
    setDraft(createDraft())
    setRows([])
    setSelection([])
    setExported(null)
    setAdding(false)
    setInputMode('photo')
    setExtraPhotos(false)
    setScanError('')
    setStatus('idle')
    nav('/new-patient/input')
  }

  const updateEvidence = useCallback((next: typeof evidence) => {
    scan.current?.abort()
    setStatus('idle')
    setScanError('')
    setDraft(current => ({ ...current, evidence: next, preview: null }))
  }, [])

  function photoSlot(kind: PhotoKind, photo?: Photo) {
    return <PhotoSlot key={photo?.id ?? kind} kind={kind} photo={photo} photos={evidence.photos} t={labels}
      onReplace={next => {
        updateEvidence(replacePhoto(evidence, photo?.id, next))
        if (kind === 'additional_photo' && !photo) setExtraPhotos(false)
      }}
      onEdit={next => updateEvidence(replacePhoto(evidence, next.id, next))}/>
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
          return {
            ...next,
            edit: row.edit,
            manualName: row.manualName,
            match: row.match && !row.suggested ? row.match : next.match,
            suggested: row.match && !row.suggested ? false : next.suggested,
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
    setExported(picked)
    nav('/new-patient/output')
  }

  const hasPhotos = evidence.photos.length > 0
  const hasText = evidence.notes.some(note => note.text.trim())
  const hasEvidence = hasPhotos || hasText
  const canScan = hasEvidence && evidence.photos.length <= 16
    && evidence.photos.reduce((sum, photo) => sum + photo.file.size, 0) < 16_000_000
  const hasWork = rows.length > 0 || hasEvidence || adding

  return <>
    <TopBar language={language} onLanguage={setLanguage} listWorkspace />
    <main className="pt-7"><PageContainer><Routes>
      <Route path="/" element={<section className="med-list intake stack">
        <h1>{t('Read and check a medicine list', 'อ่านและตรวจรายการยา')}</h1>
        <p>{t('Scan labels, paste a list or add medicines by name. Check the list and copy it for the hospital system.',
          'สแกนฉลาก วางข้อความ หรือเพิ่มยาตามชื่อ ตรวจรายการแล้วคัดลอกไปใช้ในระบบโรงพยาบาล')}</p>
        <Link className="primary-btn self-start" to="/new-patient/input">{t('Open medication list', 'เปิดรายการยา')}</Link>
      </section>}/>
      <Route path="/new-patient" element={<NewPatientLayout key={draft.caseId} language={language} hasWork={hasWork} onStartFresh={reset}/>}>
        <Route index element={<Navigate to="input" replace/>}/>
        <Route path="input" element={<div className="med-list intake stack">
          <header className="spread"><h1>{t('Add medicines', 'เพิ่มรายการยา')}</h1>
            <Button onClick={() => setAdding(value => !value)} aria-expanded={adding}><LuPlus aria-hidden="true"/>{t('Add medicine', 'เพิ่มยาเอง')}</Button>
          </header>
          {adding && <section className="intake-panel stack">
            <PickProduct language={language} onPick={match => {
              setRows(current => [...current, manualRow(match)])
              setExported(null)
              setAdding(false)
            }}/>
            <Button variant="text" className="self-start" onClick={() => {
              const row: ListRow = {
                alternatives: [], evidence: { photos: [], notes: [], question: '' },
                row: { id: crypto.randomUUID(), identity_status: 'named', observed_names: [], sources: [],
                  label_fields: {}, reported_use: [], discrepancies: [], follow_ups: [] },
              }
              setRows(current => [...current, row])
              setExported(null)
              setAdding(false)
            }}>{t('Add a row without a catalogue match', 'เพิ่มรายการที่ไม่พบในบัญชียา')}</Button>
          </section>}
          <section className="intake-panel stack">
            <div className="input-modes list-input-modes" role="group" aria-label={t('Input method', 'วิธีป้อนข้อมูล')}>
              <button type="button" aria-pressed={inputMode === 'photo'} aria-controls="photo-input" onClick={() => setInputMode('photo')}>
                <LuCamera aria-hidden="true"/>{t('Upload photos', 'อัปโหลดภาพ')}{hasPhotos && <span className="count">{evidence.photos.length}</span>}
              </button>
              <button type="button" aria-pressed={inputMode === 'text'} aria-controls="text-input" onClick={() => setInputMode('text')}>
                <LuFileText aria-hidden="true"/>{t('Paste text', 'วางข้อความ')}{hasText && <span className="count">{evidence.notes.filter(note => note.text.trim()).length}</span>}
              </button>
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
            <div className="actions">
              <Button variant="primary" disabled={!canScan || status === 'scanning'} aria-busy={status === 'scanning'} onClick={() => void analyzeEvidence()}>
                <LuScanLine aria-hidden="true"/>{status === 'scanning' ? labels.analyzing : t('Analyze evidence', 'วิเคราะห์หลักฐาน')}
              </Button>
              {hasPhotos && hasText && <small>{t('Includes photos and text', 'รวมภาพและข้อความ')}</small>}
            </div>
            {!canScan && hasEvidence && <p role="alert">{labels.tooLarge}</p>}
            {scanError && <p role="alert">{scanError}</p>}
            {draft.preview?.photo_issues?.map(issue => <p role="status" key={[issue.attachment_id, issue.item_id, issue.code].join(':')}>
              {labels[issue.code]} {issue.provider_code && analysisProviderMessage(issue.provider_code, language)}
            </p>)}
            {draft.preview?.unassigned_reports.map((fact, index) => <p key={index}>
              <strong>{t('Note without a matched medicine', 'คำบอกเล่าที่ยังไม่ตรงกับรายการยา')}</strong> · {fact.value}
            </p>)}
          </section>
          {rows.length > 0 && <section className="med-list-rows">
            <header className="spread"><h2>{t('Medicines', 'รายการยา')} · {rows.length}</h2>
              <small>{t('Kept in this tab until you close or reload it', 'เก็บไว้ในแท็บนี้จนกว่าจะปิดหรือโหลดใหม่')}</small>
            </header>
            {rows.map(row => <ListMedicine key={row.row.id} row={row} language={language} onChange={changeRow} onRemove={() => removeRow(row.row.id)}/>)}
          </section>}
          {rows.length > 0 && <Link to="/new-patient/review" className="primary-btn self-end">
            {t('Continue to Review', 'ไปที่ทบทวน')} <LuArrowRight aria-hidden="true"/>
          </Link>}
        </div>}/>
        <Route path="review" element={<div className="med-list intake stack">
          <h1>{t('Review medicines', 'ทบทวนรายการยา')}</h1>
          {!rows.length ? <Link to="/new-patient/input" className="primary-btn self-start">{t('Add medicines', 'เพิ่มรายการยา')}</Link> : <>
            <div className="spread">
              <div className="actions">
                <Button disabled={!rows.some(canShare)} onClick={() => select(rows.filter(canShare).map(row => row.row.id))}>{t('Select all ready', 'เลือกทุกรายการที่พร้อม')}</Button>
                <Button variant="text" disabled={!picked.length} onClick={() => select([])}>{t('Clear selection', 'ล้างรายการที่เลือก')}</Button>
              </div>
              <p role="status">{picked.length} {t('selected', 'รายการที่เลือก')}{pending.length > 0 && (' · ' + pending.length + ' ' + t('need a match', 'รายการยังไม่ได้จับคู่'))}</p>
            </div>
            <section className="med-list-rows">
              {rows.map(row => <ListMedicine key={row.row.id} row={row} language={language} onChange={changeRow}
                selected={selection.includes(row.row.id)} onSelect={() => select(selection.includes(row.row.id)
                  ? selection.filter(id => id !== row.row.id) : [...selection, row.row.id])}/>)}
            </section>
            <ListChecks key={rows.map(row => [row.row.id, row.match?.product.tpu, row.match?.release].join(':')).join('|')}
              rows={rows} language={language}/>
            <div className="spread">
              <Link className="text-action" to="/new-patient/input">{t('Back to Input', 'กลับไปป้อนข้อมูล')}</Link>
              <Button variant="primary" disabled={!picked.length || status === 'scanning'} onClick={approve}>{t('Prepare handoff', 'จัดทำรายการส่งต่อ')}</Button>
            </div>
          </>}
        </div>}/>
        <Route path="output" element={exported ? <Handoff rows={exported} remaining={rows.length - exported.length}
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

function Handoff({ rows, remaining, language, onReset }: {
  rows: ListRow[]; remaining: number; language: Language; onReset: () => void
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
      edit.wording, edit.quantity, edit.basis === 'reported' ? t('Patient report', 'ผู้ป่วยบอก') : t('Documented', 'ตามเอกสาร'),
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
    <header><h1>{rows.length} {t('medicines ready to hand off', 'รายการพร้อมส่งต่อ')}</h1>
      <p>{t('Copy the list for entry into the hospital system.', 'คัดลอกรายการเพื่อนำไปกรอกในระบบโรงพยาบาล')}</p>
    </header>
    <div className="actions">
      <Button variant="primary" onClick={() => void copyList()}><LuClipboard aria-hidden="true"/>{t('Copy medicine list', 'คัดลอกรายการยา')}</Button>
      <Button onClick={download}><LuDownload aria-hidden="true"/>{t('Download JSON', 'ดาวน์โหลด JSON')}</Button>
    </div>
    {copy === 'done' && <p role="status">{t('Copied', 'คัดลอกแล้ว')}</p>}
    {copy === 'error' && <label>{t('Select and copy the list', 'เลือกและคัดลอกรายการ')}
      <textarea rows={6} readOnly value={clipboard} onFocus={e => e.target.select()}/></label>}
    <section className="med-list-rows">
      {columns.map(([name, code, schedule, wording, quantity, source, organization], i) => <article className="list-medicine" key={rows[i].row.id}>
        <h3>{name}</h3>
        <p>{[schedule, quantity].filter(Boolean).join(' · ')}</p>
        {wording && <p className="hint">{wording}</p>}
        <small>{[code && 'TPU ' + code, source, organization].filter(Boolean).join(' · ')}</small>
      </article>)}
    </section>
    {remaining > 0 && <p>{remaining} {t('rows remain in Review', 'รายการยังอยู่ในหน้าทบทวน')}</p>}
    <div className="spread">
      <Link className="text-action" to="/new-patient/review">{t('Back to Review', 'กลับไปทบทวน')}</Link>
      <Button onClick={onReset}>{t('Start next list', 'เริ่มรายการใหม่')}</Button>
    </div>
  </div>
}
