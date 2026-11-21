import type { RegionBounds } from '../../api/contracts'
import { RegionOutline } from '../../components/ui/RegionOutline'
import { InputField } from '../../components/ui/InputField'
import { Button } from '../../components/ui/Button'
import { useEffect, useRef, useState } from 'react'
import type { MouseEvent } from 'react'
import type { IntakeText } from '../../i18n/intake'
import { EvidenceImage } from './EvidenceImage'
import type { Box, Photo, Region } from './draft'

const fullImage = { x: 0, y: 0, w: 100, h: 100 }
type Props = { photo: Photo; photos: Photo[]; t: IntakeText; onChange: (regions: Region[]) => void; proposePhoto?: (photo: Photo) => Promise<RegionBounds[]> }

export function PhotoItems({ photo, photos, t, onChange, proposePhoto }: Props) {
  const [suggestions, setSuggestions] = useState<Box[]>([])
  const [detection, setDetection] = useState<'idle' | 'working' | 'empty' | 'error'>('idle')
  const request = useRef(0)
  useEffect(() => () => { request.current += 1 }, [])
  async function detect() {
    if (!proposePhoto) return
    const current = ++request.current
    setDetection('working')
    try {
      const boxes = await proposePhoto(photo)
      if (current !== request.current) return
      const proposals = boxes.map(({ x, y, width, height }) => ({ x: x * 100, y: y * 100, w: width * 100, h: height * 100 }))
      setSuggestions(proposals)
      setDetection(proposals.length ? 'idle' : 'empty')
    } catch {
      if (current === request.current) setDetection('error')
    }
  }

  function accept() {
    const fresh = suggestions.filter(b => !photo.regions.some(r =>
      Math.abs(r.box.x - b.x) < .1 && Math.abs(r.box.y - b.y) < .1 &&
      Math.abs(r.box.w - b.w) < .1 && Math.abs(r.box.h - b.h) < .1))
    onChange([...photo.regions, ...fresh.map(bounds => {
      const id = crypto.randomUUID()
      return { id, rowId: id, box: bounds, organization: '' }
    })])
    setSuggestions([])
  }
  const [start, setStart] = useState<{ x: number; y: number } | null>(null)
  const [box, setBox] = useState<Box>(fullImage)
  const frontRows = photos
    .filter((p) => p.kind !== 'reverse_photo')
    .flatMap((p) =>
      p.regions.map((r, i) => ({ id: r.rowId, name: p.file.name + ' · ' + t.region + ' ' + (i + 1) })),
    )
  function add(bounds: Box) {
    const id = crypto.randomUUID()
    onChange([...photo.regions, { id, rowId: id, box: bounds, organization: '' }])
    setStart(null)
    setBox(fullImage)
  }
  function mark(event: MouseEvent<HTMLDivElement>) {
    const rect = event.currentTarget.getBoundingClientRect()
    const point = {
      x: Math.round((100 * (event.clientX - rect.left)) / rect.width),
      y: Math.round((100 * (event.clientY - rect.top)) / rect.height),
    }
    if (!start) {
      setStart(point)
      return
    }
    const w = Math.abs(point.x - start.x)
    const h = Math.abs(point.y - start.y)
    if (w && h) add({ x: Math.min(point.x, start.x), y: Math.min(point.y, start.y), w, h })
  }
  function update(id: string, patch: Partial<Region>) {
    onChange(photo.regions.map((r) => (r.id === id ? { ...r, ...patch } : r)))
  }
  return (
    <div className="stack">
      {proposePhoto && photo.kind !== 'additional_photo' && <div className="stack">
        <div className="actions">
          <Button disabled={detection === 'working'} aria-busy={detection === 'working'} onClick={() => void detect()}>{t.findRegions}</Button>
          {suggestions.length > 0 && <>
            <Button onClick={accept}>{t.acceptRegions} ({suggestions.length})</Button>
            <Button variant="text" onClick={() => setSuggestions([])}>{t.dismissRegions}</Button>
          </>}
        </div>
        {detection === 'error' && <small role="status">{t.regionServiceFailed}</small>}
        {detection === 'empty' && <small role="status">{t.noRegions}</small>}
      </div>}
      <p className="hint">{t.markHint}</p>
      <div className="region-image" onClick={mark}>
        <EvidenceImage file={photo.file} />
        {suggestions.map((b,i) => <span key={i} aria-hidden="true" className="region-box proposal-box"
          style={{ left: b.x+'%', top: b.y+'%', width: b.w+'%', height: b.h+'%', borderStyle:'dashed', pointerEvents:'none' }} />)}
        {start && <span className="corner" style={{ left: start.x + '%', top: start.y + '%' }} />}
        {photo.regions.map(({ id, box }, i) => (
          <RegionOutline key={id} box={box} number={i + 1} />
        ))}
      </div>
      {start && (
        <p role="status">
          {t.nextCorner}{' '}
          <Button variant="text" onClick={() => setStart(null)}>
            {t.clear}
          </Button>
        </p>
      )}
      <Button onClick={() => add(fullImage)}>{t.whole}</Button>
      <details>
        <summary>{t.bounds}</summary>
        <div className="region-coordinates">
          {(['x', 'y', 'w', 'h'] as const).map((key) => (
            <InputField
              key={key}
              label={t[key]}
              type="number"
              min={key === 'w' || key === 'h' ? 1 : 0}
              max="100"
              value={box[key]}
              onChange={(e) => setBox({ ...box, [key]: e.target.valueAsNumber || 0 })}
            />
          ))}
        </div>
        <Button
          disabled={
            box.x < 0 ||
            box.y < 0 ||
            box.w <= 0 ||
            box.h <= 0 ||
            box.x + box.w > 100 ||
            box.y + box.h > 100
          }
          onClick={() => add(box)}
        >
          {t.saveRegion}
        </Button>
      </details>
      {photo.regions.map((r, i) => (
        <div className="region-editor stack" key={r.id}>
          <div className="spread">
            <strong>
              {t.region} {i + 1}
            </strong>
            <Button variant="text" onClick={() => onChange(photo.regions.filter((v) => v.id !== r.id))}>
              {t.remove}
            </Button>
          </div>
          {photo.kind === 'reverse_photo' ? (
            <label>
              {t.match}
              <select value={r.rowId} onChange={(e) => update(r.id, { rowId: e.target.value })}>
                <option value={r.id}>{t.separate}</option>
                {frontRows.map((row) => (
                  <option key={row.id} value={row.id}>
                    {row.name}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <InputField
              label={t.facility}
              value={r.organization}
              onChange={(e) => update(r.id, { organization: e.target.value })}
            />
          )}
        </div>
      ))}
    </div>
  )
}
