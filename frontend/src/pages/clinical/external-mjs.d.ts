declare module '*components/print/medication-handoff.mjs' {
  export function renderMedicationHandoff(element: HTMLElement, snapshot: {
    evidence: {sources: unknown[];items: unknown[]}; rows: unknown[]; datedAt:string; mode:string
    referrals: unknown[]; decisions: unknown[]; cropUrl:(ref:{source_id:string})=>string|null
  }):void
}
