import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react'
import { Button } from '../../components/ui/Button'
import { InputField } from '../../components/ui/InputField'
import { parseRegimen } from '../../api/reconciliation'
import type { RegimenText } from '../../i18n/regimen'
import {
  basisFor,
  emptySchedule,
  fromComponent,
  hasFields,
  namedTimes,
  periods,
  type Schedule,
  type Statement,
} from './regimen'
import type { NoteKind } from './draft'

function ScheduleEditor({
  s,
  onChange,
  t,
}: {
  s: Schedule
  onChange: (s: Schedule) => void
  t: RegimenText
}) {
  const change = (patch: Partial<Schedule>) =>
    onChange({ ...s, complete: false, remainder: '', ...patch })
  const timeNames = s.times.filter((time) => !time.includes(':'))
  const clocks = s.times.filter((time) => time.includes(':'))
  return (
    <div className="schedule-fields stack">
      <div className="field-pair">
        <InputField
          label={t.amount}
          type="number"
          min={Number.MIN_VALUE}
          step="any"
          value={s.amount}
          onChange={(e) => change({ amount: e.target.value })}
        />
        <InputField
          label={t.unit}
          value={s.unit}
          onChange={(e) => change({ unit: e.target.value })}
        />
      </div>
      <label>
        {t.mode}
        <select
          aria-label={t.mode}
          value={s.mode}
          onChange={(e) =>
            change({
              mode: e.target.value as Schedule['mode'],
              count: '',
              period: '',
              periodUnit: '',
            })
          }
        >
          <option value="">{t.blank}</option>
          <option value="frequency">{t.frequency}</option>
          <option value="interval">{t.interval}</option>
        </select>
      </label>
      {s.mode && (
        <div className="period-fields">
          {s.mode === 'frequency' && (
            <InputField
              required
              label={t.count}
              type="number"
              min="1"
              step="1"
              value={s.count}
              onChange={(e) => change({ count: e.target.value })}
            />
          )}
          <InputField
            required
            label={t.period}
            type="number"
            min={Number.MIN_VALUE}
            step="any"
            value={s.period}
            onChange={(e) => change({ period: e.target.value })}
          />
          <label>
            {t.periodUnit}
            <select
              required
              aria-label={t.periodUnit}
              value={s.periodUnit}
              onChange={(e) => change({ periodUnit: e.target.value as Schedule['periodUnit'] })}
            >
              <option value="">{t.blank}</option>
              {periods.map((v) => (
                <option key={v} value={v}>
                  {t[v]}
                </option>
              ))}
            </select>
          </label>
        </div>
      )}
      <fieldset>
        <legend>{t.time}</legend>
        <div className="schedule-times">
          {namedTimes.map((time) => (
            <button
              type="button"
              key={time}
              aria-pressed={s.times.includes(time)}
              onClick={() =>
                change({
                  times: s.times.includes(time)
                    ? s.times.filter((v) => v !== time)
                    : [...s.times, time],
                })
              }
            >
              {t[time]}
            </button>
          ))}
        </div>
      </fieldset>
      <div className="field-pair">
        {[...clocks, ''].map((clock, i) => (
          <InputField
            key={i}
            label={t.clock}
            type="time"
            value={clock}
            onChange={(e) => {
              const changed = [...clocks]
              changed[i] = e.target.value
              change({ times: [...timeNames, ...new Set(changed.filter(Boolean))] })
            }}
          />
        ))}
      </div>
      <details>
        <summary>{t.more}</summary>
        <div className="field-pair">
          <InputField
            label={t.route}
            value={s.route}
            onChange={(e) => change({ route: e.target.value })}
          />
          <InputField
            label={t.meal}
            value={s.meal}
            onChange={(e) => change({ meal: e.target.value })}
          />
          <label>
            {t.prn}
            <select
              aria-label={t.prn}
              value={s.prn}
              onChange={(e) => change({ prn: e.target.value as Schedule['prn'] })}
            >
              <option value="">{t.blank}</option>
              <option value="yes">{t.yes}</option>
              <option value="no">{t.no}</option>
            </select>
          </label>
        </div>
      </details>
      {hasFields(s) && (
        <label className="pick-row">
          <input
            type="checkbox"
            checked={s.complete}
            onChange={(e) => change({ complete: e.target.checked })}
          />
          {t.covered}
        </label>
      )}
    </div>
  )
}

export function DirectionsEditor({
  statement,
  caseId,
  rowId,
  t,
  onChange,
  setPendingParses,
}: {
  setPendingParses: Dispatch<SetStateAction<number>>
  statement: Statement
  caseId: string
  rowId: string
  t: RegimenText
  onChange: (s: Statement) => void
}) {
  const { note, schedules } = statement
  const request = useRef<AbortController | null>(null)
  const [status, setStatus] = useState<'idle' | 'busy' | 'error'>('idle')
  useEffect(() => () => request.current?.abort(), [])
  useEffect(() => {
    if (status !== 'busy') return
    setPendingParses((n) => n + 1)
    return () => setPendingParses((n) => n - 1)
  }, [status, setPendingParses])
  function edit(next: Statement) {
    request.current?.abort()
    setStatus('idle')
    onChange(next)
  }
  async function fill() {
    request.current?.abort()
    const controller = new AbortController()
    request.current = controller
    setStatus('busy')
    try {
      const response = await parseRegimen(
        {
          evidence: { case_id: caseId, sources: [{ id: note.id, kind: note.kind }], items: [] },
          row_id: rowId,
          component_id: schedules[0].id,
          basis: basisFor(note.kind),
          directions_text: note.text.trim(),
          source: { source_id: note.id },
        },
        controller.signal,
      )
      if (controller.signal.aborted) return
      if (response.row_id !== rowId || !response.regimens.length)
        throw new Error('Invalid regimen response')
      onChange({ ...statement, boundWording: note.text.trim(), schedules: response.regimens.map(fromComponent) })
      setStatus('idle')
    } catch {
      if (!controller.signal.aborted) setStatus('error')
    }
  }
  return (
    <fieldset className="directions-card stack">
      <legend>{t.heading}</legend>
      <div className="field-pair">
        <InputField
          label={t.wording}
          required={schedules.some(hasFields)}
          pattern={schedules.some(hasFields) ? '.*\\S.*' : undefined}
          value={note.text}
          onBlur={() => {
            if (!statement.boundWording && note.text.trim() && schedules.some(hasFields))
              onChange({ ...statement, boundWording: note.text.trim() })
          }}
          onChange={(e) => {
            const text = e.target.value
            const replaced = Boolean(statement.boundWording && statement.boundWording !== text.trim())
            edit({
              ...statement, note: { ...note, text },
              boundWording: replaced ? '' : statement.boundWording,
              schedules: replaced ? [emptySchedule()] : schedules,
            })
          }}
        />
        <label>
          {t.kind}
          <select
            aria-label={t.kind}
            value={note.kind}
            onChange={(e) =>
              edit({ ...statement, note: { ...note, kind: e.target.value as NoteKind } })
            }
          >
            {(['other_record', 'patient_report', 'caregiver_report'] as const).map((k) => (
              <option key={k} value={k}>
                {t[k]}
              </option>
            ))}
          </select>
        </label>
      </div>
      <Button
        type="button"
        disabled={!note.text.trim() || schedules.some(hasFields) || status === 'busy'}
        aria-busy={status === 'busy'}
        onClick={() => void fill()}
      >
        {t.fill}
      </Button>
      {status === 'error' && <p role="alert">{t.failed}</p>}
      {schedules.map((s, i) => (
        <div key={s.id}>
          {schedules.length > 1 && (
            <h3>
              {t.schedule} {i + 1}
            </h3>
          )}
          <ScheduleEditor
            s={s}
            t={t}
            onChange={(next) =>
              edit({
                ...statement,
                boundWording: note.text.trim(),
                schedules: schedules.map((v) => (v.id === s.id ? next : v)),
              })
            }
          />
        </div>
      ))}
    </fieldset>
  )
}
