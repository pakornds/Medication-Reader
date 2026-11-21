import { useState } from 'react'
import type { Decision } from '../../api/contracts'
import {
  active,
  entryName,
  sourceLabel,
  supportsIdentity,
  type Save,
  type Say,
  type ReviewRow,
} from './review'

export function IdentityReview({
  row,
  pharmacist,
  save,
  t,
}: {
  row: ReviewRow
  pharmacist: boolean
  save: Save
  t: Say
}) {
  const entries = active(row)
  const [name, setName] = useState('')
  const [wording, setWording] = useState('')
  const [origin, setOrigin] = useState('')
  const [basis, setBasis] = useState<
    'dispensing_confirmation' | 'item_specific_record' | 'matched_original_package'
  >('item_specific_record')
  const [finding, setFinding] = useState('')
  const [outcome, setOutcome] = useState<Decision['outcome']>('pending')
  const [manualEvidence, setManualEvidence] = useState(false)
  const independent = entries.filter((e) => e.identity_basis && supportsIdentity(e))
  const isConfirming = ['confirm', 'correct'].includes(outcome)
  const options = isConfirming ? independent : entries
  const [sid, setSid] = useState('')
  const selected = options.find((e) => e.source.id === sid)
  const linkEvidence = async (event: React.FormEvent) => {
    event.preventDefault()
    const sourceId = crypto.randomUUID()
    const result = await save({
      action: 'link',
      row_id: row.id,
      confirmed: true,
      entry: {
        source: {
          id: sourceId,
          kind: 'reviewer_record',
          organization: origin.trim() || null,
        },
        wording: wording.trim(),
        name: name.trim(),
        identity_basis: basis,
      },
    })
    if (result) {
      setSid(sourceId)
      setName('')
      setWording('')
      setOrigin('')
      setManualEvidence(false)
    }
  }
  return (
    <div className="clinical-form">
      {row.unknown && (
        <>
          <h4>{t('Physical identity', 'ชนิดยาที่ตรวจพบ')}</h4>
          <p>
            {row.confirmed
              ? t('Confirmed by pharmacy', 'เภสัชกรยืนยันแล้ว') + ' · ' + row.confirmed.name
              : row.proposal
                ? t('Candidate pending pharmacy confirmation', 'ยาที่คาดไว้ รอเภสัชกรยืนยัน') +
                  ' · ' +
                  row.proposal.name
                : t(
                    'Identity unresolved. A pharmacist can confirm it from separate, item-specific evidence.',
                    'ยังระบุชนิดยาไม่ได้ เภสัชกรยืนยันได้เมื่อมีหลักฐานแยกที่ระบุรายการนี้โดยเฉพาะ',
                  )}
          </p>
        </>
      )}
      <button
        className="text-action"
        type="button"
        aria-expanded={manualEvidence}
        onClick={() => setManualEvidence(!manualEvidence)}
      >
        {t('Attach independent identity evidence', 'เพิ่มหลักฐานอิสระเพื่อยืนยันชนิดยา')}
      </button>
      {manualEvidence && (
        <form className="clinical-form" onSubmit={linkEvidence}>
          <label>
            {t('Identity evidence type', 'ประเภทหลักฐานระบุชนิดยา')}
            <select
              aria-label={t('Identity evidence type', 'ประเภทหลักฐานระบุชนิดยา')}
              value={basis}
              onChange={(e) => setBasis(e.target.value as typeof basis)}
            >
              <option value="item_specific_record">
                {t('Item-specific record', 'บันทึกที่ระบุรายการนี้โดยเฉพาะ')}
              </option>
              <option value="dispensing_confirmation">
                {t('Dispensing confirmation', 'การยืนยันจากหน่วยจ่ายยา')}
              </option>
              <option value="matched_original_package">
                {t('Matched original package', 'บรรจุภัณฑ์เดิมที่จับคู่แล้ว')}
              </option>
            </select>
          </label>
          <label>
            {t('Name on the independent evidence', 'ชื่อยาที่ปรากฏในหลักฐานอิสระ')}
            <input required value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          <label>
            {t('Facility or service, if known', 'หน่วยบริการ ถ้าทราบ')}
            <input value={origin} onChange={(e) => setOrigin(e.target.value)} />
          </label>
          <label>
            {t(
              'Original evidence and how it identifies this item',
              'ข้อความต้นฉบับและเหตุผลที่ระบุรายการยานี้ได้',
            )}
            <textarea required value={wording} onChange={(e) => setWording(e.target.value)} />
          </label>
          <button className="btn" disabled={!name.trim() || !wording.trim()}>
            {t('Attach evidence', 'เพิ่มหลักฐาน')}
          </button>
        </form>
      )}
      {row.unknown && pharmacist && (
        <form
          className="clinical-form"
          onSubmit={async (e) => {
            e.preventDefault()
            if (!selected) return
            const done = await save({
              action: 'decide',
              row_id: row.id,
              outcome,
              source_id: selected.source.id,
              finding: finding.trim(),
              name: isConfirming ? entryName(selected) : null,
            })
            if (done) setFinding('')
          }}
        >
          <h4>{t('Pharmacist identity decision', 'ผลพิจารณาชนิดยาโดยเภสัชกร')}</h4>
          <label>
            {t('Decision', 'การตัดสินใจ')}
            <select
              aria-label={t('Decision', 'การตัดสินใจ')}
              value={outcome}
              onChange={(e) => {
                setOutcome(e.target.value as typeof outcome)
                setSid('')
              }}
            >
              <option value="pending">{t('Keep pending', 'รอหลักฐานเพิ่มเติม')}</option>
              <option value="confirm">{t('Confirm identity', 'ยืนยันชนิดยา')}</option>
              <option value="correct">{t('Correct identity', 'แก้ไขชนิดยา')}</option>
              <option value="reject">{t('Reject candidate', 'ปฏิเสธยาที่เสนอ')}</option>
            </select>
          </label>
          <label>
            {t('Evidence for the decision', 'หลักฐานประกอบการตัดสินใจ')}
            <select
              aria-label={t('Evidence for the decision', 'หลักฐานประกอบการตัดสินใจ')}
              required
              value={sid}
              onChange={(e) => setSid(e.target.value)}
            >
              <option value="">{t('Select evidence', 'เลือกหลักฐาน')}</option>
              {options.map((e) => (
                <option key={e.source.id} value={e.source.id}>
                  {sourceLabel(e, t)} · {e.wording}
                </option>
              ))}
            </select>
          </label>
          <label>
            {t('Decision rationale', 'เหตุผลที่ตัดสินใจ')}
            <textarea required value={finding} onChange={(e) => setFinding(e.target.value)} />
          </label>
          <button className="btn" disabled={!selected || !finding.trim()}>
            {t('Record identity decision', 'บันทึกผลระบุชนิดยา')}
          </button>
        </form>
      )}
    </div>
  )
}
