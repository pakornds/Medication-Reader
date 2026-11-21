import { FacilityDetails } from './FacilityDetails'
import { InputField } from '../../components/ui/InputField'
import { Button } from '../../components/ui/Button'
import { useState, type Dispatch, type SetStateAction } from 'react'
import { LuPlus } from 'react-icons/lu'
import type { IntakeText } from '../../i18n/intake'
import { DirectionsEditor } from './DirectionsEditor'
import { newStatement, toComponents, type Statement } from './regimen'
import type { RegimenText } from '../../i18n/regimen'
import { MedicinePicker } from './MedicinePicker'
import { newNote, type Medicine } from './draft'
import { createManualEntryDraft, type ManualEntryDraft } from './manualEntryDraft'

export function ManualMedicineEntry({
  t,
  rt,
  caseId,
  onAdd,
  draft,
  setDraft,
}: {
  rt: RegimenText
  caseId: string
  t: IntakeText
  onAdd: (medicine: Medicine) => void
  draft: ManualEntryDraft
  setDraft: Dispatch<SetStateAction<ManualEntryDraft>>
}) {
  const { selected, name, strength, form, source, organization, sourceDate, facilityContact, quantity, rowId, statements } = draft
  const [pendingParses, setPendingParses] = useState(0)
  function update(patch: Partial<ManualEntryDraft>) {
    setDraft((current) => ({ ...current, ...patch }))
  }
  function setStatements(change: (statements: Statement[]) => Statement[]) {
    setDraft((current) => ({ ...current, statements: change(current.statements) }))
  }
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
    setDraft(createManualEntryDraft())
  }
  return (
    <div className="stack">
      <p className="hint">{t.manualHint}</p>
      <MedicinePicker
        t={t}
        name={name}
        selected={selected}
        onChange={(name) => update({ name, selected: undefined })}
        onSelect={(selected) => update({ selected, name: selected.product.label, strength: '', form: '' })}
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
            onChange={(e) => update({ strength: e.target.value })}
          />
          <InputField
            label={t.form}
            value={selected?.product.dose_form || form}
            readOnly={Boolean(selected?.product.dose_form)}
            onChange={(e) => update({ form: e.target.value })}
          />
        </div>
        <label>
          {t.manualSource}
          <textarea required value={source} onChange={(e) => update({ source: e.target.value })} />
        </label>
        <details><summary>{t.organization}</summary><div className="field-pair">
          <InputField label={t.organization} value={organization} onChange={e=>update({ organization: e.target.value })}/>
          <InputField label={t.date} type="date" value={sourceDate} onChange={e=>update({ sourceDate: e.target.value })}/>
        </div><FacilityDetails t={t} value={facilityContact} onChange={facilityContact => update({ facilityContact })}/></details>
        <InputField
          label={rt.quantity}
          value={quantity}
          onChange={(e) => update({ quantity: e.target.value })}
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
