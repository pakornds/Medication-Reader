import { InputField } from '../../components/ui/InputField'
import { Button } from '../../components/ui/Button'
import { useEffect, useState } from 'react'
import { LuPlus } from 'react-icons/lu'
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
  const [results, setResults] = useState<{ products: Product[]; tmt_release: string } | null>(null)
  const [selected, setSelected] = useState<CatalogueMatch>()
  const [name, setName] = useState('')
  const [strength, setStrength] = useState('')
  const [form, setForm] = useState('')
  const [source, setSource] = useState('')
  const [status, setStatus] = useState<'idle' | 'searching' | 'error'>('idle')
  useEffect(() => {
    const term = name.trim()
    if (!term || selected) return
    const controller = new AbortController()
    const timer = window.setTimeout(async () => {
      setStatus('searching')
      try {
        const found = await searchProducts(term, controller.signal)
        if (controller.signal.aborted) return
        setResults(found)
        setStatus('idle')
      } catch {
        if (!controller.signal.aborted) setStatus('error')
      }
    }, 250)
    return () => {
      window.clearTimeout(timer)
      controller.abort()
    }
  }, [name, selected])

  function add() {
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
    setResults(null)
    setStatus('idle')
  }
  return (
    <div className="stack">
      <p className="hint">{t.manualHint}</p>
      <InputField
        label={t.query}
        type="search"
        autoComplete="off"
        maxLength={120}
        value={name}
        onChange={(e) => {
          setName(e.target.value)
          setSelected(undefined)
          setResults(null)
          setStatus('idle')
        }}
      />
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
                    setStrength('')
                    setForm('')
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
        {selected && (
          <small>
            TPU {selected.product.tpu} · {selected.release}
          </small>
        )}
        <div className="field-pair">
          <InputField
            label={t.strength}
            value={selected?.product.strength || strength}
            readOnly={Boolean(selected?.product.strength)}
            onChange={(e) => setStrength(e.target.value)}
          />
          <InputField
            label={t.form}
            value={selected?.product.dose_form || form}
            readOnly={Boolean(selected?.product.dose_form)}
            onChange={(e) => setForm(e.target.value)}
          />
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
