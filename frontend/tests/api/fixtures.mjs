// Compile the repository JSON exactly as supplied, preserving literal discriminants.
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const root = new URL('../../../', import.meta.url)
const fixture = async path => JSON.parse(await readFile(new URL(path, root), 'utf8'))
const transfer = await fixture('backend/tests/fixtures/contracts/transfer_case.json')
const responses = await fixture('backend/tests/fixtures/contracts/service_responses.json')
const capture = await fixture('fixtures/package-capture/two-photos.json')
const examples = [
  [transfer.request, 'FormAnalysisInput'], [transfer.response, 'AnalysisPreview'],
  [capture, 'PackageCapture'],
  [responses.reviewer, 'ReviewerIdentity'], [responses.candidate_match, 'CandidateResult'],
  [responses.candidate_no_match, 'CandidateResult'], [responses.import_success, 'ImportReceipt'],
  [responses.ddi_partial, 'CheckSummary'], [responses.drp_unavailable, 'CheckSummary'],
  [responses.retry_conflict, 'ServiceError'], [responses.provider_timeout, 'ServiceError'],
]
const dir = await mkdtemp(join(tmpdir(), 'medication-reader-types-'))
try {
  const source = join(dir, 'fixtures.ts')
  const contract = fileURLToPath(new URL('frontend/src/api/contracts.ts', root)).replaceAll('\\', '/')
  const statements = examples.map(([value, name]) => '(' + JSON.stringify(value) + ') satisfies C.' + name)
  statements.push('(' + JSON.stringify(responses.import_retry) + ') satisfies Pick<C.ImportRequest, "retry_token" | "selected_row_ids">')
  const eventBase = { actor: responses.reviewer, at: responses.import_success.imported_at, revision: 5, rows: ['pending-b-round'] }
  for (const fields of [
    { action: 'refer', sources: ['note'], checked: 'Front label', reason: 'Identity unresolved' },
    { action: 'decide', sources: ['note'], outcome: 'pending', name: null, finding: 'Further evidence required' },
  ]) statements.push('(' + JSON.stringify({ ...eventBase, ...fields }) + ') satisfies AdmissionEvent')
  const admission = fileURLToPath(new URL('frontend/src/api/admission.ts', root)).replaceAll('\\', '/')
  await writeFile(source, 'import type * as C from ' + JSON.stringify(contract) + '\n' +
    'import type { AdmissionEvent } from ' + JSON.stringify(admission) + '\n' + statements.join(';\n'))
  const program = ts.createProgram([source], {
    strict: true, jsx: ts.JsxEmit.ReactJSX, noEmit: true, types: [], target: ts.ScriptTarget.ES2023,
    module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler,
    allowImportingTsExtensions: true, skipLibCheck: true,
  })
  const errors = ts.getPreEmitDiagnostics(program)
  assert.equal(errors.length, 0, ts.formatDiagnosticsWithColorAndContext(errors, ts.createCompilerHost({})))
  console.log('12 shared fixture contracts and 2 admission handoff event types passed.')
} finally {
  await rm(dir, { recursive: true, force: true })
}
