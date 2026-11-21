import type { Encounter } from '../api/admission'
import type { createClient } from '../api/client'
import type { CaptureCommand, PackageCapture, RegionBounds } from '../api/contracts'
import type { Draft, Photo } from '../pages/new-patient/draft'
import { admitDraft } from './admitDraft'

export async function proposePhotoRegions(client: ReturnType<typeof createClient>, draft: Draft,
  encounter: Encounter | null, photo: Photo, onEncounter: (record: Encounter) => void): Promise<RegionBounds[]> {
  if (photo.kind === 'additional_photo' || !draft.evidence.photos.some(p => p.id === photo.id))
    throw new Error('Choose a current front or reverse view.')
  const front = draft.evidence.photos.find(p => p.kind === 'label_photo')
  if (!front) throw new Error('Start with the front label photo.')
  const id = 'admission-' + draft.caseId.replaceAll('-', '')
  if (encounter && encounter.id !== id) throw new Error('Start or resume the matching encounter.')
  let record = encounter ? await client.encounter(id) : await admitDraft(client, { ...draft, medicines: [] })
  onEncounter(record)
  const side = photo.kind === 'label_photo' ? 'front' : 'reverse'
  // Save new originals in separate commands because each retake declares the exact view it replaces.
  for (const [viewSide, image] of (side === 'front' ? [['front', front]] : [['front', front], ['reverse', photo]]) as Array<['front'|'reverse',Photo]>) {
    const previous = record.capture
    const current = previous?.[viewSide]
    if (current?.attachment_id === image.id) continue
    const revision = (current?.revision ?? 0) + 1
    const view = { attachment_id: image.id, revision, regions: [] }
    const manifest: PackageCapture = { ...(previous ?? { case_id: id, front: view }), [viewSide]: view }
    if (current) {
      // Do not erase evaluated photo evidence as a side effect of asking for suggestions.
      if (previous?.packages?.some(p => p.items?.length)) throw new Error('Review this retake before requesting new suggestions.')
      manifest.packages = []
      manifest.reverse_matches = []
      manifest.sources = []
    }
    const command: CaptureCommand = { request_id: 'intake-view-' + image.id + '-' + record.revision,
      revision: record.revision, manifest,
      ...(current ? { replaces_view: { side: viewSide, attachment_id: current.attachment_id, revision: current.revision } } : {}) }
    record = await client.capture(id, command, { [viewSide]: image.file })
    onEncounter(record)
  }
  const view = record.capture?.[side]
  if (!view || view.attachment_id !== photo.id) throw new Error('The photo was replaced.')
  const result = await client.proposeRegions(id, { side, attachment_id: photo.id, revision: view.revision })
  if (result.case_id !== id || result.attachment_id !== photo.id || result.revision !== view.revision || result.side !== side)
    throw new Error('The selected view changed.')
  return result.regions
}
