# Writing specs and tasks

How to turn an idea into agent-ready GitHub issues. Use this whether a human or a planning agent writes them.

## Flow
1. **Spec** - describe the feature once, at a high level (one issue or a doc in `docs/specs/`).
2. **Split** - break it into tasks, each one PR-sized.
3. **Order** - add `Depends on: #N` so agents work in the right order.
4. **Mark ready** - add `agent-ready` only when the task passes the checklist below.

## 1. Feature spec
Write a spec when a feature needs more than one task. Save it as `docs/specs/<feature>.md`, or as an issue titled `[SPEC] ...`.

```markdown
# [SPEC] <Feature name>

## Problem
Who needs this and why.

## Proposed solution
What the system will do, in plain words. Include the inputs, outputs and main flow.

## Non-goals
What this feature will not do.

## Constraints
Stack, libraries, performance, privacy, safety (e.g. "no medical advice").

## Open questions
Anything undecided. Resolve these before marking tasks agent-ready.

## Task breakdown
- [ ] #<N> Task 1
- [ ] #<N> Task 2 (depends on #<N>)
```

## 2. Splitting into tasks
A good task:
- produces **one PR** that can be reviewed in about 15 minutes
- touches a **small, named set of files**
- has **testable** acceptance criteria (a command to run, an input with its expected output)
- can be done **without asking questions**

Split by layer or by behavior, not by "part 1 / part 2". Example for "read a medication label":

| # | Task | Depends on |
|---|---|---|
| 1 | Scaffold project (package layout, test runner, lint, CI) | none |
| 2 | `MedicationInfo` data model + validation | 1 |
| 3 | Model client interface + mock for tests | 1 |
| 4 | `extract_medication(image_path)` using the client | 2, 3 |
| 5 | Safety layer: strip/refuse dosage advice | 4 |
| 6 | CLI or API endpoint | 4, 5 |

If two outcomes can be implemented, tested, and accepted independently, write two tickets. Keep each behavior's tests with its implementation. For example, one backend ticket can return partial interaction-check coverage for an unknown medication. A separate frontend ticket can display that same result from a shared fixture. Once the contract and fixture land, both tickets can proceed in parallel. Apply the same test to features within a layer, such as digital review and printing.

Give cross-feature wiring its own ticket. Give end-to-end verification a separate ticket with a user scenario and observable result. Before publishing the plan, check that every spec requirement maps to a ticket.

### Parallel tasks and merge order

- Use `Depends on` for work that must merge before a ticket can start. Use `Merge after` only when implementation can start independently but the PR needs another issue merged for integration or release order.
- Put shared contracts, dependencies, and tooling in a prerequisite ticket. Give parallel tickets distinct file ownership, including tests. If two tasks need a shared file, assign it to one task and document which other tasks depend on it.
- Give each side of a shared interface the same examples and let agents verify their work with mocks. Add an integration ticket that depends on both sides and confirms the real workflow together.

## 3. Writing each task
Create it from the **Agent task** template (New issue -> Agent task). Fill in every section:

| Section | Write | Avoid |
|---|---|---|
| Goal | One outcome and why it matters | Several goals in one issue |
| Context | Owned paths, relevant shared contracts, related issues, stack | "the usual place" |
| Requirements | Checkboxes, each verifiable | "make it robust", "handle errors well" |
| Out of scope | Things the agent might be tempted to build | Leaving it empty |
| Acceptance criteria | Commands + expected results | "works correctly" |
| Example | Real input -> exact expected output | Placeholder values |
| Status | `Depends on`, `Merge after` if needed, priority | Leaving dependencies implicit |

### Vague vs. agent-ready
Vague:
> Add error handling to the extractor.

Agent-ready:
> - [ ] `extract_medication` raises `ImageReadError` (defined in `src/reader/errors.py`) when the file is missing, empty, or not JPG/PNG
> - [ ] Error message includes the file path
> - [ ] Tests in `tests/test_extract.py` cover all three cases

## 4. Ready checklist (before adding `agent-ready`)
- [ ] Goal is a single outcome
- [ ] Every requirement can be checked by a test or a command
- [ ] Out of scope is filled in
- [ ] Example has real input and exact output
- [ ] `Depends on` and `Merge after` are set (or `none`), without circular dependencies
- [ ] Owned paths and shared interfaces are clear for any parallel work
- [ ] No open questions remain
- [ ] Label is `status:todo`

## For planning agents
When asked to plan a feature:
1. Write the spec first and stop for human review if there are open questions.
2. Create one issue per task from the Agent task template, with `status:todo`.
3. Fill `Depends on` with real issue numbers (create issues in dependency order).
4. Do **not** add `agent-ready`; a human adds it after review.
5. Link every task from the spec's *Task breakdown*.

```bash
gh issue create --template agent-task.md --title "[TASK] ..." --body-file task.md --label status:todo
```

## Setup prompt for another repository

> Setup only. Add the trigger “Work on the project” to AGENTS.md and link a queue playbook. Reuse existing repo conventions. Create a task-writing guide, issue template and workflow labels. Reserve agent-ready for human review. Let peer workers on any computer independently claim eligible tickets using an atomic per-issue claim. Document owned paths, dependencies, merge order, one branch and PR per ticket, and safe handoffs. Require claim and progress comments, five-minute checks during implementation, verification before merge and owner-checked release. Require each worker to open a PR and spawn an independent review agent before merging. Use the most capable code-review model available to the session unless the user requests a specific model. If several models share the highest capability tier, choose any of them. If model selection is unavailable, use the default reviewer and disclose that limitation on the PR. If an independent reviewer cannot run, ask the user how to proceed. For changes to runnable behavior, run the affected workflow through its normal entry point with a representative synthetic input. After each ticket is merged and verified, post a completion update directly in the Codex chat before claiming another ticket. Include the issue, PR, and verification result. For runnable changes, show the evidence in that update. For a UI, include a screenshot or short recording of the resulting state when possible. For an API or CLI, show the request or command and a short excerpt of the actual response or output. Say what you expected and what you observed. If the workflow could not run, tell the user what you tried, what blocked it and what remains unverified. Record findings on the PR and address them. Explicitly authorize the independent reviewer to merge the reviewed commit when permissions, verification, merge order and required reviews allow it. The ticket owner handles post-merge closeout. If an implementation decision remains unclear after checking the ticket and relevant docs, ask the user a specific question before proceeding with the affected work. Continue independent work while waiting and record the answer on the ticket. If a required API key, account permission, or user-only setup step is missing, ask the user in Codex chat. Name the setting, explain what it enables, and say where to configure it securely. Ask for confirmation once configured. Never request the secret value in chat or on GitHub. Record only the blocker on the issue, continue independent work, and retry the affected check without exposing credentials. Test competing claims on an isolated remote. Verify and publish the setup, then wait for a separate request to start implementation.
