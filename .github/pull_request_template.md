## Summary
<!-- What changed and why, in 1-3 sentences. -->

Closes #<!-- issue number -->

## Changes
- 

## Acceptance criteria (copied from the issue)

<!-- Repeat for each ticket criterion. Give the observed result and evidence, or the blocker. -->
- Criterion | passed / failed / unverified | result and evidence

## How it was tested

- Tested commit SHA:
- Demo commit SHA (or reason unavailable):
- Evidence by step (mock / live with synthetic data / unverified):
<!-- Record test, lint, type-check, and acceptance-check results on the branch updated from main. -->

<!-- For runnable changes, include the reproduction steps and observed result. Show the evidence directly to the user in the per-ticket completion update as well. -->

## Scenario results

<!-- One line per affected scenario from docs/specs/medication-reader-v1.md#scenarios. -->
- SC-? | passed / expected failure (owning ticket #) / regressed | evidence

## Design comparison

<!-- UI changes only. For each changed screen, place the screenshot beside its design frame from frontend/docs/ref. List each visible difference and the decision that allows it, if any. Remove for non-UI changes. -->

## Independent agent review

- Reviewed commit SHA:
- Ticket verdict and any unmet criteria:
<!-- Before merge, record the reviewer, findings, and how actionable findings were resolved. -->

### Staff UI review

<!-- For UI changes, use independent reviewers and synthetic cases. For every affected page and its handoff, name the reviewer and record what they saw at desktop and phone widths. A single reviewer may cover multiple pages. Mark untested states explicitly. Remove this section for changes outside the staff UI. -->

| Page | Question the reviewer answers from the screen | Reviewer and observed result |
| --- | --- | --- |
| Home | Can a first-time user start a case and can returning staff identify the case they will resume? | |
| Input | Can staff scan or select a medicine, understand one row per package, recover from a failed scan and return to an unfinished entry? | |
| Review | Can staff understand the medicine, directions, source and outstanding decision, including a genuinely unknown item? | |
| Output | After approval and after reopening the case, do imported and pending rows agree with the receipt for the selected medicines? | |
| History | Can staff find a receipt, understand its date and contents and recover when access or the record is unavailable? | |

<!-- Exercise the affected journey from its normal entry point. Record a concrete example with the visible text or an anonymized screenshot. Check that the demo can be completed without typing credentials when local demo access is enabled. -->

## Merge order
<!-- List any Merge after issue numbers from the ticket, or write "none". -->

## Notes for reviewer
<!-- Decisions, trade-offs, anything left out of scope. -->
