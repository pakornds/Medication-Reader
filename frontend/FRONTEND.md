# Med Reader frontend architecture

The app has one medication reconciliation workflow and three destinations. **Home** introduces the workflow. **New Patient** holds the active case. **History** lists successful imports. All three use the same top bar. The demo opens on Home, with no sign-in screen or account menu.

This is the proposed structure for the existing Vite, React and TypeScript scaffold. The v1 design and some ticket paths still assume Next.js App Router. Use the Vite entry point and coordinate path changes with the owners of those tickets before implementing them. The backend publishes the FastAPI contract and owns import authorization. [V1 design](../docs/specs/medication-reader-v1.md) · [AI behavior contract](../docs/ai/reconciliation-behavior.md)

## Navigation

| Area | Behavior |
| --- | --- |
| Global top bar | Logo, Home, + New Patient, History, flexible space, TH/EN switch, light/dark switch. Selecting New Patient returns to the active case. Starting a fresh case is a separate explicit action if a draft exists. |
| Home | A short instruction page in the selected language explains how to photograph both sides of the same items, compare sources in Review, and print or submit pharmacist-approved rows in Output. Direct staff to **+ New Patient** to begin or resume. |
| + New Patient | A second navigation bar moves between stages of the same draft. The stages are Input, Review and Output. Selecting a stage changes the view of the open case. |
| History | A simple list of successful import timestamps, newest first. Selecting a timestamp looks up matching records on the mock hospital service. If several imports share a timestamp, show all matches for staff to distinguish. |

Use `#/` for Home, `#/new-patient` for the workspace and `#/history` for History. Render one `TopBarLink` per destination inside `TopBar.tsx`. Each takes the destination, translated label and active state, plus an optional leading icon for New Patient. Keep the selected stage and row in React state above the page switch so returning from Home or History restores the same spot.

## New Patient workspace

A new case opens at **Input**. Staff can revisit any stage, including after a partial import. Opening a stage has no side effects. For an empty Review or Output, show “Add evidence or enter a medication to begin” with an action back to Input. Selecting **Start fresh case** with work in progress asks whether to discard that case.

### Input — collect evidence

1. Place **Photo 1 · Label side** and **Photo 2 · Pill side** together. Ask staff to flip each item in place between shots. Give each slot its own preview and replace action. Accept photos, text, or both. A missing second view can be flagged for follow-up.
2. Give **Patient or caregiver report**, **Other source notes** and **Questions for the agent** separate labeled fields. For evidence, capture who supplied it and the date when known. Questions direct the analysis and remain separate from evidence citations.
3. **Analyze evidence** sends the open case inputs to FastAPI. Show progress beside the action. Preview validated suggestions with their sources, then let staff confirm which rows to add. A manual entry carries its own source. Reanalysis leaves existing edits intact until staff confirm changes.
4. On failure, keep the photos, form, and current draft available. Offer retry and manual entry. A successful analysis by itself grants neither clinical verification nor import approval.

### Review — verify one row at a time

On wide screens, place the medication list on the left and the selected row's detail on the right. Each list item shows the documented name or stable unknown name and its review status. On phones, open the detail as a full-width panel with a return to the list. Preserve the selected row when staff return from another stage.

| In the detail panel | What staff see or record |
| --- | --- |
| Identity and source | Show the row's source and link each populated field to its evidence. A matched pill-side crop can sit beside **Unknown medication A** while its dispensing source is still unknown. If matching is uncertain, show a missing-image note. Loose-pill catalog matches remain candidates pending independent evidence. |
| Directions and actual use | Show **Printed directions** with the original label wording and **Reported use** with the reporter and date. A pharmacist or doctor records **Verified current use**, including current, stopped, or uncertain status, supporting evidence, verifier and time. |
| Discrepancies | Put conflicting source values together. Preserve both originals when the reviewer records a resolution. Leave missing or unreadable values blank with a visible reason and a specific follow-up. |

### Output — hand off the draft or import reviewed rows

- **Print draft** opens a dated handoff containing all rows, their sources, unresolved questions, matched crops and space for handwritten verification. Printing is available while rows are pending. It creates no import receipt.
- **Import preview** shows which rows can be selected and gives a reason beside each ineligible row. Selection and pharmacist approval are separate actions. Before submission show the selected count and the rows that will remain pending. Any edit to an approved row requires fresh approval.
- **Import selected rows** submits the explicitly approved subset. If the server rejects a selected row, show the reason and a route back to Review. Keep the selection available for correction. For a retry of an unchanged submission, reuse its transient retry token.
- On success show the server's receipt timestamp and distinguish imported rows from those still pending. History gains the successful UTC timestamp. The remaining rows stay in the active case for follow-up.

## Proposed source layout

Create files as their screens are built.

```text
src/
  main.tsx
  App.tsx                       # Selects the page and owns the active case
  index.css                     # Tailwind entry, theme tokens, base and print rules
  assets/
  components/
    layout/TopBar.tsx           # Shared navigation and preference controls
    ui/                         # Shared controls such as Button and StatusLabel
  pages/
    home/HomePage.tsx           # Bilingual instructions for the reconciliation workflow
    new-patient/
      NewPatientPage.tsx
      WorkflowNav.tsx
      InputPage.tsx             # Evidence form and confirmation preview
      ReviewPage.tsx            # Row list, evidence comparison and verified use
      OutputPage.tsx            # Printable handoff and approved import selection
      draft.ts                  # Case state and edit/reset transitions
    history/
      HistoryPage.tsx
      importHistory.ts          # Read and record successful UTC timestamps
  api/
    reconciliation.ts           # Typed calls using the FastAPI contract
  i18n/
    messages.ts                 # Paired Thai and English interface strings
```

Page ownership gives each component a natural home. A source comparison or print layout starts beside New Patient. Extract a shared component when another view needs the same behavior. Add stage folders inside New Patient once the screens justify them. Revisit a top-level `features/` folder if the product gains a separately maintained clinical workflow.

## Case lifetime and API boundary

- Keep the case state above the page switch so visiting History, changing a stage, or switching language leaves the draft intact. Page-local state can hold temporary UI details such as an expanded source. Reload clears the case.
- Preview the agent's proposed rows before staff add them. Preserve inputs and edits on a failed request. Keep the original wording and field-level evidence alongside corrections. Digital review and print read from the same draft.
- Editing an approved row clears its approval. The backend validates the demo reviewer role, per-row approval and source evidence before import. A successful partial import leaves pending rows available for review.
- Append only the server-returned UTC timestamp after a successful import. Keep photos, case identifiers, medication data, edits, lookup results and retry tokens in memory. Use synthetic cases for development and tests.

## Working locally

From `frontend/`, use `npm ci` to install, `npm run dev` to start Vite, `npm run lint` for ESLint and `npm run build` for TypeScript and the production build. Vite writes the deployment bundle to `frontend/dist/`.

For a navigation change, exercise an edited synthetic draft through New Patient → Home → History → New Patient, then reload. Verify that navigation preserves the draft and reload clears it while keeping successful import timestamps. [Design system](docs/design-system.md)
