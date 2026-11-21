import { useState } from 'react'
import type { InterviewAnswers as Answers, InterviewDraft, UpdateInterviewDraft } from './interviewDraft'
import type { Encounter } from '../../api/admission'
import {
  active,
  interviewSource,
  ownerLabels,
  sourceLabel,
  currentUseLabels,
  type Save,
  type Say,
  type ReviewRow,
} from './review'

export function InterviewForm({
  row,
  encounter,
  save,
  t,
  draft,
  onDraft,
}: {
  row: ReviewRow
  encounter: Encounter
  save: Save
  t: Say
  draft?: InterviewDraft
  onDraft: (update: UpdateInterviewDraft) => void
}) {
  const sources = active(row).filter(interviewSource)
  const current: InterviewDraft = draft ?? {
    source: row.interview?.source_id || sources[0]?.source.id || '',
    kind: 'patient_report',
    wording: '',
    answers: row.interview || { ownership: 'uncertain', current_use: 'uncertain', source_id: '' },
  }
  const { source, kind, wording, answers, newId } = current
  const [saved, setSaved] = useState(false)
  const edit = (patch: Partial<InterviewDraft>) => {
    setSaved(false)
    onDraft((latest) => ({ ...(latest ?? current), ...patch }))
  }
  const update = (patch: Partial<Answers>) => edit({ answers: { ...answers, ...patch } })
  const chosen = sources.find((e) => e.source.id === source)
  async function submit(event: React.FormEvent) {
    event.preventDefault()
    let caseState = encounter
    let sourceId = source
    let submitted = draft
    function replaceSubmitted(next?: InterviewDraft) {
      const expected = submitted
      onDraft((latest) => latest === expected ? next : latest)
      submitted = next
    }
    if (!sourceId) {
      sourceId = newId ?? crypto.randomUUID()
      if (!newId) replaceSubmitted({ ...current, newId: sourceId })
      const linked = await save(
        {
          action: 'link',
          row_id: row.id,
          confirmed: true,
          entry: { source: { id: sourceId, kind }, wording: wording.trim() },
        },
        caseState,
      )
      if (!linked) return
      caseState = linked
      replaceSubmitted({ ...current, source: sourceId, wording: '', newId: undefined })
    }
    const result = await save(
      {
        action: 'interview',
        row_id: row.id,
        ...answers,
        source_id: sourceId,
        ownership_source_id: sourceId,
        dose: answers.dose?.trim() || null,
        route: answers.route?.trim() || null,
        schedule: answers.schedule?.trim() || null,
        reason: answers.reason?.trim() || null,
        note: answers.note?.trim() || null,
      },
      caseState,
    )
    if (result) {
      replaceSubmitted()
      setSaved(true)
    }
  }
  return (
    <form className="clinical-form" onSubmit={submit}>
      <h4>{t('Medication interview', 'สัมภาษณ์การใช้ยา')}</h4>
      <label>
        {t('Interview source', 'แหล่งข้อมูลการสัมภาษณ์')}
        <select
          aria-label={t('Interview source', 'แหล่งข้อมูลการสัมภาษณ์')}
          value={source}
          onChange={(e) => {
            const selected = e.target.value
            edit({
              source: selected,
              answers: row.interview?.source_id === selected
                ? row.interview
                : { ownership: 'uncertain', current_use: 'uncertain', source_id: selected },
            })
          }}
        >
          <option value="">{t('Record a new account', 'บันทึกคำบอกเล่าใหม่')}</option>
          {sources.map((entry) => (
            <option key={entry.source.id} value={entry.source.id}>
              {sourceLabel(entry, t)} · {entry.wording}
            </option>
          ))}
        </select>
      </label>
      {source ? (
        <blockquote>{chosen?.wording}</blockquote>
      ) : (
        <>
          <label>
            {t('Account from', 'ผู้ให้ข้อมูล')}
            <select
              aria-label={t('Account from', 'ผู้ให้ข้อมูล')}
              value={kind}
              onChange={(e) => edit({ kind: e.target.value as typeof kind })}
            >
              <option value="patient_report">{t('Patient', 'ผู้ป่วย')}</option>
              <option value="caregiver_report">{t('Caregiver', 'ผู้ดูแล')}</option>
            </select>
          </label>
          <label>
            {t('Original interview wording', 'คำบอกเล่าตามจริง')}
            <textarea required value={wording} onChange={(e) => edit({ wording: e.target.value })} />
          </label>
        </>
      )}
      <div className="clinical-fields">
        <label>
          {t('Whose medicine?', 'ยาของใคร')}
          <select
            aria-label={t('Whose medicine?', 'ยาของใคร')}
            value={answers.ownership}
            onChange={(e) => update({ ownership: e.target.value as Answers['ownership'] })}
          >
            {Object.entries(ownerLabels(t)).map(([key, label]) => (
              <option key={key} value={key}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label>
          {t('Current use', 'สถานะการใช้ยา')}
          <select
            aria-label={t('Current use', 'สถานะการใช้ยา')}
            value={answers.current_use}
            onChange={(e) => update({ current_use: e.target.value as Answers['current_use'] })}
          >
            {Object.entries(currentUseLabels(t)).map(([key, label]) => (
              <option key={key} value={key}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label>
          {t('Actual dose', 'ขนาดยาที่ใช้จริง')}
          <input value={answers.dose || ''} onChange={(e) => update({ dose: e.target.value })} />
        </label>
        <label>
          {t('Actual route', 'ทางที่ใช้ยาจริง')}
          <input value={answers.route || ''} onChange={(e) => update({ route: e.target.value })} />
        </label>
        <label>
          {t('Actual schedule', 'เวลาหรือความถี่ที่ใช้จริง')}
          <input value={answers.schedule || ''} onChange={(e) => update({ schedule: e.target.value })} />
        </label>
        <label>
          {t('Reported reason for use', 'เหตุผลที่ใช้ยาตามคำบอกเล่า')}
          <input value={answers.reason || ''} onChange={(e) => update({ reason: e.target.value })} />
        </label>
      </div>
      <label>
        {t('Handoff note', 'บันทึกสำหรับส่งต่อ')}
        <textarea value={answers.note || ''} onChange={(e) => update({ note: e.target.value })} />
      </label>
      <div className="clinical-actions">
        <button className="btn" disabled={!source && !wording.trim()}>
          {t('Save interview', 'บันทึกการสัมภาษณ์')}
        </button>
        {saved && <span role="status">{t('Interview saved', 'บันทึกการสัมภาษณ์แล้ว')}</span>}
      </div>
    </form>
  )
}
