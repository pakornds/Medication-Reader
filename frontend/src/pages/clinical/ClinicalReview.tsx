import { useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { ApiError } from '../../api/client'
import type { Encounter } from '../../api/admission'
import type { EvidenceSource, LabelField, Observation, ReviewerIdentity } from '../../api/contracts'
import type { Language } from '../../i18n/messages'
import { regimenText } from '../../i18n/regimen'
import { intake } from '../../i18n/intake'
import { RegimenReadback } from '../new-patient/RegimenReadback'
import { Handoff } from './Handoff'
import { LocatedImage } from './LocatedImage'
import { rowRegions } from './locatedEvidence'
import { InterviewForm } from './InterviewForm'
import type { InterviewDraft, UpdateInterviewDraft } from './interviewDraft'
import { VerifyForm } from './VerifyForm'
import { IdentityReview } from './IdentityReview'
import { IdentityIncident, type Incident } from './IdentityIncident'
import { ScreeningPanel } from './ScreeningPanel'
import {
  active,
  bilingual,
  entryName,
  intakeCorrections,
  needsIdentity,
  ownerLabels,
  rowName,
  sourceLabel,
  stateLabel,
  currentUseLabels,
  verification,
  type Client,
  type Entry,
  type Save,
  type Say,
} from './review'
import './clinical.css'

interface Props {
  language: Language
  client: Client
  actor: ReviewerIdentity
  encounter: Encounter
  onEncounter: (value: Encounter) => void
  interviewDrafts: Record<string, InterviewDraft>
  onInterviewDraft: (id: string, update: UpdateInterviewDraft) => void
}
function statusName(value: Encounter['status'], t: Say) {
  return value === 'Finished'
    ? t('Finished', 'เสร็จสิ้น')
    : value === 'Awaiting pharmacist review'
      ? t('Awaiting pharmacist review', 'รอเภสัชกรทบทวน')
      : t('In progress', 'กำลังดำเนินการ')
}
function SourceFields({
  entry,
  language,
}: {
  entry: Entry & { intake_observations?: Partial<Record<LabelField, Observation>> }
  language: Language
}) {
  const t = intake[language]
  const fields = { ...entry.intake_observations, ...entry.scan_fields }
  for (const key of ['strength', 'form', 'dose', 'directions', 'indication'] as const) {
    if (entry[key]) fields[key] = { status: 'readable', value: entry[key] }
    else if (entry.label_overrides?.includes(key)) delete fields[key]
  }
  return (
    <dl className="clinical-source-fields">
      {(Object.entries(fields) as [LabelField, Observation][]).map(([key, observed]) => (
        <div key={key}>
          <dt>{t[key]}</dt>
          <dd>{observed.value || (observed.status === 'unreadable' ? t.unreadable : t.missing)}</dd>
        </div>
      ))}
    </dl>
  )
}
function ReviewSession({ language, client, actor, encounter, onEncounter, interviewDrafts, onInterviewDraft }: Props) {
  const t = bilingual(language)
  const rows = Object.values(encounter.rows)
  const [selected, setSelected] = useState(rows[0]?.id || '')
  const row = encounter.rows[selected] || rows[0]
  const verified = row && verification(row)
  const corrections = row ? intakeCorrections(row) : []
  const regions = row ? rowRegions(encounter, row) : []
  const activeSources = new Set(row ? active(row).map((e) => e.source.id) : [])
  const [busy, setBusy] = useState(false)
  const locked = useRef(false)
  const [error, setError] = useState('')
  const [checked, setChecked] = useState('')
  const [reason, setReason] = useState('')
  const [referIds, setReferIds] = useState<string[]>([])
  const retry = useRef<{ key: string; requestId: string } | null>(null)
  const pharmacist = actor.role === 'pharmacist'
  const writable = encounter.status !== 'Finished' && (encounter.status === 'In progress' || pharmacist)
  const save: Save = async (command, base = encounter) => {
    if (locked.current) return null
    locked.current = true
    setBusy(true)
    setError('')
    const key = JSON.stringify([base.id, base.revision, command])
    if (retry.current?.key !== key) retry.current = { key, requestId: crypto.randomUUID() }
    try {
      const next = await client.action(base.id, {
        revision: base.revision,
        request_id: retry.current.requestId,
        command,
      })
      retry.current = null
      onEncounter(next)
      return next
    } catch (e) {
      let detail =
        e instanceof Error ? e.message : t('Could not save clinical review', 'บันทึกการทบทวนไม่สำเร็จ')
      if (e instanceof ApiError && e.status === 409) {
        try {
          onEncounter(await client.encounter(base.id))
          detail +=
            ' · ' +
            t(
              'Review refreshed. Check the current row before retrying.',
              'โหลดข้อมูลล่าสุดแล้ว กรุณาตรวจรายการก่อนลองใหม่',
            )
        } catch {
          /* Preserve the original server error. */
        }
      }
      setError(detail)
      return null
    } finally {
      locked.current = false
      setBusy(false)
    }
  }
  const pending = rows.filter((r) => r.unknown && !r.confirmed)
  const referral = pending.filter((r) => needsIdentity(r) || referIds.includes(r.id))
  const incidents = Object.values(
    (encounter as Encounter & { identity_incidents?: Record<string, Incident> }).identity_incidents || {},
  )
  const unavailable = Object.values(
    (
      encounter as Encounter & {
        unavailable_sources?: Record<string, { source: EvidenceSource; follow_up: string }>
      }
    ).unavailable_sources || {},
  )
  return (
    <section className="clinical-workspace" aria-label={t('Clinical review', 'ทบทวนทางคลินิก')}>
      <header className="clinical-heading">
        <div>
          <h2>{t('Clinical review', 'ทบทวนทางคลินิก')}</h2>
          <p>
            {encounter.patient_alias} · {statusName(encounter.status, t)} ·{' '}
            {rows.filter((r) => r.verified).length}/{rows.length} {t('verified', 'ยืนยันแล้ว')}
          </p>
        </div>
        <Handoff encounter={encounter} client={client} t={t} />
      </header>
      {error && (
        <p role="alert" className="clinical-error">
          {error}
        </p>
      )}
      {!rows.length && (
        <p>
          {t(
            'Add medicines on Input to begin clinical review.',
            'เพิ่มรายการยาในหน้าป้อนข้อมูลเพื่อเริ่มทบทวน',
          )}
        </p>
      )}
      {unavailable.length > 0 && (
        <details className="clinical-card">
          <summary>
            {t('Outstanding source records', 'เอกสารที่ยังไม่ได้รับ')} ({unavailable.length})
          </summary>
          {unavailable.map((v) => (
            <p key={v.source.id}>
              {[
                v.source.organization || v.source.department_or_ward,
                v.source.unavailable_reason,
                v.follow_up,
              ]
                .filter(Boolean)
                .join(' · ')}
            </p>
          ))}
        </details>
      )}
      {row && (
        <div className="clinical-columns">
          <nav className="clinical-list" aria-label={t('Medicines to review', 'รายการยาที่ต้องทบทวน')}>
            {rows.map((r, i) => (
              <button
                type="button"
                key={r.id}
                aria-current={r.id === row.id ? 'true' : undefined}
                onClick={() => setSelected(r.id)}
              >
                <strong>
                  {i + 1}. {rowName(r, t)}
                </strong>
                <small>{stateLabel(r, t)}</small>
              </button>
            ))}
          </nav>
          <article className="clinical-card clinical-form" key={row.id}>
            <div>
              <h3>{rowName(row, t)}</h3>
              <p>{stateLabel(row, t)}</p>
            </div>
            {corrections.length > 0 && (
              <section className="clinical-inset">
                <h4>{t('Intake corrections', 'ข้อมูลที่แก้ไขระหว่างรับข้อมูล')}</h4>
                {corrections.map(([field, value]) => (
                  <p key={field}>
                    {
                      (
                        {
                          name: t('Name', 'ชื่อยา'),
                          strength: t('Strength', 'ความแรง'),
                          form: t('Dosage form', 'รูปแบบยา'),
                          directions: t('Directions', 'วิธีใช้ยา'),
                        } as Record<string, string>
                      )[field]
                    }{' '}
                    · {value || t('Cleared by staff', 'ผู้ทบทวนลบค่าเดิม')}
                  </p>
                ))}
              </section>
            )}
            <details open className="clinical-evidence">
              <summary>{t('Source evidence', 'หลักฐานต้นทาง')}</summary>
              {active(row).map((entry) => (
                <section key={entry.source.id}>
                  <strong>{sourceLabel(entry, t)}</strong>
                  <blockquote>{entry.wording}</blockquote>
                  <SourceFields entry={entry} language={language} />
                  <small>
                    {[
                      entry.source.source_date,
                      entry.source.department_or_ward,
                      entry.source.organization_address,
                      entry.source.organization_phone,
                      entry.source.organization_phone_extension &&
                        t('Ext. ', 'เบอร์ต่อ ') + entry.source.organization_phone_extension,
                      entry.source.organization_email,
                      entry.source.contact !== entry.source.organization_phone ? entry.source.contact : null,
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </small>
                  {entry.photo && (
                    <LocatedImage
                      entry={entry}
                      region={regions.find((r) => r.source_id === entry.source.id)}
                      caseId={encounter.id}
                      client={client}
                      t={t}
                    />
                  )}
                </section>
              ))}
              {regions
                .filter((r) => !row.entries.some((e) => e.source.id === r.source_id))
                .map((r) => (
                  <section key={r.item_id}>
                    <strong>
                      {r.region.side === 'front'
                        ? t('Package front', 'ด้านฉลากของบรรจุภัณฑ์')
                        : t('Matched package reverse', 'ด้านหลังบรรจุภัณฑ์ที่จับคู่แล้ว')}
                    </strong>
                    <LocatedImage region={r} caseId={encounter.id} client={client} t={t} />
                  </section>
                ))}
              {row.intake?.regimens
                ?.filter((c) => Object.values(c.evidence).every((ref) => activeSources.has(ref.source_id)))
                .map((c) => (
                  <RegimenReadback key={c.component_id} component={c} t={regimenText[language]} />
                ))}
            </details>
            {row.interview && (
              <section className="clinical-inset">
                <h4>{t('Recorded interview', 'ข้อมูลสัมภาษณ์ที่บันทึก')}</h4>
                <p>
                  {ownerLabels(t)[row.interview.ownership]} · {currentUseLabels(t)[row.interview.current_use]}
                </p>
                <p>
                  {[
                    row.interview.dose,
                    row.interview.route,
                    row.interview.schedule,
                    row.interview.reason,
                    row.interview.note,
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </p>
                {row.verified && (
                  <p>
                    {t('Verified by', 'ยืนยันโดย')} {row.verified.actor.name} · <time>{row.verified.at}</time>
                  </p>
                )}
                {verified?.identity?.normalized_medication_id && (
                  <p>
                    {verified.identity.name} · TPU {verified.identity.normalized_medication_id} ·{' '}
                    {verified.identity.tmt_release}
                  </p>
                )}
                {verified?.regimens?.map((c) => (
                  <RegimenReadback key={c.component_id} component={c} t={regimenText[language]} />
                ))}
              </section>
            )}
            <fieldset disabled={busy} className="clinical-form">
              {writable && (
                <>
                  <details key={row.id} open={!row.interview || Boolean(interviewDrafts[row.id])}>
                    <summary>
                      {row.interview
                        ? t('Edit interview', 'แก้ไขการสัมภาษณ์')
                        : t('Record interview', 'บันทึกการสัมภาษณ์')}
                    </summary>
                    <InterviewForm row={row} encounter={encounter} save={save} t={t}
                      draft={interviewDrafts[row.id]} onDraft={update => onInterviewDraft(row.id, update)} />
                  </details>
                  {(row.unknown ||
                    new Set(
                      active(row)
                        .filter((e) => e.name)
                        .map((e) => entryName(e).toLowerCase()),
                    ).size > 1) && <IdentityReview row={row} pharmacist={pharmacist} save={save} t={t} />}
                  {row.interview && (
                    <details key={JSON.stringify([row.interview, row.verified?.at])} open={!row.verified}>
                      <summary>{t('Verify actual use', 'ยืนยันการใช้จริง')}</summary>
                      <VerifyForm row={row} actor={actor} save={save} t={t} language={language} />
                    </details>
                  )}
                </>
              )}
              {incidents
                .filter((i) => i.row_id === row.id)
                .map((item) => (
                  <IdentityIncident
                    key={item.id}
                    item={item}
                    entries={row.entries}
                    pharmacist={pharmacist}
                    save={save}
                    t={t}
                  />
                ))}
            </fieldset>
          </article>
        </div>
      )}
      {encounter.status === 'In progress' && pending.length > 0 && (
        <details className="clinical-card">
          <summary>
            {t('Refer unresolved items to pharmacy', 'ส่งต่อรายการที่ยังระบุไม่ได้ให้เภสัชกร')}
          </summary>
          <form
            className="clinical-form"
            onSubmit={(e) => {
              e.preventDefault()
              void save({
                action: 'refer',
                row_ids: referral.map((r) => r.id),
                checked: checked.trim(),
                reason: reason.trim(),
              })
            }}
          >
            {pending.map((r) => (
              <label className="clinical-check" key={r.id}>
                <input
                  type="checkbox"
                  disabled={needsIdentity(r)}
                  checked={referral.includes(r)}
                  onChange={(e) =>
                    setReferIds(e.target.checked ? [...referIds, r.id] : referIds.filter((id) => id !== r.id))
                  }
                />
                {rowName(r, t)} · {rows.indexOf(r) + 1}
              </label>
            ))}
            <label>
              {t('Evidence already checked', 'หลักฐานที่ตรวจแล้ว')}
              <textarea required value={checked} onChange={(e) => setChecked(e.target.value)} />
            </label>
            <label>
              {t('Reason for referral', 'เหตุผลที่ส่งต่อ')}
              <textarea required value={reason} onChange={(e) => setReason(e.target.value)} />
            </label>
            <button className="btn" disabled={busy || !referral.length || !checked.trim() || !reason.trim()}>
              {t('Send pharmacy referral', 'ส่งเรื่องให้เภสัชกร')}
            </button>
          </form>
        </details>
      )}
      {encounter.events
        .filter((e) => e.action === 'refer')
        .map((e) => (
          <p key={e.revision} className="clinical-inset">
            {t('Pharmacy referral', 'ส่งต่อเภสัชกร')} · {e.reason} · {e.checked} · {e.at}
          </p>
        ))}
      {rows.length > 0 && ['doctor', 'pharmacist'].includes(actor.role) && (
        <ScreeningPanel key={encounter.revision} encounter={encounter} client={client} t={t} />
      )}
      <div className="clinical-actions">
        {writable && rows.length > 0 && (
          <button
            type="button"
            className="btn"
            disabled={busy || rows.some((r) => !r.verified || needsIdentity(r))}
            onClick={() => void save({ action: 'finish' })}
          >
            {t('Finish clinical review', 'สิ้นสุดการทบทวนทางคลินิก')}
          </button>
        )}
        <Link to="/new-patient/output" className="text-action">
          {t('Go to import preview', 'ไปยังตัวอย่างก่อนนำเข้า')}
        </Link>
      </div>
    </section>
  )
}
export function ClinicalReview(props: Props) {
  return <ReviewSession key={props.encounter.id + '-' + props.actor.id} {...props} />
}
