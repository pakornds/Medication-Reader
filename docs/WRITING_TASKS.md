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

Give cross-feature wiring its own ticket. Give end-to-end verification a separate ticket with a user scenario and observable result. Before publishing the plan, link every requirement to verified implementation evidence, an existing ticket, or a ticket for the remaining gap.

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
2. For each new or changed requirement, fetch the latest default branch and compare the expected behavior against current code and tests. Search open and closed issues (including comments), open PRs and merged PRs by behavior, related terms and affected paths. Verify what actually landed. A closed issue alone does not establish that the requirement was delivered.
   - Already implemented and verified: link the supporting code, tests or merged PR in the spec and skip ticket creation.
   - Already tracked: link the existing issue or PR. Refine the existing ticket for compatible missing acceptance checks and notify its owner if work is active.
   - Partially covered or untracked: describe the precise gap. Recheck GitHub immediately before filing, then create one issue per independently testable missing outcome with `status:todo`. Link prior work and record what it already covers.
3. Fill `Depends on` with real issue numbers (create issues in dependency order).
4. Do **not** add `agent-ready`; a human adds it after review.
5. Link every task from the spec's *Task breakdown*.

```bash
gh issue create --template agent-task.md --title "[TASK] ..." --body-file task.md --label status:todo
```

## Setup prompt for another repository

Copy the following prompt into a session in the target repository.

```text
Setup only. Configure this repository so that a later, separate message saying “Work on the project” starts a worker on the GitHub Issues queue. Setup runs once. Workers on different computers can then claim tickets independently.

Inspect the repository’s existing instructions, templates, labels, branch protections, and verification commands. Reuse what already works. Verify authenticated GitHub access before making remote changes.

Create or update these files:

- `AGENTS.md` — Include the exact trigger “Work on the project” and link to the runtime playbook.
- `docs/RUNNING_TICKET_QUEUE.md` — Document how workers select, claim, implement, review, merge, hand off, and complete tickets. Keep this playbook focused on active work.
- `docs/WRITING_TASKS.md` — Document ticket planning and include a reusable setup prompt for future repositories.
- `.github/ISSUE_TEMPLATE/agent-task.md` — Include the outcome, owned paths and tests, exclusions, concrete input and expected result, acceptance checks, Depends on, Merge after, and a status block for owner, branch, PR, and progress.
- `.github/pull_request_template.md` — Include the closing issue reference, acceptance checks, verification results, independent review findings, and merge order.

Use GitHub Issues as the shared queue and communication board. Create any missing labels: `agent-ready`, `status:todo`, `status:in-progress`, `status:blocked`, `status:in-review`, `status:done`. Each ticket has one status label. A human adds `agent-ready` after reviewing the ticket.

## Ticket planning

During planning, check new or changed requirements against current code, tests, open and closed issues, and open and merged PRs. Link verified work. Update matching open tickets with any missing acceptance checks. Recheck GitHub immediately before filing and create tickets only for uncovered outcomes. When a requirement extends existing behavior, identify the existing code and tests the worker can modify within scope. On startup, resume and each three-minute check, fetch the default branch and compare the published spec with the last successfully assessed revision. On a first run, assess the current requirements. Skip unchanged content. Use the most capable available reasoning model for changed-requirement analysis when possible. Serialize issue creation across workers with a short, atomic planning claim independent of implementation claims. Under the claim, refresh issues and PRs, reuse matching work and file only independently testable uncovered outcomes as status:todo. Link the spec revision and section, and leave agent-ready to human review. Retry incomplete assessments at the next check.

Give each ticket one independently testable outcome that fits in a small PR. Split frontend, backend, and features within either layer whenever they can be accepted independently. Put shared contracts, fixtures, and tooling in prerequisite tickets so workers can test against the same examples in parallel. Give cross-feature wiring and end-to-end verification separate tickets. Use “Depends on” for prerequisites that must merge before work starts, and “Merge after” for merge order only. Check for circular dependencies, overlapping paths, and uncovered requirements.

## Worker playbook

1. Read the current issues, comments, branches, and PRs. Choose an open, unassigned ticket labeled `agent-ready` and `status:todo` whose dependencies have merged. Prefer related tickets when several qualify.
2. Acquire an atomic remote claim keyed by issue number before editing. Use a unique worker/run ID even when computers share one GitHub account. If another worker wins, choose another ticket. If the result is uncertain, verify ownership. Document owner-checked release, explicit handoff, and recovery of abandoned claims.
3. After claiming, recheck for existing work and overlapping paths. Record the worker ID, branch, and owned paths on the issue. Assign it, set `status:in-progress`, and post a claim comment. Use one implementation branch, worktree, and PR per ticket.
4. Start immediately after confirming ownership. Keep working between checks. After three minutes and every three minutes during active work, recheck the claim, ticket comments, related branches, commits, and PRs. Recheck on resume and before pushing. If a conflict appears, preserve edits and resolve it with the other worker before continuing on the affected paths.
5. Ask cross-ticket questions on the recipient worker’s issue, address the worker by name, and link your own ticket. Record decisions where both workers can find them. Update checklists as work progresses and comment on status changes, blockers, and handoffs. If anything about the implementation remains unclear after checking the ticket and relevant docs, ask the user a specific question before proceeding with the affected work. Continue independent work while waiting, and record the answer on the ticket. If a required API key, account permission, or user-only setup step is missing, ask the user in Codex chat. Name the setting, explain what it enables, and say where to configure it securely. Ask for confirmation once configured. Never request the secret value in chat or on GitHub. Record only the blocker on the issue, continue independent work, and retry the affected check without exposing credentials.
6. Run acceptance and repository checks. For changes to runnable behavior, run the affected workflow through its normal entry point with a representative synthetic input. After each ticket is merged and verified, post a completion update directly in the Codex chat before claiming another ticket. Include the issue, PR, and verification result. For runnable changes, show the evidence in that update. For a UI, include a screenshot or short recording of the resulting state when possible. For an API or CLI, show the request or command and a short excerpt of the actual response or output. Say what you expected and what you observed. If the workflow could not run, tell the user what you tried, what blocked it and what remains unverified. Open a PR with “Closes #N”, record verification, and set `status:in-review`. Spawn an independent review agent using the most capable code-review model available unless the user specifies one. If model selection is unavailable, use the default reviewer and disclose that on the PR. If an independent reviewer cannot run, ask the user how to proceed.
7. On the PR record the exact commit SHA tested, the SHA used for the runtime demonstration, and the SHA independently reviewed. If the PR head changes, rerun the affected checks and demonstration and review the delta before merging. Update the SHAs to the verified head. For each demonstrated step label its evidence mock, live with synthetic data, or unverified. State which component ran, which dependency was simulated, and any blocker. Carry these labels into the per-ticket chat update. Record review findings, address actionable issues, and have resulting changes reviewed. The independent reviewer may merge the exact commit it reviewed when its GitHub permissions, required approvals, branch protections, checks, and merge order allow it. Otherwise, hand the reviewed commit SHA to the ticket owner for merge under the same conditions.
8. The ticket owner verifies the merge, completes post-merge checks, marks the issue done, and releases its claim. Continue while eligible work remains unless the user requested a single ticket.

Install an issue_comment workflow for a trusted repository writer to post `/codex answer <question>` on a GitHub issue and start a fresh, read-only Codex run. Include the issue, recent comments, referenced same-repo tickets and the default-branch checkout. Post its answer back on that issue from a separate least-privilege job. Ignore PRs, ordinary comments and bot replies. Use pinned actions, keep untrusted text out of shell source, and ask the user to configure the OPENAI_API_KEY Actions secret securely. Test trusted and ignored triggers plus reply routing.

Verify setup against an isolated test remote: two workers racing for one ticket produce exactly one winner; workers can claim different tickets concurrently; a losing worker cannot release the winner’s claim. Verify the Markdown links, templates, labels, and exact trigger.

Push the setup to the default branch if permitted, otherwise open a setup PR. Report what changed and what you verified, then stop. Leave ticket implementation for a later “Work on the project” request.
```
