import type { createClient } from '../api/client'
import type { Encounter } from '../api/admission'
import type { DispensingFacility, EvidenceItem, EvidenceSource, RegionBounds } from '../api/contracts'
import type { Draft, Medicine, CatalogueMatch, Suggestion } from '../pages/new-patient/draft'

type Original = { media_type: string; data: string }
type IntakePart = {
  row: Suggestion
  origin: Medicine['origin']
  catalogue: CatalogueMatch | null
  sources: EvidenceSource[]
  items: EvidenceItem[]
  notes: Record<string, string>
  regions: Record<string, RegionBounds>
  physical_items: Record<string, string>
}

type Edits = Record<'name' | 'strength' | 'form' | 'directions', string>
type Snapshot = Pick<Medicine, 'row' | 'evidence'> & { facility?: DispensingFacility }
type EditableMedicine = Medicine & Snapshot & { corrections?: Edits; linkedScans?: Snapshot[] }
type IntakeRow = IntakePart & { linked: IntakePart[]; corrections: Partial<Edits> }

export type IntakeCommand = {
  case_id: string
  revision: number
  rows: IntakeRow[]
  originals: Record<string, Original>
}

function prepareSnapshot({ row, evidence, facility }: Snapshot, originals: Map<string, File>,
  origin: Medicine['origin'], catalogue: CatalogueMatch | null): IntakePart {
  const sources = new Map<string, EvidenceSource>()
  const items: EvidenceItem[] = []
  const notes: Record<string, string> = {}
  const regions: Record<string, RegionBounds> = {}
  const physicalItems: Record<string, string> = {}

  for (const ref of row.sources) {
    let dispensing: Omit<DispensingFacility, 'evidence'> | undefined
    if (facility && facility.evidence.source_id === ref.source_id && (facility.evidence.item_id ?? null) === (ref.item_id ?? null)) {
      const { organization, organization_type, department_or_ward, organization_address,
        organization_phone, organization_phone_extension, organization_email } = facility
      dispensing = { organization, organization_type, department_or_ward, organization_address,
        organization_phone, organization_phone_extension, organization_email }
    }
    const note = evidence.notes.find(n => n.id === ref.source_id)
    if (note) {
      sources.set(note.id, {
        id: note.id, kind: note.kind, source_date: note.date || null,
        ...(note.kind === 'other_record' ? { ...note.facilityContact, organization: note.author || null } : { reporter: note.author || null }), ...dispensing,
      })
      notes[note.id] = note.text
      if (ref.item_id) items.push({ id: ref.item_id, source_id: note.id, row_id: row.id, kind: 'record_excerpt' })
      continue
    }
    const photo = evidence.photos.find(p => p.id === ref.source_id || p.regions.some(r => r.id === ref.source_id))
    const region = photo?.regions.find(r => r.id === ref.item_id)
    if (!photo || !region || (photo.id !== ref.source_id && region.id !== ref.source_id)) throw new Error('The draft contains a photo reference without a located original.')
    const existing = originals.get(photo.id)
    if (existing && existing !== photo.file) throw new Error('One attachment has different originals. Review the retake.')
    originals.set(photo.id, photo.file)
    sources.set(ref.source_id, {
      id: ref.source_id, kind: photo.kind, attachment_id: photo.id,
      ...region.facilityContact, organization: region.organization || null, source_date: photo.date || null, ...dispensing,
    })
    const label = photo.kind !== 'reverse_photo'
    items.push({ id: region.id, source_id: ref.source_id, row_id: row.id, kind: label ? 'label_region' : 'pill_crop' })
    physicalItems[region.id] = region.rowId
    regions[region.id] = { x: region.box.x / 100, y: region.box.y / 100,
      width: region.box.w / 100, height: region.box.h / 100 }
  }
  return { row, origin, catalogue,
    sources: [...sources.values()], items, notes, regions, physical_items: physicalItems }
}

function prepareMedicine(medicine: EditableMedicine, originals: Map<string, File>): IntakeRow {
  const primary = prepareSnapshot(medicine, originals, medicine.origin, medicine.catalogue ?? null)
  const linked = (medicine.linkedScans ?? []).map(snapshot => prepareSnapshot(snapshot, originals, 'analysis', null))
  const { row, catalogue } = medicine
  const before: Edits = {
    name: row.observed_names.length === 1 ? row.observed_names[0].value : '',
    strength: row.label_fields.strength?.value ?? catalogue?.product.strength ?? '',
    form: row.label_fields.form?.value ?? catalogue?.product.dose_form ?? '',
    directions: row.label_fields.directions?.value ?? '',
  }
  const corrections: Partial<Edits> = {}
  for (const key of Object.keys(before) as Array<keyof Edits>) {
    if (medicine.corrections && before[key] !== medicine.corrections[key])
      corrections[key] = medicine.corrections[key]
  }
  return { ...primary, linked, corrections }
}

function encode(file: File): Promise<Original> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(new Error('Could not read the original medication photo.'))
    reader.onload = () => {
      const data = String(reader.result).split(',')[1]
      if (data) resolve({ media_type: file.type, data })
      else reject(new Error('The original medication photo is empty.'))
    }
    reader.readAsDataURL(file)
  })
}

export async function admitDraft(client: ReturnType<typeof createClient>, draft: Draft,
  encounter: Encounter | null = null): Promise<Encounter> {
  if (encounter && encounter.id !== "admission-" + draft.caseId.replaceAll("-", ""))
    throw new Error("Choose the encounter for this draft.")
  const originals = new Map<string, File>()
  const rows = draft.medicines.map(m => prepareMedicine(m, originals))
  const uploads = await Promise.all([...originals].filter(([id]) => !encounter?.intake_attachments?.includes(id))
    .map(async ([id, file]) => [id, await encode(file)] as const))
  return client.admitIntake({ case_id: draft.caseId, revision: encounter?.revision ?? 0, rows,
    originals: Object.fromEntries(uploads) })
}
