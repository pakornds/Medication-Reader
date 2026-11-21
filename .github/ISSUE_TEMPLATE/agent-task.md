---
name: Agent task
about: Spec for an agent to read, implement, and report status on
title: "[TASK] "
labels: ["status:todo", "priority:medium"]
assignees: ""
---

## Goal
<!-- Name the consumer, the single outcome, and where they can observe it. Link the spec section. -->

## Context
- **Owned files/modules:** `path/to/file`
- **Shared contracts:** <!-- Link shared types or API examples, or write "none" -->
- **Related issues:** #
- **Scenarios affected:** <!-- e.g. SC-1, SC-3 from docs/specs/medication-reader-v1.md#scenarios, or "none" -->
- **Screen and design frame:** <!-- UI work only, e.g. Review, frontend/docs/ref/02 Workspace — conflict. Otherwise "none" -->
- **Stack / constraints:** <!-- e.g. Python, uv, no new dependencies -->
- **References:** <!-- docs, links, examples -->

## Requirements
- [ ] <!-- Specific, verifiable behavior 1 -->
- [ ] <!-- Specific, verifiable behavior 2 -->

## Out of scope
- <!-- List exclusions. Link the issue that owns any later integration or end-to-end check. -->

## Acceptance criteria
- [ ] Tests pass: `<test command>`
- [ ] Lint/type checks pass: `<lint command>`
- [ ] <!-- For each requirement give the input or precondition, action, and observable result at this ticket's boundary. Cover relevant failure cases. -->
- [ ] Affected scenario tests pass, or keep their recorded expected failure, and no other scenario regresses
- [ ] UI work: screenshot of each changed screen beside its design frame, at desktop and phone width
- [ ] Docs/README updated if behavior changed

## Example
**Input:**
```
...
```
**Expected output:**
```
...
```

## Implementation notes (optional)
<!-- Suggested approach, pitfalls, naming, interfaces to respect. -->

---

## Status
<!-- Agents: edit this block in place. Also keep the `status:*` label in sync. -->
- **State:** todo <!-- todo | in-progress | blocked | in-review | done -->
- **Owner:** unassigned
- **Branch:** none
- **PR:** none
- **Depends on:** <!-- #N, #M or "none" -->
- **Merge after:** <!-- #N, #M or "none". Use for PR ordering only. -->
- **Last update:** YYYY-MM-DD

### Progress checklist
- [ ] Read issue and confirm dependencies are `status:done`
- [ ] Set `status:in-progress` and assign self
- [ ] Implement requirements
- [ ] Add/update tests
- [ ] Open PR with `Closes #<this issue>`
- [ ] Set `status:in-review`
- [ ] Verify against current `main` after any `Merge after` tickets are done
- [ ] Confirm PR merged to `main` and set `status:done`

### Notes / blockers
<!-- Agents: record blockers, decisions, and open questions here. If blocked, set `status:blocked` and stop. Do not guess. -->
(none)

### Agent protocol
1. Only start if the label is `status:todo`, `agent-ready` is present, and all `Depends on` issues are `status:done`.
2. Acquire and confirm the per-issue claim in `docs/RUNNING_TICKET_QUEUE.md` before editing. Recheck for existing work every three minutes while implementing. Swap the status label as work moves: `todo -> in-progress -> in-review -> done` (or `blocked`).
3. Follow the repository's `AGENTS.md` for branch isolation, verification, and merging. Tick checklist items as you finish them.
4. Post one comment per state change using the format in `AGENTS.md`.
5. Never modify files listed under Out of scope.
