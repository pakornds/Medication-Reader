import type { Draft, Evidence, Preview } from '../pages/new-patient/draft'
import { createClient } from './client'
import type { EvidenceItem, FormAnalysisInput } from './contracts'

const client = createClient(import.meta.env.VITE_API_BASE_URL)
export function analysisForm(caseId: string, evidence: Evidence): FormData {
  const notes = evidence.notes.filter((note) => note.text.trim())
  const { photos } = evidence
  const sources = [
    ...photos.flatMap((photo) => [
      { id: photo.id, kind: photo.kind, attachment_id: photo.id, source_date: photo.date || null },
      ...photo.regions.map((region) => ({
        id: region.id,
        kind: photo.kind,
        attachment_id: photo.id,
        organization: region.organization.trim() || null,
        source_date: photo.date || null,
      })),
    ]),
    ...notes.map((note) => ({
      id: note.id,
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
          [id]: `Region in uploaded image: x=${box.x}%, y=${box.y}% from top left; width=${box.w}%, height=${box.h}%`,
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
      region_locations: locations,
    } satisfies FormAnalysisInput),
  )
  for (const photo of photos) body.append('photos', photo.file)
  return body
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
