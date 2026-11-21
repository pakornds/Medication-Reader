import { searchProducts } from '../../api/reconciliation'
import type { CatalogueMatch, Evidence, FacilityContact, Medicine, MedicineEvidence, Preview } from '../new-patient/draft'
import { regimenText } from '../../i18n/regimen'
import type { Language } from '../../i18n/messages'
import { rowName, scanEvidence } from '../new-patient/draft'
import { basisFor, emptySchedule, fromComponent, hasFields, periods, type Schedule, type Statement } from '../new-patient/regimen'

export type ListRow = MedicineEvidence & {
  match?: CatalogueMatch
  suggested?: boolean
  alternatives: CatalogueMatch[]
  manualName?: string
  manualStrength?: string
  manualForm?: string
  edit?: RowEdit
}

export type RowEdit = {
  wording: string
  quantity: string
  schedules: Schedule[]
  basis: 'documented' | 'reported'
  scheduleSources?: Record<string, { basis: RowEdit['basis']; wording: string }>
  facility?: FacilityContact & { organization?: string }
}

export function values(row: ListRow): RowEdit {
  if (row.edit) return row.edit
  const schedules = row.row.regimens?.map(fromComponent) ?? []
  const wording = row.row.label_fields.directions?.value || row.row.regimens?.[0]?.directions_text || ''
  return {
    wording,
    quantity: row.row.label_fields.amount_prescribed?.value || '',
    schedules: schedules.length ? schedules : [emptySchedule()],
    basis: row.row.regimens?.[0]?.basis === 'reported' ? 'reported' : 'documented',
  }
}

export function manualRow(medicine: Medicine, statements: Statement[]): ListRow {
  const row: ListRow = {
    ...medicine,
    match: medicine.catalogue,
    manualName: medicine.row.observed_names[0]?.value,
    alternatives: [],
  }
  const active = statements.filter(statement => statement.note.text.trim() || statement.schedules.some(hasFields))
  if (!active.length) return row
  return {
    ...row,
    edit: {
      ...values(row),
      wording: active.map(statement => statement.note.text.trim()).filter(Boolean).join(' / '),
      basis: basisFor(active[0].note.kind),
      schedules: active.flatMap(statement => statement.schedules),
      scheduleSources: Object.fromEntries(active.flatMap(statement => statement.schedules.map(schedule => [
        schedule.id, { basis: basisFor(statement.note.kind), wording: statement.note.text.trim() },
      ]))),
    },
  }
}

export async function scannedRows(preview: Preview, evidence: Evidence, signal: AbortSignal): Promise<ListRow[]> {
  const lookups = new Map<string, ReturnType<typeof searchProducts>>()
  return Promise.all(preview.rows.map(async row => {
    const scan = scanEvidence(preview, row, evidence)
    const identity = scan.catalogueIdentity
    const alternatives: CatalogueMatch[] = []
    if (identity) {
      const search = identity.trade_name || identity.ingredient
      const request = lookups.get(search) ?? searchProducts(search.slice(0, 120), signal)
      lookups.set(search, request)
      try {
        const response = await request
        if (response.tmt_release === identity.release) {
          const compatible = [...new Set([...identity.candidate_tpus, ...(identity.compatible_tpus ?? [])])]
          const products = await Promise.all(compatible.map(async id => {
            const product = response.products.find(item => item.tpu === id && item.active_tmt)
              ?? await searchProducts(id, signal).then(result => result.tmt_release === identity.release
                ? result.products.find(item => item.tpu === id && item.active_tmt) : undefined)
            return product ? { product, release: identity.release } : null
          }))
          alternatives.push(...products.filter(product => product !== null))
        }
      } catch {
        // A local lookup failure leaves the original scan available for review.
      }
    }
    const match = identity?.compatible_tpus?.length === 1 && alternatives.length === 1 && !row.discrepancies.length
      ? alternatives[0] : undefined
    return { ...scan, alternatives, match, suggested: Boolean(match) }
  }))
}

export const say = (language: Language, en: string, th: string) => language === 'th' ? th : en

export function listName(row: ListRow, language: Language) {
  const product = row.match?.product
  const identity = row.catalogueIdentity
  if (product && (!identity || ![...identity.candidate_tpus, ...(identity.compatible_tpus ?? [])].includes(product.tpu)))
    return product.label
  return (!product && nameWithoutProduct(row)) || rowName(row.row, language, row.catalogueIdentity)
}

export function writtenNames(row: ListRow): string[] {
  if (row.row.identity_status !== 'named') return []
  return [...new Set(row.row.observed_names.map(name => name.value.trim()).filter(Boolean))]
}

export function nameWithoutProduct(row: ListRow): string | undefined {
  if (row.manualName !== undefined) return row.manualName.trim() || undefined
  const names = writtenNames(row)
  return names.length === 1 && !row.row.discrepancies.length ? names[0] : undefined
}

export function canShare(row: ListRow) {
  return Boolean(row.match || nameWithoutProduct(row))
}

export function scheduleSummary(schedule: Omit<Schedule, 'id' | 'complete' | 'remainder'>, language: Language) {
  const t = regimenText[language]
  const unit = periods.find(period => period === schedule.periodUnit)
  const period = unit && schedule.period ? t.formatPeriod(Number(schedule.period), t[unit]) : ''
  const frequency = period && (
    schedule.mode === 'interval' ? t.formatInterval(period) : schedule.count ? t.formatFrequency(Number(schedule.count), period) : ''
  )
  const times = schedule.times.map(time => t[time as keyof typeof t] as string || time)
  return [[schedule.amount, schedule.unit].filter(Boolean).join(' '), frequency, times.join(', '),
    schedule.route, schedule.meal, schedule.prn === 'yes' && t.prn].filter(Boolean).join(' · ')
}

export function exportRows(rows: ListRow[]) {
  return rows.map(row => {
    const product = row.match?.product
    const edit = values(row)
    const facility = edit.facility ?? row.facility
    const record = row.evidence.notes.find(note => note.kind === 'other_record')
    return {
      product_name: product?.label ?? nameWithoutProduct(row) ?? '',
      ingredient: product?.source_generic ?? '',
      tpu: product?.tpu ?? null,
      tmt_release: row.match?.release ?? null,
      strength: product?.strength ?? row.manualStrength ?? row.row.label_fields.strength?.value ?? null,
      dosage_form: product?.dose_form ?? row.manualForm ?? row.row.label_fields.form?.value ?? null,
      directions: edit.wording,
      directions_source: edit.basis === 'reported' ? 'patient_report'
        : row.evidence.photos.length || row.evidence.notes.some(note => note.text.trim()) ? 'documented' : 'manual_entry',
      quantity_as_written: edit.quantity,
      schedules: edit.schedules.filter(hasFields).map(schedule => ({
        basis: edit.scheduleSources?.[schedule.id]?.basis
          ?? (row.edit ? edit.basis : row.row.regimens?.find(c => c.component_id === schedule.id)?.basis ?? edit.basis),
        directions_as_written: edit.scheduleSources?.[schedule.id]?.wording || null,
        dose_amount: schedule.amount ? Number(schedule.amount) : null,
        dose_unit: schedule.unit || null,
        schedule_type: schedule.mode || null,
        frequency_count: schedule.mode === 'frequency' && schedule.count ? Number(schedule.count) : null,
        period_value: schedule.mode && schedule.period ? Number(schedule.period) : null,
        period_unit: schedule.mode ? schedule.periodUnit || null : null,
        times: schedule.times,
        route: schedule.route || null,
        meal_relation: schedule.meal || null,
        as_needed: schedule.prn ? schedule.prn === 'yes' : null,
      })),
      source: {
        original_names: row.row.observed_names.map(name => name.value),
        original_directions: row.row.label_fields.directions?.value ?? null,
        kind: row.evidence.photos.length ? 'label_photo' : row.evidence.notes.length ? 'note' : 'manual_entry',
        date: row.evidence.photos[0]?.date || row.evidence.notes[0]?.date || null,
        organization: facility?.organization ?? row.evidence.notes.find(note => note.kind === 'other_record')?.author ?? null,
        type: facility?.organization_type ?? record?.facilityContact?.organization_type ?? null,
        department: facility?.department_or_ward ?? record?.facilityContact?.department_or_ward ?? null,
        phone: facility?.organization_phone ?? record?.facilityContact?.organization_phone ?? null,
        extension: facility?.organization_phone_extension ?? record?.facilityContact?.organization_phone_extension ?? null,
        address: facility?.organization_address ?? record?.facilityContact?.organization_address ?? null,
        email: facility?.organization_email ?? record?.facilityContact?.organization_email ?? null,
      },
    }
  })
}
