import { ScanCatalogue } from './ScanCatalogue'
import { MedicineDetails } from './MedicineEvidence'
import { Button } from '../../components/ui/Button'
import { InputField } from '../../components/ui/InputField'
import { useId, useState } from 'react'
import { Link } from 'react-router-dom'
import { intake, type IntakeText } from '../../i18n/intake'
import type { Language } from '../../i18n/messages'
import { EvidenceCrop, EvidenceImage } from './EvidenceImage'
import {
  currentCatalogueIdentity,
  draftValues,
  hasEarlierEvidence,
  knownOrder,
  medicineName,
  photoCitation,
  rowName,
  scanEvidence,
  type Draft,
  type CatalogueMatch,
  type DraftValues,
  type Evidence,
  type Fact,
  type Medicine,
  type Preview,
  type Ref,
} from './draft'

function Citation({ reference, evidence, t }: { reference: Ref; evidence: Evidence; t: IntakeText }) {
  const [open, setOpen] = useState(false)
  const note = evidence.notes.find((n) => n.id === reference.source_id)
  if (note)
    return (
      <details className="citation">
        <summary>{t[note.kind]}</summary>
        <blockquote>{note.text}</blockquote>
        <small>{[note.author, note.facilityContact?.department_or_ward, note.facilityContact?.organization_address, note.facilityContact?.organization_phone, note.facilityContact?.organization_phone_extension, note.facilityContact?.organization_email, note.date].filter(Boolean).join(' · ')}</small>
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
      <small>{[photo.file.name, region?.organization, region?.facilityContact?.department_or_ward, region?.facilityContact?.organization_address, region?.facilityContact?.organization_phone, region?.facilityContact?.organization_phone_extension, region?.facilityContact?.organization_email, photo.date].filter(Boolean).join(' · ')}</small>
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
  const groupId = useId()
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
    if (target && draft.medicines.some((medicine) => medicine.row.id === target)) {
      placements.set(row.id, target)
    } else if (!target && !existing) {
      placements.set(row.id, null)
    }
  }
  return (
    <section className="intake-panel stack">
      <h2>{t.preview} · {preview.rows.length}</h2>
      {!preview.rows.length && <p>{t.noRows}</p>}
      {preview.rows.map((row, index) => {
        const existing = knownOrder(draft.medicines, row.id)
        const checked = selected.includes(row.id)
        const scan = scanEvidence(preview, row, draft.evidence)
        const heading = rowName(row, language, scan.catalogueIdentity)
        const titleId = groupId + '-medicine-' + index
        return (
          <div className="suggestion stack" key={row.id}>
            <div className="spread">
              <h3><label className="pick-row">
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() => setSelected((current) => checked
                    ? current.filter((id) => id !== row.id) : [...current, row.id])}
                />
                <strong id={titleId}>{heading}</strong>
              </label></h3>
              <Button variant="text" onClick={() => onDismiss(preview, row.id)}>{t.dismissSuggestion}</Button>
            </div>
            {draft.medicines.length > 0 && <label>
              <span id={titleId + '-target'}>{language === 'th' ? 'เพิ่มเข้ารายการ' : 'Add to'}</span>
              <select aria-labelledby={titleId + '-target ' + titleId}
                value={targets.get(row.id) ?? ''}
                onChange={(event) => {
                  const target = event.target.value
                  setTargets((current) => new Map(current).set(row.id, target))
                }}
              >
                <option value="">{existing ? t.chooseOrder : t.addNewOrder}</option>
                {draft.medicines.map((medicine) => {
                  const { strength, form, directions } = draftValues(medicine)
                  const label = [medicineName(medicine, language), strength, form, directions].filter(Boolean).join(' · ')
                  return <option key={medicine.row.id} value={medicine.row.id}>{label}</option>
                })}
              </select>
            </label>}
            <MedicineDetails {...scan} language={language} />
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

export function DraftReview({ draft, language, onSave, onCatalogue, embedded = false }: {
  embedded?: boolean
  onCatalogue?: (medicine: Medicine, match: CatalogueMatch | undefined) => void
  draft: Draft
  language: Language
  onSave: (id: string, values: DraftValues) => void
}) {
  const t = intake[language]
  return (
    <div className="intake stack">
      {!embedded && <h1>{language === 'th' ? 'ทบทวน' : 'Review'}</h1>}
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
              <details className="staff-corrections">
                <summary>{t.draftChanges}</summary>
                <dl>
                  {([['name', t.draftName], ['strength', t.draftStrength], ['form', t.draftForm],
                    ['directions', t.draftDirections]] as const).map(([field, label]) => (
                    corrections[field] !== undefined && (
                      <div key={field}><dt>{label}</dt><dd>{corrections[field] || t.missing}</dd></div>
                    )
                  ))}
                </dl>
              </details>
            )}
            <MedicineDetails {...medicine} catalogueIdentity={currentCatalogueIdentity(medicine)} language={language} edits={corrections} />
            {linkedScans?.map((scan, index) => (
              <section className="suggestion" key={index}>
                <h3>{t.linkedScan}</h3>
                {hasEarlierEvidence(scan, draft.evidence) && <p role="status">{t.earlier}</p>}
                <MedicineDetails {...scan} language={language} />
              </section>
            ))}
            {medicine.origin==='analysis' && row.identity_status==='named' && onCatalogue && <ScanCatalogue medicine={medicine} language={language} onChange={match=>onCatalogue(medicine,match)}/> }
          </article>
        )
      })}
      {!embedded && <Link className="text-action" to="/new-patient/input">
        {t.back}
      </Link>}
    </div>
  )
}
