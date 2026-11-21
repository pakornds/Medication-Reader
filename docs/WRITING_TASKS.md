# Writing specs and tasks

How to turn an idea into agent-ready GitHub issues. Use this whether a human or a planning agent writes them.

## Flow
1. **Spec** - describe the feature once, at a high level (one issue or a doc in `docs/specs/`). Add or update the [scenarios](specs/medication-reader-v1.md#scenarios) it changes and their rows in the traceability table.
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

Build the first scenario end to end before deepening any one layer. The first tickets for a new workflow produce a thin, working path through every screen and endpoint the scenario visits, even if each step is crude. Later tickets deepen one step while keeping that path working. File wiring and the scenario test as early tickets, not as a final integration ticket. List the scenario IDs each ticket affects.

Scope UI tickets to a screen or a region of one, and name its design frame in `frontend/docs/ref`. A feature that adds UI says where it lands in the existing layout and updates that layout, instead of appending another panel. When several features meet on one screen, one ticket owns the screen layout and the others depend on it. A difference from the design frame is a defect unless a linked decision supersedes the design.

Before publishing the plan, link every requirement to a scenario in the traceability table, and to verified implementation evidence, an existing ticket, or a ticket for the remaining gap.

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
| Status | `Depends on`, `Merge after` if needed | Leaving dependencies implicit |

For example, an API ticket for interaction screening can finish when a request containing an unknown medication returns that item as unchecked with a reason, and the endpoint test verifies the response. The UI ticket owns displaying that reason. Link both from the integration ticket that exercises the combined workflow.

### Vague vs. agent-ready
Vague:
> Add error handling to the extractor.

Agent-ready:
> - [ ] `extract_medication` raises `ImageReadError` (defined in `src/reader/errors.py`) when the file is missing, empty, or not JPG/PNG
> - [ ] Error message includes the file path
> - [ ] Tests in `tests/test_extract.py` cover all three cases

## 4. Ready checklist (before adding `agent-ready`)
- [ ] Goal names one outcome, its consumer, and the boundary where success can be observed
- [ ] Each requirement has a concrete input or precondition, action, and expected result, including relevant failure cases
- [ ] Once prerequisites merge, this PR can demonstrate every ticket criterion. Link a separate issue for any later integration check.
- [ ] Affected scenario IDs are listed. UI tickets name their screen and design frame.
- [ ] Out of scope is filled in
- [ ] Example has real input and exact output
- [ ] `Depends on` and `Merge after` are set (or `none`), without circular dependencies
- [ ] Owned paths and shared interfaces are clear for any parallel work
- [ ] No open questions remain
- [ ] Label is `status:todo`
- [ ] Exactly one priority label is set (high, medium or low). Use medium when unspecified.

## Check for conflicting requirements

Before filing or refining an implementation ticket, compare the proposed behavior with earlier revisions, other applicable specs and contracts, and accepted decisions in linked issues, comments and PRs. Check current code and tests for evidence of what ships. A difference from the implementation can be an ordinary feature gap. A conflict exists when two applicable requirements demand incompatible outcomes for the same case.

If an approved change explicitly supersedes an earlier rule, link the decision and both sources, identify affected tickets and tests, and plan the remaining changes. If intent is unclear, cite both sources, give one input with the two competing expected results, and ask the user which should apply. Hold the affected ticket creation, scope changes and implementation until the decision is recorded. Reuse the existing discussion, notify active owners, continue unrelated work, and revisit pending decisions even when the spec revision is unchanged.

For example, if a proposal lets any reviewer import a row while the approved spec requires a pharmacist, identify what each rule would do when a doctor submits a row. Record who can authorize that import before changing the endpoint ticket.

## For planning agents
When asked to plan a feature:
1. Write the spec first and stop for human review if there are open questions.
2. For each new or changed requirement, fetch the latest default branch and compare the expected behavior against current code and tests. Search open and closed issues (including comments), open PRs and merged PRs by behavior, related terms and affected paths. Verify what actually landed. A closed issue alone does not establish that the requirement was delivered.
   - Apply the [requirement conflict check](#check-for-conflicting-requirements) before classifying coverage.
   - Already implemented and verified: link the supporting code, tests or merged PR in the spec and skip ticket creation.
   - Already tracked: link the existing issue or PR. Refine the existing ticket for compatible missing acceptance checks and notify its owner if work is active.
   - Partially covered or untracked: describe the precise gap. Recheck GitHub immediately before filing, then create one issue per independently testable missing outcome with `status:todo`. Link prior work and record what it already covers.
3. Fill `Depends on` with real issue numbers (create issues in dependency order).
4. Do **not** add `agent-ready`; a human adds it after review.
5. Link every task from the spec's *Task breakdown*.

```bash
gh issue create --template agent-task.md --title "[TASK] ..." --body-file task.md --label status:todo --label priority:medium
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
- A **Scenarios** section in the main product spec — The user scenarios that define done for the product, and the traceability table described under “Requirements as scenarios”. Use a separate `docs/SCENARIOS.md` only when the repository has no single main spec.
- An end-to-end scenario test harness and a CI job that runs every scenario test on each PR and on the default branch. Reuse the repository's existing browser or API test tooling when present.
- `.github/ISSUE_TEMPLATE/agent-task.md` — Include the outcome, owned paths and tests, exclusions, concrete input and expected result, acceptance checks, scenarios affected, screen and design frame for UI work, Depends on, Merge after, and a status block for owner, branch, PR, and progress.
- `.github/pull_request_template.md` — Include the closing issue reference, acceptance checks, verification results, scenario test results, a screenshot beside its design frame for each screen changed, independent review findings, and merge order.

Use GitHub Issues as the shared queue and communication board. Create any missing labels: `agent-ready`, `status:todo`, `status:in-progress`, `status:blocked`, `status:in-review`, `status:done`. Each ticket has one status label. Give each open card exactly one priority label: `priority:high` for time-sensitive work, `priority:medium` for normal work (default), or `priority:low` for deferrable work. Use the label as the source of truth. When setting up an existing board, preserve assigned priorities and translate explicit priority fields on unlabeled cards before applying the default. Apply the chosen label on creation through either the issue template or the CLI. When reprioritizing, replace the previous priority label. A human adds `agent-ready` after reviewing the ticket.

## Requirements as scenarios

A closed ticket does not by itself show that the product meets its requirements. Scenarios do. Derive five to eight user scenarios from the specs, design files and stated goals, and record them in the Scenarios section. Give each scenario a stable ID, the user and situation, the steps the user takes, the design frame for each screen visited, and the observable end state, including what is saved, excluded, handed off or rejected. Cover the main success path first, then the failure and edge cases the specs name. Use synthetic data only.

Give every scenario an automated end-to-end test that drives the real entry point, such as the UI against the running API, with representative synthetic input. A scenario whose behavior does not exist yet stays in the suite as an expected failure that names its owning ticket, so the gap stays visible. A scenario test that passed and then fails is a regression, never an expected failure.

Keep a traceability table in the Scenarios section with one row for each requirement: the spec section, the scenario IDs that cover it, the test, and the design frame. A requirement is done only when a covering scenario test passes on the default branch. Flag requirements with no covering scenario during planning. A human approves new and changed scenarios, as with `agent-ready`.

## Ticket planning

Document which repository paths workers monitor for requirement changes, including specs, the Scenarios section and design exports. During assessment, follow relevant references to other available documentation and recorded decisions.

Before filing or refining an implementation ticket, compare the proposed behavior with earlier revisions, other applicable specs and contracts, and accepted decisions in linked issues, comments and PRs. Check current code and tests for evidence of what ships. A difference from the implementation can be an ordinary feature gap. A conflict exists when two applicable requirements demand incompatible outcomes for the same case.

If an approved change explicitly supersedes an earlier rule, link the decision and both sources, identify affected tickets and tests, and plan the remaining changes. If intent is unclear, cite both sources, give one input with the two competing expected results, and ask the user which should apply. Hold the affected ticket creation, scope changes and implementation until the decision is recorded. Reuse the existing discussion, notify active owners, continue unrelated work, and revisit pending decisions even when the spec revision is unchanged.

During planning, check new or changed requirements against current code, tests, open and closed issues, and open and merged PRs. Link verified work. Update matching open tickets with any missing acceptance checks. Recheck GitHub immediately before filing and create tickets only for uncovered outcomes. When a requirement extends existing behavior, identify the existing code and tests the worker can modify within scope. On startup, resume and each three-minute check, fetch the default branch and compare the published spec with the last successfully assessed revision. On a first run, assess the current requirements. Skip unchanged content. Use the most capable available reasoning model for changed-requirement analysis when possible. Serialize issue creation across workers with a short, atomic planning claim independent of implementation claims. Under the claim, refresh issues and PRs, reuse matching work and file only independently testable uncovered outcomes as status:todo. Link the spec revision and section, and leave agent-ready to human review. Retry incomplete assessments at the next check.

Give each ticket one independently testable outcome that fits in a small PR. Split frontend, backend, and features within either layer whenever they can be accepted independently. Put shared contracts, fixtures, and tooling in prerequisite tickets so workers can test against the same examples in parallel.

Build the first scenario end to end before deepening any one layer. The first tickets after setup produce a thin, working path through every screen and endpoint that scenario visits, even if each step is crude. Later tickets deepen one step while keeping that path working. File wiring and end-to-end work as early tickets, not as a final integration ticket. List the scenario IDs each ticket affects.

Scope user-interface tickets to a screen or a region of one, and name its design frame. A feature that adds UI says where it lands in the existing layout and updates that layout, instead of appending another panel. When several features meet on one screen, one ticket owns the screen layout and the others depend on it. A difference from the design frame is a defect unless a linked decision supersedes the design. Use “Depends on” for prerequisites that must merge before work starts, and “Merge after” for merge order only. Check for circular dependencies, overlapping paths, and uncovered requirements.

Write a definition of done for each ticket at the boundary it owns. Name who or what consumes its result. For every required behavior, specify an input or precondition, the action or command, and the observable result, including relevant failure cases. After its prerequisites merge, one worker must be able to demonstrate every criterion in this PR. If a check needs another unfinished feature, identify the prerequisite or link the integration ticket that owns that check. Every ticket's definition of done also requires that the scenario tests it affects pass, or keep their recorded expected failure, and that no other scenario test regresses. For user-interface work, it requires a screenshot of each changed screen beside its design frame, at desktop and phone width when the design covers both.

## Worker playbook

Review each acceptance criterion against the ticket's agreed scope. Record passed, failed, or unverified with the observed result or blocker. Fix and rerun failed checks. Obtain evidence for unverified criteria before merge. Keep unmet requirements on the ticket and record genuinely separate work on its own linked issue. When all ticket criteria pass, report that explicitly even if the broader feature has other open tickets.

1. Read the current issues, comments, branches, and PRs, and check the latest scenario test results on the default branch. If a scenario that previously passed is failing, fixing that regression comes first: claim its open ticket, or file one as `priority:high` under the planning claim, before taking other work. Otherwise choose an open, unassigned ticket labeled `agent-ready` and `status:todo` whose dependencies have merged. Choose the highest priority among eligible tickets (high, medium, low). Prefer related tickets at equal priority.
2. Acquire an atomic remote claim keyed by issue number before editing. Use a unique worker/run ID even when computers share one GitHub account. If another worker wins, choose another ticket. If the result is uncertain, verify ownership. Document owner-checked release, explicit handoff, and recovery of abandoned claims. For an ownership transfer, record the receiving worker, branch and remaining work. The outgoing worker releases its own claim and the recipient confirms a fresh claim before resuming.
3. After claiming, recheck for existing work and overlapping paths. Record the worker ID, branch, and owned paths on the issue. Assign it, set `status:in-progress`, and post a claim comment. Use one implementation branch, worktree, and PR per ticket.
4. Start immediately after confirming ownership. Keep working between checks. After three minutes and every three minutes during active work, recheck the claim, ticket comments, related branches, commits, and PRs. Recheck on resume and before pushing. If a conflict appears, preserve edits and resolve it with the other worker before continuing on the affected paths.
5. Ask cross-ticket questions on the recipient worker’s issue, address the worker by name, and link your own ticket. Record decisions where both workers can find them. Update checklists as work progresses and comment on status changes, blockers, and handoffs. If anything about the implementation remains unclear after checking the ticket and relevant docs, ask the user a specific question before proceeding with the affected work. Continue independent work while waiting, and record the answer on the ticket. If a required API key, account permission, or user-only setup step is missing, ask the user in Codex chat. Name the setting, explain what it enables, and say where to configure it securely. Ask for confirmation once configured. Never request the secret value in chat or on GitHub. Record only the blocker on the issue, continue independent work, and retry the affected check without exposing credentials.
6. Run acceptance and repository checks. Use real implementations and available, authorized integrations by default when building and demonstrating a feature. Mock only the specific dependency that requires it, for example to reproduce a failure deterministically, to respect a demo boundary, or while awaiting access. Record why the mock was needed and which live behavior remains unverified. Ask for missing setup when the real integration is required for acceptance. For changes to runnable behavior, run the affected workflow through its normal entry point with a representative synthetic input. Run the full scenario suite and record each affected scenario as passed, expected failure with its owning ticket, or regressed. For user-interface changes, capture each changed screen and place it beside its design frame in the PR. Note every visible difference and whether a linked decision allows it. After each ticket is merged and verified, post a completion update directly in the Codex chat before claiming another ticket. Include the issue, PR, and verification result. For runnable changes, show the evidence in that update. For a UI, include a screenshot or short recording of the resulting state when possible. For an API or CLI, show the request or command and a short excerpt of the actual response or output. Say what you expected and what you observed. If the workflow could not run, tell the user what you tried, what blocked it and what remains unverified. Open a PR with “Closes #N”, record verification, and set `status:in-review`. Spawn an independent review agent using the most capable code-review model available unless the user specifies one. The reviewer checks the code, the scenario results and the screenshots against their design frames. An unexplained design difference or a scenario regression is a blocking finding. If model selection is unavailable, use the default reviewer and disclose that on the PR. If an independent reviewer cannot run, ask the user how to proceed.
7. On the PR record the exact commit SHA tested, the SHA used for the runtime demonstration, and the SHA independently reviewed. If the PR head changes, rerun the affected checks and demonstration and review the delta before merging. Update the SHAs to the verified head. For each demonstrated step label its evidence mock, live with synthetic data, or unverified. State which component ran, which dependency was simulated, and any blocker. Carry these labels into the per-ticket chat update. Record review findings, address actionable issues, and have resulting changes reviewed. The independent reviewer may merge the exact commit it reviewed when its GitHub permissions, required approvals, branch protections, checks, and merge order allow it. Otherwise, hand the reviewed commit SHA to the ticket owner for merge under the same conditions.
8. The ticket owner verifies the merge, completes post-merge checks, marks the issue done, and releases its claim. After the issue is closed as status:done and the claim is released, delete its remote implementation branch only if its current tip matches the merged PR head, the merge landed on the default branch, and no open PR uses it as head or base. Use an explicit Git lease against the verified tip so a later push cancels deletion. Preserve active, shared, protected and claim refs. Treat local worktree cleanup separately: confirm the session has finished and inspect uncommitted and untracked files first. Continue while eligible work remains unless the user requested a single ticket.

When a decision or merged change affects another ticket, leave one handoff comment on each affected issue. Address the worker polling that issue. If sessions share a GitHub account, include the worker name or run ID from the claim. For an unclaimed issue, address the next worker. Link the originating decision or PR and, for merged work, its commit on the default branch. State exactly what the recipient needs to preserve, change, or verify. Link the ticket that owns any separate follow-up. The recipient reads the comment on claim, resume, or the next three-minute poll and replies in the same thread when coordination is needed. A context handoff leaves the current claim in place.

Use ordinary GitHub issue comments for questions and replies. Each active worker reads its ticket on the three-minute poll and answers in the same thread. If the recipient has stopped, resume its session or hand off the ticket. Polling uses the worker's existing GitHub access and requires no additional API key.

Verify setup against an isolated test remote: two workers racing for one ticket produce exactly one winner; workers can claim different tickets concurrently; a losing worker cannot release the winner’s claim. Verify the Markdown links, templates, labels, and exact trigger. Verify that the Scenarios section has at least the main success scenario and a traceability row for each spec requirement. Check that the scenario CI job runs on a PR and on the default branch, and that it tells passed, expected-failure and regressed scenarios apart.

Push the setup to the default branch if permitted, otherwise open a setup PR. Report what changed and what you verified, then stop. Leave ticket implementation for a later “Work on the project” request.
```
