import type { Encounter, AdmissionRow } from '../../api/admission'
import type { Entry } from './review'

export async function entryCrop(entry: Entry) {
  if (!entry.photo) return null
  const image = new Image()
  image.src = 'data:' + entry.photo.media_type + ';base64,' + entry.photo.data
  await image.decode()
  const [x, y, w, h] = entry.photo.region
  const width = w * image.naturalWidth,
    height = h * image.naturalHeight
  const scale = Math.min(1, 640 / Math.max(width, height))
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(width * scale))
  canvas.height = Math.max(1, Math.round(height * scale))
  const context = canvas.getContext('2d')
  if (!context) return null
  context.drawImage(
    image,
    x * image.naturalWidth,
    y * image.naturalHeight,
    width,
    height,
    0,
    0,
    canvas.width,
    canvas.height,
  )
  return canvas.toDataURL()
}

export function rowRegions(encounter: Encounter, row: AdmissionRow) {
  const item = encounter.capture?.packages
    ?.find((p) => p.id === row.package_id)
    ?.items?.find((i) => i.row_id === row.capture_item_id)
  return item?.evidence.filter(evidence => !row.superseded.includes(evidence.source_id)) || []
}
