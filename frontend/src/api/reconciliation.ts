import type { Draft, Evidence, Preview, Product } from '../pages/new-patient/draft'

const base = (import.meta.env.VITE_API_BASE_URL || '').replace(/\/$/, '')
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
    photo.regions.map((region) => ({
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
    }),
  )
  for (const photo of photos) body.append('photos', photo.file)
  return body
}

export async function analyze(draft: Draft, signal: AbortSignal): Promise<Preview> {
  const response = await fetch(base + '/medication-analysis', {
    method: 'POST',
    body: analysisForm(draft.caseId, draft.evidence),
    signal,
  })
  if (!response.ok) throw new Error('analysis')
  const preview: Preview = await response.json()
  if (preview.case_id !== draft.caseId || !Array.isArray(preview.rows)) throw new Error('case')
  return preview
}

export async function searchProducts(
  query: string,
  signal: AbortSignal,
): Promise<{ products: Product[]; tmt_release: string }> {
  const response = await fetch(base + '/checks/local/products?' + new URLSearchParams({ q: query }), {
    signal,
  })
  if (!response.ok) throw new Error('catalogue')
  return response.json()
}
