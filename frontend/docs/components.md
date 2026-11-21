# Med Reader component guide

Use this catalog when planning a screen. The shared controls below are available in the Vite app. The planned catalog describes the remaining screen-specific work. The [frontend architecture](../FRONTEND.md) defines navigation and draft ownership. The [design system](design-system.md) defines tokens, sizing and interaction states.

## First example: the top bar

`App` renders one `TopBar` above the active page. [TopBar](../src/components/layout/TopBar.tsx) renders a [TopBarLink](../src/components/layout/TopBarLink.tsx) for each destination. React Router updates the selected background and current-page state on navigation, including browser Back.

| Label | Destination | Behavior |
| --- | --- | --- |
| Home | `/` | Open the instruction page. |
| + New Patient | `/new-patient` | Open the workspace at Input for an empty case, or resume the active draft. |
| History | `/history` | Open the successful import list. |

Each link receives its address, translated label and optional leading icon. It renders a native anchor and owns the shared hover, keyboard focus and current-page treatment. Only the current link gets `aria-current="page"`. The plus is decorative. Starting a fresh case is a separate workspace action. Keep language and theme controls at the far end of the bar.

## Choosing a component boundary

- Start with the screen that needs the component. When two uses have the same job, name the shared piece and build both uses with it. The photo slots are a good example. Each accepts a label, a preview and a replacement callback, while Input keeps the two evidence references separate.
- Put shell components in `src/components/layout/` and shared presentation controls in `src/components/ui/`. Keep reconciliation-specific pieces beside their pages under `src/pages/`. Review and Output can share a source display inside `pages/new-patient/`.
- Keep a small helper beside its only caller. Extract a separate file when another module needs it or the parent becomes hard to read.
- Let the parent own data that must survive navigation. Pass values and callbacks down to controls. A photo slot can open a file picker, and a status label can display approval. The workspace handles evidence updates and the server validates imports.

## Shared UI components

| Component | Use |
| --- | --- |
| [Button](../src/components/ui/Button.tsx) | Primary, secondary, text, and preference actions. Defaults to an ordinary button. Use `type="submit"` to submit a form. |
| [InputField](../src/components/ui/InputField.tsx) | A labeled native input for text, dates, and numbers. Accepts native input properties and events. |
| [SectionHeading](../src/components/ui/SectionHeading.tsx) | A section title and its short instruction. Use the heading ID to label the surrounding section. |
| [RegionOutline](../src/components/ui/RegionOutline.tsx) | Marks an image region using percentage coordinates. Accepts an optional number for the editable photo view. |

## Screen component catalog

| Component | Owner under `src/` | Responsibility |
| --- | --- | --- |
| `TopBar`, `TopBarLink` | `components/layout/` | Global destinations using React Router NavLink. |
| `LanguageSwitch`, `ThemeToggle` | Top bar | Read the current preference and request a change. Localize accessible names and preserve the active draft. |
| `PageContainer` | `components/layout/` | Align shell and page gutters. Offer reading width for Home and History, wide width for Review. |
| `StatusLabel` | `components/ui/` | Pair translated text with a visual tone. The caller supplies the actual state, such as **Needs review**, **Approved for import**, or **Imported**. |
| `WorkflowNav` | `pages/new-patient/` | Select Input, Review or Output within the same case. Mark the active stage with `aria-current="step"`. |
| `PhotoSlot` | Input | Render the label-side and pill-side uploads independently. Keep each preview and replace action associated with its slot. |
| `EvidenceField` | `pages/new-patient/` | Show a field label, original value and source together in review and handoff. Show the reason for a blank field. Use a readable citation in print. |

Start with the shell components in phase one and add the remaining pieces with their screens. A History receipt and a Review medication row can use the same colors and spacing while keeping their own markup and actions. [Implementation plan](implementation-plan.md)

## Writing and checking components

Use PascalCase for component names and files, named exports for new reusable components, and local prop types beside the component. Keep a hook with its first caller and give it a `use` prefix. Use a small variant union for mutually exclusive appearances. Forward relevant native props such as `type`, `disabled` and `aria-describedby` to the underlying element. Use `type="button"` for ordinary buttons inside forms. The caller can control layout while the component owns its appearance.

Keep interface strings, including accessible labels, in the paired Thai and English messages. Preserve the original wording of medication evidence when the interface language changes. Keep receipt storage in the History module. If browser storage is unavailable after a successful import, show the server receipt and explain that local history could not be saved.

Test a shared component through its callers with synthetic data. For the top bar, navigate Home → New Patient → History and use Back. Confirm the correct link is current, keyboard focus is visible, and the draft resumes. For a shared evidence field, compare the source wording in Review and print, including a missing or unreadable value.
