import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { PackageLayout } from '../../src/components/package-layout/layout.mjs'
import { bindCaptureRegion, preserveCapture, regionBounds } from '../../frontend/src/components/workspace/captureManifest.ts'

const fixture = JSON.parse(readFileSync(new URL('../../fixtures/package-capture/two-photos.json', import.meta.url)))

test('restoring and saving the mixed package keeps distinct clinical items and the second front region', () => {
  const layout = new PackageLayout(fixture.case_id)
  layout.restore(fixture)
  const updated = preserveCapture(layout.snapshot(), fixture)
  assert.deepEqual(updated.packages, fixture.packages)
  assert.deepEqual(updated.sources.map(source => source.id).sort(), fixture.sources.map(source => source.id).sort())
  assert.equal(layout.frontOwner('front-b-oval').id, 'package-b')
  layout.edit('front', 'front-b-oval', { x: .51, y: .13, width: .13, height: .08 })
  const edited = preserveCapture(layout.snapshot(), fixture)
  assert.deepEqual(edited.packages[1].items.map(item => item.row_id), ['pending-b-round', 'pending-b-oval'])
  assert.ok(edited.packages[1].items.every(item => item.evidence.every(e => e.region.revision === edited.front.revision)))
})

test('a reverse retake preserves front attribution and requires a new match for reverse evidence', () => {
  const layout = new PackageLayout(fixture.case_id)
  layout.restore(fixture)
  layout.replaceView('reverse', { attachment_id: 'second-back', exif_orientation: 1 })
  const revised = preserveCapture(layout.snapshot(), fixture)
  assert.equal(revised.reverse_matches.length, 0)
  assert.deepEqual(revised.packages[1], fixture.packages[1])
  assert.ok(revised.packages.every(pkg => pkg.items.every(item => item.evidence.every(e => e.region.side === 'front'))))
  assert.equal(regionBounds(revised, fixture.reverse_matches[0].region), undefined)
})

test('a new attribution must name the visible region of its own package', () => {
  const first = fixture.packages[0], third = fixture.packages[2]
  assert.throws(() => bindCaptureRegion(fixture, first.id, third.front_regions[0], 'label', 'new', 'new-row'))
  const updated = bindCaptureRegion(fixture, first.id, first.front_regions[0], 'label', 'new', 'new-row')
  assert.deepEqual(updated.packages[2], third)
  assert.equal(updated.packages[0].items.at(-1).evidence[0].region.region_id, 'front-a')
  assert.equal(updated.sources.at(-1).attachment_id, fixture.front.attachment_id)
})
