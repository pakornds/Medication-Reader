# Run the GitHub ticket queue

On any computer, open a checkout and say **“Work on the project”**. Each session independently selects eligible tickets. For a single-ticket run, say “Work only on issue #N”. GitHub issues and PRs carry progress between computers.

## Select a ticket

Read [AGENTS.md](../AGENTS.md), the [task-writing guide](WRITING_TASKS.md), and the [current spec](specs/medication-reader-v1.md). Verify authenticated access and fetch current main. Inspect open issues, owners, comments, branches and PRs, including work started under earlier instructions. Leave existing claims with their owners. Select an open, unassigned issue with both agent-ready and status:todo whose Depends on issues are done and merged. Prefer related tickets when several qualify. Merge after controls merge order only.

## Claim one issue atomically

Each worker competes only for its chosen ticket. Before editing or changing its status, create one remote claim ref keyed by issue number. Use a fresh run ID even when sessions share a GitHub account. In PowerShell, set the issue number to your selected ticket and run:

```powershell
$issue = 123  # replace with the selected issue number
$runId = [guid]::NewGuid().ToString()
$claim = "refs/heads/codex-claims/issue-$issue"
$token = git -c user.name=Codex -c user.email=codex@localhost commit-tree 'origin/main^{tree}' -p origin/main -m "Issue $issue claimed by $runId"
if ($LASTEXITCODE -ne 0) { throw 'Could not create claim identity' }
git push "--force-with-lease=${claim}:" origin "${token}:$claim"
```

The create-only lease gives one worker ownership. If the push fails or times out, inspect `git ls-remote origin $claim`. Proceed only if the remote SHA matches your token. If another worker won, pick another ticket. Keep the token until release.

After winning, reread the live issue and active claims, including newly created claim refs, before editing. Check other active tickets' owned paths and associated PRs. If work already exists, coordinate on the issue before continuing. If two tickets overlap, honor any explicit file-section agreement or dependency. Otherwise the workers agree on a handoff or sequence on both tickets before touching the shared path. Preserve existing edits. Independent tickets can proceed in parallel.

Record the run ID, claim SHA, worker name, owned paths and implementation branch on the ticket. Assign yourself, set status:in-progress and post a claim comment. Use one implementation branch, worktree and PR for that ticket.

## Work and recheck every five minutes

Start immediately after confirming ownership. **Five minutes after starting, and every five minutes during active work**, reread the issue, comments and related PRs, fetch the implementation branch if published, and check its commits for work another session already completed or started. Verify the remote claim still matches your token. Recheck on resume and before pushing or opening a PR. Keep implementing between checks. During a long command, check at the next safe breakpoint.

If ownership changes, completed work appears or paths conflict, pause the affected edits, preserve your branch and discuss ownership directly on the issue. Address the other worker by its recorded name. Update checklist items as you finish them. Comment on material progress, decisions, blockers, status changes and handoffs. Link related issues and PRs. An unchanged poll needs no comment.

When you need another worker's answer, post the question on their ticket, address their recorded worker name and link your own issue. Reply in that thread and link the decision from both tickets. Continue independent work while waiting.

## Finish or hand off

Run acceptance checks and the repo's documented checks. Open one PR targeting main with a closing reference. Record verification, set status:in-review, respect merge order and required reviews, and recheck against current main before merge. Confirm the merge and post-merge checks, then close out the issue as status:done.

Release your claim with `git push "--force-with-lease=${claim}:$token" origin ":$claim"`. For a handoff, record the receiving worker, branch and remaining work on the ticket. The outgoing worker stops and releases its own claim. The named recipient acquires a fresh claim and confirms it on the issue before resuming. For an abandoned claim, a human verifies the previous worker has stopped and checks the issue, branches and PRs before clearing the ref with a lease against the observed SHA. Five minutes of silence alone never authorizes takeover.

Refresh the queue and continue with eligible work unless assigned a single issue. Record blockers and report pending work when nothing more can advance.
