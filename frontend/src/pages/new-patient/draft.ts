import type { AnalysisPreview, DispensingFacility, EvidenceRef, RegimenComponent, SourcedValue } from '../../api/contracts'
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
export type Ref = EvidenceRef
export type Fact = SourcedValue
export type RegimenField = Exclude<keyof RegimenComponent['evidence'], 'directions_text'>
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
export type Preview = Omit<AnalysisPreview, 'rows' | 'unassigned_reports'> & {
  rows: Suggestion[]
  unassigned_reports: Fact[]
}
export type Product = {
  tpu: string
  label: string
  active_tmt: boolean
  strength: string
  dose_form: string
}
export type CatalogueMatch = { product: Product; release: string; evidence?: Ref }
export type Evidence = { photos: Photo[]; notes: Note[]; question: string }
export type MedicineEvidence = {
  row: Suggestion
  evidence: Evidence
  facility?: DispensingFacility
}
export type DraftValues = { name: string; strength: string; form: string; directions: string }
export type Medicine = MedicineEvidence & {
  origin: 'analysis' | 'manual'
  catalogue?: CatalogueMatch
  originalCatalogue?: CatalogueMatch
  corrections?: Partial<DraftValues>
  linkedScans?: MedicineEvidence[]
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
  if (row.observed_names.length > 1) {
    return language === 'th' ? 'พบหลายชื่อในหลักฐาน' : 'Multiple names in evidence'
  }
  return (
    row.observed_names[0]?.value ||
    row.unknown_label ||
    (language === 'th' ? 'ยาไม่ทราบชื่อ' : 'Unknown medicine')
  )
}

function sourcedValues(medicine: Medicine): DraftValues {
  const { row } = medicine
  const catalogue = medicine.originalCatalogue ?? (medicine.catalogue?.evidence ? undefined : medicine.catalogue)
  return {
    name: row.observed_names.length === 1 ? row.observed_names[0].value : '',
    strength: row.label_fields.strength?.value ?? catalogue?.product.strength ?? '',
    form: row.label_fields.form?.value ?? catalogue?.product.dose_form ?? '',
    directions: row.label_fields.directions?.value ?? '',
  }
}

export function draftValues(medicine: Medicine): DraftValues {
  return { ...sourcedValues(medicine), ...medicine.corrections }
}

export function withDraftValues(medicine: Medicine, values: DraftValues): Medicine {
  const original = sourcedValues(medicine)
  const corrections: Partial<DraftValues> = {}
  for (const field of ['name', 'strength', 'form', 'directions'] as const) {
    if (values[field] !== original[field]) corrections[field] = values[field]
  }
  return { ...medicine, corrections: Object.keys(corrections).length ? corrections : undefined }
}

export function medicineName(medicine: Medicine, language: Language) {
  if (medicine.row.identity_status === 'named' && medicine.corrections?.name === '') {
    return language === 'th' ? 'ยาไม่ทราบชื่อ' : 'Unknown medicine'
  }
  return (medicine.row.identity_status === 'named' && draftValues(medicine).name)
    || rowName(medicine.row, language)
}

export function scanEvidence(preview: Preview, row: Suggestion, evidence: Evidence): MedicineEvidence {
  const facility = preview.dispensing_facilities?.[row.id]
  const ref = facility?.evidence
  const cited = ref && row.sources.some((source) => (
    source.source_id === ref.source_id && (source.item_id ?? null) === (ref.item_id ?? null)
  ))
  return { row, evidence, facility: cited ? facility : undefined }
}

export function knownOrder(medicines: Medicine[], scanId: string) {
  return medicines.find((medicine) => (
    medicine.row.id === scanId || medicine.linkedScans?.some(({ row }) => row.id === scanId)
  ))
}

export function linkScan(medicine: Medicine, scan: MedicineEvidence): Medicine {
  const scans = medicine.linkedScans ?? []
  const prior = medicine.origin === 'analysis' ? [medicine, ...scans] : scans
  if (prior.some((entry) => (
    !hasEarlierEvidence(entry, scan.evidence)
    && JSON.stringify(entry.row) === JSON.stringify(scan.row)
    && JSON.stringify(entry.facility) === JSON.stringify(scan.facility)
  ))) return medicine
  return { ...medicine, linkedScans: [...scans, scan] }
}

export function photoCitation(evidence: Evidence, reference: Ref) {
  const photo = evidence.photos.find((source) => (
    source.id === reference.source_id || source.regions.some((region) => region.id === reference.source_id)
  ))
  if (!photo) return undefined
  const sourceRegion = photo.regions.find((region) => region.id === reference.source_id)
  const region = reference.item_id
    ? photo.regions.find(({ id }) => id === reference.item_id)
    : sourceRegion
  if ((reference.item_id && !region) || (sourceRegion && sourceRegion !== region)) return undefined
  return { photo, region }
}

export function hasCaseWork({ evidence, medicines, preview }: Draft): boolean {
  return Boolean(medicines.length || preview || evidence.photos.length || evidence.question ||
    evidence.notes.length !== 2 || evidence.notes.some(note => note.text || note.author || note.date || note.kind === 'caregiver_report'))
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
export function hasEarlierEvidence(medicine: MedicineEvidence, current: Evidence): boolean {
  return medicine.row.sources.some((ref) => {
    const note = medicine.evidence.notes.find((source) => source.id === ref.source_id)
    if (note) return !current.notes.includes(note)
    const earlier = photoCitation(medicine.evidence, ref)
    if (!earlier) return false
    const latest = photoCitation(current, ref)
    return !latest || earlier.photo.file !== latest.photo.file || earlier.photo.date !== latest.photo.date
      || earlier.region !== latest.region
  })
}
