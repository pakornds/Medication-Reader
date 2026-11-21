import { InputField } from '../../components/ui/InputField'
import type { IntakeText } from '../../i18n/intake'
import type { FacilityContact } from './draft'

export function FacilityDetails({value={},onChange,t}: {value?:FacilityContact;onChange:(v:FacilityContact)=>void;t:IntakeText}) {
  const fields = ['department_or_ward','organization_address','organization_phone','organization_phone_extension','organization_email'] as const
  return <details><summary>{t.facilityContact}</summary><div className="field-pair">
    <label>{t.facilityType}<select value={value.organization_type ?? ''} onChange={e=>{
      onChange({...value, organization_type:e.target.value as FacilityContact['organization_type'] || undefined})
    }}><option value="">{t.unspecifiedFacility}</option>{(['clinic','hospital','community_pharmacy','other'] as const).map(k=><option key={k} value={k}>{t[k]}</option>)}</select></label>
    {fields.map(k=><InputField key={k} label={t[k]} value={value[k] ?? ''} onChange={e=>onChange({...value,[k]:e.target.value.trim()?e.target.value:undefined})}/>)}
  </div></details>
}
