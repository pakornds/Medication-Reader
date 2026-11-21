import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, Navigate, Route, Routes, useNavigate } from 'react-router-dom'
import { LuArrowRight, LuCamera, LuClipboard, LuDownload, LuPlus, LuScanLine } from 'react-icons/lu'
import { PageContainer } from '../../components/layout/PageContainer'
import { TopBar } from '../../components/layout/TopBar'
import { Button } from '../../components/ui/Button'
import { InputField } from '../../components/ui/InputField'
import { analyze, applyLocatedRegions } from '../../api/reconciliation'
import { createClient } from '../../api/client'
import type { LocalScreeningResult } from '../../api/contracts'
import { intake } from '../../i18n/intake'
import type { Language } from '../../i18n/messages'
import { analysisErrorMessage, analysisProviderMessage } from '../new-patient/analysisError'
import { createDraft, newNote, replacePhoto, type Photo, type PhotoKind } from '../new-patient/draft'
import { FacilityDetails } from '../new-patient/FacilityDetails'
import { NewPatientLayout } from '../new-patient/NewPatientLayout'
import { PhotoSlot } from '../new-patient/PhotoSlot'
import { canShare, exportRows, listName, manualRow, say, scannedRows, scheduleSummary, values, type ListRow } from './listData'
import { ListMedicine, PickProduct } from './ListMedicine'
import './medication-list.css'

const client = createClient()

export default function MedicationListApp() {
  const [language, setLanguage] = useState<Language>(() => {
    try { return localStorage.getItem('medrec.language') === 'th' ? 'th' : 'en' } catch { return 'en' }
  })
  const [draft, setDraft] = useState(createDraft)
  const [rows, setRows] = useState<ListRow[]>([])
  const [selection, setSelection] = useState<string[]>([])
  const [exported, setExported] = useState<ListRow[] | null>(null)
  const [adding, setAdding] = useState(false)
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

  async function readPhotos() {
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

  const hasEvidence = evidence.photos.length > 0 || evidence.notes.some(note => note.text.trim())
  const canScan = hasEvidence && evidence.photos.length <= 16
    && evidence.photos.reduce((sum, photo) => sum + photo.file.size, 0) < 16_000_000
  const hasWork = rows.length > 0 || hasEvidence || adding

  return <>
    <TopBar language={language} onLanguage={setLanguage} showHistory={false} />
    <main className="pt-7"><PageContainer><Routes>
      <Route path="/" element={<section className="med-list intake stack">
        <h1>{t('Read and check a medicine list', 'อ่านและตรวจรายการยา')}</h1>
        <p>{t('Scan labels or add medicines, check the list, then copy it for the hospital system.',
          'สแกนฉลากหรือเพิ่มยา ตรวจรายการ แล้วคัดลอกไปใช้ในระบบโรงพยาบาล')}</p>
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
            <div className="spread"><h2 className="flex items-center gap-2"><LuCamera aria-hidden="true"/>{labels.photos}</h2>
              <Button variant="primary" disabled={!canScan || status === 'scanning'} aria-busy={status === 'scanning'} onClick={() => void readPhotos()}>
                <LuScanLine aria-hidden="true"/>{status === 'scanning' ? labels.analyzing : t('Analyze evidence', 'วิเคราะห์หลักฐาน')}
              </Button>
            </div>
            {!canScan && hasEvidence && <p role="alert">{labels.tooLarge}</p>}
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
            <details><summary>{t('Add note or record', 'เพิ่มคำบอกเล่าหรือเอกสาร')}</summary>
              <div className="stack">{evidence.notes.map(note => {
                function patch(change: Partial<typeof note>) {
                  updateEvidence({ ...evidence, notes: evidence.notes.map(item => item.id === note.id ? { ...item, ...change } : item) })
                }
                return <div key={note.id} className="stack">
                  <label>{note.kind === 'other_record' ? labels.other_record : labels.account}
                    <textarea value={note.text} rows={2} onChange={e => patch({ text: e.target.value })}/>
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
            </details>
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
      <Route path="/history" element={<Navigate to="/new-patient/input" replace/>}/>
      <Route path="*" element={<Navigate to="/" replace/>}/>
    </Routes></PageContainer></main>
  </>
}

function ListChecks({ rows, language }: { rows: ListRow[]; language: Language }) {
  const [result, setResult] = useState<LocalScreeningResult>()
  const [status, setStatus] = useState<'idle' | 'busy' | 'error'>('idle')
  const t = (en: string, th: string) => say(language, en, th)
  async function check() {
    setResult(undefined)
    setStatus('busy')
    try {
      setResult(await client.checkCatalogueList({ rows: rows.map(row => ({
        row_id: row.row.id, tpu: row.match?.product.tpu ?? null, release: row.match?.release ?? null,
      })) }))
      setStatus('idle')
    } catch { setStatus('error') }
  }
  const named = (id: string) => {
    const row = rows.find(item => item.row.id === id)
    return row ? listName(row, language) : id
  }
  return <details className="intake-panel">
    <summary>{t('Check interactions and duplicate ingredients', 'ตรวจยาตีกันและตัวยาซ้ำ')}</summary>
    <div className="stack">
      <p className="hint">{t('Compares catalogue products. Actual use, dose and route are outside this check.',
        'เปรียบเทียบผลิตภัณฑ์ในบัญชียา การตรวจนี้ไม่ประเมินการใช้จริง ขนาดยา หรือทางที่ให้ยา')}</p>
      <Button className="self-start" onClick={() => void check()} disabled={status === 'busy'}>{status === 'busy'
        ? t('Checking…', 'กำลังตรวจ…') : t('Run check', 'เริ่มตรวจ')}</Button>
      {status === 'error' && <p role="alert">{t('The local reference could not be loaded.', 'ไม่สามารถเปิดฐานข้อมูลอ้างอิง')}</p>}
      {result && <div className="stack" role="status">
        {result.rows.filter(row => row.reason).map(row => <p key={row.row_id}>
          {named(row.row_id)} · {t('Unassessed', 'ยังไม่ได้ประเมิน')} · {row.reason}
        </p>)}
        {!result.pairs.length && <p>{t('Add at least two medicines for a comparison.', 'เพิ่มยาอย่างน้อยสองรายการเพื่อเปรียบเทียบ')}</p>}
        {result.pairs.map(pair => <div className="list-check-pair" key={pair.row_ids.join(':')}>
          <strong>{pair.row_ids.map(named).join(' + ')}</strong>
          <p>{t('Interactions', 'อันตรกิริยา')} · {screeningStatus(pair.ddi.status, language)}</p>
          {pair.ddi.interactions?.map(rule => <details key={rule.rule_id}><summary>{rule.relevance} · {rule.rule_id}</summary>
            <p>{[rule.condition, rule.consequence, rule.source_basis].filter(Boolean).join(' · ')}</p>
          </details>)}
          {pair.ddi.status !== 'lookup_complete' && pair.ddi.reasons.map(reason => <small key={reason}>{reason}</small>)}
          <p>{t('Duplicate ingredients', 'ตัวยาซ้ำ')} · {screeningStatus(pair.duplicate.status, language)}</p>
          {pair.duplicate.ingredients?.map(ingredient => <p key={ingredient.subs_id}>{ingredient.name}</p>)}
        </div>)}
      </div>}
    </div>
  </details>
}

function screeningStatus(status: string, language: Language) {
  const translation = {
    potential: ['Potential finding', 'อาจพบปัญหา'],
    partial: ['Partial coverage', 'ตรวจได้บางส่วน'],
    lookup_complete: ['No finding in covered scope', 'ไม่พบในขอบเขตที่ตรวจ'],
    unassessed: ['Unassessed', 'ยังไม่ได้ประเมิน'],
  }[status]
  return translation ? say(language, translation[0], translation[1]) : status
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
