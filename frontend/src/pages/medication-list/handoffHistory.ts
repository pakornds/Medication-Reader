import { exportRows, listName, scheduleSummary, values, type ListRow } from './listData'
import type { Language } from '../../i18n/messages'

const prefix = 'medrec:completed-handoff:'

type HistoryMedicine = {
  name: string
  strength: string | null
  form: string | null
  tpu: string | null
  quantity: string
  schedule: Record<Language, string[]>
}
type HistoryHandoff = {
  createdAt: string
  medicines: HistoryMedicine[]
}

export function saveHandoff(rows: ListRow[], language: Language): boolean {
  const exported = exportRows(rows)
  const entry: HistoryHandoff = {
    createdAt: new Date().toISOString(),
    medicines: rows.map((row, index) => {
      const medicine = exported[index]
      const { schedules } = values(row)
      return {
        name: listName(row, language),
        strength: medicine.strength,
        form: medicine.dosage_form,
        tpu: medicine.tpu,
        quantity: medicine.quantity_as_written,
        schedule: {
          en: schedules.map(schedule => scheduleSummary(schedule, 'en')).filter(Boolean),
          th: schedules.map(schedule => scheduleSummary(schedule, 'th')).filter(Boolean),
        },
      }
    }),
  }
  try {
    localStorage.setItem(prefix + crypto.randomUUID(), JSON.stringify(entry))
    return true
  } catch {
    return false
  }
}

function isMedicine(value: unknown): value is HistoryMedicine {
  if (!value || typeof value !== 'object') return false
  const row = value as Partial<HistoryMedicine>
  const nullableText = (field: unknown) => field === null || typeof field === 'string'
  return typeof row.name === 'string' && typeof row.quantity === 'string'
    && [row.strength, row.form, row.tpu].every(nullableText)
    && [row.schedule?.en, row.schedule?.th].every(schedule =>
      Array.isArray(schedule) && schedule.every(line => typeof line === 'string'))
}

function isHandoff(value: unknown): value is HistoryHandoff {
  if (!value || typeof value !== 'object') return false
  const entry = value as Partial<HistoryHandoff>
  return typeof entry.createdAt === 'string' && Number.isFinite(Date.parse(entry.createdAt))
    && Array.isArray(entry.medicines) && entry.medicines.length > 0 && entry.medicines.every(isMedicine)
}

export function readHandoffs(): Array<HistoryHandoff & { key: string }> | null {
  try {
    const result: Array<HistoryHandoff & { key: string }> = []
    for (let index = 0; index < localStorage.length; index++) {
      const key = localStorage.key(index)
      if (!key?.startsWith(prefix)) continue
      const raw = localStorage.getItem(key)
      if (!raw) continue
      try {
        const entry: unknown = JSON.parse(raw)
        if (isHandoff(entry)) result.push({ ...entry, key })
      } catch {
        // A damaged entry should not hide the rest of the history.
      }
    }
    return result.sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))
  } catch {
    return null
  }
}
