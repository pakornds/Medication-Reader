// Run against a dedicated synthetic FastAPI instance with its bundled catalogue installed.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createClient, ApiError } from '../../src/api/client.ts'

const root = new URL('../../../', import.meta.url)
const base = process.env.TEST_API_URL
assert.ok(base && process.env.MEDICATION_READER_DEMO_NURSE_TOKEN && process.env.MEDICATION_READER_DEMO_REVIEWER_TOKEN)
const nurse = createClient(base, process.env.MEDICATION_READER_DEMO_NURSE_TOKEN)
const pharmacy = createClient(base, process.env.MEDICATION_READER_DEMO_REVIEWER_TOKEN)
const anonymous = createClient(base)
const denied = (status, code) => error => error instanceof ApiError && error.status === status
  && (!code || (error.service?.code === code && error.service.recoverable))
const state = await nurse.createEncounter({ patient_alias: 'Synthetic client fixture' })
const id = state.id
assert.equal((await nurse.session()).actor.role, 'nurse')
assert.equal((await pharmacy.encounter(id)).id, id)
await assert.rejects(anonymous.encounter(id), denied(403))

const front = new Blob([await readFile(new URL('tests/ui/intake/table-front-orientation-6.jpg', root))], { type: 'image/jpeg' })
const reverse = new Blob([await readFile(new URL('tests/ui/intake/table-reverse.png', root))], { type: 'image/png' })
const manifest = JSON.parse((await readFile(new URL('fixtures/package-capture/two-photos.json', root), 'utf8')).replaceAll('demo-two-photos', id))
const frontOnly = { case_id: id, front: manifest.front }
const first = { revision: 1, request_id: 'front', manifest: frontOnly }
const initial = await nurse.capture(id, first, { front })
assert.equal(initial.capture.reverse, null)
assert.deepEqual(await nurse.capture(id, first, { front }), initial)
const full = { revision: initial.revision, request_id: 'two-views', manifest }
const captured = await nurse.capture(id, full, { reverse })
assert.deepEqual(await pharmacy.encounter(id), captured)
const shared = captured.capture.sources.filter(s => s.attachment_id === manifest.front.attachment_id && s.organization)
assert.equal(new Set(shared.map(s => s.organization)).size, 2)
const pending = Object.values(captured.rows).filter(row => row.capture_item_id?.startsWith('pending-b'))
assert.equal(pending.length, 2)
assert.ok(pending.every(row => row.unknown && row.package_id === 'package-b' && !row.verified))
assert.equal(captured.capture.reverse_matches.find(m => m.package_id === 'package-b').status, 'candidate')
assert.deepEqual(await nurse.capture(id, full, { reverse }), captured)
await assert.rejects(nurse.capture(id, { ...full, request_id: 'stale' }), denied(409))
const view = { side: 'front', attachment_id: manifest.front.attachment_id, revision: manifest.front.revision }
assert.equal((await pharmacy.view(id, view)).size, front.size)
const link = manifest.packages[0].front_regions[0]
assert.ok((await pharmacy.region(id, link)).size > 0)
await assert.rejects(nurse.proposeRegions(id, { ...view, revision: 999 }), denied(404, 'view_unavailable'))

const add = { revision: captured.revision, request_id: 'add-report', command: { action: 'add',
  entry: { source: { id: 'interview-note', kind: 'patient_report', reporter: 'Synthetic patient' }, wording: 'I brought a tablet.' } } }
const changed = await nurse.action(id, add)
assert.deepEqual(await nurse.action(id, add), changed)
await assert.rejects(nurse.action(id, { ...add, request_id: 'stale-action' }), denied(409))
const replayRevision = (await pharmacy.encounter(id)).revision
const order = await nurse.action(id, { revision: changed.revision, request_id: 'documented-order',
  command: { action: 'add', entry: { source: { id: 'order-a-record', kind: 'prescription', organization: 'Demo Clinic' },
    wording: 'Synthetic A from the clinic record', name: 'Synthetic A' } } })
assert.deepEqual(await pharmacy.admissionCandidates(id), [{ id: 'order-a-record', name: 'Synthetic A', origin: 'Encounter record' }])
const reportedRow = changed.events.at(-1).rows[0]
const referral = await nurse.action(id, { revision: order.revision, request_id: 'refer', command: {
  action: 'refer', row_ids: [reportedRow], checked: 'Interview note', reason: 'No label identifies the tablet',
} })
assert.equal((await pharmacy.encounter(id)).events.at(-1).reason, 'No label identifies the tablet')
const decision = await pharmacy.action(id, { revision: referral.revision, request_id: 'decision', command: {
  action: 'decide', row_id: reportedRow, outcome: 'pending', finding: 'An identified package is needed', source_id: 'interview-note',
} })
assert.equal(decision.events.at(-1).finding, 'An identified package is needed')
await assert.rejects(nurse.analyzeForm(new FormData()), denied(422, 'invalid_analysis_form'))
const choices = await nurse.intakeProducts('AMLOC')
for (const [code, strength] of [['108455','5 mg'], ['108591','10 mg']]) {
  const product = choices.find(p => p.id === code)
  assert.ok(product?.release)
  assert.equal(product.name, 'amlodipine')
  assert.equal(product.form, 'tablet')
  assert.equal(product.strength, strength)
}
console.log(JSON.stringify({ encounter: 'synthetic', frontOnlyReverse: initial.capture.reverse, activeRows: Object.keys(captured.rows).length,
  sharedSources: shared.map(s => s.organization), pendingItems: pending.map(r => r.capture_item_id),
  revisionAfterAction: changed.revision, replayRevision, referralReason: referral.events.at(-1).reason,
  pharmacistFinding: decision.events.at(-1).finding,
  unauthorized: 403, stale: 409, proposalError: 'view_unavailable', analysisError: 'invalid_analysis_form',
  catalogue: choices.filter(p => ['108455','108591'].includes(p.id)).map(p => [p.id,p.strength,p.form,p.release]) }))
