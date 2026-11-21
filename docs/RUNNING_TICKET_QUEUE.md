# Run the GitHub ticket queue

On any computer, open a checkout and say **“Work on the project”**. Each session independently selects eligible tickets. For a single-ticket run, say “Work only on issue #N”. GitHub issues and PRs carry progress between computers.

## Select a ticket

Read [AGENTS.md](../AGENTS.md), the [task-writing guide](WRITING_TASKS.md), and the [current spec](specs/medication-reader-v1.md). Verify authenticated access and fetch current main. Inspect open issues, owners, comments, branches and PRs, including work started under earlier instructions. Leave existing claims with their owners. Select an open, unassigned issue with both agent-ready and status:todo whose Depends on issues are done and merged. Prefer related tickets when several qualify. Merge after controls merge order only.

Compare the assigned ticket with the latest spec, code, tests and PRs before editing. Follow the spec check below to plan any newly uncovered work.

## Check published spec changes

On startup, resume and each three-minute check, fetch the default branch and compare the published spec with the last successfully assessed revision. On a first run, assess the current requirements. Skip unchanged content. Use the most capable available reasoning model for changed-requirement analysis when possible. Serialize issue creation across workers with a short, atomic planning claim independent of implementation claims. Under the claim, refresh issues and PRs, reuse matching work and file only independently testable uncovered outcomes as status:todo. Link the spec revision and section, and leave agent-ready to human review. Retry incomplete assessments at the next check.

For this repo, watch all of `docs/specs/` and `docs/ai/reconciliation-behavior.md` on `origin/main`. Use the path-limited Git diff between the last assessed commit and the fetched commit, including new files, renames and removals. Record the assessed SHA in the worker's handoff after successful reconciliation. If the saved revision is missing or inaccessible, reconcile the current spec against GitHub and the implementation. A removed or ambiguous requirement calls for a note on the affected ticket and clarification when necessary.

Use the create-only lease and owner-checked release described below with the fixed ref `refs/heads/codex-planning/spec-updates` and a fresh token. This claim covers only the planning transaction. If another worker holds it, continue implementation and retry next poll. The holder follows the [planning guide](WRITING_TASKS.md#for-planning-agents), checks code and tests plus open and closed issues and PRs, then records links to the issues created or reused. After a partial failure, search for already-filed outcomes before retrying. Keep the scope of in-progress implementation tickets stable and ask their owner about any conflicting change.

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

## Work and recheck every three minutes

Start immediately after confirming ownership. **Three minutes after starting, and every three minutes during active work**, reread the issue, comments and related PRs, fetch the implementation branch if published, and check its commits for work another session already completed or started. Verify the remote claim still matches your token. Recheck on resume and before pushing or opening a PR. Keep implementing between checks. During a long command, check at the next safe breakpoint.

If ownership changes, completed work appears or paths conflict, pause the affected edits, preserve your branch and discuss ownership directly on the issue. Address the other worker by its recorded name. Update checklist items as you finish them. Comment on material progress, decisions, blockers, status changes and handoffs. Link related issues and PRs. An unchanged poll needs no comment.

When you need another worker's answer, post the question on their ticket, address their recorded worker name and link your own issue. Reply in that thread and link the decision from both tickets. Continue independent work while waiting. If an implementation decision remains unclear after checking the ticket and relevant docs, ask the user a specific question before proceeding with the affected work. Continue independent work while waiting and record the answer on the ticket. If a required API key, account permission, or user-only setup step is missing, ask the user in Codex chat. Name the setting, explain what it enables, and say where to configure it securely. Ask for confirmation once configured. Never request the secret value in chat or on GitHub. Record only the blocker on the issue, continue independent work, and retry the affected check without exposing credentials.

Use ordinary GitHub issue comments for questions and replies. Each active worker reads its ticket on the three-minute poll and answers in the same thread. If the recipient has stopped, resume its session or hand off the ticket. Polling uses the worker's existing GitHub access and requires no additional API key.

## Review the PR

After opening the PR and before merging, spawn a separate review agent. Use the most capable code-review model available to the session unless the user requests a specific model. If several models share the highest capability tier, choose any of them. If model selection is unavailable, use the default reviewer and disclose that limitation on the PR. If an independent reviewer cannot run, ask the user how to proceed.

Give the reviewer the ticket, acceptance criteria, PR diff and verification results. Ask it to check correctness, regressions and missing tests. Record its findings on the PR, address actionable findings, and have it review any resulting changes. Follow the repository's required GitHub reviews and checks as well.

The independent reviewer may merge the reviewed PR when its GitHub credentials permit it, all actionable findings are resolved, acceptance checks pass, merge order is satisfied, and GitHub allows the merge under branch protection and required reviews. Verify that the PR head still matches the reviewed commit when merging. If the reviewer lacks merge access, hand the reviewed commit SHA back to the ticket owner to merge under the same conditions. In either case, the ticket owner verifies the merge, completes the issue and releases the claim.

## Demonstrate the result to the user

On the PR record the exact commit SHA tested, the SHA used for the runtime demonstration, and the SHA independently reviewed. If the PR head changes, rerun the affected checks and demonstration and review the delta before merging. Update the SHAs to the verified head. For each demonstrated step label its evidence mock, live with synthetic data, or unverified. State which component ran, which dependency was simulated, and any blocker. Carry these labels into the per-ticket chat update.

Use real implementations and available, authorized integrations by default when building and demonstrating a feature. Mock only the specific dependency that requires it, for example to reproduce a failure deterministically, to respect a demo boundary, or while awaiting access. Record why the mock was needed and which live behavior remains unverified. Ask for missing setup when the real integration is required for acceptance. For changes to runnable behavior, run the affected workflow through its normal entry point with a representative synthetic input. After each ticket is merged and verified, post a completion update directly in the Codex chat before claiming another ticket. Include the issue, PR, and verification result. For runnable changes, show the evidence in that update. For a UI, include a screenshot or short recording of the resulting state when possible. For an API or CLI, show the request or command and a short excerpt of the actual response or output. Say what you expected and what you observed. If the workflow could not run, tell the user what you tried, what blocked it and what remains unverified. Save the reproduction steps and evidence on the PR as well.

## Finish or hand off

Run acceptance checks and the repo's documented checks. Open one PR targeting main with a closing reference. Record verification, set status:in-review, respect merge order and required reviews, and recheck against current main before merge. Confirm the merge and post-merge checks, then close out the issue as status:done.

Release your claim with `git push "--force-with-lease=${claim}:$token" origin ":$claim"`. For a handoff, record the receiving worker, branch and remaining work on the ticket. The outgoing worker stops and releases its own claim. The named recipient acquires a fresh claim and confirms it on the issue before resuming. For an abandoned claim, a human verifies the previous worker has stopped and checks the issue, branches and PRs before clearing the ref with a lease against the observed SHA. Three minutes of silence alone never authorizes takeover.

After the issue is closed as status:done and the claim is released, delete its remote implementation branch only if its current tip matches the merged PR head, the merge landed on the default branch, and no open PR uses it as head or base. Use an explicit Git lease against the verified tip so a later push cancels deletion. Preserve active, shared, protected and claim refs. Treat local worktree cleanup separately: confirm the session has finished and inspect uncommitted and untracked files first. Refresh the queue and continue with eligible work unless assigned a single issue. Record blockers and report pending work when nothing more can advance.
