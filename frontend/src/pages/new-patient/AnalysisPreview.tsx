import { RegionOutline } from '../../components/ui/RegionOutline'
import { Button } from '../../components/ui/Button'
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { intake, type IntakeText } from '../../i18n/intake'
import type { Language } from '../../i18n/messages'
import { EvidenceImage } from './EvidenceImage'
import {
  hasEarlierEvidence,
  rowName,
  type Draft,
  type Evidence,
  type Fact,
  type Ref,
  type Suggestion,
} from './draft'

function Citation({ reference, evidence, t }: { reference: Ref; evidence: Evidence; t: IntakeText }) {
  const note = evidence.notes.find((n) => n.id === reference.source_id)
  if (note)
    return (
      <details className="citation">
        <summary>{t[note.kind]}</summary>
        <blockquote>{note.text}</blockquote>
        <small>{[note.author, note.date].filter(Boolean).join(' · ')}</small>
      </details>
    )
  const photo = evidence.photos.find(
    (p) => p.id === reference.source_id || p.regions.some((r) => r.id === reference.source_id),
  )
  if (!photo) return null
  const index = photo.regions.findIndex((r) => r.id === reference.item_id)
  const region = photo.regions[index]
  return (
    <details className="citation">
      <summary>
        {t[photo.kind]}
        {region && ' · ' + t.region + ' ' + (index + 1)}
      </summary>
      <div className="region-image">
        <EvidenceImage file={photo.file} />
        {region && <RegionOutline box={region.box} />}
      </div>
      <small>{[photo.file.name, region?.organization, photo.date].filter(Boolean).join(' · ')}</small>
    </details>
  )
}
function QuotedFact({ fact, evidence, t }: { fact: Fact; evidence: Evidence; t: IntakeText }) {
  return (
    <div>
      {fact.value}
      <Citation reference={fact.evidence} evidence={evidence} t={t} />
    </div>
  )
}
export function RowEvidence({
  row,
  evidence,
  t,
}: {
  row: Suggestion
  evidence: Evidence
  t: IntakeText
}) {
  return (
    <div className="row-evidence stack">
      {row.observed_names.map((fact, i) => (
        <QuotedFact key={i} fact={fact} evidence={evidence} t={t} />
      ))}
      {Object.entries(row.label_fields).map(([key, field]) => (
        <div key={key}>
          <strong>{t[key as keyof IntakeText] || key}</strong> ·{' '}
          {field.value || (field.status === 'unreadable' ? t.unreadable : t.missing)}
          {field.evidence && <Citation reference={field.evidence} evidence={evidence} t={t} />}
        </div>
      ))}
      {row.reported_use.length > 0 && (
        <div>
          <strong>{t.reported}</strong>
          {row.reported_use.map((fact, i) => (
            <QuotedFact key={i} fact={fact} evidence={evidence} t={t} />
          ))}
        </div>
      )}
      {row.discrepancies.map((d) => (
        <div key={d.id}>
          <strong>{t.discrepancies}</strong>
          {d.observed_values.map((fact, i) => (
            <QuotedFact key={i} fact={fact} evidence={evidence} t={t} />
          ))}
          <p>{d.question}</p>
        </div>
      ))}
      {row.follow_ups.length > 0 && (
        <div>
          <strong>{t.followup}</strong>
          <ul>
            {row.follow_ups.map((f, i) => (
              <li key={i}>{f.question}</li>
            ))}
          </ul>
        </div>
      )}
      <div>
        <strong>{t.sources}</strong>
        {row.sources.map((ref, i) => (
          <Citation key={i} reference={ref} evidence={evidence} t={t} />
        ))}
      </div>
    </div>
  )
}

export function AnalysisPreview({
  draft,
  language,
  onConfirm,
}: {
  draft: Draft
  language: Language
  onConfirm: (ids: string[]) => void
}) {
  const [selected, setSelected] = useState<string[]>([])
  const t = intake[language]
  const preview = draft.preview
  if (!preview) return null
  return (
    <section className="intake-panel stack">
      <h2>{t.preview}</h2>
      {!preview.rows.length && <p>{t.noRows}</p>}
      {preview.rows.map((row) => {
        const existing = draft.medicines.find((m) => m.row.id === row.id)
        const checked = selected.includes(row.id)
        return (
          <div className="suggestion" key={row.id}>
            <label className="pick-row">
              <input
                type="checkbox"
                disabled={existing?.origin === 'manual'}
                checked={checked}
                onChange={() =>
                  setSelected(checked ? selected.filter((id) => id !== row.id) : [...selected, row.id])
                }
              />
              <strong>{rowName(row, language)}</strong>
            </label>
            {existing && <small>{existing.origin === 'manual' ? t.confirmed : t.update}</small>}
            <RowEvidence row={row} evidence={draft.evidence} t={t} />
          </div>
        )
      })}
      {preview.unassigned_reports?.length > 0 && (
        <div>
          <h3>{t.unassigned}</h3>
          {preview.unassigned_reports.map((fact, i) => (
            <QuotedFact key={i} fact={fact} evidence={draft.evidence} t={t} />
          ))}
        </div>
      )}
      {!!preview.rows.length && (
        <Button
          variant="primary"
          disabled={!selected.length}
          onClick={() => {
            onConfirm(selected)
            setSelected([])
          }}
        >
          {t.confirm}
        </Button>
      )}
    </section>
  )
}

export function DraftReview({ draft, language }: { draft: Draft; language: Language }) {
  const t = intake[language]
  return (
    <div className="intake stack">
      <h1>{language === 'th' ? 'ทบทวน' : 'Review'}</h1>
      {!draft.medicines.length && <p>{t.noMedicines}</p>}
      {draft.medicines.map((medicine) => {
        const { row, evidence, catalogue } = medicine
        return (
          <article className="intake-panel stack" key={row.id}>
            <div className="spread">
              <h2>{rowName(row, language)}</h2>
              <span className="pending-label">{t.pending}</span>
            </div>
            {hasEarlierEvidence(medicine, draft.evidence) && <p role="status">{t.earlier}</p>}
            {catalogue && (
              <small>
                TPU {catalogue.product.tpu} · {catalogue.release}
              </small>
            )}
            <RowEvidence row={row} evidence={evidence} t={t} />
          </article>
        )
      })}
      <Link className="text-action" to="/new-patient/input">
        {t.back}
      </Link>
    </div>
  )
}
