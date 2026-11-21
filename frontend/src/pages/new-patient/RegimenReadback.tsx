import type { RegimenComponent } from '../../api/contracts'
import type { RegimenText } from '../../i18n/regimen'
import { namedTimes } from './regimen'

export function RegimenReadback({
  component: c,
  t,
}: {
  component: RegimenComponent
  t: RegimenText
}) {
  const times = (c.time_of_day ?? []).map((value) => {
    const key = namedTimes.find((v) => v === value)
    return key ? t[key] : value
  })
  const period = c.period_unit && c.period_value ? t.formatPeriod(c.period_value, t[c.period_unit]) : ''
  const frequency =
    c.schedule_type === 'frequency' && c.frequency_count != null
      ? t.formatFrequency(c.frequency_count, period)
      : c.schedule_type === 'interval'
        ? t.formatInterval(period)
        : ''
  const fields = [
    [t.amount, [c.dose_amount, c.dose_unit].filter((v) => v != null).join(' ')],
    [t.mode, frequency],
    [t.time, times.join(', ')],
    [t.route, c.route],
    [t.meal, c.meal_relation],
    [t.prn, c.as_needed == null ? '' : c.as_needed ? t.yes : t.no],
  ]
  return (
    <section className="regimen-readback">
      <strong>{t[c.basis]}</strong>
      <blockquote>{c.directions_text}</blockquote>
      <dl>
        {fields.map(([key, value]) => (
          <div key={key}>
            <dt>{key}</dt>
            <dd>{value || t.blank}</dd>
          </div>
        ))}
      </dl>
      {c.unparsed_text && (
        <p>
          {t.remaining} · {c.unparsed_text}
        </p>
      )}
    </section>
  )
}
