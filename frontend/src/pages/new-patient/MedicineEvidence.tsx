import { useState } from 'react'
import { intake } from '../../i18n/intake'
import { regimenText } from '../../i18n/regimen'
import type { Language } from '../../i18n/messages'
import { EvidenceCrop, EvidenceImage } from './EvidenceImage'
import { RegimenReadback } from './RegimenReadback'
import {
  photoCitation,
  type DraftValues,
  type Evidence,
  type MedicineEvidence,
  type Ref,
} from './draft'
import './medicine-evidence.css'

const labels = {
  en: {
    inspect: 'View source and details',
    name: 'Names read',
    check: 'Check which name identifies this medicine.',
    blank: 'Missing fields',
    original: 'Original source',
  },
  th: {
    inspect: 'ดูแหล่งข้อมูลและรายละเอียด',
    name: 'ชื่อที่อ่านได้',
    check: 'ตรวจสอบว่าชื่อใดระบุยารายการนี้',
    blank: 'ช่องที่ไม่มีข้อมูล',
    original: 'แหล่งข้อมูลเดิม',
  },
}

function sourceInfo(evidence: Evidence, ref: Ref, language: Language) {
  const t = intake[language]
  const note = evidence.notes.find((n) => n.id === ref.source_id)
  const resolved = photoCitation(evidence, ref)
  const photo = resolved?.photo
  const region = resolved?.region
  const label = photo
    ? [t[photo.kind], region && t.region + ' ' + (photo.regions.indexOf(region) + 1)]
        .filter(Boolean)
        .join(' · ')
    : note
      ? t[note.kind]
      : labels[language].original
  return { note, photo, region, label }
}

type Detail = { label: string; value: string }
type SourceGroup = { ref: Ref; facts: Detail[]; regimenFacts: Detail[] }

export function MedicineDetails({
  row,
  evidence,
  facility,
  catalogueIdentity,
  language,
  edits,
}: MedicineEvidence & { language: Language; edits?: Partial<DraftValues> }) {
  const [open, setOpen] = useState(false)
  const t = intake[language],
    l = labels[language]
  const groups = new Map<string, SourceGroup>()
  function group(ref: Ref) {
    const key = JSON.stringify([ref.source_id, ref.item_id ?? null])
    let found = groups.get(key)
    if (!found) {
      found = { ref, facts: [], regimenFacts: [] }
      groups.set(key, found)
    }
    return found
  }
  const uncited: Detail[] = []
  function fact(ref: Ref | null | undefined, label: string, value: string) {
    const facts = ref ? group(ref).facts : uncited
    if (!facts.some((f) => f.label === label && f.value === value)) facts.push({ label, value })
  }
  for (const ref of row.sources) group(ref)
  for (const name of row.observed_names) fact(name.evidence, l.name, name.value)
  const missing: string[] = []
  for (const [key, field] of Object.entries(row.label_fields)) {
    const label = t[key as keyof typeof t] || key
    if (field.value || field.status === 'unreadable')
      fact(field.evidence, label, field.value || t.unreadable)
    else missing.push(label)
  }
  for (const report of row.reported_use) fact(report.evidence, t.reported, report.value)
  for (const conflict of row.discrepancies)
    for (const observation of conflict.observed_values)
      fact(observation.evidence, t.discrepancies, observation.value)
  if (facility)
    fact(
      facility.evidence,
      t.dispensingSource,
      [
        facility.organization,
        facility.department_or_ward,
        facility.organization_address,
        facility.organization_phone,
        facility.organization_phone_extension,
        facility.organization_email,
      ]
        .filter(Boolean)
        .join(' · '),
    )
  if (row.reverse_crop) group(row.reverse_crop)
  const components = row.regimens ?? []
  components.forEach((component, index) => {
    const prefix = components.length > 1 ? index + 1 + ' · ' : ''
    for (const [field, ref] of Object.entries(component.evidence)) {
      const value = component[field as keyof typeof component]
      if (!ref || value == null) continue
      if (field === 'directions_text') {
        fact(
          ref,
          component.basis === 'reported' ? t.reportedDirections : t.directions,
          String(value),
        )
      } else {
        const display = typeof value === 'boolean' ? (value ? t.yes : t.no) : String(value)
        if (display)
          group(ref).regimenFacts.push({
            label: prefix + (t[field as keyof typeof t] ?? field),
            value: display,
          })
      }
    }
  })
  const sources = [...groups.values()]
  const display = (key: string) => row.label_fields[key]?.value
  const strength = edits?.strength ?? display('strength')
  const form = edits?.form ?? display('form')
  const directions = edits?.directions ?? display('directions')
  const dose = display('dose')
  const names = new Set(row.observed_names.map((n) => n.value.trim()).filter(Boolean))
  return (
    <>
      {names.size > 1 && !catalogueIdentity && !edits?.name && (
        <p className="medicine-check">{l.check}</p>
      )}
      {[strength, form].some(Boolean) && (
        <p className="medicine-presentation">{[strength, form].filter(Boolean).join(' · ')}</p>
      )}
      {directions && (
        <p>
          <strong>{t.directions}</strong> · {directions}
        </p>
      )}
      {dose && !directions?.includes(dose) && (
        <p>
          <strong>{t.dose}</strong> · {dose}
        </p>
      )}
      {display('amount_prescribed') && (
        <p>
          <strong>{t.amount_prescribed}</strong> · {display('amount_prescribed')}
        </p>
      )}
      {row.discrepancies.map((conflict) => (
        <p className="medicine-check" key={conflict.id}>
          {conflict.question}
        </p>
      ))}
      <details className="medicine-source" onToggle={(event) => setOpen(event.currentTarget.open)}>
        <summary>
          {l.inspect}
          {sources.length === 1 && ' · ' + sourceInfo(evidence, sources[0].ref, language).label}
        </summary>
        <div className="row-evidence stack">
          {sources.map(({ ref, facts, regimenFacts }) => {
            const { note, photo, region, label } = sourceInfo(evidence, ref, language)
            const contact = note?.facilityContact ?? region?.facilityContact
            const origin = [
              photo?.file.name,
              note?.author,
              region?.organization,
              contact?.department_or_ward,
              contact?.organization_address,
              contact?.organization_phone,
              contact?.organization_phone_extension,
              contact?.organization_email,
              note?.date || photo?.date,
            ]
              .filter(Boolean)
              .join(' · ')
            return (
              <section
                className="source-facts stack"
                key={JSON.stringify(ref)}
                data-source={ref.source_id}
                data-item={ref.item_id}
              >
                {sources.length > 1 && <h4>{label}</h4>}
                {row.reverse_crop?.source_id === ref.source_id &&
                  row.reverse_crop.item_id === ref.item_id && <strong>{t.matchedReverse}</strong>}
                {open && photo && (
                  <div className="region-image citation-image">
                    {region ? (
                      <EvidenceCrop
                        file={photo.file}
                        region={region}
                        label={label}
                        unavailable={t.cropUnavailable}
                      />
                    ) : (
                      <EvidenceImage file={photo.file} />
                    )}
                  </div>
                )}
                {note && <blockquote>{note.text}</blockquote>}
                {origin && <small>{origin}</small>}
                {facts.length > 0 && <FactList facts={facts} />}
                {regimenFacts.length > 0 && (
                  <div className="regimen-sources">
                    <strong>{t.structuredDirections}</strong>
                    <FactList facts={regimenFacts} />
                  </div>
                )}
              </section>
            )
          })}
          {catalogueIdentity && (
            <p>
              <strong>{language === 'th' ? 'ชื่อในบัญชียา' : 'Catalogue names'}</strong> ·{' '}
              {[catalogueIdentity.ingredient, catalogueIdentity.trade_name]
                .filter(Boolean)
                .join(' · ')}{' '}
              · {catalogueIdentity.release}
            </p>
          )}
          {uncited.length > 0 && <FactList facts={uncited} />}
          {components.map((component) => (
            <RegimenReadback
              key={component.component_id}
              component={component}
              t={regimenText[language]}
            />
          ))}
          {missing.length > 0 && (
            <p>
              <strong>{l.blank}</strong> · {missing.join(', ')}
            </p>
          )}
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
        </div>
      </details>
    </>
  )
}

function FactList({ facts }: { facts: Detail[] }) {
  return (
    <dl className="source-fact-list">
      {facts.map(({ label, value }, i) => (
        <div key={i}>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  )
}
