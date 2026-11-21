import type { RegimenComponent } from '../../api/contracts'
import { newNote, type NoteKind } from './draft'

export const namedTimes = ['morning', 'noon', 'afternoon', 'evening', 'night', 'bedtime'] as const
export const periods = ['hour', 'day', 'week', 'month'] as const

export function emptySchedule() {
  return {
    id: crypto.randomUUID() as string,
    amount: '',
    unit: '',
    mode: '' as '' | 'frequency' | 'interval',
    count: '',
    period: '',
    periodUnit: '' as '' | (typeof periods)[number],
    times: [] as string[],
    route: '',
    meal: '',
    prn: '' as '' | 'yes' | 'no',
    complete: false,
    remainder: '',
  }
}

export type Schedule = ReturnType<typeof emptySchedule>
export function newStatement() {
  return { note: newNote('other_record'), schedules: [emptySchedule()], parsed: false }
}
export type Statement = ReturnType<typeof newStatement>
export const basisFor = (kind: NoteKind) => (kind === 'other_record' ? 'documented' : 'reported')

export function fromComponent(c: RegimenComponent): Schedule {
  return {
    id: c.component_id,
    amount: String(c.dose_amount ?? ''),
    unit: c.dose_unit ?? '',
    mode: c.schedule_type ?? '',
    count: String(c.frequency_count ?? ''),
    period: String(c.period_value ?? ''),
    periodUnit: c.period_unit ?? '',
    times: c.time_of_day ?? [],
    route: c.route ?? '',
    meal: c.meal_relation ?? '',
    prn: c.as_needed == null ? '' : c.as_needed ? 'yes' : 'no',
    complete: c.parse_status === 'complete',
    remainder: c.unparsed_text ?? '',
  }
}

export function hasFields(s: Schedule) {
  return Boolean(
    s.amount ||
      s.unit.trim() ||
      s.mode ||
      s.times.length ||
      s.route.trim() ||
      s.meal.trim() ||
      s.prn,
  )
}

export function toComponents({ note, schedules }: Statement): RegimenComponent[] {
  const wording = note.text.trim()
  if (!wording) return []
  return schedules.map((s) => {
    const fields = {
      directions_text: wording,
      dose_amount: s.amount ? Number(s.amount) : null,
      dose_unit: s.unit.trim() || null,
      schedule_type: s.mode || null,
      frequency_count: s.mode === 'frequency' ? Number(s.count) : null,
      period_value: s.mode ? Number(s.period) : null,
      period_unit: s.mode ? s.periodUnit || null : null,
      time_of_day: s.times,
      route: s.route.trim() || null,
      meal_relation: s.meal.trim() || null,
      as_needed: s.prn ? s.prn === 'yes' : null,
    }
    const status = !hasFields(s) ? 'unparsed' : s.complete ? 'complete' : 'partial'
    return {
      ...fields,
      component_id: s.id,
      basis: basisFor(note.kind),
      parse_status: status,
      unparsed_text: status === 'complete' ? null : s.remainder || wording,
      evidence: Object.fromEntries(
        Object.entries(fields)
          .filter(([, v]) => v !== null && (!Array.isArray(v) || v.length > 0))
          .map(([k]) => [k, { source_id: note.id }]),
      ),
    }
  })
}
