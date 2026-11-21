import type { Interview } from '../../api/contracts'

export type InterviewAnswers = Omit<Interview, 'action' | 'row_id'>

export type InterviewDraft = {
  source: string
  kind: 'patient_report' | 'caregiver_report'
  wording: string
  answers: InterviewAnswers
  newId?: string
}

export type UpdateInterviewDraft = (current?: InterviewDraft) => InterviewDraft | undefined
