import { FacilityDetails } from './FacilityDetails'
import { InputField } from '../../components/ui/InputField'
import { Button } from '../../components/ui/Button'
import { useLayoutEffect, useState } from 'react'
import { LuPlus } from 'react-icons/lu'
import type { IntakeText } from '../../i18n/intake'
import { DirectionsEditor } from './DirectionsEditor'
import { hasFields, newStatement, toComponents } from './regimen'
import type { RegimenText } from '../../i18n/regimen'
import { MedicinePicker } from './MedicinePicker'
import { newNote, type CatalogueMatch, type FacilityContact, type Medicine } from './draft'

export function ManualMedicineEntry({
  t,
  rt,
  caseId,
  onAdd,
  onWorkChange,
}: {
  rt: RegimenText
  caseId: string
  t: IntakeText
  onAdd: (medicine: Medicine) => void
  onWorkChange: (hasWork: boolean) => void
}) {
  const [selected, setSelected] = useState<CatalogueMatch>()
  const [name, setName] = useState('')
  const [strength, setStrength] = useState('')
  const [form, setForm] = useState('')
  const [source, setSource] = useState('')
  const [organization, setOrganization] = useState('')
  const [sourceDate, setSourceDate] = useState('')
  const [facilityContact, setFacilityContact] = useState<FacilityContact>({})
  const [quantity, setQuantity] = useState('')
  const [rowId, setRowId] = useState(() => crypto.randomUUID())
  const [statements, setStatements] = useState(() => [newStatement()])
  const [pendingParses, setPendingParses] = useState(0)
  const hasWork = Boolean(name || selected || strength || form || source || organization || sourceDate || Object.values(facilityContact).some(Boolean) || quantity ||
    statements.length > 1 || statements.some(({ note, schedules }) =>
      note.text || note.kind !== 'other_record' || schedules.some(hasFields)))
  useLayoutEffect(() => {
    onWorkChange(hasWork)
    return () => onWorkChange(false)
  }, [hasWork, onWorkChange])
  function add() {
    if (pendingParses > 0) return
    const directions = statements.filter((s) => s.note.text.trim())
    const note = { ...newNote('other_record'), text: source.trim(), author:organization.trim(), date:sourceDate, facilityContact }
    const evidence = { source_id: note.id }
    const label_fields = Object.fromEntries(
      Object.entries({ strength, form, amount_prescribed: quantity })
        .filter(([, value]) => value.trim())
        .map(([key, value]) => [key, { value: value.trim(), status: 'readable', evidence }]),
    )
    onAdd({
      origin: 'manual',
      catalogue: selected,
      evidence: { photos: [], notes: [note, ...directions.map((s) => s.note)], question: '' },
      row: {
        id: rowId,
        identity_status: 'named',
        sources: [evidence, ...directions.map((s) => ({ source_id: s.note.id }))],
        regimens: directions.flatMap(toComponents),
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
    setOrganization('')
    setSourceDate('')
    setFacilityContact({})
    setQuantity('')
    setRowId(crypto.randomUUID())
    setStatements([newStatement()])
  }
  return (
    <div className="stack">
      <p className="hint">{t.manualHint}</p>
      <MedicinePicker
        t={t}
        name={name}
        selected={selected}
        onChange={(value) => {
          setName(value)
          setSelected(undefined)
        }}
        onSelect={(match) => {
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
        <details><summary>{t.organization}</summary><div className="field-pair">
          <InputField label={t.organization} value={organization} onChange={e=>setOrganization(e.target.value)}/>
          <InputField label={t.date} type="date" value={sourceDate} onChange={e=>setSourceDate(e.target.value)}/>
        </div><FacilityDetails t={t} value={facilityContact} onChange={setFacilityContact}/></details>
        <InputField
          label={rt.quantity}
          value={quantity}
          onChange={(e) => setQuantity(e.target.value)}
        />
        {statements.map((statement) => (
          <div className="stack" key={statement.note.id}>
            <DirectionsEditor
              statement={statement}
              caseId={caseId}
              rowId={rowId}
              t={rt}
              setPendingParses={setPendingParses}
              onChange={(next) =>
                setStatements((current) =>
                  current.map((s) => (s.note.id === next.note.id ? next : s)),
                )
              }
            />
            {statements.length > 1 && (
              <Button
                variant="text"
                onClick={() =>
                  setStatements((current) => current.filter((s) => s.note.id !== statement.note.id))
                }
              >
                {rt.remove}
              </Button>
            )}
          </div>
        ))}
        <Button
          variant="text"
          onClick={() => setStatements((current) => [...current, newStatement()])}
        >
          {rt.add}
        </Button>
        <Button
          variant="primary"
          type="submit"
          disabled={!name.trim() || !source.trim() || pendingParses > 0}
        >
          <LuPlus />
          {t.addMedicine}
        </Button>
      </form>
    </div>
  )
}
