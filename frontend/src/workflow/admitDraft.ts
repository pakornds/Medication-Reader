import type { createClient } from '../api/client'
import type { Encounter } from '../api/admission'
import type { CatalogueIdentity, DispensingFacility, EvidenceItem, EvidenceSource, RegionBounds } from '../api/contracts'
import { hasEarlierEvidence, photoCitation, type Draft, type Medicine, type Note, type MedicineEvidence, type DraftValues, type CatalogueMatch, type Suggestion } from '../pages/new-patient/draft'

type Original = { media_type: string; data: string }
type IntakePart = {
  row: Suggestion
  origin: Medicine['origin']
  catalogue: CatalogueMatch | null
  catalogue_identity?: CatalogueIdentity
  sources: EvidenceSource[]
  items: EvidenceItem[]
  notes: Record<string, string>
  regions: Record<string, RegionBounds>
  physical_items: Record<string, string>
}

export type DocumentExcerpts = Record<string, Record<string, string>>
type IntakeRow = IntakePart & { linked: IntakePart[]; corrections: Partial<DraftValues>; document_excerpts?: Record<string, string> }

export function sharedDocuments(medicines: Medicine[]) {
  const documents = new Map<string, { note: Note; rows: Set<Medicine> }>()
  for (const medicine of medicines) {
    for (const part of [medicine, ...(medicine.linkedScans ?? [])]) {
      for (const note of part.evidence.notes) {
        if (note.kind !== 'other_record' || !part.row.sources.some(ref => ref.source_id === note.id)) continue
        const document = documents.get(note.id) ?? { note, rows: new Set<Medicine>() }
        document.rows.add(medicine)
        documents.set(note.id, document)
      }
    }
  }
  return [...documents.values()].filter(document => document.rows.size > 1)
}

export function selectedExcerpt(excerpts: DocumentExcerpts, encounter: Encounter | undefined, rowId: string, sourceId: string) {
  return excerpts[rowId]?.[sourceId] ?? encounter?.rows[rowId]?.intake_document_excerpts?.[sourceId] ?? ''
}

export type IntakeCommand = {
  case_id: string
  current_views: Partial<Record<'front' | 'reverse', string>>
  revision: number
  rows: IntakeRow[]
  originals: Record<string, Original>
}

function attributedFacility(facility: DispensingFacility | undefined, ref: Suggestion['sources'][number]): Partial<EvidenceSource> {
  if (!facility || facility.evidence.source_id !== ref.source_id || (facility.evidence.item_id ?? null) !== (ref.item_id ?? null))
    return {}
  const details: Partial<EvidenceSource> = { organization: facility.organization }
  for (const key of ['department_or_ward', 'organization_address', 'organization_phone', 'organization_phone_extension', 'organization_email'] as const) {
    if (facility[key]) details[key] = facility[key]
  }
  if (facility.organization_type) details.organization_type = facility.organization_type
  return details
}

function prepareSnapshot({ row, evidence, facility, catalogueIdentity }: MedicineEvidence, originals: Map<string, File>,
  origin: Medicine['origin'], catalogue: CatalogueMatch | null, currentEvidence: Draft['evidence']): IntakePart {
  const sources = new Map<string, EvidenceSource>()
  const items: EvidenceItem[] = []
  const notes: Record<string, string> = {}
  const regions: Record<string, RegionBounds> = {}
  const physicalItems: Record<string, string> = {}

  for (const ref of row.sources) {
    const dispensing = attributedFacility(facility, ref)
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
    const located = photoCitation(evidence, ref)
    if (!located?.region || ref.item_id !== located.region.id) throw new Error('The draft contains a photo reference without a located original.')
    const { photo, region } = located
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
  const earlier = hasEarlierEvidence({ row, evidence }, currentEvidence)
  return { row, origin, catalogue, catalogue_identity: earlier ? undefined : catalogueIdentity,
    sources: [...sources.values()], items, notes, regions, physical_items: physicalItems }
}

function prepareMedicine(medicine: Medicine, originals: Map<string, File>, currentEvidence: Draft['evidence'],
  excerpts: Record<string, string>): IntakeRow {
  const primary = prepareSnapshot(medicine, originals, medicine.origin, medicine.catalogue ?? null, currentEvidence)
  const linked = (medicine.linkedScans ?? []).map(snapshot => prepareSnapshot(snapshot, originals, 'analysis', null, currentEvidence))
  const documentIds = new Set([primary, ...linked].flatMap(part => Object.keys(part.notes)))
  const selected = Object.fromEntries(Object.entries(excerpts).filter(([id]) => documentIds.has(id)))
  return { ...primary, linked, corrections: medicine.corrections ?? {},
    ...(Object.keys(selected).length ? { document_excerpts: selected } : {}) }
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
  encounter: Encounter | null = null, excerpts: DocumentExcerpts = {}): Promise<Encounter> {
  if (encounter && encounter.id !== "admission-" + draft.caseId.replaceAll("-", ""))
    throw new Error("Choose the encounter for this draft.")
  const originals = new Map<string, File>()
  const rows = draft.medicines.map(m => prepareMedicine(m, originals, draft.evidence, {
    ...encounter?.rows[m.row.id]?.intake_document_excerpts, ...excerpts[m.row.id],
  }))
  const uploads = await Promise.all([...originals].filter(([id]) => !encounter?.intake_attachments?.includes(id))
    .map(async ([id, file]) => [id, await encode(file)] as const))
  const current_views: IntakeCommand['current_views'] = {}
  for (const photo of draft.evidence.photos) {
    if (photo.kind !== 'additional_photo' && originals.has(photo.id))
      current_views[photo.kind === 'label_photo' ? 'front' : 'reverse'] = photo.id
  }
  return client.admitIntake({ case_id: draft.caseId, current_views, revision: encounter?.revision ?? 0, rows,
    originals: Object.fromEntries(uploads) })
}
