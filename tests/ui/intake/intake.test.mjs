import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { IntakeDraft } from '../../../src/components/intake/model.ts'
import { imageOrientation } from '../../../src/components/intake/orientation.ts'

const fixture = (name, type) => new File([readFileSync(new URL(name, import.meta.url))], name, { type })
const front = fixture('table-front-orientation-6.jpg', 'image/jpeg')
const back = fixture('table-reverse.png', 'image/png')

test('originals retain their camera orientation without rotating or encoding the upload', async () => {
  assert.equal(await imageOrientation(front), 6)
  assert.equal(await imageOrientation(back), 1)
  const draft = new IntakeDraft('case')
  assert.equal(draft.setPhoto('front', front, 6).file, front)
  assert.equal(draft.snapshot().photos[0].file, front)
})

test('resizing A withdraws only A, B gets the current revision; stale targeted retakes are rejected', () => {
  const draft = new IntakeDraft('case')
  const photo = draft.setPhoto('front', front, 6)
  const rows = ['A', 'B'].map(name => draft.addMedicine(name, null))
  const scene = {
    case_id: 'case', front: { attachment_id: photo.attachment_id, revision: 1,
      regions: ['A', 'B'].map((id, i) => ({ id, bounds: { x: i / 2, y: 0, width: .5, height: 1 } })) },
    packages: ['A', 'B'].map(id => ({ id, front_regions: [{region_id:id}] })), reverse_matches: [],
  }
  draft.syncLayout(scene)
  for (const [i, {id}] of scene.packages.entries()) draft.confirmScan(rows[i].id, {
    case_id: 'case', source_id: photo.source_id, attachment_id: photo.attachment_id, revision: 1,
    region_id: id, package_id: id, side: 'front',
  })
  scene.front.revision = 2
  scene.front.regions[0].bounds.width = .4
  draft.syncLayout(scene)
  assert.equal(rows[0].scans.length, 0)
  assert.equal(rows[0].superseded_scans[0].revision, 1)
  assert.equal(rows[1].scans[0].revision, 2)
  scene.packages.shift()
  draft.syncLayout(scene)
  assert.throws(() => draft.setPhoto('additional', back, 1, {package_id:'A', side:'reverse'}), /invalid_target/)
  assert.equal(draft.photos.length, 1)
  assert.equal(draft.setPhoto('additional', back, 1).target, undefined)
  assert.equal(draft.setPhoto('front', front, 6).revision, 3)
})

test('file type, required prior-record reason, and missing facility metadata', () => {
  const draft = new IntakeDraft('case')
  assert.throws(() => draft.setPhoto('front', new File(['test'], 'test.heic', {type:'image/heic'}), 1), /unsupported_photo/)
  const r = draft.addRecord()
  r.source.availability = 'unavailable'
  assert.throws(() => draft.snapshot(), /unavailable_reason/)
  r.source.unavailable_reason = 'Clinic unavailable'
  assert.equal(draft.snapshot().evidence.sources[0].organization, undefined)
  assert.equal(draft.snapshot().evidence.sources[0].source_date, undefined)
})
