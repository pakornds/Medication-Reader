import type { Encounter } from '../api/admission'
import type { Language } from '../i18n/messages'
import { medicineName } from '../pages/new-patient/draft'
import { selectedExcerpt, type sharedDocuments, type DocumentExcerpts } from './admitDraft'

export function SharedDocumentExcerpts({ documents, encounter, excerpts, onChange, language }: {
  documents: ReturnType<typeof sharedDocuments>; encounter?: Encounter; excerpts: DocumentExcerpts
  onChange: (rid: string, sid: string, value: string) => void; language: Language
}) {
  const th = language === 'th'
  return documents.map(({ note, rows }) => <fieldset key={note.id} className="stack">
    <legend>{[th ? 'เอกสารที่ใช้อ้างอิงร่วมกัน' : 'Shared document', note.author, note.date].filter(Boolean).join(' · ')}</legend>
    <blockquote style={{whiteSpace:'pre-wrap'}}>{note.text}</blockquote>
    {[...rows].map(medicine => {
      const value=selectedExcerpt(excerpts, encounter, medicine.row.id, note.id)
      const invalid=Boolean(value && !note.text.includes(value))
      return <label key={medicine.row.id}>
        {th ? 'คัดลอกข้อความต้นฉบับสำหรับ' : 'Copy the exact source passage for'} {medicineName(medicine, language)}
        <textarea required value={value} aria-invalid={invalid} onChange={e => onChange(medicine.row.id, note.id, e.target.value)} />
        {invalid && <small>{th ? 'กรุณาใช้ข้อความที่ตรงกับเอกสารต้นฉบับด้านบน' : 'Use wording that appears in the source document above.'}</small>}
      </label>
    })}
  </fieldset>)
}
