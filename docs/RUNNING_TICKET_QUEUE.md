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

When you need another worker's answer, post the question on their ticket, address their recorded worker name and link your own issue. Reply in that thread and link the decision from both tickets. Continue independent work while waiting. If an implementation decision remains unclear after checking the ticket and relevant docs, ask the user a specific question before proceeding with the affected work. Continue independent work while waiting and record the answer on the ticket.

## Review the PR

After opening the PR and before merging, spawn a separate review agent. Use the most capable code-review model available to the session unless the user requests a specific model. If several models share the highest capability tier, choose any of them. If model selection is unavailable, use the default reviewer and disclose that limitation on the PR. If an independent reviewer cannot run, ask the user how to proceed.

Give the reviewer the ticket, acceptance criteria, PR diff and verification results. Ask it to check correctness, regressions and missing tests. Record its findings on the PR, address actionable findings, and have it review any resulting changes. Follow the repository's required GitHub reviews and checks as well.

The independent reviewer may merge the reviewed PR when its GitHub credentials permit it, all actionable findings are resolved, acceptance checks pass, merge order is satisfied, and GitHub allows the merge under branch protection and required reviews. Verify that the PR head still matches the reviewed commit when merging. If the reviewer lacks merge access, hand the reviewed commit SHA back to the ticket owner to merge under the same conditions. In either case, the ticket owner verifies the merge, completes the issue and releases the claim.

## Demonstrate the result to the user

For changes to runnable behavior, run the affected workflow through its normal entry point with a representative synthetic input. After each ticket is merged and verified, post a completion update directly in the Codex chat before claiming another ticket. Include the issue, PR, and verification result. For runnable changes, show the evidence in that update. For a UI, include a screenshot or short recording of the resulting state when possible. For an API or CLI, show the request or command and a short excerpt of the actual response or output. Say what you expected and what you observed. If the workflow could not run, tell the user what you tried, what blocked it and what remains unverified. Save the reproduction steps and evidence on the PR as well.

## Finish or hand off

Run acceptance checks and the repo's documented checks. Open one PR targeting main with a closing reference. Record verification, set status:in-review, respect merge order and required reviews, and recheck against current main before merge. Confirm the merge and post-merge checks, then close out the issue as status:done.

Release your claim with `git push "--force-with-lease=${claim}:$token" origin ":$claim"`. For a handoff, record the receiving worker, branch and remaining work on the ticket. The outgoing worker stops and releases its own claim. The named recipient acquires a fresh claim and confirms it on the issue before resuming. For an abandoned claim, a human verifies the previous worker has stopped and checks the issue, branches and PRs before clearing the ref with a lease against the observed SHA. Five minutes of silence alone never authorizes takeover.

Refresh the queue and continue with eligible work unless assigned a single issue. Record blockers and report pending work when nothing more can advance.
