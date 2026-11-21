import { regimenText } from '../../i18n/regimen'
import { SectionHeading } from '../../components/ui/SectionHeading'
import { InputField } from '../../components/ui/InputField'
import { Button } from '../../components/ui/Button'
import { useEffect, useRef, useState } from 'react'
import type { Dispatch, SetStateAction } from 'react'
import { Link } from 'react-router-dom'
import {
  LuArrowRight,
  LuClipboardList,
  LuFileText,
  LuTrash2,
  LuListPlus,
  LuPlus,
  LuScanLine,
  LuLoaderCircle,
} from 'react-icons/lu'
import { analyze } from '../../api/reconciliation'
import { intake } from '../../i18n/intake'
import type { Language } from '../../i18n/messages'
import { AnalysisPreview } from './AnalysisPreview'
import { ManualMedicineEntry } from './ManualMedicineEntry'
import { PhotoSlot } from './PhotoSlot'
import {
  newNote,
  replacePhoto,
  rowName,
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
}: {
  draft: Draft
  setDraft: Dispatch<SetStateAction<Draft>>
  language: Language
}) {
  const t = intake[language]
  const [mode, setMode] = useState<'evidence' | 'manual'>('evidence')
  const [addSlot, setAddSlot] = useState(false)
  const [status, setStatus] = useState<'idle' | 'loading' | 'error'>('idle')
  const request = useRef<AbortController | null>(null)
  const previewArea = useRef<HTMLDivElement>(null)
  const { evidence, medicines } = draft
  const hasEvidence = evidence.photos.length > 0 || evidence.notes.some((note) => note.text.trim())
  const missingRegions = evidence.photos.some((p) => p.kind !== 'reverse_photo' && !p.regions.length)
  const tooLarge =
    evidence.photos.length > 16 || evidence.photos.reduce((sum, p) => sum + p.file.size, 0) >= 16_000_000
  useEffect(() => () => request.current?.abort(), [])
  function editEvidence(next: Evidence) {
    request.current?.abort()
    setStatus('idle')
    setDraft((d) => ({ ...d, evidence: next, preview: null }))
  }
  function editPhoto(next: Photo) {
    editEvidence(replacePhoto(evidence, next.id, next))
  }
  function slot(kind: PhotoKind, photo?: Photo) {
    return (
      <PhotoSlot
        key={photo?.id || kind}
        kind={kind}
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
      setDraft((d) => (d.evidence === evidence ? { ...d, preview } : d))
      setStatus('idle')
      requestAnimationFrame(() => previewArea.current?.scrollIntoView({ block: 'start' }))
    } catch {
      if (!controller.signal.aborted) setStatus('error')
    }
  }
  function confirm(ids: string[]) {
    setDraft((d) => {
      if (!d.preview) return d
      const selected = d.preview.rows.filter(
        (r) =>
          ids.includes(r.id) && !d.medicines.some((m) => m.origin === 'manual' && m.row.id === r.id),
      )
      const additions = selected.map((row) => ({
        row,
        evidence: d.evidence,
        origin: 'analysis' as const,
      }))
      const remaining = d.preview.rows.filter((r) => !selected.includes(r))
      return {
        ...d,
        medicines: [
          ...d.medicines.filter((m) => !selected.some((r) => r.id === m.row.id)),
          ...additions,
        ],
        preview:
          remaining.length || d.preview.unassigned_reports?.length
            ? { ...d.preview, rows: remaining }
            : null,
      }
    })
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
    : missingRegions
      ? t.needRegions
      : !hasEvidence
        ? t.analyzeHint
        : ''
  return (
    <div className="intake">
      <div className="intake-title">
        <h1>{t.title}</h1>
        <p>{t.intro}</p>
      </div>
      <div className="intake-grid">
        <div className="stack main-column">
          <section className="intake-panel">
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
                <Button
                  variant="primary"
                  disabled={!!reason || status === 'loading'}
                  aria-busy={status === 'loading'}
                  onClick={() => void runAnalysis()}
                >
                  {status === 'loading' ? (
                    <LuLoaderCircle aria-hidden="true" className="motion-safe:animate-spin" />
                  ) : (
                    <LuScanLine aria-hidden="true" />
                  )}
                  {status === 'loading' ? t.analyzing : t.analyze}
                </Button>
                {reason && <p className="hint">{reason}</p>}
                {status === 'error' && <p role="alert">{t.analyzeFail}</p>}
              </div>
            </div>
            <div hidden={mode !== 'manual'}>
              <ManualMedicineEntry caseId={draft.caseId} rt={regimenText[language]}
                t={t}
                onAdd={(medicine) => setDraft((d) => ({ ...d, medicines: [...d.medicines, medicine] }))}
              />
            </div>
          </section>
          <div ref={previewArea} hidden={mode !== 'evidence'}>
            {draft.preview && <AnalysisPreview draft={draft} language={language} onConfirm={confirm} />}
          </div>
        </div>
        <aside aria-labelledby="draft-heading" className="intake-panel stack">
          <div className="spread">
            <h2 id="draft-heading">{t.draft}</h2>
            <span className="count" aria-live="polite">
              {medicines.length}
            </span>
          </div>
          {medicines.length === 0 ? (
            <div className="empty-case">
              <LuClipboardList aria-hidden="true" />
              <p>{t.emptyHint}</p>
            </div>
          ) : (
            <>
              <ul className="draft-list">
                {medicines.map(({ row }) => {
                  const name = rowName(row, language)
                  const details = [row.label_fields.strength?.value, row.label_fields.form?.value]
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
            </>
          )}
        </aside>
      </div>
    </div>
  )
}
