import { useState } from 'react'
import { LuFlaskConical } from 'react-icons/lu'
import { createClient } from '../../api/client'
import type { LocalScreeningResult, RuleMatch } from '../../api/contracts'
import { Button } from '../../components/ui/Button'
import type { Language } from '../../i18n/messages'
import { listName, nameWithoutProduct, say, type ListRow } from './listData'

const client = createClient()
const noAction = 'Ingen tiltak nødvendig'
type Pair = LocalScreeningResult['pairs'][number]

function actionRules(pair: Pair) {
  return pair.ddi.interactions?.filter(rule => rule.relevance !== noAction) ?? []
}

function referenceUrl(value: string | null) {
  if (!value) return undefined
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : undefined
  } catch {
    return undefined
  }
}

function SourceRule({ rule, language }: { rule: RuleMatch; language: Language }) {
  const t = (en: string, th: string) => say(language, en, th)
  const ingredientMatch = rule.ingredient_route_match
  const uncertain = ingredientMatch?.classification_uncertain
  const summary = ingredientMatch && t(ingredientMatch.summary_en, ingredientMatch.summary_th)
  const references = [...rule.references, ...(ingredientMatch?.references ?? [])]
  const label = rule.relevance === 'Bør unngås' ? t('FEST flags this combination to avoid', 'FEST ระบุว่าควรหลีกเลี่ยงคู่นี้')
    : rule.relevance === 'Forholdsregler bør tas' ? t('FEST flags this combination for precautions', 'FEST ระบุว่าควรระวังเมื่อใช้คู่นี้')
      : t('Interaction flagged by FEST', 'พบอันตรกิริยาตามข้อมูล FEST')
  return <div className="stack">
    {!uncertain && <strong>{label}</strong>}
    {ingredientMatch && !uncertain && <div>
      {summary && <p>{summary}</p>}
      <small className="hint">{t('Ingredient-level check', 'ตรวจจากตัวยา')}</small>
    </div>}
    <details>
      <summary>{uncertain
        ? t('FEST rule', 'กฎของ FEST') + ' · ' + rule.matched_atcs.flat().join(' + ')
        : t('Source conditions and references', 'เงื่อนไขและเอกสารอ้างอิง')}</summary>
      {uncertain && <p>{label}</p>}
      {rule.condition && <p>{t('Applies when', 'เงื่อนไขที่เกี่ยวข้อง')} · {rule.condition}</p>}
      {rule.consequence && <p>{t('Possible effect', 'ผลที่อาจเกิดขึ้น')} · {rule.consequence}</p>}
      <p className="hint">FEST · {rule.rule_id}</p>
      {ingredientMatch && <p className="hint">{t('Oral ingredient mapping', 'การจับคู่ตัวยาชนิดรับประทาน')} · {ingredientMatch.mapping_version}</p>}
      {references.map((ref, index) => {
        const url = referenceUrl(ref.url)
        return url ? <a className="text-action" key={index} href={url} target="_blank" rel="noreferrer">
          {ref.title || t('Open reference', 'เปิดเอกสารอ้างอิง')}
        </a> : ref.title ? <p key={index}>{ref.title}</p> : null
      })}
    </details>
  </div>
}

function InteractionFindings({ pair, language }: { pair: Pair; language: Language }) {
  const t = (en: string, th: string) => say(language, en, th)
  const rules = actionRules(pair)
  const uncertain = rules.some(rule => rule.ingredient_route_match?.classification_uncertain)
  const summaries = new Set(rules.flatMap(rule => {
    const match = rule.ingredient_route_match
    return match && match.classification_uncertain ? [t(match.summary_en, match.summary_th)] : []
  }).filter(Boolean))
  return <>
    {uncertain && <div className="stack">
      <strong>{t('FEST flags a potential interaction', 'FEST พบอันตรกิริยาที่อาจเกิดขึ้น')}</strong>
      {[...summaries].map(summary => <p key={summary}>{summary}</p>)}
      <small className="hint">{t('The ingredient matches more than one product classification. Check the indication to see which rule applies.',
        'ตัวยาตรงกับการจัดกลุ่มผลิตภัณฑ์มากกว่าหนึ่งแบบ ตรวจสอบข้อบ่งใช้เพื่อเลือกกฎที่ตรงกับผลิตภัณฑ์')}</small>
    </div>}
    {rules.map(rule => <SourceRule key={rule.rule_id} rule={rule} language={language} />)}
  </>
}

export function ListChecks({ rows, language }: { rows: ListRow[]; language: Language }) {
  const [result, setResult] = useState<LocalScreeningResult>()
  const [status, setStatus] = useState<'idle' | 'busy' | 'error'>('idle')
  const t = (en: string, th: string) => say(language, en, th)
  async function check() {
    setResult(undefined)
    setStatus('busy')
    try {
      setResult(await client.checkCatalogueList({ rows: rows.map(row => ({
        row_id: row.row.id, tpu: row.match?.product.tpu ?? null, release: row.match?.release ?? null,
      })) }))
      setStatus('idle')
    } catch { setStatus('error') }
  }
  const byId = new Map(rows.map(row => [row.row.id, row]))
  const names = new Map(rows.map(row => [row.row.id, listName(row, language)]))
  const pairName = (pair: Pair) => pair.row_ids.map(id => names.get(id)).filter(Boolean).join(' + ')
  const pairs = result?.pairs ?? []
  const findings = pairs.filter(pair => actionRules(pair).length || pair.duplicate.status === 'potential')
  const incomplete = pairs.filter(pair =>
    pair.ddi.status === 'unassessed' || pair.ddi.status === 'partial' || pair.duplicate.status === 'unassessed')
  const unresolved = result?.rows.filter(row => row.reason) ?? []
  const scope = t('Catalogue check for interactions and shared ingredients.', 'ตรวจอันตรกิริยาและตัวยาซ้ำจากบัญชียา')
  return <section className="intake-panel stack" aria-labelledby="medicine-checks">
    <div className="spread">
      <div>
        <h2 id="medicine-checks">{t('Medicine checks', 'ตรวจสอบยา')}</h2>
        <p className="hint">{scope}</p>
      </div>
      <Button onClick={() => void check()} disabled={status === 'busy' || rows.length < 2}>
        <LuFlaskConical aria-hidden="true"/>
        {status === 'busy' ? t('Checking…', 'กำลังตรวจ…') : result ? t('Check again', 'ตรวจอีกครั้ง') : t('Check medicines', 'ตรวจสอบยา')}
      </Button>
    </div>
    {rows.length < 2 && <p className="hint">{t('Add another medicine to compare.', 'เพิ่มยาอีกหนึ่งรายการเพื่อเปรียบเทียบ')}</p>}
    {status === 'error' && <p role="alert">{t('Could not load the medicine references. Try again.', 'เปิดข้อมูลอ้างอิงยาไม่ได้ ลองอีกครั้ง')}</p>}
    {result && <>
      <div className="check-summary" role="status">
        <strong>{findings.length > 0
          ? t(findings.length === 1 ? '1 pair to review' : findings.length + ' pairs to review', findings.length + ' คู่ที่ควรทบทวน')
          : incomplete.length === pairs.length
            ? t('No pair fully assessed', 'ยังประเมินได้ไม่ครบทุกคู่')
            : t('No findings in covered pairs', 'ไม่พบปัญหาในคู่ที่ตรวจได้')}</strong>
        {incomplete.length > 0 && <small>{t(incomplete.length === 1
          ? '1 pair with incomplete coverage' : incomplete.length + ' pairs with incomplete coverage',
        incomplete.length + ' คู่ที่ตรวจได้ไม่ครบ')}</small>}
      </div>
      {findings.map(pair => <article className="check-finding stack" key={pair.row_ids.join(':')}>
        <h3>{pairName(pair)}</h3>
        {pair.duplicate.status === 'potential' && <p>
          <strong>{t('Shared ingredient', 'ตัวยาซ้ำ')}</strong>
          {' · '}{pair.duplicate.ingredients?.map(item => item.name).join(', ')}
          <small className="block">TMT {result.tmt_release}</small>
        </p>}
        <InteractionFindings pair={pair} language={language} />
      </article>)}
      {unresolved.length > 0 && <div>
        <h3>{t('Medicines that couldn’t be assessed', 'รายการยาที่ยังประเมินไม่ได้')}</h3>
        <ul className="check-unassessed">
          {unresolved.map(resultRow => {
            const row = byId.get(resultRow.row_id)
            const reason = row?.match ? t('Re-select this product from the catalogue', 'เลือกผลิตภัณฑ์นี้จากบัญชียาอีกครั้ง')
              : row && nameWithoutProduct(row) ? t('No TMT product for the check', 'ไม่มีผลิตภัณฑ์ TMT สำหรับตรวจ')
                : t('Medicine name needs review', 'ต้องตรวจสอบชื่อยา')
            return <li key={resultRow.row_id}>{names.get(resultRow.row_id)} · {reason}</li>
          })}
        </ul>
      </div>}
      <details>
        <summary>{t('View all pairs', 'ดูยาทุกคู่')} ({pairs.length})</summary>
        <div className="stack">
          {pairs.map(pair => <div className="list-check-pair" key={pair.row_ids.join(':')}>
            <strong>{pairName(pair)}</strong>
            <p>{t('Interactions', 'อันตรกิริยา')} · {pair.ddi.status === 'partial' ? t('Partly assessed', 'ตรวจได้บางส่วน')
              : pair.ddi.status === 'unassessed' ? t('Unassessed', 'ยังไม่ได้ประเมิน')
                : actionRules(pair).length ? t('Finding to review', 'พบข้อมูลที่ควรทบทวน') : t('No finding in scope', 'ไม่พบในขอบเขตที่ตรวจ')}</p>
            <p>{t('Shared ingredients', 'ตัวยาซ้ำ')} · {pair.duplicate.status === 'unassessed' ? t('Unassessed', 'ยังไม่ได้ประเมิน')
              : pair.duplicate.status === 'potential' ? pair.duplicate.ingredients?.map(item => item.name).join(', ')
                : t('None found', 'ไม่พบ')}</p>
            {pair.ddi.status === 'unassessed' && <small>{pair.ddi.reasons[0]?.replace(/^(First|Second) row: /, '')}</small>}
          </div>)}
          <small>TMT {result.tmt_release}{result.fest_release && ' · FEST ' + result.fest_release}</small>
        </div>
      </details>
    </>}
  </section>
}
