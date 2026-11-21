import { useEffect, useRef, useState } from 'react'
import type { createClient } from '../../api/client'
import type { Encounter } from '../../api/admission'
import type { CaptureCommand, PackageCapture, RegionLink } from '../../api/contracts'
import { imageOrientation } from '../../../../src/components/intake/orientation'
import { mountPackageLayout, type CaptureEditor } from '../../../../src/components/package-layout/editor.mjs'
import '../../../../src/components/package-layout/editor.css'
import { bindCaptureRegion, packageLinks, preserveCapture, regionBounds, type Side } from './captureManifest'
import { CaptureRow } from './CaptureRow'

type Props = { client: ReturnType<typeof createClient>; encounter: Encounter; onEncounter: (encounter: Encounter) => void }
const sides = ['front', 'reverse'] as const
const message = (error: unknown) => error instanceof Error ? error.message : 'The capture could not be saved.'

export function SceneCapture(props: Props) {
  const [reload, setReload] = useState(0)
  return <SceneWorkspace key={props.encounter.id + ':' + reload} {...props} onReload={() => setReload(value => value + 1)} />
}

function SceneWorkspace({ client, encounter, onEncounter, onReload }: Props & { onReload: () => void }) {
  const [initial] = useState(() => ({ encounter, client }))
  const [scene, setScene] = useState(encounter.capture)
  const [saved, setSaved] = useState(encounter.capture)
  const [busy, setBusy] = useState(false)
  const [ready, setReady] = useState(false)
  const [status, setStatus] = useState('')
  const [selected, select] = useState<{ packageId: string; link: RegionLink; original: Blob } | null>(null)
  const layout = useRef<HTMLDivElement>(null)
  const editor = useRef<CaptureEditor | null>(null)
  const files = useRef<Partial<Record<Side, Blob>>>({})
  const urls = useRef<Partial<Record<Side, string>>>({})
  const pending = useRef<{ key: string; id: string } | null>(null)
  const mounted = useRef(false)
  useEffect(() => {
    let live = true
    mounted.current = true
    const widget = mountPackageLayout(layout.current!, { caseId: initial.encounter.id,
      onChange: (geometry: PackageCapture) => { setScene(geometry); select(null) } })
    editor.current = widget
    async function restore() {
      const capture = initial.encounter.capture
      if (capture) {
        await Promise.all(sides.map(async side => {
          const photo = capture[side]
          if (!photo) return
          const blob = await initial.client.view(capture.case_id, { side, attachment_id: photo.attachment_id, revision: photo.revision })
          if (!live) return
          files.current[side] = blob
          urls.current[side] = URL.createObjectURL(blob)
        }))
        if (live) widget.restore(capture, urls.current)
      }
      if (live) setReady(true)
    }
    restore().catch(error => { if (live) setStatus(message(error)) })
    const originals = urls.current
    return () => {
      live = false
      mounted.current = false
      widget.dispose()
      for (const side of sides) if (originals[side]) URL.revokeObjectURL(originals[side])
    }
  }, [initial])

  async function run(operation: () => Promise<void>) {
    setBusy(true)
    setStatus('')
    try { await operation() } catch (error) { if (mounted.current) setStatus(message(error)) }
    finally { if (mounted.current) setBusy(false) }
  }
  async function persist(manifest: PackageCapture, current = encounter, existing_rows: Record<string, string> = {}) {
    if (JSON.stringify(current.capture) !== JSON.stringify(saved))
      throw new Error('Saved package photos changed. Reload the saved photos before editing.')
    const originals: Partial<Record<Side, Blob>> = {}
    const command: CaptureCommand = { revision: current.revision, request_id: '', manifest, existing_rows }
    for (const side of sides) {
      const view = manifest[side], before = current.capture?.[side]
      if (!view || before?.attachment_id === view.attachment_id) continue
      const original = files.current[side]
      if (!original) throw new Error('Select the original photo again.')
      originals[side] = original
      if (before) command.replaces_view = { side, attachment_id: before.attachment_id, revision: before.revision }
    }
    const key = JSON.stringify(command)
    if (pending.current?.key !== key) pending.current = { key, id: crypto.randomUUID() }
    command.request_id = pending.current.id
    const result = await client.capture(current.id, command, originals)
    if (!mounted.current) throw new Error('Encounter closed.')
    pending.current = null
    setSaved(result.capture)
    setScene(result.capture)
    onEncounter(result)
    return result
  }
  async function attach(side: Side, file: File) {
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || file.size > 4_000_000)
      throw new Error('Choose a PNG, JPEG or WebP under 4 MB.')
    const orientation = await imageOrientation(file)
    if (!mounted.current) return
    const url = URL.createObjectURL(file)
    const before = urls.current[side]
    const beforeFile = files.current[side]
    const beforeScene = editor.current!.snapshot()
    files.current[side] = file
    urls.current[side] = url
    editor.current!.setPhoto(side, { attachment_id: crypto.randomUUID(), revision: (scene?.[side]?.revision || 0) + 1,
      exif_orientation: orientation, url })
    try {
      await persist(preserveCapture(editor.current!.snapshot(), saved))
    } catch (error) {
      if (mounted.current && beforeScene.front) {
        files.current[side] = beforeFile
        urls.current[side] = before
        editor.current!.restore(beforeScene, urls.current)
        setScene(scene)
        URL.revokeObjectURL(url)
      }
      throw error
    }
    if (before) URL.revokeObjectURL(before)
    setStatus(side === 'front' ? 'Label-side photo saved. Mark the packages.' : 'Reverse photo saved. Check the package matches.')
  }
  async function propose(side: Side) {
    const manifest = preserveCapture(editor.current!.snapshot(), saved)
    const result = JSON.stringify(scene) === JSON.stringify(saved) ? encounter : await persist(manifest)
    const view = result.capture?.[side]
    if (!view) return
    try {
      const proposal = await client.proposeRegions(result.id, { side, attachment_id: view.attachment_id, revision: view.revision })
      if (!mounted.current) return
      editor.current!.addProposals(side, { ...proposal, bounds: proposal.regions })
      setStatus(proposal.regions.length ? 'Review the suggested regions and save the layout.' : 'No regions found. Draw the package regions manually.')
    } catch (error) { throw new Error(message(error) + ' Draw or adjust package regions manually.', { cause: error }) }
  }
  const dirty = JSON.stringify(scene) !== JSON.stringify(saved)
  const finished = encounter.status === 'Finished'
  return <section className="intake stack" aria-label="Whole-table photos">
    <h2>Whole-table photos</h2>
    <p>Photograph the labels first. Flip the packages in place for an optional reverse photo.</p>
    <fieldset className="stack" disabled={!ready || busy || finished}>
      {sides.map(side => <label key={side}>{side === 'front' ? 'Label-side original' : 'Reverse original (optional)'}
        <input type="file" accept="image/png,image/jpeg,image/webp" disabled={side === 'reverse' && !scene?.front}
          onChange={e => { const file = e.target.files?.[0]; e.target.value = ''; if (file) void run(() => attach(side, file)) }} />
      </label>)}
      <div ref={layout} />
      {scene?.front && <div>
        {sides.filter(side => scene[side]).map(side => <button type="button" key={side} onClick={() => void run(() => propose(side))}>Suggest {side} regions</button>)}
        <button type="button" disabled={!dirty} onClick={() => void run(async () => { await persist(preserveCapture(editor.current!.snapshot(), saved)); setStatus('Layout saved.') })}>Save regions and matches</button>
      </div>}
      {saved?.packages?.map(pkg => <div key={pkg.id}>
        <strong>{pkg.id}</strong>
        {packageLinks(saved, pkg.id).map(link => <button type="button" key={link.side + link.region_id}
          disabled={dirty || !regionBounds(saved, link)} onClick={() => select({ packageId: pkg.id, link, original: files.current[link.side]! })}>
          Review {link.side} region {link.region_id}
        </button>)}
      </div>)}
      {selected && saved && !dirty && <CaptureRow key={JSON.stringify(selected)} client={client} encounter={encounter}
        manifest={saved} packageId={selected.packageId} link={selected.link} original={selected.original}
        onEncounter={onEncounter} onRetaken={rowId => { select(null); setStatus('Item retake saved on ' + rowId + '.') }}
        bind={async (current, sourceId, kind, rowId, itemId) => {
          const next = bindCaptureRegion(saved, selected.packageId, selected.link, kind, sourceId, itemId)
          const result = await persist(next, current, rowId ? { [itemId]: rowId } : {})
          setStatus('Region linked to ' + result.capture_rows?.[itemId] + '.')
          select(null)
        }} />}
    </fieldset>
    <p role="status">{status}</p>
    {status && <button type="button" disabled={busy} onClick={() => void run(async () => {
      const current = await client.encounter(encounter.id)
      if (mounted.current) { onEncounter(current); onReload() }
    })}>Reload saved photos and discard local region edits</button>}
  </section>
}
