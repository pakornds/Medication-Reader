import { useState } from 'react'
import { Button } from '../../components/ui/Button'
import { InputField } from '../../components/ui/InputField'
import { intake } from '../../i18n/intake'
import type { Language } from '../../i18n/messages'
import { regimenText } from '../../i18n/regimen'
import type { CatalogueMatch } from '../new-patient/draft'
import { FacilityDetails } from '../new-patient/FacilityDetails'
import { ScheduleEditor } from '../new-patient/DirectionsEditor'
import { emptySchedule } from '../new-patient/regimen'
import { MedicineDetails } from '../new-patient/MedicineEvidence'
import { MedicinePicker } from '../new-patient/MedicinePicker'
import { canShare, listName, say, scheduleSummary, values, type ListRow } from './listData'

export function PickProduct({ language, row, onPick }: {
  language: Language; row?: ListRow; onPick: (match: CatalogueMatch) => void
}) {
  const t = (en: string, th: string) => say(language, en, th)
  const [query, setQuery] = useState(row?.catalogueIdentity?.trade_name
    || row?.catalogueIdentity?.ingredient || row?.row.observed_names[0]?.value || '')
  return <div className="stack">
    {Boolean(row?.alternatives.length) && <div className="stack">
      <strong>{t('Suggested catalogue matches', 'ผลิตภัณฑ์ยาที่แนะนำ')}</strong>
      {row?.alternatives.map(match => <Button key={match.product.tpu} className="product-option" onClick={() => onPick(match)}>
        {match.product.label}
      </Button>)}
    </div>}
    <MedicinePicker t={intake[language]} name={query} autoFocus onChange={setQuery} onSelect={onPick} />
  </div>
}

export function ListMedicine({ row, language, selected, onSelect, onChange, onRemove }: {
  row: ListRow; language: Language; selected?: boolean
  onSelect?: () => void; onChange: (row: ListRow) => void; onRemove?: () => void
}) {
  const t = (en: string, th: string) => say(language, en, th)
  const rt = regimenText[language]
  const [panel, setPanel] = useState<'edit' | 'match' | null>(null)
  const edit = values(row)
  const title = listName(row, language)
  const qualifiers = [row.match?.product.strength || row.manualStrength || row.row.label_fields.strength?.value,
    row.match?.product.dose_form || row.manualForm || row.row.label_fields.form?.value]
    .filter(value => value && !title.toLowerCase().includes(value.toLowerCase()))
  const ready = canShare(row)
  const toggle = (next: typeof panel) => setPanel(previous => previous === next ? null : next)
  return <article className="list-medicine">
    <div className="list-medicine-main">
      {onSelect && <input type="checkbox" checked={Boolean(selected)} disabled={!ready}
        aria-label={t('Include ', 'เลือก ') + title} onChange={onSelect} />}
      <div className="min-w-0">
        <h3>{title}</h3>
        {qualifiers.length > 0 && <p className="hint">{qualifiers.join(' · ')}</p>}
        {!ready && <p className="list-needs-match">{t('Match needed', 'ต้องเลือกผลิตภัณฑ์ยา')}</p>}
        {row.suggested && <small>{t('Suggested match', 'ผลจับคู่ที่แนะนำ')}</small>}
        {row.row.discrepancies.length > 0 && <p className="list-needs-match">{t('Check conflicting source details', 'ตรวจสอบข้อมูลต้นทางที่ขัดแย้งกัน')}</p>}
      </div>
      <div className="list-directions">
        {edit.schedules.map(schedule => scheduleSummary(schedule, language)).filter(Boolean).map((value, i) => <p key={i}>{value}</p>)}
        {edit.wording && <p className="hint">{edit.wording}</p>}
        {edit.quantity && <small>{t('Quantity', 'จำนวนที่ระบุ')} · {edit.quantity}</small>}
      </div>
      <div className="actions list-row-actions">
        <Button variant={ready ? 'text' : 'secondary'} aria-expanded={panel === 'match'} onClick={() => toggle('match')}>
          {ready ? t('Change match', 'เปลี่ยนผลิตภัณฑ์') : t('Choose match', 'เลือกผลิตภัณฑ์')}
        </Button>
        <Button variant="text" aria-expanded={panel === 'edit'} onClick={() => toggle('edit')}>{t('Edit', 'แก้ไข')}</Button>
      </div>
    </div>
    {panel === 'match' && <div className="list-row-panel">
      <PickProduct language={language} row={row} onPick={match => {
        onChange({ ...row, match, suggested: false })
        setPanel(null)
      }} />
      {row.match && <Button variant="text" onClick={() => onChange({ ...row, match: undefined, suggested: false })}>
        {t('Clear product match', 'ล้างผลิตภัณฑ์ที่เลือก')}
      </Button>}
    </div>}
    {panel === 'edit' && <div className="list-row-panel stack">
      {!row.match && <InputField label={t('Name as written', 'ชื่อยาตามต้นฉบับ')} value={row.manualName ?? ''}
        onChange={e => onChange({ ...row, manualName: e.target.value })} />}
      {!row.match && <div className="field-pair">
        <InputField label={intake[language].strength} value={row.manualStrength ?? row.row.label_fields.strength?.value ?? ''}
          onChange={e => onChange({ ...row, manualStrength: e.target.value })}/>
        <InputField label={intake[language].form} value={row.manualForm ?? row.row.label_fields.form?.value ?? ''}
          onChange={e => onChange({ ...row, manualForm: e.target.value })}/>
      </div>}
      <div className="field-pair">
        <label>{rt.kind}<select value={edit.basis} onChange={e => onChange({
          ...row, edit: { ...edit, basis: e.target.value as typeof edit.basis },
        })}>
          <option value="documented">{rt.other_record}</option>
          <option value="reported">{rt.patient_report}</option>
        </select></label>
        <InputField label={rt.quantity} value={edit.quantity} onChange={e => onChange({
          ...row, edit: { ...edit, quantity: e.target.value },
        })}/>
      </div>
      <label>{rt.wording}<textarea rows={2} value={edit.wording} onChange={e => onChange({
        ...row, edit: { ...edit, wording: e.target.value },
      })}/></label>
      {edit.schedules.map((schedule, i) => <div className="stack" key={schedule.id}>
        <ScheduleEditor s={schedule} t={rt} showCompletion={false} onChange={next => onChange({
          ...row, edit: { ...edit, schedules: edit.schedules.map((value, index) => index === i ? next : value) },
        })}/>
        {edit.schedules.length > 1 && <Button variant="text" onClick={() => onChange({
          ...row, edit: { ...edit, schedules: edit.schedules.filter((_, index) => index !== i) },
        })}>{rt.remove}</Button>}
      </div>)}
      <details><summary>{t('Source details', 'รายละเอียดแหล่งข้อมูล')}</summary>
        <div className="stack">
          <InputField label={intake[language].organization} value={(edit.facility ?? row.facility)?.organization ?? ''}
            onChange={e => onChange({ ...row, edit: { ...edit, facility: { ...(edit.facility ?? row.facility), organization: e.target.value } } })}/>
          <FacilityDetails t={intake[language]} value={edit.facility ?? row.facility}
            onChange={contact => onChange({ ...row, edit: { ...edit, facility: { ...(edit.facility ?? row.facility), ...contact } } })}/>
        </div>
      </details>
      <div className="actions">
        <Button onClick={() => onChange({ ...row, edit: { ...edit, schedules: [...edit.schedules, emptySchedule()] } })}>{rt.add}</Button>
        <Button variant="text" onClick={() => setPanel(null)}>{t('Done', 'เสร็จแล้ว')}</Button>
        {onRemove && <Button variant="text" onClick={onRemove}>{t('Remove row', 'ลบรายการ')}</Button>}
      </div>
    </div>}
    {row.row.sources.length > 0 && <MedicineDetails {...row} language={language} />}
  </article>
}
