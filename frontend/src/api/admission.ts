import type { Decision, ImportReceipt, Interview, PackageCapture, ReviewerIdentity, SourceEntry } from './contracts'

type InterviewAnswers = Omit<Interview, 'action' | 'row_id'>
type IdentifiedItem = { name: string; source_id: string }

export interface AdmissionRow {
  id: string
  package_id?: string
  capture_item_id?: string
  unknown_capture_attachments?: string[]
  imported_at?: string
  entries: Array<SourceEntry & { product?: string; label_overrides?: string[] }>
  superseded: string[]
  unknown: boolean
  referred: boolean
  proposal: { name: string; reference: string; proposer: string; independent_entry?: boolean } | null
  confirmed: (IdentifiedItem & { reviewer: string }) | null
  interview: InterviewAnswers | null
  verified: {
    actor: ReviewerIdentity
    at: string
    source_id: string
    identity: IdentifiedItem | null
    resolution: string | null
    answer: InterviewAnswers
  } | null
}

export interface Encounter {
  id: string
  patient_alias: string
  assigned: string[]
  revision: number
  status: 'In progress' | 'Awaiting pharmacist review' | 'Finished'
  created_at: string
  rows: Record<string, AdmissionRow>
  capture?: PackageCapture
  capture_rows?: Record<string, string>
  receipts: ImportReceipt[]
  events: AdmissionEvent[]
}

export type AdmissionEvent = {
  actor: ReviewerIdentity
  at: string
  revision: number
  rows: string[]
} & (
  | { action: 'capture' | 'finish'; sources: string[] }
  | { action: 'add' | 'link'; sources: string[]; replaces: string | null }
  | { action: 'interview'; answer: InterviewAnswers; sources: string[] }
  | { action: 'propose'; proposal: NonNullable<AdmissionRow['proposal']> }
  | { action: 'decide'; outcome: Decision['outcome']; name: string | null; finding: string; sources: string[] }
  | { action: 'verify'; verification: NonNullable<AdmissionRow['verified']>; sources: string[] }
  | { action: 'refer'; checked: string; reason: string; sources: string[] }
  | { action: 'import'; imported_at: string }
)

export type AdmissionCandidate = { id: string; name: string; origin: 'Encounter record' | 'Mock hospital' }
export type EncounterSummary = Pick<Encounter, 'id' | 'patient_alias' | 'status'> & { updated_at: string }
