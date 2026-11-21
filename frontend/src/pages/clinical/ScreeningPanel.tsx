import { useEffect, useRef, useState } from 'react'
import { renderEncounterCoverage } from '../../../../src/components/checks/coverage-panel.mjs'
import { ApiError } from '../../api/client'
import type { Encounter } from '../../api/admission'
import type { LocalScreeningResult, VersionedScreeningReport } from '../../api/contracts'
import { rowName, type Client, type Say } from './review'

function safeLink(raw: string | null) {
  try {
    const url = new URL(raw || '')
    return ['https:', 'http:'].includes(url.protocol) ? url.href : undefined
  } catch {
    return undefined
  }
}

export function ScreeningPanel({ client, encounter, t }: { client: Client; encounter: Encounter; t: Say }) {
  const [local, setLocal] = useState<LocalScreeningResult>()
  const [reports, setReports] = useState<Partial<Record<'DDI'|'DRP', VersionedScreeningReport>>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const locked = useRef(false)
  const name = (id: string) => (encounter.rows[id] ? rowName(encounter.rows[id], t) : id)
  const status = (v: string) =>
    ({
      potential: t('Potential finding', 'อาจพบปัญหา'),
      lookup_complete: t('Lookup complete', 'ค้นข้อมูลแล้ว'),
      partial: t('Partial coverage', 'ตรวจได้บางส่วน'),
      unassessed: t('Unassessed', 'ยังประเมินไม่ได้'),
      finding: t('Finding', 'พบผล'),
      no_finding: t('No finding in evaluated scope', 'ไม่พบในขอบเขตที่ประเมิน'),
      unevaluated: t('Unevaluated', 'ไม่ได้ประเมิน'),
      complete: t('Complete', 'เสร็จแล้ว'),
      unavailable: t('Unavailable', 'ไม่พร้อมใช้งาน'),
      not_run: t('Not run', 'ยังไม่ตรวจ'),
    })[v] || v
  async function run(kind: 'local' | 'DDI' | 'DRP') {
    if (locked.current) return
    locked.current = true
    setBusy(true)
    setError('')
    try {
      if (kind === 'local') {
        setLocal(undefined)
        setLocal(await client.localCheck({ case_id: encounter.id, admission_revision: encounter.revision }))
      } else {
        setReports(previous => ({ ...previous, [kind]: undefined }))
        const previous = await client.snapshot(encounter.id).catch((error) => {
          if (error instanceof ApiError && error.status === 404) return null
          throw error
        })
        const snapshot =
          previous?.current && previous.admission_revision === encounter.revision
            ? previous
            : await client.updateSnapshot(encounter.id, {
                admission_revision: encounter.revision,
                previous_snapshot_id: previous?.snapshot_id,
              })
        const report = await client.runReport(encounter.id, kind, { snapshot_id: snapshot.snapshot_id, enabled: true })
        setReports(previous => ({ ...previous, [kind]: report }))
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : t('Screening unavailable', 'คัดกรองไม่ได้'))
    } finally {
      locked.current = false
      setBusy(false)
    }
  }
  return (
    <details className="clinical-card screening">
      <summary>{t('Optional medication checks', 'การตรวจสอบยาเพิ่มเติม')}</summary>
      <p>
        {t(
          'Check the current encounter against the installed interaction and ingredient databases.',
          'ตรวจการเกิดปฏิกิริยาระหว่างยาและตัวยาซ้ำจากฐานข้อมูลที่ติดตั้งสำหรับเคสนี้',
        )}
      </p>
      <button type="button" className="btn" disabled={busy} onClick={() => void run('local')}>
        {t('Check interactions and duplicate ingredients', 'ตรวจยาตีกันและตัวยาซ้ำ')}
      </button>
      {busy && <p role="status">{t('Running check…', 'กำลังตรวจสอบ…')}</p>}
      {error && <p role="alert">{error}</p>}
      {local && (
        <section aria-live="polite" className="clinical-form">
          <p>{[local.tmt_release, local.fest_release, local.checked_at].filter(Boolean).join(' · ')}</p>
          {local.warnings?.map((warning) => (
            <p key={warning}>{warning}</p>
          ))}
          {local.ddi_unavailable_reason && <p>{local.ddi_unavailable_reason}</p>}
          {local.rows.map((r) => (
            <div key={r.row_id}>
              <strong>{name(r.row_id)}</strong> ·{' '}
              {r.tpu ? 'TPU ' + r.tpu : t('No confirmed catalogue match', 'ยังไม่จับคู่กับบัญชียา')}
              {r.reason && <p>{r.reason}</p>}
              {r.route_note && <p>{r.route_note}</p>}
            </div>
          ))}
          {!local.pairs.length && <p>{t('No medicine pairs to assess.', 'ไม่มีคู่ยาให้ประเมิน')}</p>}
          {local.pairs.map((pair) => (
            <section key={pair.row_ids.join('/')} className="clinical-inset">
              <h4>{pair.row_ids.map(name).join(' + ')}</h4>
              <p>
                {t('Interaction', 'อันตรกิริยา')} · {status(pair.ddi.status)}
              </p>
              {pair.ddi.reasons.map((r) => (
                <p key={r}>{r}</p>
              ))}
              {pair.ddi.interactions?.map((rule) => (
                <details key={rule.rule_id}>
                  <summary>
                    {rule.relevance} · {rule.rule_id}
                  </summary>
                  <p>
                    {[rule.condition, rule.consequence, rule.mechanism, rule.source_basis]
                      .filter(Boolean)
                      .join(' · ')}
                  </p>
                  {rule.references.map((ref, i) =>
                    safeLink(ref.url) ? (
                      <p key={i}>
                        <a href={safeLink(ref.url)} target="_blank" rel="noreferrer">
                          {ref.title || rule.rule_id}
                        </a>
                      </p>
                    ) : (
                      <p key={i}>{ref.title}</p>
                    ),
                  )}
                </details>
              ))}
              <p>
                {t('Duplicate ingredient', 'ตัวยาซ้ำ')} · {status(pair.duplicate.status)}
              </p>
              {pair.duplicate.ingredients?.map((i) => (
                <p key={i.subs_id}>
                  {i.name} · TMT {i.subs_id}
                </p>
              ))}
              {pair.duplicate.reasons.map((r) => (
                <p key={r}>{r}</p>
              ))}
            </section>
          ))}
          <p className="hint">{local.ddi_scope}</p>
        </section>
      )}
      <details>
        <summary>{t('Simulated DDI / DRP coverage', 'ขอบเขตการคัดกรอง DDI / DRP แบบจำลอง')}</summary>
        <div className="clinical-actions">
          {(['DDI', 'DRP'] as const).map((k) => (
            <button key={k} className="btn" type="button" disabled={busy} onClick={() => void run(k)}>
              {t('Run simulated', 'ตรวจแบบจำลอง')} {k}
            </button>
          ))}
        </div>
        {Object.values(reports).map(report => report && <ReportCoverage key={report.kind} report={report} encounter={encounter} t={t}/>)}
      </details>
    </details>
  )
}

function ReportCoverage({ report, encounter, t }: { report: VersionedScreeningReport; encounter: Encounter; t: Say }) {
  const panel = useRef<HTMLElement>(null)
  useEffect(() => {
    if (panel.current) renderEncounterCoverage(panel.current, report,
      new Map(Object.values(encounter.rows).map(row => [row.id, rowName(row, t)])), t)
  }, [report, encounter, t])
  return <section ref={panel} aria-live="polite"/>
}
