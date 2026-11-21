declare module '*components/print/medication-handoff.mjs' {
  export function renderMedicationHandoff(
    element: HTMLElement,
    snapshot: {
      evidence: { sources: unknown[]; items: unknown[] }
      rows: unknown[]
      datedAt: string
      mode: string
      referrals: unknown[]
      decisions: unknown[]
      cropUrl: (ref: { source_id: string; item_id?: string | null }) => string | null
    },
  ): void
}
declare module '*components/candidates/candidate-comparison.mjs' {
  export function mountCandidateComparison(element: HTMLElement, options: {
    request: import('../../api/contracts').CandidateRequest
    cropUrl: string
    lookup: (request: import('../../api/contracts').CandidateRequest) => Promise<import('../../api/contracts').CandidateResult>
  }): () => void
}
declare module '*components/checks/coverage-panel.mjs' {
  export function renderEncounterCoverage(element: HTMLElement, report: import('../../api/contracts').VersionedScreeningReport,
    rowNames: Map<string, string>, t: (english: string, thai: string) => string): void
}
