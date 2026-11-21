import { type CatalogueMatch, type FacilityContact } from './draft'
import { hasFields, newStatement, type Statement } from './regimen'

export type ManualEntryDraft = {
  selected?: CatalogueMatch
  name: string
  strength: string
  form: string
  source: string
  organization: string
  sourceDate: string
  facilityContact: FacilityContact
  quantity: string
  rowId: string
  statements: Statement[]
}

export function createManualEntryDraft(): ManualEntryDraft {
  return {
    name: '',
    strength: '',
    form: '',
    source: '',
    organization: '',
    sourceDate: '',
    facilityContact: {},
    quantity: '',
    rowId: crypto.randomUUID(),
    statements: [newStatement()],
  }
}

export function hasManualEntryWork(draft: ManualEntryDraft) {
  const { name, selected, strength, form, source, organization, sourceDate, facilityContact, quantity, statements } = draft
  return Boolean(name || selected || strength || form || source || organization || sourceDate ||
    Object.values(facilityContact).some(Boolean) || quantity || statements.length > 1 ||
    statements.some(({ note, schedules }) => note.text || note.kind !== 'other_record' || schedules.some(hasFields)))
}
