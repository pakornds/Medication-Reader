import type { PackageCapture, PackageEvidence, RegionLink } from '../../api/contracts'

export type Side = RegionLink['side']

export function packageLinks(scene: PackageCapture, packageId: string) {
  const pkg = scene.packages?.find(value => value.id === packageId)
  return [...(pkg?.front_regions || []), ...(scene.reverse_matches || [])
    .filter(match => match.package_id === packageId && match.status === 'confirmed').map(match => match.region)]
}

export function regionBounds(scene: PackageCapture, link: RegionLink) {
  const view = scene[link.side]
  if (!view || view.attachment_id !== link.attachment_id || view.revision !== link.revision) return
  const region = view.regions?.find(value => value.id === link.region_id)
  if (view.visibility !== 'opaque' && region?.visibility !== 'opaque') return region?.bounds
}

// The layout editor owns geometry. Keep clinical items only on evidence still attributed to their package.
export function preserveCapture(geometry: PackageCapture, previous?: PackageCapture): PackageCapture {
  if (!previous) return structuredClone(geometry)
  const result = structuredClone(geometry)
  const removed = new Set(previous.packages?.flatMap(pkg => pkg.items?.flatMap(item => item.evidence.map(e => e.source_id)) || []))
  for (const pkg of result.packages || []) {
    const before = previous.packages?.find(value => value.id === pkg.id)
    const links = packageLinks(result, pkg.id)
    pkg.items = (before?.items || []).flatMap(item => {
      const evidence = item.evidence.flatMap(value => {
        const link = links.find(link => link.side === value.region.side &&
          link.attachment_id === value.region.attachment_id && link.region_id === value.region.region_id)
        const before = regionBounds(previous, value.region)
        const after = link && regionBounds(result, link)
        if (!before || !after || before.x !== after.x || before.y !== after.y ||
            before.width !== after.width || before.height !== after.height) return []
        removed.delete(value.source_id)
        return [{ ...value, region: link! }]
      })
      return evidence.length ? [{ ...item, evidence }] : []
    })
  }
  const currentAttachments = [result.front.attachment_id, result.reverse?.attachment_id]
  const invalidatedReverse = new Set<string>()
  if (previous.front.attachment_id !== result.front.attachment_id) {
    for (const pkg of previous.packages || []) for (const item of pkg.items || [])
      for (const evidence of item.evidence) if (evidence.region.side === 'reverse') invalidatedReverse.add(evidence.source_id)
  }
  result.sources = previous.sources?.filter(source => !removed.has(source.id) && !invalidatedReverse.has(source.id) &&
    (!source.attachment_id || currentAttachments.includes(source.attachment_id)))
  return result
}

export function bindCaptureRegion(scene: PackageCapture, packageId: string, link: RegionLink,
  kind: PackageEvidence['kind'], sourceId: string, itemId: string) {
  const result = structuredClone(scene)
  const pkg = result.packages?.find(value => value.id === packageId)
  if (!pkg || !regionBounds(result, link) || !packageLinks(result, packageId).some(region =>
    region.side === link.side && region.region_id === link.region_id)) throw new Error('Select an attributed, visible region.')
  const source = { id: sourceId, kind: link.side === 'front' ? 'label_photo' as const : 'reverse_photo' as const,
    attachment_id: link.attachment_id }
  result.sources ??= []
  if (!result.sources.some(existing => existing.id === source.id)) result.sources.push(source)
  pkg.items ??= []
  let item = pkg.items.find(value => value.row_id === itemId)
  if (!item) {
    item = { row_id: itemId, kind: kind === 'appearance' ? 'pending_appearance' : 'order', evidence: [] }
    pkg.items.push(item)
  }
  if (kind === 'label') item.kind = 'order'
  if (!item.evidence.some(value => value.source_id === source.id && value.region.region_id === link.region_id)) {
    item.evidence.push({ item_id: itemId + '-' + link.region_id, source_id: source.id, kind, region: link })
  }
  return result
}
