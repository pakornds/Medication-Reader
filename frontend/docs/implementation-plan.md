# Frontend implementation plan

Build the medication reconciliation workflow in six phases using the existing Vite, React, and TypeScript scaffold. Follow one synthetic case through intake, analysis, review, print, and mock hospital import. Align the older Next.js ticket paths with the Vite layout before implementation.

Use the [frontend architecture](../FRONTEND.md), [design system](design-system.md), [v1 design](../../docs/specs/medication-reader-v1.md), and [AI behavior contract](../../docs/ai/reconciliation-behavior.md) throughout. Test each phase as it lands. Use synthetic fixtures that match the FastAPI contract while endpoints are in development.

## Phase 1 — App shell and navigation

Build Home, New Patient, and History with a shared top bar, Thai/English language control, and light/dark theme control. Give New Patient three stages — Input, Review, and Output. Keep the active case, stage, and selected row in memory across navigation.

**Acceptance check.** Leave an edited synthetic case for History, switch language, and return to the same stage and row with the edits intact. Starting a fresh case asks for confirmation before discarding work.

## Phase 2 — Evidence intake

Place the label-side and pill-side photo slots together. Explain how to flip items in place and let staff preview and replace either photo independently. Support supplemental photos and manual medication entry. Give patient reports, other source notes, and questions for the agent separate fields. Capture the source of each piece of evidence.

**Acceptance check.** Enter two photos and a Thai patient report, then replace one photo. The other photo and the report retain their own sources. Staff can also proceed with photos alone or text alone.

## Phase 3 — Analysis and confirmation

Connect **Analyze evidence** to FastAPI once the contract and analysis endpoint are ready. Preview validated suggestions, field-level citations, discrepancies, and follow-up questions beside the inputs. Let staff confirm which suggestions enter the draft. Preserve existing edits during reanalysis.

**Acceptance check.** A mixed upload produces a named row and a stable **Unknown medication A**, each with a visible source. A failed request preserves the form and draft for retry or manual entry.

## Phase 4 — Clinical review and print

Show the medication list beside the selected row on desktop. On phones, open the detail at full width with a way back to the list. Show conflicting values with their sources. Keep printed directions, reported use, and clinician-verified current use distinct. Let a pharmacist or doctor record the resolution, supporting evidence, verifier, and time.

Generate the dated print handoff from the same draft. Include all rows, sources, supported photo crops, unresolved questions, and space for handwritten verification.

**Acceptance check.** Open both sources for a conflict, record a resolution, and print. Both originals remain visible. An unknown item with an uncertain photo match carries a missing-image note in both digital and print views.

**First demo milestone.** Staff can enter two photos and a patient report, confirm a sourced draft, and print a handoff that shows what still needs verification.

## Phase 5 — Approval, import, and history

Show which rows are eligible for import, the reason beside each pending row, and what will remain after submission. Require explicit pharmacist approval for each selected row. Clear that approval when the row changes. Submit the approved subset to FastAPI for server validation, display actionable errors, and reuse the transient retry token for an unchanged submission. Save only successful server-returned UTC receipt timestamps in local history.

**Acceptance check.** Import one approved row while an unknown row stays pending. Retry an unchanged submission and confirm the mock hospital has one record for it. After reload, the draft is empty and the timestamp opens all records matching that time.

## Phase 6 — End-to-end verification

Exercise the assembled workflow with synthetic fixtures. Check keyboard navigation, Thai text wrapping, mobile review, both themes, print layout, and recovery from analysis and import failures. Run the core workflow with optional checks off. When simulated drug–drug interaction or drug-related problem checks are included, verify their demo labels, coverage, skipped items, and stale state after a relevant edit.

**Acceptance check.** From a fresh browser session, complete intake, analysis, review, print, partial import, and history lookup. Run the frontend tests, lint, and production build.
