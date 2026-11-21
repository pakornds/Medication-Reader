import { InputField } from '../../components/ui/InputField'
import { Button } from '../../components/ui/Button'
import { useEffect, useRef, useState } from 'react'
import { LuPlus, LuSearch } from 'react-icons/lu'
import type { IntakeText } from '../../i18n/intake'
import { searchProducts } from '../../api/reconciliation'
import { newNote, type CatalogueMatch, type Medicine, type Product } from './draft'

export function ManualMedicineEntry({
  t,
  onAdd,
}: {
  t: IntakeText
  onAdd: (medicine: Medicine) => void
}) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<{ products: Product[]; tmt_release: string } | null>(null)
  const [selected, setSelected] = useState<CatalogueMatch>()
  const [name, setName] = useState('')
  const [strength, setStrength] = useState('')
  const [form, setForm] = useState('')
  const [source, setSource] = useState('')
  const [status, setStatus] = useState<'idle' | 'searching' | 'error'>('idle')
  const request = useRef<AbortController | null>(null)
  useEffect(() => () => request.current?.abort(), [])
  async function search() {
    request.current?.abort()
    const controller = new AbortController()
    request.current = controller
    setStatus('searching')
    try {
      const found = await searchProducts(query.trim(), controller.signal)
      if (!controller.signal.aborted) {
        setResults(found)
        setStatus('idle')
      }
    } catch {
      if (!controller.signal.aborted) setStatus('error')
    }
  }
  function add() {
    request.current?.abort()
    const note = { ...newNote('other_record'), text: source.trim() }
    const evidence = { source_id: note.id }
    const label_fields = Object.fromEntries(
      Object.entries({ strength, form })
        .filter(([, value]) => value.trim())
        .map(([key, value]) => [key, { value: value.trim(), status: 'readable', evidence }]),
    )
    onAdd({
      origin: 'manual',
      catalogue: selected,
      evidence: { photos: [], notes: [note], question: '' },
      row: {
        id: crypto.randomUUID(),
        identity_status: 'named',
        sources: [evidence],
        observed_names: [{ value: name.trim(), evidence }],
        label_fields,
        reported_use: [],
        discrepancies: [],
        follow_ups: [],
      },
    })
    setSelected(undefined)
    setName('')
    setForm('')
    setStrength('')
    setSource('')
    setQuery('')
    setResults(null)
    setStatus('idle')
  }
  return (
    <div className="stack">
      <p className="hint">{t.manualHint}</p>
      <form
        className="search-line"
        onSubmit={(e) => {
          e.preventDefault()
          void search()
        }}
      >
        <InputField
          label={t.query}
          maxLength={120}
          value={query}
          onChange={(e) => {
            request.current?.abort()
            setQuery(e.target.value)
            setResults(null)
            setStatus('idle')
          }}
        />
        <Button type="submit" disabled={!query.trim() || status === 'searching'}>
          <LuSearch />
          {t.search}
        </Button>
      </form>
      {status === 'searching' && <p role="status">{t.searching}</p>}
      {status === 'error' && <p role="alert">{t.catalogFail}</p>}
      {results &&
        (results.products.length ? (
          <ul className="product-list">
            {results.products.map((p) => (
              <li key={p.tpu}>
                <button
                  onClick={() => {
                    setSelected({ product: p, release: results.tmt_release })
                    setName(p.label)
                    setResults(null)
                  }}
                >
                  <strong>{p.label}</strong>
                  <small>
                    TPU {p.tpu}
                    {p.active_tmt ? '' : ' · ' + t.historical}
                  </small>
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p role="status">{t.noProducts}</p>
        ))}
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault()
          add()
        }}
      >
        <InputField
          label={t.name}
          required
          value={name}
          onChange={(e) => {
            setSelected(undefined)
            setName(e.target.value)
          }}
        />
        {selected && (
          <small>
            TPU {selected.product.tpu} · {selected.release}
          </small>
        )}
        <div className="field-pair">
          <InputField
            label={t.strength}
            value={strength}
            onChange={(e) => setStrength(e.target.value)}
          />
          <InputField label={t.form} value={form} onChange={(e) => setForm(e.target.value)} />
        </div>
        <label>
          {t.manualSource}
          <textarea required value={source} onChange={(e) => setSource(e.target.value)} />
        </label>
        <Button variant="primary" type="submit" disabled={!name.trim() || !source.trim()}>
          <LuPlus />
          {t.addMedicine}
        </Button>
      </form>
    </div>
  )
}
