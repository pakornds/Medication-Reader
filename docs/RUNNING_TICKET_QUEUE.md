# Run the GitHub ticket queue

Start in this repository with “Run the GitHub ticket queue until drained. Use multiple workers if available.” For a separate worker session, use “Work only on GitHub issue #N. Read and follow the worker instructions in `docs/RUNNING_TICKET_QUEUE.md`.”

This playbook applies to an active run. A later run can pick up from GitHub once it starts.

## Coordinator

1. Read [AGENTS.md](../AGENTS.md), the [task-writing guide](WRITING_TASKS.md), and the [current spec](specs/medication-reader-v1.md). Verify authenticated GitHub access, fetch current `origin/main`, and inspect issues, their comments, and linked PRs. Resume work already assigned to this run when ownership is clear. Leave tickets actively owned by another run with their current owners.
2. Build the ready queue. Select open issues with `agent-ready` and `status:todo` whose `Depends on` tickets are `status:done` and whose dependency PRs have merged into `main`. Use the owned paths in each ticket to identify work that can run in parallel. Humans add `agent-ready` after review.
3. Assign each selected issue to one named worker and record the claim in GitHub before dispatching it. Keep one issue, one branch, one PR, and one worktree or checkout per active ticket. Use subagents when available or give independently launched Codex sessions explicit issue numbers. If running alone, take the next eligible issue yourself. Keep one dispatcher for the queue, especially when workers share a GitHub account.
4. Review completed work against the ticket. Respect any `Merge after` requirement and verify each PR against current `main`. Merge through the PR once all required reviews, checks, and acceptance criteria pass. Confirm the merge and complete any post-merge checks before updating the issue to `status:done`. Recheck later PRs against the new `main`.
5. Refresh the queue after each merge or worker handoff and dispatch newly eligible work. If a ticket is blocked, record the exact blocker, keep its state current, and continue with other eligible work. Wait for work or checks already in progress when their result can advance the queue. Stop when there is no eligible issue, active worker, or actionable PR, or when access blocks further progress. Report the merged issues, verification results, and any remaining blockers.

## Worker

- Read your assigned issue, comments, and linked dependencies before editing. Use the issue's branch and separate worktree, and stay within its owned paths. If you need another ticket's changes, link that ticket and describe the exact contract change or blocker.
- Use direct messages for quick coordination when workers share a session. Record decisions, blockers, contract changes, and handoffs on the affected GitHub issues or PRs so workers in separate sessions can pick them up.
- Run the documented checks and the issue's acceptance checks. Open or update one PR to `main` with `Closes #N`, record the results, and update the issue to `status:in-review`. Hand the PR back to the coordinator for merge. A worker in a separate session reports back on the issue or PR and waits for another explicit assignment.
