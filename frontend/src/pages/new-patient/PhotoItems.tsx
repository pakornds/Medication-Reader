import { RegionOutline } from '../../components/ui/RegionOutline'
import { InputField } from '../../components/ui/InputField'
import { Button } from '../../components/ui/Button'
import { useState } from 'react'
import type { MouseEvent } from 'react'
import type { IntakeText } from '../../i18n/intake'
import { EvidenceImage } from './EvidenceImage'
import type { Box, Photo, Region } from './draft'

const fullImage = { x: 0, y: 0, w: 100, h: 100 }
type Props = { photo: Photo; photos: Photo[]; t: IntakeText; onChange: (regions: Region[]) => void }

export function PhotoItems({ photo, photos, t, onChange }: Props) {
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
      <p className="hint">{t.markHint}</p>
      <div className="region-image" onClick={mark}>
        <EvidenceImage file={photo.file} />
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
