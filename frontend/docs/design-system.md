# Med Reader design system

This guide defines the target styles for the Vite frontend. The current stylesheet still contains the starter screen styles. Use this guide as the screens are built. For page ownership, stage transitions and draft lifetime, see the [frontend architecture](../FRONTEND.md).

## Tailwind and units

Use Tailwind v4 utilities in component markup. Keep shared tokens, font definitions, base interaction rules and print styles in `src/index.css`. When two screens share a control and its states, put that control in `components/ui/`. Reserve inline styles for values measured at runtime. Keep component styles within this system so each screen inherits the same theme.

| Sizing decision | Convention |
| --- | --- |
| Spacing, dimensions, radius, offsets and shadow lengths | Start with the utility scale, such as `gap-4`, `p-6`, `size-5` and `rounded-lg`. Write custom lengths in rem, such as `w-[17.5rem]`. Use fluid widths for responsive content. |
| Typography | Keep the root at the user's browser font size. Define font sizes and their line heights in rem. |
| Borders, dividers, rings and outlines | Use pixel widths for crisp edges. Use `border-t` for a hairline divider and a 2px outline for keyboard focus. |
| Browser measurements | A measured value such as a textarea's `scrollHeight` can be applied directly in pixels. |

In `px-4`, the x means horizontal padding. At the default Tailwind scale this sets 1rem on each side.

## Color tokens

Use numbers for the three surface levels and names for foregrounds, interaction states and status. These example light and dark values establish the starting palette. Keep implementation values together in the global stylesheet.

| Utility | Light | Dark | Where it belongs |
| --- | --- | --- | --- |
| `bg-1` | `#f5f7f8` | `#121a20` | Page canvas |
| `bg-2` | `#ffffff` | `#1c282f` | Top bar, workflow bar, panels and history list |
| `bg-3` | `#eaf0f2` | `#293840` | Inset evidence, quoted text and the area around a photo |
| `text-ink` | `#182831` | `#f1f5f6` | Headings, names, strengths and field values |
| `text-secondary` | `#344952` | `#cfdee4` | Field labels, supporting descriptions and navigation |
| `text-muted` | `#475d68` | `#b4c5cc` | Captions, hints and timestamps |
| `border-line` | `#758790` | `#869aa4` | Dividers and control boundaries |
| `text-accent`, `outline-accent` | `#075e67` | `#81d7de` | Evidence links, selection markers and keyboard focus |

### Actions and feedback

| Element | Resting and interactive states |
| --- | --- |
| Medication row or History entry | Rest on `bg-2`. Use `hover:bg-hover` for a pointer preview. Use `bg-selected` and a persistent accent edge for the open row. Give its control an accessible current or expanded state that matches its behavior. Keep the focus outline visible over either fill. |
| Primary button | Give the main action in each panel a high-contrast fill. Use `bg-primary text-on-primary`, `enabled:hover:bg-primary-hover` and `disabled:bg-primary-disabled disabled:text-on-disabled`. Use a dark fill with light type in light theme and reverse the pair in dark theme. Name the action, for example **Import selected rows**. |
| Status | Use `text-warning bg-warning-soft` for **Needs review**, `text-danger bg-danger-soft` for **Import failed**, `text-success bg-success-soft` for **Imported**, and `text-info bg-info-soft` for an informational notice. Include the label even when an icon is present. Keep **Approved for import** and **Imported** visibly distinct. |
| Dialog | Use `backdrop:bg-overlay` behind a `bg-2 shadow-popup` surface. Give the dialog a visible heading and return focus to its trigger when dismissed. |

Choose the hover fill as a subtle tint and the selected fill as a stronger accent tint. Reserve `bg-3` for evidence so a static excerpt stays visually distinct from the selected row. Use solid status foregrounds on their paired soft backgrounds. Check every intended pair in both themes, including text over hover and selection. Target at least 4.5:1 for normal text and 3:1 for focus indicators and essential control boundaries against adjacent colors.

### Registering tokens

For each new color, define a light value on `:root`, a dark value on `:root[data-theme="dark"]` and its utility in `@theme inline`. Scope numbered tokens to backgrounds so a class like `text-1` cannot accidentally pick up the canvas color. A representative excerpt from the target stylesheet follows.

```css
@import "tailwindcss";
@source not "../docs";

:root {
  --surface-1: #f5f7f8;
  --ink: #182831;
  --accent: #075e67;
}
:root[data-theme="dark"] {
  --surface-1: #121a20;
  --ink: #f1f5f6;
  --accent: #81d7de;
}
@theme inline {
  --background-color-1: var(--surface-1);
  --text-color-ink: var(--ink);
  --color-accent: var(--accent);
}
```

Use the same pattern for other surfaces, foregrounds, status pairs, overlays and `--shadow-popup`. Use named utilities in JSX. Put theme-independent typography in a plain `@theme` block.

## Theme behavior

Follow the device setting on first load and on device changes until the user chooses a theme. Set the effective `data-theme` on the document root before first paint and set `color-scheme` to match for native controls. The top-bar switch overrides the device for the current app session. Hold the override in memory across navigation. A reload follows the device again.

Give the logo a theme-appropriate asset or tint if needed. Keep filters off medication photos and crops so staff can compare the original colors. Test a device change with the switch untouched, then choose the opposite theme and navigate to History and back.

## Typography

Register each named size and line height together, for example `--text-body: 1rem` and `--text-body--line-height: 1.625rem`. Use the same scale in Thai and English.

| Class | Size / line height | Typical weight and use |
| --- | --- | --- |
| `text-title` | 1.5 / 2rem | 600 for the page title |
| `text-heading` | 1.125 / 1.75rem | 600 for panels and dialogs |
| `text-body` | 1 / 1.625rem | 400 for medication values, quoted evidence and text inputs |
| `text-small` | 0.875 / 1.375rem | 400 for supporting text, 500 for navigation, labels and buttons |
| `text-caption` | 0.75 / 1.125rem | 500 for timestamps and short badges |

Reserve 700 for brief emphasis. Use body size for source wording that staff must compare. Use minimum heights and vertical padding so a wrapped field label can grow without clipping Thai tone marks.

## Icons, pointers and keyboard focus

Import named Lucide icons from `react-icons/lu`. Set size with utilities such as `size-5` and inherit the surrounding text color. Hide decorative icons with `aria-hidden="true"`. Give icon-only controls a localized accessible name. Pair consequential actions with a visible text label.

Use native links for destinations and buttons for actions. Give enabled buttons a pointer cursor, editable text an I-beam, and disabled buttons a disabled cursor. Put the reason for an unavailable action in nearby visible text. Apply one global keyboard focus treatment.

```css
@layer base {
  button:enabled { cursor: pointer; }
  button:disabled { cursor: not-allowed; }
  :focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }
}
```

## Layout and spacing

Use a shared `PageContainer` for horizontal gutters and content width. The top-bar background spans the viewport. Its inner content aligns with the workspace. Place the logo, New Patient and History first, with the language and theme controls at the far end. On small screens let the links wrap below the controls in a predictable keyboard order. The second navigation bar appears on New Patient and contains Input, Review and Output. Give the navigation landmarks distinct accessible names. Underline the current destination and set `aria-current="page"` or `aria-current="step"` as appropriate.

| Layout choice | Starting value |
| --- | --- |
| Side gutters | `px-4 md:px-6 lg:px-8` |
| Review workspace | `mx-auto w-full max-w-6xl` for the row list and detail together. At phone width give the detail its own full-width view with a return to the list. |
| History and single-column reading | `mx-auto w-full max-w-3xl` |
| Sections and panels | `gap-8` between major sections, `gap-4` between panels, `p-4 md:p-6` inside panels |
| Related controls | `gap-2` between an icon and its label, `gap-3` between a heading and its content |

Use document scrolling on narrow screens. Open a newly chosen stage at its heading. When staff return from a row detail or History, restore their place in the active case. Changing theme or language preserves focus and scroll position.

## Thai and English

Use a Thai-capable system font stack with `text-body` for paragraphs and inputs. Let labels wrap and controls grow vertically. Check Thai vowel and tone marks at narrow widths and with browser zoom. Keep strengths, units and dates legible in both themes.

Switch interface strings together and update the document's `lang` to `th` or `en`. Preserve label text, units, reporter quotations and source dates exactly as recorded when switching languages. History can format a timestamp for the active locale while retaining its UTC value for lookup. Show the displayed time zone.

## Evidence, states and print

Keep a medication's source beside its value. Show conflicting values with their respective sources side by side on wide screens and as separately labeled blocks on phones. Give printed directions, reported use and reviewer-verified use distinct labels. Show an unresolved item's stable name and matched crop, or a missing-image note.

Distinguish an empty History from a failed lookup. Keep the editable draft visible after an analysis or import failure and place retry feedback near the action that failed.

Print the same dated draft on white with dark text, visible source references, unresolved status labels, matched crops and room for handwritten verification. Hide navigation and interactive controls. Check print preview from both screen themes with a bilingual synthetic row and an unresolved item.

## Walkthrough before shipping a screen

1. Use a synthetic bilingual label and an unlabeled item. Move from Input to Review, switch language and theme, then visit History and return. Confirm the same row, original evidence text and edits are still visible.
2. At phone width, read a long Thai reporter name and compare two conflicting values. Labels and source references should wrap beside their values. Use the keyboard to reach each navigation control, source link and row action, with focus visible throughout.
3. Print from dark theme with both rows pending. Check that the paper draft identifies both rows, keeps the matched crop with its unknown item, and leaves room for notes.
4. Approve one eligible synthetic row and import it. Verify the other row remains pending. Reload and confirm History retains the receipt and New Patient opens an empty case.
