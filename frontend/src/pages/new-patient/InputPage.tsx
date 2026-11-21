import { scanActions } from './scanActions'
import { FacilityDetails } from './FacilityDetails'
import type { RegionBounds } from '../../api/contracts'
import { regimenText } from '../../i18n/regimen'
import { SectionHeading } from '../../components/ui/SectionHeading'
import { InputField } from '../../components/ui/InputField'
import { Button } from '../../components/ui/Button'
import { useEffect, useRef, useState } from 'react'
import type { Dispatch, SetStateAction } from 'react'
import { Link } from 'react-router-dom'
import {
  LuArrowRight,
  LuFileText,
  LuTrash2,
  LuListPlus,
  LuPlus,
  LuScanLine,
  LuLoaderCircle,
} from 'react-icons/lu'
import { analyze, applyLocatedRegions } from '../../api/reconciliation'
import { analysisErrorMessage, analysisProviderMessage } from './analysisError'
import { intake } from '../../i18n/intake'
import type { Language } from '../../i18n/messages'
import { AnalysisPreview } from './AnalysisPreview'
import { ManualMedicineEntry } from './ManualMedicineEntry'
import type { ManualEntryDraft } from './manualEntryDraft'
import { LabelTranscription } from './LabelTranscription'
import { PhotoSlot } from './PhotoSlot'
import {
  newNote,
  draftValues,
  medicineName,
  replacePhoto,
  updateDraftEvidence,
  type Draft,
  type Evidence,
  type Note,
  type Photo,
  type PhotoKind,
} from './draft'

export function InputPage({
  draft,
  setDraft,
  language,
  proposePhoto,
  manualEntry,
  setManualEntry,
}: {
  draft: Draft
  setDraft: Dispatch<SetStateAction<Draft>>
  language: Language
  manualEntry: ManualEntryDraft
  setManualEntry: Dispatch<SetStateAction<ManualEntryDraft>>
  proposePhoto?: (photo:Photo)=>Promise<RegionBounds[]>
}) {
  const t = intake[language]
  const [mode, setMode] = useState<'evidence' | 'manual'>('evidence')
  const [editingSources, setEditingSources] = useState(false)
  const [addSlot, setAddSlot] = useState(false)
  const [status, setStatus] = useState<'idle' | 'loading' | 'error'>('idle')
  const [failure, setFailure] = useState<unknown>(null)
  const request = useRef<AbortController | null>(null)
  const previewArea = useRef<HTMLDivElement>(null)
  const { evidence, medicines } = draft
  const hasSuggestions = Boolean(draft.preview?.rows.length) && mode === 'evidence'
  const hasEvidence = evidence.photos.length > 0 || evidence.notes.some((note) => note.text.trim())
  const tooLarge =
    evidence.photos.length > 16 || evidence.photos.reduce((sum, p) => sum + p.file.size, 0) >= 16_000_000
  useEffect(() => () => request.current?.abort(), [])
  function editEvidence(next: Evidence) {
    request.current?.abort()
    setStatus('idle')
    setDraft(d => updateDraftEvidence(d, next))
  }
  function editPhoto(next: Photo) {
    editEvidence(replacePhoto(evidence, next.id, next))
  }
  function slot(kind: PhotoKind, photo?: Photo) {
    return (
      <PhotoSlot
        key={photo?.id || kind}
        kind={kind}
        proposePhoto={proposePhoto}
        photo={photo}
        photos={evidence.photos}
        t={t}
        onEdit={editPhoto}
        onReplace={(next) => {
          if (photo || next) editEvidence(replacePhoto(evidence, photo?.id, next))
          if (kind === 'additional_photo' && !photo) setAddSlot(false)
        }}
      />
    )
  }
  function patchNote(id: string, patch: Partial<Note>) {
    editEvidence({
      ...evidence,
      notes: evidence.notes.map((n) => (n.id === id ? { ...n, ...patch } : n)),
    })
  }
  const firstReport = evidence.notes.find((note) => note.kind !== 'other_record')
  const firstRecord = evidence.notes.find((note) => note.kind === 'other_record')
  function removeNote(note: Note) {
    const notes = evidence.notes.filter((entry) => entry.id !== note.id)
    const sameType = (entry: Note) => (entry.kind === 'other_record') === (note.kind === 'other_record')
    if (!notes.some(sameType)) {
      const empty = newNote(note.kind === 'other_record' ? 'other_record' : 'patient_report')
      notes.splice(evidence.notes.indexOf(note), 0, empty)
    }
    editEvidence({ ...evidence, notes })
  }
  async function runAnalysis() {
    request.current?.abort()
    const controller = new AbortController()
    request.current = controller
    setStatus('loading')
    setDraft((d) => ({ ...d, preview: null }))
    try {
      const preview = await analyze(draft, controller.signal)
      if (controller.signal.aborted) return
      setDraft((d) => (d.caseId === draft.caseId && d.evidence === evidence
        ? { ...d, evidence: applyLocatedRegions(evidence, preview), preview } : d))
      setStatus('idle')
      setEditingSources(false)
      requestAnimationFrame(() => previewArea.current?.focus({ preventScroll: false }))
    } catch (error) {
      if (!controller.signal.aborted) { setFailure(error); setStatus('error') }
    }
  }
  function removeMedicine(id: string) {
    setDraft((current) => ({
      ...current,
      medicines: current.medicines.filter((medicine) => medicine.row.id !== id),
    }))
  }
  const tabs = [
    { key: 'evidence', icon: LuFileText },
    { key: 'manual', icon: LuListPlus },
  ] as const
  const reason = tooLarge
    ? t.tooLarge
    : !hasEvidence ? t.analyzeHint : ''
  const analysisAction = <div className="stack">
    <Button variant="primary" disabled={!!reason || status === 'loading'} aria-busy={status === 'loading'} onClick={() => void runAnalysis()}>
      {status === 'loading' ? <LuLoaderCircle aria-hidden="true" className="motion-safe:animate-spin" /> : <LuScanLine aria-hidden="true" />}
      {status === 'loading' ? t.analyzing : t.analyze}
    </Button>
    {reason && <p className="hint">{reason}</p>}
    {status === 'error' && <p role="alert">{analysisErrorMessage(failure,language)}</p>}
  </div>
  return (
    <div className="intake">
      <div className="intake-title">
        <h1>{t.title}</h1>
        {!hasSuggestions && <p>{t.intro}</p>}
      </div>
      <div className={medicines.length ? "intake-grid" : "intake-grid intake-single"}>
        <div className="stack main-column">
          <div ref={previewArea} tabIndex={-1} hidden={mode !== 'evidence' || !draft.preview}>
            {draft.preview?.photo_issues?.map(issue => {
              const photo = evidence.photos.find(p => p.id === issue.attachment_id)
              if (!photo) return null
              const index = photo.regions.findIndex(r => r.id === issue.item_id)
              return <p role="status" key={photo.id + (issue.item_id || '') + issue.code}>
                <strong>{t[photo.kind]} · {photo.file.name}{index >= 0 ? ' · ' + t.region + ' ' + (index+1) : ''}</strong>
                {' · '}{t[issue.code]}
                {issue.provider_code && <span> {analysisProviderMessage(issue.provider_code,language)}</span>}
              </p>
            })}
            {draft.preview?.unassessed_question && <p role="status"><strong>{language === 'th' ? 'คำถามที่รอเจ้าหน้าที่ทบทวน' : 'Question for staff review'}</strong> · {draft.evidence.question}</p>}
            {draft.preview?.remaining_evidence_unassessed && <p role="status">{t.remainingUnassessed}</p>}
            {draft.preview && (
              <AnalysisPreview draft={draft} language={language} {...scanActions(setDraft)} />
            )}
          </div>
          {hasSuggestions && <button type="button" className="text-action edit-scan-inputs"
            aria-expanded={editingSources} aria-controls="intake-entry" onClick={() => setEditingSources(value => !value)}>
            {editingSources ? t.hideInputs : t.editInputs}
          </button>}
          <section id="intake-entry" className="intake-panel" hidden={hasSuggestions && !editingSources}>
            <div className="input-modes" role="group" aria-label={t.mode}>
              {tabs.map(({ key, icon: Icon }) => (
                <button aria-pressed={mode === key} key={key} onClick={() => setMode(key)}>
                  <Icon aria-hidden="true" />
                  {t[key]}
                </button>
              ))}
            </div>
            <div hidden={mode !== 'evidence'}>
              <div className="stack">
                <section aria-labelledby="photo-heading" className="stack">
                  <SectionHeading id="photo-heading" title={t.photos} description={t.flip} />
                  <div className="photo-pair">
                    {slot(
                      'label_photo',
                      evidence.photos.find((p) => p.kind === 'label_photo'),
                    )}
                    {slot(
                      'reverse_photo',
                      evidence.photos.find((p) => p.kind === 'reverse_photo'),
                    )}
                  </div>
                  <LabelTranscription draft={draft} language={language}
                    key={evidence.photos.map(p=>p.id + p.regions.map(r=>[r.id,r.rowId,r.box.x,r.box.y,r.box.w,r.box.h].join('.')).join(',')).join('|')}
                    onUse={row=>setDraft(current=>{
                      if(current.caseId!==draft.caseId || current.evidence!==evidence || current.medicines.some(m=>m.row.id===row.id)) return current
                      return {...current, medicines:[...current.medicines,{row,evidence,origin:'analysis'}]}
                    })}/>
                  {evidence.photos
                    .filter((p) => p.kind === 'additional_photo')
                    .map((p) => slot(p.kind, p))}
                  {addSlot && slot('additional_photo')}
                  {!addSlot && evidence.photos.length < 16 && (
                    <Button variant="text" onClick={() => setAddSlot(true)}>
                      <LuPlus />
                      {t.addPhoto}
                    </Button>
                  )}
                  {evidence.photos.length > 0 && analysisAction}
                </section>
                <section aria-labelledby="notes-heading" className="written-evidence stack">
                  <SectionHeading id="notes-heading" title={t.notesHeading} description={t.notesHelp} />
                  {evidence.notes.map((note) => (
                    <section className="note-block stack" key={note.id} id={note.id} tabIndex={-1}>
                      <div className="spread">
                        <label htmlFor={'text-' + note.id}>
                          {note.kind === 'other_record' ? t.other_record : t.account}
                        </label>
                        {(note.text ||
                          note.author ||
                          note.date ||
                          note !== (note.kind === 'other_record' ? firstRecord : firstReport)) && (
                          <Button
                            variant="text"
                            aria-label={t.remove + ' ' + t[note.kind]}
                            onClick={() => removeNote(note)}
                          >
                            <LuTrash2 aria-hidden="true" />
                            {t.remove}
                          </Button>
                        )}
                      </div>
                      <textarea
                        id={'text-' + note.id}
                        value={note.text}
                        placeholder={note.kind === 'other_record' ? t.noteHint : t.reportHint}
                        onChange={(e) => patchNote(note.id, { text: e.target.value })}
                      />
                      <details>
                        <summary>{t.details}</summary>
                        <div className="field-pair">
                          {note.kind !== 'other_record' && (
                            <label>
                              {t.role}
                              <select
                                value={note.kind}
                                onChange={(e) =>
                                  patchNote(note.id, { kind: e.target.value as Note['kind'] })
                                }
                              >
                                <option value="patient_report">{t.patient_report}</option>
                                <option value="caregiver_report">{t.caregiver_report}</option>
                              </select>
                            </label>
                          )}
                          <InputField
                            label={note.kind === 'other_record' ? t.organization : t.author}
                            value={note.author}
                            onChange={(e) => patchNote(note.id, { author: e.target.value })}
                          />
                          <InputField
                            label={t.date}
                            type="date"
                            value={note.date}
                            onChange={(e) => patchNote(note.id, { date: e.target.value })}
                          />
                        </div>
                        {note.kind==='other_record' && <FacilityDetails t={t} value={note.facilityContact} onChange={facilityContact=>patchNote(note.id,{facilityContact})}/>}
                      </details>
                    </section>
                  ))}
                  <div className="actions">
                    {(['patient_report', 'other_record'] as const).map((kind) => (
                      <Button
                        variant="text"
                        key={kind}
                        onClick={() =>
                          editEvidence({ ...evidence, notes: [...evidence.notes, newNote(kind)] })
                        }
                      >
                        <LuPlus />
                        {kind === 'other_record' ? t.anotherNote : t.anotherReport}
                      </Button>
                    ))}
                  </div>
                </section>
                <details className="agent-question">
                  <summary>
                    {t.question} · {t.optional}
                  </summary>
                  <textarea
                    aria-label={t.question}
                    rows={2}
                    value={evidence.question}
                    placeholder={t.questionHint}
                    onChange={(e) => editEvidence({ ...evidence, question: e.target.value })}
                  />
                </details>
                {!evidence.photos.length && analysisAction}
              </div>
            </div>
            <div hidden={mode !== 'manual'}>
              <ManualMedicineEntry caseId={draft.caseId} rt={regimenText[language]}
                t={t}
                draft={manualEntry}
                setDraft={setManualEntry}
                onAdd={(medicine) => setDraft((d) => ({ ...d, medicines: [...d.medicines, medicine] }))}
              />
            </div>
          </section>

        </div>
        {medicines.length > 0 && <aside aria-labelledby="draft-heading" className="intake-panel stack">
          <div className="spread">
            <h2 id="draft-heading">{t.draft}</h2>
            <span className="count" aria-live="polite">
              {medicines.length}
            </span>
          </div>
              <ul className="draft-list">
                {medicines.map((medicine) => {
                  const { row } = medicine
                  const values = draftValues(medicine)
                  const name = medicineName(medicine, language)
                  const details = [values.strength, values.form]
                    .filter(Boolean)
                    .join(' · ')
                  return (
                    <li className="draft-line" key={row.id}>
                      <div>
                        <strong>{name}</strong>
                        {details && <small>{details}</small>}
                      </div>
                      <Button
                        variant="text"

                        aria-label={t.remove + ' ' + name}
                        onClick={() => removeMedicine(row.id)}
                      >
                        <LuTrash2 aria-hidden="true" />
                        {t.remove}
                      </Button>
                    </li>
                  )
                })}
              </ul>
              <Link className="primary-btn" to="/new-patient/review">
                {t.review}
                <LuArrowRight aria-hidden="true" />
              </Link>
        </aside>}
      </div>
    </div>
  )
}
