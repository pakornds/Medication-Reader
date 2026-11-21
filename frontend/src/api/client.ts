import type * as C from './contracts'
import type { AdmissionCandidate, Encounter, EncounterSummary } from './admission'

export class ApiError extends Error {
  readonly status: number
  readonly service?: C.ServiceError

  constructor(status: number, message: string, service?: C.ServiceError) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.service = service
  }
}

function serviceError(value: unknown): value is C.ServiceError {
  return typeof value === 'object' && value !== null
    && 'code' in value && typeof value.code === 'string'
    && 'message' in value && typeof value.message === 'string'
    && 'recoverable' in value && typeof value.recoverable === 'boolean'
    && (!('row_ids' in value) || (Array.isArray(value.row_ids) && value.row_ids.every(id => typeof id === 'string')))
}

export function createClient(baseUrl = '', reviewerToken?: string) {
  const base = baseUrl.replace(/\/$/, '')
  const admission = (id: string) => '/admissions/' + encodeURIComponent(id)

  async function response(path: string, init: RequestInit = {}) {
    const headers = new Headers(init.headers)
    if (reviewerToken && (path.startsWith('/admissions') || path.startsWith('/imports') || path === '/checks' || path === '/checks/local')) {
      headers.set('X-Demo-Reviewer-Token', reviewerToken)
    }
    const result = await fetch(base + path, { ...init, headers, redirect: 'error', cache: 'no-store' })
    if (!result.ok) {
      const error = await result.json().catch(() => null)
      const detail: unknown = error?.detail
      if (serviceError(detail)) throw new ApiError(result.status, detail.message, detail)
      throw new ApiError(result.status, typeof detail === 'string' ? detail : 'Request failed (HTTP ' + result.status + ')')
    }
    return result
  }

  async function json<T>(path: string, init?: RequestInit): Promise<T> {
    return (await response(path, init)).json()
  }
  const body = (value: unknown, method = 'POST'): RequestInit => ({
    method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value),
  })
  const products = (query: string, signal?: AbortSignal) =>
    json<C.ProductOptions>('/checks/local/products?' + new URLSearchParams({ q: query }), { signal })
  const analyzeForm = (form: FormData, signal?: AbortSignal) =>
    json<C.AnalysisPreview>('/medication-analysis', { method: 'POST', body: form, signal })

  return {
    products,
    parseRegimen: (request: C.RegimenParseRequest, signal?: AbortSignal) =>
      json<C.RegimenParseResult>('/regimens/parse', { ...body(request), signal }),
    async intakeProducts(query: string, signal?: AbortSignal) {
      const result = await products(query, signal)
      return result.products.map(product => ({
        ...product, id: product.tpu, release: result.tmt_release,
        name: product.source_generic, form: product.dose_form,
      }))
    },
    analyzeForm,
    analyze(input: C.FormAnalysisInput, photos: Blob[], signal?: AbortSignal) {
      const form = new FormData()
      form.append('form', JSON.stringify(input))
      for (const photo of photos) form.append('photos', photo)
      return analyzeForm(form, signal)
    },
    candidates: (input: C.CandidateRequest) => json<C.CandidateResult>('/pill-candidates', body(input)),
    session: () => json<{ actor: C.ReviewerIdentity; catalogue: Array<{ id: string; name: string }> }>('/admissions/session'),
    encounters: () => json<EncounterSummary[]>('/admissions'),
    createEncounter: (input: C.NewEncounter) => json<Encounter>('/admissions', body(input)),
    encounter: (id: string) => json<Encounter>(admission(id)),
    admissionCandidates: (id: string) => json<AdmissionCandidate[]>(admission(id) + '/candidates'),
    action: (id: string, input: C.Action) => json<Encounter>(admission(id) + '/actions', body(input)),
    capture(id: string, command: C.CaptureCommand, originals: { front?: Blob; reverse?: Blob } = {}) {
      const form = new FormData()
      form.append('command', JSON.stringify(command))
      for (const side of ['front', 'reverse'] as const) {
        const image = originals[side]
        if (image) form.append(side, image)
      }
      return json<Encounter>(admission(id) + '/capture', { method: 'POST', body: form })
    },
    proposeRegions: (id: string, view: C.CaptureViewRequest) =>
      json<C.PackageRegionResult>(admission(id) + '/capture/propose-regions', body(view)),
    view: async (id: string, view: C.CaptureViewRequest) =>
      (await response(admission(id) + '/capture/view', body(view))).blob(),
    region: async (id: string, region: C.RegionLink) =>
      (await response(admission(id) + '/capture/region', body(region))).blob(),
    approve: (input: C.ApprovalRequest) => json<C.PharmacistApproval>('/imports/approvals', body(input)),
    importRows: (input: C.ImportRequest) => json<C.ImportReceipt>('/imports', body(input)),
    receipts: (timestamp: string) => json<C.HospitalRecord[]>('/imports?' + new URLSearchParams({ imported_at: timestamp })),
    check: (input: C.CoverageRequest) => json<C.CheckSummary>('/checks', body(input)),
    localCheck: (input: C.LocalScreeningRequest) => json<C.LocalScreeningResult>('/checks/local', body(input)),
    updateSnapshot: (id: string, input: C.SnapshotUpdate) =>
      json<C.SnapshotVersion>(admission(id) + '/review-snapshot', body(input, 'PUT')),
    snapshot: (id: string) => json<C.SnapshotVersion>(admission(id) + '/review-snapshot'),
    runReport: (id: string, kind: C.VersionedScreeningReport['kind'], input: C.RunReport) =>
      json<C.VersionedScreeningReport>(admission(id) + '/review-reports/' + kind, body(input)),
    report: (id: string, kind: C.VersionedScreeningReport['kind'], snapshotId: string) =>
      json<C.VersionedScreeningReport>(admission(id) + '/review-reports/' + kind + '?' + new URLSearchParams({ snapshot_id: snapshotId })),
  }
}
