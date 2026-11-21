import { Button } from '../../components/ui/Button'
import { InputField } from '../../components/ui/InputField'
import { useState } from 'react'
import { Link } from 'react-router-dom'
import type { RegimenComponent } from '../../api/contracts'
import { intake, type IntakeText } from '../../i18n/intake'
import type { Language } from '../../i18n/messages'
import { EvidenceCrop, EvidenceImage } from './EvidenceImage'
import {
  draftValues,
  hasEarlierEvidence,
  knownOrder,
  medicineName,
  photoCitation,
  rowName,
  scanEvidence,
  type Draft,
  type DraftValues,
  type Evidence,
  type Fact,
  type Medicine,
  type MedicineEvidence,
  type Preview,
  type Ref,
  type RegimenField,
} from './draft'

function Citation({ reference, evidence, t }: { reference: Ref; evidence: Evidence; t: IntakeText }) {
  const [open, setOpen] = useState(false)
  const note = evidence.notes.find((n) => n.id === reference.source_id)
  if (note)
    return (
      <details className="citation">
        <summary>{t[note.kind]}</summary>
        <blockquote>{note.text}</blockquote>
        <small>{[note.author, note.date].filter(Boolean).join(' · ')}</small>
      </details>
    )
  const resolved = photoCitation(evidence, reference)
  if (!resolved) return null
  const { photo, region } = resolved
  const label = [t[photo.kind], region && `${t.region} ${photo.regions.indexOf(region) + 1}`]
    .filter(Boolean).join(' · ')
  return (
    <details className="citation" onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>{label}</summary>
      {open && (
        <div className="region-image citation-image">
          {region
            ? <EvidenceCrop file={photo.file} region={region} label={label} unavailable={t.cropUnavailable} />
            : <EvidenceImage file={photo.file} />}
        </div>
      )}
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

const regimenFields: RegimenField[] = [
  'dose_amount', 'dose_unit', 'schedule_type', 'frequency_count', 'period_value',
  'period_unit', 'time_of_day', 'route', 'meal_relation', 'as_needed',
]

function StructuredDirections({ component, evidence, t }: { component: RegimenComponent; evidence: Evidence; t: IntakeText }) {
  return (
    <details className="citation">
      <summary>{component.basis === 'reported' ? t.reportedDirections : t.structuredDirections}</summary>
      <blockquote>{component.directions_text}</blockquote>
      {component.evidence.directions_text && (
        <Citation reference={component.evidence.directions_text} evidence={evidence} t={t} />
      )}
      <dl>
        {regimenFields.map((field) => {
          const reference = component.evidence[field]
          const value = component[field]
          if (!reference || value == null || (Array.isArray(value) && !value.length)) return null
          return (
            <div key={field}>
              <dt><strong>{t[field]}</strong></dt>
              <dd>
                {typeof value === 'boolean' ? (value ? t.yes : t.no) : String(value)}
                <Citation reference={reference} evidence={evidence} t={t} />
              </dd>
            </div>
          )
        })}
      </dl>
    </details>
  )
}
export function RowEvidence({
  row,
  evidence,
  facility,
  scan = true,
  t,
}: MedicineEvidence & {
  t: IntakeText
  scan?: boolean
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
      {row.regimens?.map((component) => (
        <StructuredDirections key={component.component_id} component={component} evidence={evidence} t={t} />
      ))}
      {scan && (
        <div>
          <strong>{t.dispensingSource}</strong>
          {facility ? (
            <>
              <p>{[facility.organization, facility.department_or_ward, facility.organization_address].filter(Boolean).join(' · ')}</p>
              {facility.organization_phone && (
                <p>{[facility.organization_phone, facility.organization_phone_extension].filter(Boolean).join(' · ')}</p>
              )}
              {facility.organization_email && <p>{facility.organization_email}</p>}
              <Citation reference={facility.evidence} evidence={evidence} t={t} />
            </>
          ) : <p>{t.missing}</p>}
        </div>
      )}
      {row.reverse_crop && (
        <div>
          <strong>{t.matchedReverse}</strong>
          <Citation reference={row.reverse_crop} evidence={evidence} t={t} />
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
  onDismiss,
}: {
  draft: Draft
  language: Language
  onConfirm: (preview: Preview, placements: ReadonlyMap<string, string | null>) => void
  onDismiss: (preview: Preview, id: string) => void
}) {
  const [selected, setSelected] = useState<string[]>([])
  const [targets, setTargets] = useState<Map<string, string>>(new Map())
  const t = intake[language]
  const preview = draft.preview
  if (!preview) return null
  const selectedCount = preview.rows.filter((row) => selected.includes(row.id)).length
  const placements = new Map<string, string | null>()
  for (const row of preview.rows) {
    if (!selected.includes(row.id)) continue
    const target = targets.get(row.id)
    const existing = knownOrder(draft.medicines, row.id)
    if (target && draft.medicines.some((medicine) => medicine.row.id === target)
      && (!existing || existing.row.id === target)) {
      placements.set(row.id, target)
    } else if (!target && !existing) {
      placements.set(row.id, null)
    }
  }
  return (
    <section className="intake-panel stack">
      <h2>{t.preview}</h2>
      {!preview.rows.length && <p>{t.noRows}</p>}
      {preview.rows.map((row) => {
        const existing = knownOrder(draft.medicines, row.id)
        const checked = selected.includes(row.id)
        const heading = rowName(row, language)
        const orders = existing ? [existing] : draft.medicines
        return (
          <div className="suggestion stack" key={row.id}>
            <div className="spread">
              <label className="pick-row">
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() => setSelected((current) => checked
                    ? current.filter((id) => id !== row.id) : [...current, row.id])}
                />
                <strong>{heading}</strong>
              </label>
              <Button variant="text" onClick={() => onDismiss(preview, row.id)}>{t.dismissSuggestion}</Button>
            </div>
            <label>
              {t.draftOrderFor} {heading}
              <select
                value={targets.get(row.id) ?? ''}
                onChange={(event) => {
                  const target = event.target.value
                  setTargets((current) => new Map(current).set(row.id, target))
                }}
              >
                <option value="">{existing ? t.chooseOrder : t.addNewOrder}</option>
                {orders.map((medicine) => {
                  const { strength, form } = draftValues(medicine)
                  const label = [medicineName(medicine, language), strength, form].filter(Boolean).join(' · ')
                  return <option key={medicine.row.id} value={medicine.row.id}>{label}</option>
                })}
              </select>
            </label>
            <RowEvidence {...scanEvidence(preview, row, draft.evidence)} t={t} />
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
          disabled={!placements.size || placements.size !== selectedCount}
          onClick={() => {
            onConfirm(preview, placements)
            setSelected([])
            setTargets(new Map())
          }}
        >
          {t.confirm}
        </Button>
      )}
    </section>
  )
}

function DraftEditor({ medicine, t, onSave }: { medicine: Medicine; t: IntakeText; onSave: (values: DraftValues) => void }) {
  const values = draftValues(medicine)
  return (
    <details className="med-corrections">
      <summary>{t.editDraft}</summary>
      <form className="stack" onSubmit={(event) => {
        event.preventDefault()
        const form = new FormData(event.currentTarget)
        onSave({
          name: String(form.get('name') ?? '').trim(),
          strength: String(form.get('strength') ?? '').trim(),
          form: String(form.get('form') ?? '').trim(),
          directions: String(form.get('directions') ?? '').trim(),
        })
      }}>
        <InputField label={t.draftName} name="name" defaultValue={values.name} />
        <div className="field-pair">
          <InputField label={t.draftStrength} name="strength" defaultValue={values.strength} />
          <InputField label={t.draftForm} name="form" defaultValue={values.form} />
        </div>
        <label>{t.draftDirections}<textarea name="directions" defaultValue={values.directions} /></label>
        <Button type="submit">{t.saveDraft}</Button>
      </form>
    </details>
  )
}

export function DraftReview({ draft, language, onSave }: {
  draft: Draft
  language: Language
  onSave: (id: string, values: DraftValues) => void
}) {
  const t = intake[language]
  return (
    <div className="intake stack">
      <h1>{language === 'th' ? 'ทบทวน' : 'Review'}</h1>
      {!draft.medicines.length && <p>{t.noMedicines}</p>}
      {draft.medicines.map((medicine) => {
        const { row, catalogue, corrections, linkedScans } = medicine
        return (
          <article className="intake-panel stack" key={row.id}>
            <div className="spread">
              <h2>{medicineName(medicine, language)}</h2>
              <span className="pending-label">{t.pending}</span>
            </div>
            {medicine.origin === 'analysis' && hasEarlierEvidence(medicine, draft.evidence) && (
              <p role="status">{t.earlier}</p>
            )}
            {catalogue && (
              <small>
                TPU {catalogue.product.tpu} · {catalogue.release}
              </small>
            )}
            <DraftEditor medicine={medicine} t={t} onSave={(values) => onSave(row.id, values)} />
            {corrections && (
              <div>
                <strong>{t.draftChanges}</strong>
                <p>{[corrections.name, corrections.strength, corrections.form, corrections.directions]
                  .filter(Boolean).join(' · ')}</p>
              </div>
            )}
            <RowEvidence {...medicine} scan={medicine.origin === 'analysis'} t={t} />
            {linkedScans?.map((scan, index) => (
              <section className="suggestion" key={index}>
                <h3>{t.linkedScan}</h3>
                {hasEarlierEvidence(scan, draft.evidence) && <p role="status">{t.earlier}</p>}
                <RowEvidence {...scan} t={t} />
              </section>
            ))}
          </article>
        )
      })}
      <Link className="text-action" to="/new-patient/input">
        {t.back}
      </Link>
    </div>
  )
}
