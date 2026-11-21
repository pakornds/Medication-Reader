import { useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import type { ProductOption, ProductOptions } from '../../api/contracts'
import { searchProducts } from '../../api/reconciliation'
import { Button } from '../../components/ui/Button'
import type { Language } from '../../i18n/messages'
import { EvidenceCrop } from './EvidenceImage'
import { photoCitation, type CatalogueMatch, type Fact, type MedicineEvidence, type Photo, type Region } from './draft'

const copy = {
  en: {
    compare: 'Compare label with catalogue', observed: 'Scanned label', search: 'Search catalogue',
    query: 'Observed name or TPU code', strength: 'Strength', form: 'Form', ingredients: 'Ingredients',
    release: 'Catalogue release', empty: 'No matching trade products', loading: 'Searching…',
    error: 'Catalogue unavailable. Retry the search.', candidates: 'Trade products',
    mismatch: 'Wording differs from the label', confirm: 'Confirm trade product',
    replace: 'Replace confirmed TPU', confirmed: 'Confirmed trade product', missingCrop: 'Crop unavailable',
  },
  th: {
    compare: 'เปรียบเทียบฉลากกับบัญชียา', observed: 'ฉลากที่สแกน', search: 'ค้นหาในบัญชียา',
    query: 'ชื่อบนฉลากหรือรหัส TPU', strength: 'ความแรง', form: 'รูปแบบยา', ingredients: 'ตัวยาสำคัญ',
    release: 'รุ่นบัญชียา', empty: 'ไม่พบผลิตภัณฑ์ที่ตรงกัน', loading: 'กำลังค้นหา…',
    error: 'ไม่สามารถเปิดบัญชียาได้ กรุณาค้นหาอีกครั้ง', candidates: 'ผลิตภัณฑ์ยา',
    mismatch: 'ข้อความต่างจากฉลาก', confirm: 'ยืนยันผลิตภัณฑ์ยา',
    replace: 'แทนที่ TPU ที่ยืนยันแล้ว', confirmed: 'ผลิตภัณฑ์ยาที่ยืนยันแล้ว', missingCrop: 'ไม่มีภาพส่วนที่เลือก',
  },
}

type LocatedName = { fact: Fact; photo: Photo; region: Region }
type Props = {
  scan: MedicineEvidence
  language: Language
  current?: CatalogueMatch
  onConfirm: (match: CatalogueMatch) => void
}

function Search({ scan, language, current, onConfirm, name }: Props & { name: LocatedName }) {
  const t = copy[language]
  const { fact, photo, region } = name
  const [query, setQuery] = useState(fact.value)
  const [result, setResult] = useState<ProductOptions>()
  const [status, setStatus] = useState<'idle' | 'loading' | 'error'>('idle')
  const active = useRef<AbortController | undefined>(undefined)
  useEffect(() => () => active.current?.abort(), [])

  function observed(field: 'strength' | 'form') {
    const value = scan.row.label_fields[field]
    return value?.status === 'readable' && value.evidence?.source_id === fact.evidence.source_id
      && value.evidence.item_id === fact.evidence.item_id ? value.value?.trim() ?? '' : ''
  }
  const strength = observed('strength')
  const form = observed('form')

  async function search(event: FormEvent) {
    event.preventDefault()
    const term = query.trim()
    if (!term) return
    active.current?.abort()
    const controller = new AbortController()
    active.current = controller
    setResult(undefined)
    setStatus('loading')
    try {
      // Include neighboring strengths/forms as alternatives to the narrower label search.
      const qualified = [term, strength, form].filter(Boolean).join(' ')
      const queries = [term]
      if (!/^\d+$/.test(term) && qualified !== term && qualified.length <= 120) queries.unshift(qualified)
      const responses = await Promise.all(queries.map(q => searchProducts(q, controller.signal)))
      if (controller.signal.aborted) return
      const release = responses[0].tmt_release
      if (responses.some(r => r.tmt_release !== release)) throw new Error('Catalogue changed during search')
      const products = new Map<string, ProductOption>()
      for (const response of responses) {
        for (const product of response.products) products.set(product.tpu, product)
      }
      setResult({ tmt_release: release, products: [...products.values()] })
      setStatus('idle')
    } catch {
      if (!controller.signal.aborted) setStatus('error')
    }
  }

  const normalize = (value: string) => value.trim().replace(/\s+/g, ' ').toLowerCase()
  return <div className="field-pair scan-comparison">
    <div className="stack">
      <strong>{t.observed}</strong>
      <span>{fact.value}</span>
      {strength && <span>{t.strength} · {strength}</span>}
      {form && <span>{t.form} · {form}</span>}
      <div className="region-image citation-image"><EvidenceCrop file={photo.file} region={region}
        label={photo.file.name} unavailable={t.missingCrop} /></div>
      <small>{[photo.file.name, region.organization, photo.date].filter(Boolean).join(' · ')}</small>
    </div>
    <div className="stack">
      <form className="stack" onSubmit={search}>
        <label>{t.query}<input value={query} maxLength={120} onChange={event => {
          active.current?.abort()
          setResult(undefined)
          setStatus('idle')
          setQuery(event.target.value)
        }} /></label>
        <Button type="submit" disabled={!query.trim() || status === 'loading'}>{t.search}</Button>
      </form>
      {status === 'loading' && <p role="status">{t.loading}</p>}
      {status === 'error' && <p role="alert">{t.error}</p>}
      {result && <>
        <p role="status">{result.products.length ? t.candidates + ' · ' + result.products.length : t.empty}
          <br />{t.release} · {result.tmt_release}</p>
        {result.products.map(product => {
          const differences = [
            strength && product.strength && normalize(strength) !== normalize(product.strength) && t.strength,
            form && product.dose_form && normalize(form) !== normalize(product.dose_form) && t.form,
          ].filter(Boolean)
          const sameProduct = current?.product.tpu === product.tpu && current.release === result.tmt_release
          const selected = sameProduct && current.evidence?.source_id === fact.evidence.source_id
            && current.evidence.item_id === fact.evidence.item_id
          return <div className="suggestion stack" key={product.tpu}>
            <strong>{product.label}</strong>
            <span>TPU {product.tpu}</span>
            {product.source_generic && <span>{t.ingredients} · {product.source_generic}</span>}
            {product.strength && <span>{t.strength} · {product.strength}</span>}
            {product.dose_form && <span>{t.form} · {product.dose_form}</span>}
            {differences.length > 0 && <span>{t.mismatch} · {differences.join(', ')}</span>}
            {selected ? <strong>{t.confirmed}</strong> :
              <Button onClick={() => onConfirm({ product, release: result.tmt_release, evidence: fact.evidence })}>
                {current && !sameProduct ? t.replace + ' ' + current.product.tpu : t.confirm}
              </Button>}
          </div>
        })}
      </>}
    </div>
  </div>
}

export function ScanCatalogue(props: Props) {
  const [open, setOpen] = useState(false)
  const [index, setIndex] = useState(0)
  const t = copy[props.language]
  if (props.scan.row.identity_status !== 'named') return null
  const names: LocatedName[] = []
  for (const fact of props.scan.row.observed_names) {
    const located = photoCitation(props.scan.evidence, fact.evidence)
    if (fact.evidence.item_id && located?.region && located.region.rowId === props.scan.row.id
      && !(props.scan.row.reverse_crop?.source_id === fact.evidence.source_id
        && props.scan.row.reverse_crop.item_id === fact.evidence.item_id)) {
      names.push({ fact, photo: located.photo, region: located.region })
    }
  }
  const name = names[index] ?? names[0]
  if (!name) return null
  return <details className="citation" onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>{t.compare}</summary>
    {open && <>
      {names.length > 1 && <label>{t.observed}
        <select value={index} onChange={event => setIndex(Number(event.target.value))}>
          {names.map(({ fact }, i) => <option key={i} value={i}>{fact.value}</option>)}
        </select>
      </label>}
      <Search {...props} name={name} key={JSON.stringify([name.fact, name.photo.id, name.region.id])} />
    </>}
  </details>
}
