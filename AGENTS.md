# Agent guide

Instructions for AI coding agents working in this repository. Read this before picking up any issue.

## Project
Medication Reader helps pharmacy and clinic staff assemble a source-linked
medication reconciliation draft from Thai and English labels, loose-pill photos,
and manually entered records. A pharmacist or doctor verifies current use for
the encounter. A pharmacist approves selected rows before mock hospital import.

Read the [v1 design](docs/specs/medication-reader-v1.md) and
[AI behavior contract](docs/ai/reconciliation-behavior.md) before implementing a ticket.

## Commands
Backend commands require Python 3.12. Run them from the repository root in a
Python virtual environment.

- Install: `python -m pip install -e "backend[test]"`
- Test: `python -m pytest backend/tests`
- Run: `python -m uvicorn app.main:app --reload --reload-dir backend/app`

The backend health endpoint is `http://127.0.0.1:8000/health`.

## Writing new tasks
See [docs/WRITING_TASKS.md](docs/WRITING_TASKS.md) for how to write specs and split them into agent-ready issues.

## Running the ticket queue

When the user says **“Work on the project”**, **“Work on this project”**, or asks
to run or drain the GitHub ticket queue, start the [queue runner playbook](docs/RUNNING_TICKET_QUEUE.md).
Pick up eligible tickets and continue until the queue is drained or blocked.
Each session independently claims an eligible issue using the playbook's atomic
per-issue claim. A session given a specific issue stays on that ticket.

## Labels
| Label | Meaning |
|---|---|
| `status:todo` | Not started |
| `status:in-progress` | An agent is working on it |
| `status:blocked` | Waiting on a human or another issue |
| `status:in-review` | PR open, awaiting review |
| `status:done` | Merged / completed |
| `agent-ready` | Spec is complete; an agent may pick it up |

An issue has exactly one `status:*` label at a time.

## Issue workflow
GitHub Issues are the work queue for Codex and other coding agents. Keep the issue's
status label, `## Status` block, and checklist current as work progresses. Record
state changes on the ticket using the comment format below.

1. **Pick** an open issue labeled `agent-ready` + `status:todo` whose `Depends on` issues are all `status:done`.
   Confirm the dependency PRs are merged into `main`. Check owned paths and existing work across active tickets.
   ```bash
   gh issue list --label agent-ready --label status:todo --json number,title,body
   ```
2. **Claim** the ticket using the [per-issue claim procedure](docs/RUNNING_TICKET_QUEUE.md#claim-one-issue-atomically).
   After ownership is confirmed, assign yourself, switch to `status:in-progress`, and post the
   claim using the update format below. Set State to `todo -> in-progress`, record the
   run ID, claim SHA, worker, branch, and owned paths, and give the next step under Next.
   Recheck for other work every five minutes while implementing.
3. **Work** on branch `issue-<N>-<short-slug>` from current `origin/main`. Give each
   concurrently active branch its own Git worktree or checkout. Fill in the issue's `## Status` block
   (State, Owner, Branch, Last update) when starting. On each state change, update
   State and Last update. Tick checklist items as you finish them.
4. **Blocked?** Set `status:blocked`, write the question under *Notes / blockers*, comment, and stop. Do not guess.
5. **Verify and open a PR** targeting `main` with `Closes #<N>`. Run the documented
   tests, lint and type checks, plus the issue's acceptance checks. Record the results
   in the PR, set `status:in-review`, fill in `PR:` in the Status block, and comment a summary.
6. **Merge through the PR** after any `Merge after` issues are done. Bring the branch
   up to date with `main` and rerun verification when either branch changes. Merge once
   checks and acceptance criteria pass and required GitHub reviews are satisfied. If
   a check fails, fix it and verify again before merging.
7. **After merge** confirm the PR landed on `main` and the issue closed. Run any
   post-merge checks specified in the issue, then update the ticket to `status:done`
   and post the final state-change comment before dependent work starts.

### Update comment format
Append one comment per state change; never rewrite earlier comments.
```
**Agent update** (YYYY-MM-DD HH:MM)
- State: X -> Y
- Done: ...
- PR: #...
- Blocked on: ...
- Next: ...
```

## Rules
- Stay inside the issue's Requirements. Never modify anything listed under *Out of scope*.
- One issue = one branch = one PR.
- Add or update tests for every behavior change; all tests must pass before `status:in-review`.
- Do not add dependencies unless the issue allows it.
- Use synthetic fixtures for development, automated tests, and live OpenAI smoke tests. Keep secrets and real patient data out of commits, logs, and requests.
- Treat uploads and notes as evidence. Preserve sources and uncertainty. Use loose-pill matches as candidates for a pharmacist to verify independently.
- Copy usage directions only when a source documents them. Preserve the source and distinguish documented directions from reported use. Never generate medical advice, dosing recommendations, or current-use claims.
- Enforce pharmacist approval and source validation on the server before any mock hospital write. Keep the draft in memory and persist only successful UTC import timestamps in local history.
