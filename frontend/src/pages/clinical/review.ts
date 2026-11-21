import type { Action, Interview, ReviewerIdentity } from '../../api/contracts'
import type { AdmissionRow, Encounter } from '../../api/admission'
import type { createClient } from '../../api/client'
import type { Language } from '../../i18n/messages'

export type Client = ReturnType<typeof createClient>
export type Command = Action['command']
export type Save = (command: Command, base?: Encounter) => Promise<Encounter | null>
export type Say = (english: string, thai: string) => string
export const bilingual = (language: Language): Say => (en, th) => language === 'th' ? th : en
export type Entry = AdmissionRow['entries'][number]
export type ReviewRow = AdmissionRow & {
  screening_attestation?: { at: string; actor: ReviewerIdentity } | null
}
export const active = (row: AdmissionRow) => row.entries.filter(e => !row.superseded.includes(e.source.id))
export const reported = (e: Entry) => ['patient_report','caregiver_report'].includes(e.source.kind)
export const supportsIdentity = (e: Entry) => Boolean(e.name && (!e.photo ||
  ((e.photo.front_attributed || e.photo.pairing === 'matched') && !e.photo.appearance)))
export const interviewSource = (e: Entry) => reported(e) || Boolean(e.record_basis)
export const entryName = (e: Entry) => e.product || [e.name, e.strength, e.form].filter(Boolean).join(' ')
export function rowName(row: AdmissionRow, t: Say) {
  if (row.confirmed) return row.confirmed.name
  if (row.unknown) return t('Unidentified medicine','ยาที่ยังระบุไม่ได้')
  return row.verified?.identity?.name || active(row).find(supportsIdentity)?.product ||
    active(row).find(supportsIdentity)?.name || t('Medicine','ยา')
}
export function stateLabel(row: AdmissionRow, t: Say) {
  if (row.referred) return t('Referred to pharmacy','ส่งต่อเภสัชกร')
  if (row.proposal) return t('Identity decision pending','รอยืนยันชนิดยา')
  if (row.verified) return t('Verified','ตรวจสอบแล้ว')
  if (row.interview) return t('Interview recorded','บันทึกการสัมภาษณ์แล้ว')
  return t('Awaiting interview','รอสัมภาษณ์')
}
export function sourceLabel(entry: Entry, t: Say) {
  const names = {
    patient_report: t('Patient report','คำบอกเล่าของผู้ป่วย'), caregiver_report: t('Caregiver report','คำบอกเล่าของผู้ดูแล'),
    prescription: t('Prescription','ใบสั่งยา'), transfer_record: t('Transfer record','เอกสารส่งต่อ'),
    reviewer_record: t('Clinician record','บันทึกผู้ทบทวน'), label_photo: t('Label photo','ภาพฉลาก'),
    reverse_photo: t('Reverse photo','ภาพด้านหลัง'), additional_photo: t('Additional photo','ภาพเพิ่มเติม'),
    other_record: t('Written record','เอกสารต้นทาง'),
  }
  return [names[entry.source.kind], entry.source.organization, entry.source.reporter].filter(Boolean).join(' · ')
}
export const currentUseLabels = (t: Say): Record<Interview['current_use'],string> => ({
  uncertain:t('Uncertain','ยังไม่แน่ใจ'),current:t('Currently taking','กำลังใช้'),reported_stopped:t('Reported stopped','แจ้งว่าหยุดใช้'),
  discontinued_order:t('Documented discontinuation','มีคำสั่งหยุดยา'),not_owned:t('Belongs to someone else','เป็นยาของผู้อื่น'),
})
export const ownerLabels = (t: Say): Record<Interview['ownership'],string> => ({
  uncertain:t('Uncertain','ยังไม่แน่ใจ'),patient:t('Patient','ผู้ป่วย'),other:t('Someone else','ผู้อื่น'),
})
export function needsIdentity(row: AdmissionRow) {
  return row.unknown && !row.confirmed && Boolean(row.proposal || row.referred ||
    ['current','uncertain'].includes(row.interview?.current_use ?? ''))
}
