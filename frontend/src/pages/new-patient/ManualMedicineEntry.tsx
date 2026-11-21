import { InputField } from '../../components/ui/InputField'
import { Button } from '../../components/ui/Button'
import { useState } from 'react'
import { LuPlus } from 'react-icons/lu'
import type { IntakeText } from '../../i18n/intake'
import { MedicinePicker } from './MedicinePicker'
import { newNote, type CatalogueMatch, type Medicine } from './draft'

export function ManualMedicineEntry({
  t,
  onAdd,
}: {
  t: IntakeText
  onAdd: (medicine: Medicine) => void
}) {
  const [selected, setSelected] = useState<CatalogueMatch>()
  const [name, setName] = useState('')
  const [strength, setStrength] = useState('')
  const [form, setForm] = useState('')
  const [source, setSource] = useState('')
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
  }
  return (
    <div className="stack">
      <p className="hint">{t.manualHint}</p>
      <MedicinePicker t={t} name={name} selected={selected}
        onChange={value => { setName(value); setSelected(undefined) }}
        onSelect={match => {
          setSelected(match)
          setName(match.product.label)
          setStrength('')
          setForm('')
        }}
      />
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
