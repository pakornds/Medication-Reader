import type { Draft, Evidence, Preview } from '../pages/new-patient/draft'
import { createClient } from './client'
import type { EvidenceItem, FormAnalysisInput } from './contracts'

const client = createClient(import.meta.env.VITE_API_BASE_URL)
export function analysisForm(caseId: string, evidence: Evidence): FormData {
  const notes = evidence.notes.filter((note) => note.text.trim())
  // A detected reverse-side item contributes to a row only after the reviewer places it.
  const photos = evidence.photos.flatMap(photo => {
    if (!photo.regions.some(region => region.pendingPair)) return [photo]
    const regions = photo.regions.filter(region => !region.pendingPair)
    return regions.length ? [{...photo,regions}] : []
  })
  const sources = [
    ...photos.flatMap((photo) => [
      { id: photo.id, kind: photo.kind, attachment_id: photo.id, source_date: photo.date || null },
      ...photo.regions.map((region) => ({
        id: region.id,
        kind: photo.kind,
        attachment_id: photo.id,
        ...region.facilityContact,
        organization: region.organization.trim() || null,
        source_date: photo.date || null,
      })),
    ]),
    ...notes.map((note) => ({
      id: note.id,
      ...(note.kind==='other_record' ? note.facilityContact : {}),
      kind: note.kind,
      source_date: note.date || null,
      [note.kind === 'other_record' ? 'organization' : 'reporter']: note.author.trim() || null,
    })),
  ]
  const items = photos.flatMap((photo) =>
    photo.regions.map((region): EvidenceItem => ({
      id: region.id,
      source_id: region.id,
      row_id: region.rowId,
      kind: photo.kind === 'reverse_photo' ? 'pill_crop' : 'label_region',
    })),
  )
  const locations = Object.fromEntries(
    photos.flatMap((photo) =>
      photo.regions.map(({ id, box }) => [
        id,
        {
          [id]: [box.x, box.y, box.w, box.h].map(value => +value.toFixed(8) + '%').join(','),
        },
      ]),
    ),
  )
  const facts = (report: boolean) =>
    notes
      .filter((note) => (note.kind !== 'other_record') === report)
      .map((note) => ({ value: note.text, evidence: { source_id: note.id } }))
  const body = new FormData()
  body.append(
    'form',
    JSON.stringify({
      evidence: { case_id: caseId, sources, items },
      patient_report: facts(true),
      other_source_notes: facts(false),
      question: evidence.question.trim() || null,
      photo_source_ids: photos.map((photo) => photo.id),
      scene_photo_ids: photos.filter(photo => !photo.regions.length).map(photo => photo.id),
      region_locations: locations,
    } satisfies FormAnalysisInput),
  )
  for (const photo of photos) body.append('photos', photo.file)
  return body
}

export function applyLocatedRegions(evidence: Evidence, preview: Preview): Evidence {
  const discovered = preview.located_regions
  if (!discovered?.length) return evidence
  const hasFront = evidence.photos.some(photo => photo.kind === 'label_photo')
  const photos = evidence.photos.map(photo => {
    const located = discovered.filter(item => item.attachment_id === photo.id)
    if (!located.length) return photo
    const additions = located.filter(item => !photo.regions.some(region => region.id === item.item_id))
      .map(({item_id, row_id, bounds}) => ({
        id: item_id, rowId: row_id, organization: '',
        pendingPair: photo.kind === 'reverse_photo' && hasFront ? true : undefined,
        box: { x: bounds.x * 100, y: bounds.y * 100, w: bounds.width * 100, h: bounds.height * 100 },
      }))
    return { ...photo, regions: [...photo.regions, ...additions] }
  })
  return { ...evidence, photos }
}

export async function analyze(draft: Draft, signal: AbortSignal): Promise<Preview> {
  const preview = await client.analyzeForm(analysisForm(draft.caseId, draft.evidence), signal)
  if (preview.case_id !== draft.caseId || !Array.isArray(preview.rows)) throw new Error('case')
  return {
    ...preview, unassigned_reports: preview.unassigned_reports ?? [],
    rows: preview.rows.map(row => ({
      ...row, observed_names: row.observed_names ?? [], reported_use: row.reported_use ?? [],
      label_fields: row.label_fields ?? {}, discrepancies: row.discrepancies ?? [], follow_ups: row.follow_ups ?? [],
    })),
  }
}

export const searchProducts = client.products

export const parseRegimen = client.parseRegimen
