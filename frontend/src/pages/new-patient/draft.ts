import type { RegimenComponent } from '../../api/contracts'
import type { PercentBox } from '../../components/ui/RegionOutline'
import type { Language } from '../../i18n/messages'

export type PhotoKind = 'label_photo' | 'reverse_photo' | 'additional_photo'
export type NoteKind = 'patient_report' | 'caregiver_report' | 'other_record'
export type Box = PercentBox
export type Region = { id: string; rowId: string; box: Box; organization: string }
export type Photo = {
  id: string
  kind: PhotoKind
  file: File
  regions: Region[]
  date: string
}
export type Note = { id: string; kind: NoteKind; text: string; author: string; date: string }
export type Ref = { source_id: string; item_id?: string | null }
export type Fact = { value: string; evidence: Ref }
export type Suggestion = {
  id: string
  identity_status: string
  unknown_label?: string | null
  observed_names: Fact[]
  sources: Ref[]
  label_fields: Record<string, { value?: string | null; status: string; evidence?: Ref | null }>
  regimens?: RegimenComponent[]
  reported_use: Fact[]
  discrepancies: { id: string; observed_values: Fact[]; question: string }[]
  follow_ups: { question: string }[]
  reverse_crop?: Ref | null
}
export type Preview = { case_id: string; rows: Suggestion[]; unassigned_reports: Fact[] }
export type Product = {
  tpu: string
  label: string
  active_tmt: boolean
  strength: string
  dose_form: string
}
export type CatalogueMatch = { product: Product; release: string }
export type Evidence = { photos: Photo[]; notes: Note[]; question: string }
export type Medicine = {
  row: Suggestion
  evidence: Evidence
  origin: 'analysis' | 'manual'
  catalogue?: CatalogueMatch
}
export type Draft = {
  caseId: string
  evidence: Evidence
  medicines: Medicine[]
  preview: Preview | null
}

export function newNote(kind: NoteKind): Note {
  return { id: crypto.randomUUID(), kind, text: '', author: '', date: '' }
}
export function createDraft(): Draft {
  return {
    caseId: crypto.randomUUID(),
    medicines: [],
    preview: null,
    evidence: { photos: [], notes: [newNote('patient_report'), newNote('other_record')], question: '' },
  }
}

export function rowName(row: Suggestion, language: Language) {
  return (
    row.observed_names.map((fact) => fact.value).join(' / ') ||
    row.unknown_label ||
    (language === 'th' ? 'ยาไม่ทราบชื่อ' : 'Unknown medicine')
  )
}

// A reverse-side crop is linked only while its matching front-side item exists.
export function replacePhoto(
  evidence: Evidence,
  previousId: string | undefined,
  next?: Photo,
): Evidence {
  const previous = evidence.photos.find((photo) => photo.id === previousId)
  if (!previous) return next ? { ...evidence, photos: [...evidence.photos, next] } : evidence

  const retainedItems = new Set(next?.regions.map((region) => region.id))
  const removedRows = new Set(
    previous.regions
      .filter((region) => previous.kind !== 'reverse_photo' && !retainedItems.has(region.id))
      .map((region) => region.rowId),
  )
  const photos: Photo[] = []
  for (const photo of evidence.photos) {
    if (photo.id === previousId) {
      if (next) photos.push(next)
    } else if (
      photo.kind === 'reverse_photo' &&
      photo.regions.some((region) => removedRows.has(region.rowId))
    ) {
      const regions = photo.regions.map((region) =>
        removedRows.has(region.rowId) ? { ...region, rowId: region.id } : region,
      )
      photos.push({ ...photo, regions })
    } else {
      photos.push(photo)
    }
  }
  return { ...evidence, photos }
}

// Confirmed suggestions retain their original evidence even after staff edit intake.
export function hasEarlierEvidence(medicine: Medicine, current: Evidence): boolean {
  if (medicine.origin === 'manual') return false
  return medicine.row.sources.some((ref) => {
    const note = medicine.evidence.notes.find((source) => source.id === ref.source_id)
    if (note) return !current.notes.includes(note)
    const photo = medicine.evidence.photos.find(
      (source) =>
        source.id === ref.source_id || source.regions.some((region) => region.id === ref.source_id),
    )
    return photo !== undefined && !current.photos.includes(photo)
  })
}
