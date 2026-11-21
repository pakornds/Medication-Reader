import { useEffect, useRef, useState } from 'react'
import type { createClient } from '../../api/client'
import type { Encounter } from '../../api/admission'
import type { LabelField, Observation, PackageCapture, RegionLink, SourceEntry } from '../../api/contracts'
import { regionBounds } from './captureManifest'

const fields = ['name', 'strength', 'form', 'dose', 'directions', 'indication'] as const
type Field = typeof fields[number] | 'wording'
const blank = { name: '', strength: '', form: '', dose: '', directions: '', indication: '', wording: '' }
type Props = {
  client: ReturnType<typeof createClient>; encounter: Encounter; manifest: PackageCapture; packageId: string
  link: RegionLink; original: Blob; onEncounter: (encounter: Encounter) => void
  onRetaken: (rowId: string) => void
  bind: (encounter: Encounter, sourceId: string, kind: 'label' | 'appearance', rowId: string, itemId: string) => Promise<void>
}
async function imageData(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result).split(',')[1])
    reader.onerror = () => reject(new Error('Could not read the image.'))
    reader.readAsDataURL(file)
  })
}

export function CaptureRow({ client, encounter, manifest, packageId, link, original, onEncounter, onRetaken, bind }: Props) {
  const pkg = manifest.packages!.find(p => p.id === packageId)!
  const located = pkg.items?.filter(item => item.evidence.some(e => e.region.side === link.side && e.region.region_id === link.region_id)) || []
  const [target, setTarget] = useState(located.length === 1 ? encounter.capture_rows?.[located[0].row_id] || '' : '')
  const [kind, setKind] = useState<'label' | 'appearance'>(located.length === 1 && located[0].kind === 'pending_appearance' ? 'appearance' : 'label')
  const [sourceId] = useState(() => crypto.randomUUID())
  const [itemId] = useState(() => crypto.randomUUID())
  const [values, setValues] = useState(blank)
  const edited = useRef(new Set<Field>())
  const [observations, setObservations] = useState<Partial<Record<LabelField, Observation>>>({})
  const [names, setNames] = useState<string[]>([])
  const [crop, setCrop] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [retake, setRetake] = useState<File | null>(null)
  const [replacementUrl, setReplacementUrl] = useState('')
  useEffect(() => () => { if (replacementUrl) URL.revokeObjectURL(replacementUrl) }, [replacementUrl])
  const [replaces, setReplaces] = useState('')
  const [savedRow, setSavedRow] = useState('')
  const request = useRef<{ key: string; id: string } | null>(null)
  const live = useRef(true)
  const linkKey = JSON.stringify(link)
  useEffect(() => {
    let active = true
    live.current = true
    let url = ''
    client.region(encounter.id, JSON.parse(linkKey)).then(blob => {
      if (active) { url = URL.createObjectURL(blob); setCrop(url) }
    }).catch(reason => { if (active) setError(reason.message) })
    return () => { active = false; live.current = false; if (url) URL.revokeObjectURL(url) }
  }, [client, encounter.id, linkKey])
  const bounds = regionBounds(manifest, link)!
  const coordinates: [number, number, number, number] = retake ? [0, 0, 1, 1] : [bounds.x, bounds.y, bounds.width, bounds.height]
  const source = { id: sourceId, kind: link.side === 'front' ? 'label_photo' as const : 'reverse_photo' as const,
    ...(!retake && { attachment_id: link.attachment_id }) }
  const rows = Object.values(encounter.rows).filter(row => !row.package_id || row.package_id === packageId)
  const row = encounter.rows[target]
  const currentPhotos = row?.entries.filter(entry => entry.photo && entry.source.kind === source.kind &&
    !row.superseded.includes(entry.source.id)).map(entry => ({ id: entry.source.id, bag: entry.photo!.bag, wording: entry.wording })) || []
  for (const item of located.filter(item => item.row_id === row?.capture_item_id)) {
    for (const evidence of item.evidence) {
      if (evidence.region.side !== link.side || evidence.region.region_id !== link.region_id ||
        row!.superseded.includes(evidence.source_id) || currentPhotos.some(photo => photo.id === evidence.source_id)) continue
      currentPhotos.push({ id: evidence.source_id, bag: packageId, wording: link.side + ' ' + evidence.kind + ' · ' + link.region_id })
    }
  }
  const attached = row?.capture_item_id
  async function work(operation: () => Promise<void>) {
    setBusy(true); setError('')
    try { await operation() } catch (reason) {
      if (live.current) setError(reason instanceof Error ? reason.message : 'Could not read this region. Enter its wording manually.')
    } finally { if (live.current) setBusy(false) }
  }
  function edit(key: Field, value: string) {
    edited.current.add(key)
    setValues(previous => ({ ...previous, [key]: value }))
  }
  async function scan() {
    const rowId = target || itemId
    const result = await client.analyze({
      evidence: { case_id: encounter.id, sources: [source], items: [{ id: 'selected', source_id: sourceId,
        row_id: rowId, kind: link.side === 'front' ? 'label_region' : 'matched_reverse_label' }] },
      photo_source_ids: [sourceId],
      region_locations: { [sourceId]: { selected: coordinates.map(n => (n * 100).toFixed(8) + '%').join(', ') } },
    }, [retake || original])
    if (!live.current) return
    const resultRow = result.rows.find(r => r.id === rowId)
    if (!resultRow) throw new Error('No supported transcription for this region. Enter the wording manually.')
    const citedNames = [...new Set((resultRow.observed_names || []).filter(n =>
      n.evidence.source_id === sourceId && n.evidence.item_id === 'selected').map(n => n.value))]
    const scanned = resultRow.label_fields || {}
    setObservations(scanned)
    setNames(citedNames)
    const prefilled = { ...blank, name: citedNames.length === 1 ? citedNames[0] : '' }
    for (const key of fields) {
      if (key === 'name') continue
      const value = scanned[key]
      if (value?.evidence?.source_id === sourceId && value.evidence.item_id === 'selected') prefilled[key] = value.value || ''
    }
    prefilled.wording = [...new Set([...citedNames, ...Object.values(scanned).map(f => f?.value).filter(Boolean)])].join(' · ')
    setValues(previous => Object.assign({}, previous, Object.fromEntries(Object.entries(prefilled).filter(([key]) => !edited.current.has(key as Field)))))
  }
  async function save() {
    if (savedRow) return bind(encounter, sourceId, kind, savedRow, attached || itemId)
    if (kind === 'appearance' && !retake) return bind(encounter, sourceId, kind, target, attached || itemId)
    if (!values.wording.trim()) throw new Error('Record the original wording or appearance.')
    if (retake && !replaces) throw new Error('Select the original item evidence to replace.')
    const file = retake || original
    const entry: SourceEntry = { source, wording: values.wording, scan_fields: observations,
      photo: { bag: retake ? currentPhotos.find(e => e.id === replaces)!.bag : packageId,
        data: await imageData(file), media_type: file.type as NonNullable<SourceEntry['photo']>['media_type'],
        region: coordinates, front_attributed: link.side === 'front' && kind === 'label',
        pairing: link.side === 'reverse' ? 'matched' : 'uncertain', appearance: kind === 'appearance' ? values.wording : null } }
    for (const key of fields) if (values[key].trim() || edited.current.has(key)) entry[key] = values[key].trim() || null
    const command = target ? { action: 'link' as const, row_id: target, entry, confirmed: true as const, replaces: retake ? replaces : null }
      : { action: 'add' as const, entry }
    const key = JSON.stringify([encounter.revision, command])
    if (request.current?.key !== key) request.current = { key, id: crypto.randomUUID() }
    const current = await client.action(encounter.id, { revision: encounter.revision, request_id: request.current.id, command })
    if (!live.current) return
    const changed = Object.values(current.rows).find(row => row.entries.some(e => e.source.id === sourceId))
    if (!changed) throw new Error('The saved evidence did not identify an admission row.')
    onEncounter(current)
    setSavedRow(changed.id)
    if (!retake) await bind(current, sourceId, kind, changed.id, attached || itemId)
    else onRetaken(changed.id)
  }
  return <fieldset disabled={busy}><legend>Review selected region</legend>
    {(replacementUrl || crop) && <figure><img src={replacementUrl || crop}
      alt={(replacementUrl ? 'Replacement item photo' : 'Selected ' + link.side + ' region') + ' for ' + packageId}
      style={{ maxWidth: '16rem', maxHeight: '12rem' }} />
      {replacementUrl && <figcaption>Replacement item photo for this retake</figcaption>}</figure>}
    <label>Admission row<select aria-label="Admission row" value={target} disabled={!!savedRow || !!retake} onChange={e => setTarget(e.target.value)}>
      <option value="">New medication or pending appearance</option>
      {rows.map(row => <option key={row.id} value={row.id}>{row.id} · {row.verified?.identity?.name || row.entries.find(e => e.name)?.name || 'Pending identity'}</option>)}
    </select></label>
    <label>Region contains<select aria-label="Region contains" value={kind} disabled={!!savedRow} onChange={e => setKind(e.target.value as typeof kind)}>
      <option value="label">Attributed label</option><option value="appearance">Unidentified appearance</option>
    </select></label>
    {!!currentPhotos.length && <label>Targeted retake (same item and side)<input type="file" accept="image/png,image/jpeg,image/webp"
      disabled={!!savedRow} onChange={e => { const file = e.target.files?.[0]; if (!file) return
        if (file.size > 4_000_000) { setError('Choose a photo under 4 MB.'); return }
        setRetake(file); setReplacementUrl(URL.createObjectURL(file)); setReplaces(currentPhotos.length === 1 ? currentPhotos[0].id : '')
        setValues(blank); edited.current.clear(); setObservations({}); setNames([])
      }} /></label>}
    {retake && <label>Item evidence to replace<select value={replaces} onChange={e => setReplaces(e.target.value)}>
      <option value="">Select the previous photo</option>{currentPhotos.map(e => <option key={e.id} value={e.id}>{e.id} · {e.wording}</option>)}
    </select></label>}
    {kind === 'label' && <>
      <button type="button" disabled={!!savedRow} onClick={() => void work(scan)}>Scan selected label region</button>
      {names.length > 1 && <label>Name observed in this region<select value={names.includes(values.name) ? values.name : ''} onChange={e => edit('name', e.target.value)}>
        <option value="">Choose a name or leave unresolved</option>{names.map(name => <option key={name}>{name}</option>)}</select></label>}
      {fields.map(key => <label key={key}>Documented {key}<input value={values[key]} disabled={!!savedRow} onChange={e => edit(key, e.target.value)} /></label>)}
    </>}
    {(kind === 'label' || retake) && <label>Original wording or appearance<textarea value={values.wording} disabled={!!savedRow}
      onChange={e => edit('wording', e.target.value)} /></label>}
    <button type="button" disabled={!!savedRow && !!retake} onClick={() => void work(save)}>{retake ? 'Save item retake' : 'Link selected region to row'}</button>
    <p role="status">{error}</p>
  </fieldset>
}
