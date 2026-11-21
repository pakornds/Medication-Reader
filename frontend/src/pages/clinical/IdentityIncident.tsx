import { useState } from 'react'
import type { ReviewerIdentity } from '../../api/contracts'
import { sourceLabel, type Entry, type Save, type Say } from './review'

export type Incident = {
  id: string
  row_id: string
  conflicting_sources: { source_id: string; name: string }[]
  corroborating_source_id: string
  identity: string
  decision: string
  resolution: string
  reviewer: ReviewerIdentity
  recorded_at: string
  pharmacy_assessments: {
    outcome: 'confirmed_medication_error' | 'not_confirmed' | 'needs_review'
    assessment: string
    recorder: ReviewerIdentity
    recorded_at: string
  }[]
}
export function IdentityIncident({
  item,
  entries,
  pharmacist,
  save,
  t,
}: {
  item: Incident
  entries: Entry[]
  pharmacist: boolean
  save: Save
  t: Say
}) {
  const [outcome, setOutcome] = useState<Incident['pharmacy_assessments'][number]['outcome']>('needs_review')
  const [assessment, setAssessment] = useState('')
  const options = {
    needs_review: t('Needs pharmacy review', 'รอเภสัชกรทบทวน'),
    not_confirmed: t('Medication error not confirmed', 'ยังไม่ยืนยันความคลาดเคลื่อน'),
    confirmed_medication_error: t('Confirmed medication error', 'ยืนยันความคลาดเคลื่อนทางยา'),
  }
  const corroboration = entries.find((e) => e.source.id === item.corroborating_source_id)
  return (
    <section className="clinical-inset">
      <h4>{t('Disputed identity decision', 'การตัดสินกรณีชนิดยาขัดแย้ง')}</h4>
      <p>
        {item.identity} · {item.resolution} · {item.reviewer.name} · {item.recorded_at}
      </p>
      {item.conflicting_sources.map((s) => (
        <p key={s.source_id}>
          {s.name} · {entries.find((e) => e.source.id === s.source_id)?.wording || s.source_id}
        </p>
      ))}
      {corroboration && (
        <blockquote>
          {sourceLabel(corroboration, t)} · {corroboration.wording}
        </blockquote>
      )}
      {item.pharmacy_assessments.map((a, i) => (
        <p key={i}>
          {options[a.outcome]} · {a.assessment} · {a.recorder.name} · {a.recorded_at}
        </p>
      ))}
      {pharmacist && (
        <form
          className="clinical-form"
          onSubmit={async (e) => {
            e.preventDefault()
            const result = await save({
              action: 'assess_identity_incident',
              incident_id: item.id,
              outcome,
              assessment: assessment.trim(),
            })
            if (result) setAssessment('')
          }}
        >
          <label>
            {t('Pharmacy assessment', 'ผลประเมินของเภสัชกร')}
            <select
              aria-label={t('Pharmacy assessment', 'ผลประเมินของเภสัชกร')}
              value={outcome}
              onChange={(e) => setOutcome(e.target.value as typeof outcome)}
            >
              {Object.entries(options).map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </select>
          </label>
          <label>
            {t('Assessment note', 'บันทึกผลการประเมิน')}
            <textarea required value={assessment} onChange={(e) => setAssessment(e.target.value)} />
          </label>
          <button className="btn" disabled={!assessment.trim()}>
            {t('Record pharmacy assessment', 'บันทึกผลประเมินของเภสัชกร')}
          </button>
        </form>
      )}
    </section>
  )
}
