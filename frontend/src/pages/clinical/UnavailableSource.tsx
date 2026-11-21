import { useRef } from 'react'
import type { EvidenceSource } from '../../api/contracts'
import type { Save, Say } from './review'

export function UnavailableSource({ save, t, busy }: { save: Save; t: Say; busy: boolean }) {
  const id = useRef(crypto.randomUUID())
  return <details className="clinical-card">
    <summary>{t('Record an unavailable source', 'บันทึกแหล่งข้อมูลที่ยังไม่ได้รับ')}</summary>
    <form className="clinical-form" onSubmit={async event => {
      event.preventDefault()
      const form = event.currentTarget
      const fields = new FormData(form)
      const value = (key: string) => String(fields.get(key) || '').trim() || null
      const source: EvidenceSource = {
        id: id.current, kind: fields.get('kind') as EvidenceSource['kind'], availability: 'unavailable',
        unavailable_reason: value('reason'), organization: value('organization'),
        department_or_ward: value('ward'), contact: value('contact'), reporter: value('reporter'),
      }
      if (await save({ action: 'record_unavailable_source', source, follow_up: value('follow_up') })) {
        form.reset()
        id.current = crypto.randomUUID()
        form.closest('details')?.removeAttribute('open')
      }
    }}>
      <label>{t('Source type', 'ประเภทแหล่งข้อมูล')}<select name="kind">
        <option value="transfer_record">{t('Transfer record', 'เอกสารส่งต่อ')}</option>
        <option value="prescription">{t('Prescription', 'ใบสั่งยา')}</option>
        <option value="reviewer_record">{t('Clinician record', 'บันทึกบุคลากรทางการแพทย์')}</option>
        <option value="other_record">{t('Other record', 'บันทึกอื่น')}</option>
        <option value="patient_report">{t('Patient report', 'คำบอกเล่าของผู้ป่วย')}</option>
        <option value="caregiver_report">{t('Caregiver report', 'คำบอกเล่าของผู้ดูแล')}</option>
      </select></label>
      <label>{t('Organization', 'สถานพยาบาล')}<input name="organization" /></label>
      <label>{t('Department or ward', 'แผนกหรือหอผู้ป่วย')}<input name="ward" /></label>
      <label>{t('Reporter', 'ผู้ให้ข้อมูล')}<input name="reporter" /></label>
      <label>{t('Contact', 'ช่องทางติดต่อ')}<input name="contact" /></label>
      <label>{t('Reason unavailable', 'เหตุผลที่ยังไม่ได้รับ')}<input name="reason" required /></label>
      <label>{t('Follow-up', 'สิ่งที่ต้องติดตาม')}<input name="follow_up" /></label>
      <button className="btn" disabled={busy}>{t('Save source follow-up', 'บันทึกการติดตาม')}</button>
    </form>
  </details>
}
