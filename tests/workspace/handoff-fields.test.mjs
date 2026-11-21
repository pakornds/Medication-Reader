import assert from 'node:assert/strict'
import test from 'node:test'
import { handoffFields } from '../../frontend/src/pages/clinical/handoffFields.ts'

test('legacy intake facts in the handoff require a current citation on the same admission row', () => {
  const current = { source_id: 'continued-label', item_id: 'region-b' }
  const removed = { source_id: 'withdrawn-reverse', item_id: 'region-a' }
  const readable = (value, evidence) => ({ status: 'readable', value, evidence })
  const row = { id: 'item-1', intake: { label_fields: {
    strength: readable('withdrawn strength', removed),
    form: readable('documented tablet', current),
    directions: readable('wrong item wording', { ...current, item_id: 'neighbor' }),
    dose: readable('uncited dose'),
    indication: { status: 'missing' },
  } } }
  const entries = [{ source: { id: current.source_id }, strength: 'confirmed strength' }]
  const items = [{ source_id: current.source_id, id: 'region-b', row_id: row.id },
    { source_id: current.source_id, id: 'neighbor', row_id: 'item-2' }]
  const fields = handoffFields(row, entries, new Map([[current.source_id, current]]), items)
  assert.deepEqual(fields, { strength: readable('confirmed strength', current), form: readable('documented tablet', current),
    indication: { status: 'missing' } })
  assert.equal(row.intake.label_fields.strength.value, 'withdrawn strength')
})
