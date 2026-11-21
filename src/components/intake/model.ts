export type Side = 'front' | 'reverse'
export type PhotoKind = 'label_photo' | 'reverse_photo' | 'additional_photo'
export type RecordKind = 'transfer_record' | 'prescription' | 'other_record'
export type Role = 'nurse' | 'doctor' | 'pharmacist'
export type Product = { id: string; name: string; label?: string; strength?: string; form?: string; tpu?: string; release?: string }
export type PhotoTarget = { package_id: string; side: Side }
export type Source = {
  id: string
  kind: PhotoKind | RecordKind | 'patient_report' | 'caregiver_report' | 'reviewer_record'
  attachment_id?: string
  reporter?: string
  collector?: string
  organization?: string
  organization_type?: 'clinic' | 'hospital' | 'community_pharmacy' | 'other'
  organization_address?: string
  organization_phone?: string
  organization_phone_extension?: string
  organization_email?: string
  department_or_ward?: string
  source_date?: string
  availability?: 'unavailable'
  unavailable_reason?: string
}
export type Attachment = {
  source_id: string
  attachment_id: string
  revision: number
  kind: PhotoKind
  exif_orientation: number
  file: File
  target?: PhotoTarget
}
export type RegionLink = {
  case_id: string; source_id: string; attachment_id: string; revision: number
  region_id: string; package_id: string; side: Side
}
export type ManualRow = {
  id: string; source_id: string; catalogue_id: string | null
  name: string; strength: string; form: string; directions: string; scans: RegionLink[]; superseded_scans: RegionLink[]
  selected_product: Product | null; dose: string; schedule: string; source_wording: string
}
export type IntakeRecord = { source: Source; wording: string }
export type SourcedText = { value: string; evidence: { source_id: string } }
type Bounds = { x: number; y: number; width: number; height: number }
type SceneView = {
  attachment_id: string; revision: number; visibility?: string
  regions: { id: string; bounds: Bounds; visibility?: string }[]
}
export interface Scene {
  case_id: string
  front: SceneView | null
  reverse?: SceneView | null
  packages: { id: string; front_regions: { region_id: string }[] }[]
  reverse_matches: { package_id: string; status: string; region: { region_id: string } }[]
}
export interface Submission {
  case_id: string
  photos: Attachment[]
  superseded_evidence: { photo: Attachment; sources: Source[] }[]
  evidence: { case_id: string; sources: Source[] }
  manual_rows: ManualRow[]
  patient_report: SourcedText[]
  schedule_unknown_source_id?: string
  other_source_notes: SourcedText[]
  question?: string
}
export interface LayoutBridge {
  setPhoto(side: Side, photo: { attachment_id: string; revision: number; exif_orientation: number; url: string } | null): void
}
const uid = () => crypto.randomUUID()
const kinds: Record<Side, PhotoKind> = { front: 'label_photo', reverse: 'reverse_photo' }

export class IntakeDraft {
  readonly rows: ManualRow[] = []
  readonly photos: Attachment[] = []
  readonly records: IntakeRecord[] = []
  private readonly history: Submission['superseded_evidence'] = []
  readonly interview: IntakeRecord
  scheduleUnknown = false
  question = ''
  readonly caseId: string
  readonly collector: string | undefined

  constructor(caseId: string, collector?: string) {
    if (!caseId.trim()) throw new Error('A case is required.')
    this.caseId = caseId
    this.collector = collector
    this.interview = { source: { id: uid(), kind: 'patient_report', collector }, wording: '' }
  }

  addMedicine(name: string, product: Product | null) {
    if (!name.trim()) throw new Error('Enter the documented medicine name.')
    const row: ManualRow = { id: uid(), source_id: uid(), catalogue_id: product?.id ?? null, selected_product: product ? { ...product } : null,
      dose: '', schedule: '', source_wording: '', name: name.trim(), strength: product?.strength ?? '', form: product?.form ?? '', directions: '', scans: [], superseded_scans: [] }
    this.rows.push(row)
    return row
  }

  addRecord(kind: RecordKind = 'transfer_record') {
    const record: IntakeRecord = { source: { id: uid(), kind, collector: this.collector }, wording: '' }
    this.records.push(record)
    return record
  }

  setPhoto(slot: Side | 'additional', file: File, exifOrientation: number, target?: PhotoTarget) {
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || !file.size)
      throw new Error('unsupported_photo')
    if (file.size > 4_000_000) throw new Error('oversize_photo')
    if (target && (slot !== 'additional' || !target.package_id.trim() ||
        (this.scene && !this.scene.packages.some(pkg => pkg.id === target.package_id)))) throw new Error('invalid_target')
    const kind = slot === 'additional' ? 'additional_photo' : kinds[slot]
    const previous = this.photos.find(p => slot === 'additional'
      ? target && p.target?.package_id === target.package_id && p.target.side === target.side
      : p.kind === kind)
    const photo: Attachment = { source_id: uid(), attachment_id: uid(),
      revision: (previous?.revision ?? 0) + 1, kind, file, exif_orientation: exifOrientation, ...(target && { target: { ...target } }) }
    if (previous) {
      const activeRefs = this.rows.flatMap(row => [...row.scans, ...row.superseded_scans])
      if (activeRefs.some(link => link.attachment_id === previous.attachment_id)) {
        this.history.push({ photo: { ...previous }, sources: [
          { id: previous.source_id, kind: previous.kind, attachment_id: previous.attachment_id },
          ...this.records.filter(r => r.source.attachment_id === previous.attachment_id).map(r => ({ ...r.source })),
        ] })
      }
      this.photos.splice(this.photos.indexOf(previous), 1, photo)
      this.withdrawLinks(link => link.attachment_id === previous.attachment_id)
      for (const record of this.records) {
        // A replaced photo cannot remain the basis of institution metadata for a new upload.
        if (record.source.attachment_id === previous.attachment_id) this.detachedRecords.add(record.source.id)
      }
    } else this.photos.push(photo)
    return photo
  }

  readonly detachedRecords = new Set<string>()

  private withdrawLinks(withdraw: (link: RegionLink) => boolean) {
    for (const row of this.rows) {
      row.superseded_scans.push(...row.scans.filter(withdraw))
      row.scans = row.scans.filter(link => !withdraw(link))
    }
  }

  private scene?: Scene

  syncLayout(scene: Scene | null) {
    if (!scene || scene.case_id !== this.caseId) return
    for (const side of ['front', 'reverse'] as const) {
      const view = scene[side]
      const photo = this.photos.find(p => p.kind === kinds[side])
      if (view && (!photo || photo.attachment_id !== view.attachment_id || view.revision < photo.revision)) return
    }
    const previous = this.scene
    this.scene = structuredClone(scene)
    for (const view of [scene.front, scene.reverse]) {
      const photo = this.photos.find(p => p.attachment_id === view?.attachment_id)
      if (view && photo && view.revision >= photo.revision) photo.revision = view.revision
    }
    for (const row of this.rows) {
      for (const link of row.scans) {
        const view = scene[link.side]
        if (!view || view.attachment_id !== link.attachment_id || view.revision <= link.revision) continue
        const before = previous?.[link.side]?.regions.find(r => r.id === link.region_id)
        const after = view.regions.find(r => r.id === link.region_id)
        const reissued = { ...link, revision: view.revision }
        if (before && after && before.visibility === after.visibility && this.currentRegion(reissued) &&
            (['x', 'y', 'width', 'height'] as const).every(key => before.bounds[key] === after.bounds[key])) {
          row.superseded_scans.push({ ...link })
          link.revision = view.revision
        }
      }
    }
    this.withdrawLinks(link => !this.currentRegion(link))
  }

  private currentRegion(link: RegionLink) {
    const scene = this.scene
    const view = scene?.[link.side]
    if (!scene || !view || scene.case_id !== link.case_id || view.attachment_id !== link.attachment_id
      || view.visibility === 'opaque' || view.revision !== link.revision || !view.regions.some(r => r.id === link.region_id && r.visibility !== 'opaque')) return false
    if (link.side === 'reverse') return scene.reverse_matches.some(match =>
      match.status === 'confirmed' && match.package_id === link.package_id && match.region.region_id === link.region_id)
    return scene.packages.some(p => p.id === link.package_id && p.front_regions.some(r => r.region_id === link.region_id))
  }

  confirmScan(rowId: string, link: RegionLink) {
    const row = this.rows.find(r => r.id === rowId)
    const photo = this.photos.find(p => p.attachment_id === link.attachment_id && p.revision === link.revision)
    const logicalSource = this.records.find(r => r.source.id === link.source_id && r.source.attachment_id === link.attachment_id)
    if (!row || !photo || !this.currentRegion(link) || link.case_id !== this.caseId || (!logicalSource && photo.source_id !== link.source_id)
      || !link.region_id.trim() || !link.package_id.trim() || (photo.target && (
        photo.target.package_id !== link.package_id || photo.target.side !== link.side))
      || (photo.kind !== 'additional_photo' && kinds[link.side] !== photo.kind))
      throw new Error('stale_link')
    if (!row.scans.some(r => r.attachment_id === link.attachment_id && r.region_id === link.region_id && r.source_id === link.source_id))
      row.scans.push({ ...link })
  }

  snapshot(): Submission {
    const sources: Source[] = this.photos.map(p => ({ id: p.source_id, kind: p.kind, attachment_id: p.attachment_id }))
    for (const row of this.rows) sources.push({ id: row.source_id, kind: 'reviewer_record', collector: this.collector })
    const patient_report: SourcedText[] = []
    const other_source_notes: SourcedText[] = []
    if (this.interview.wording.trim() || this.scheduleUnknown) {
      sources.push({ ...this.interview.source })
      if (this.interview.wording.trim()) patient_report.push({
        value: this.interview.wording.trim(), evidence: { source_id: this.interview.source.id },
      })
    }
    for (const { source, wording } of this.records) {
      if (this.detachedRecords.has(source.id)) continue
      if (source.availability === 'unavailable' && !source.unavailable_reason?.trim()) throw new Error('unavailable_reason')
      if (!source.availability && !source.attachment_id && !wording.trim()) continue
      sources.push({ ...source })
      if (!source.availability && !source.attachment_id && wording.trim())
        other_source_notes.push({ value: wording.trim(), evidence: { source_id: source.id } })
    }
    return { case_id: this.caseId, evidence: { case_id: this.caseId, sources },
      superseded_evidence: this.history.map(entry => ({
        photo: { ...entry.photo }, sources: entry.sources.map(s => ({ ...s })),
      })),
      photos: this.photos.map(p => ({ ...p, ...(p.target && { target: { ...p.target } }) })),
      manual_rows: structuredClone(this.rows), patient_report, other_source_notes,
      ...(this.scheduleUnknown && { schedule_unknown_source_id: this.interview.source.id }),
      ...(this.question.trim() && { question: this.question.trim() }) }
  }
}
