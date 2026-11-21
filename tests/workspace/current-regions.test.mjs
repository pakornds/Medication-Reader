import assert from 'node:assert/strict'
import test from 'node:test'
import { rowRegions } from '../../frontend/src/pages/clinical/locatedEvidence.ts'

test('a replaced appearance cannot be offered for comparison or handoff', () => {
  const original = { source_id: 'original', kind: 'appearance' }
  const current = { source_id: 'current', kind: 'label' }
  const encounter = { capture: { packages: [{ id: 'bag', items: [
    { row_id: 'item', evidence: [original, current] },
  ] }] } }
  const row = { package_id: 'bag', capture_item_id: 'item', superseded: ['original'] }
  assert.deepEqual(rowRegions(encounter, row), [current])
})
