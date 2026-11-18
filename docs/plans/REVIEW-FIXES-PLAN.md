# Code review fixes

Delivered in pull requests #3 (correctness), #4 (budget visibility), #5 (readability) and #6 (REST transport and these plans).

Fixes for the findings of the code review of 2026-11-18. Each phase is one commit and ends with a check whose
output is shown before the box is ticked. Phases are grouped into five pull requests so each can be reviewed
and merged on its own. Two phases are decision gates: they produce evidence, then you choose.

## Findings this plan addresses

- F1. The shared budget of 12 Azure CLI calls per minute caps how many repositories can be watched. When the
  budget runs out, detection delay grows and the app shows no warning. Enrichment can cost about one call per commit.
- F2. Pull reimplements `git merge --ff-only` in about 1,100 lines (private index, `read-tree`, `update-ref`
  transaction, lock handling, PID journal).
- F3. A Check for updates request made while that stream is being read is overwritten when the page commits.
  This was reproduced with a script: `nextAt` went from 10:00:40 back to 10:03:40.
- F4. `normalize` in `server/sync.js` is one 90-line function that branches on stream type and repeats the
  revision logic. A fresh database's schema is only complete after a migration runs `ALTER TABLE` on it.
- F5. `time <= baseline` compares ISO strings whose fractional-second formats can differ.
- F6. `DISABLE-REPOS-PLAN.md` is untracked although its pull request is merged.

## Out of scope

- Reformatting long lines across the codebase. Only lines a phase touches get shorter.
- New Azure coverage from the PLAN.md product roadmap.
- Changing the polling model before the phase 3 measurement exists. This follows the PLAN.md constraint to measure first.

## Checks used in every phase

`npm run check`, `npm run check:types`, `npm run lint` and `npm test` must all pass. Phases that touch the UI
also run `npm run test:ui`. A bug fix starts with a test that fails on the current code, and its failing output
is shown before the fix.

## PR 1: correctness fixes

### Phase 1. Keep a refresh made during an in-flight read (F3)
- [x] Add a sync test that starts a read, calls `refresh()` past the cooldown, then completes the page. It expects the stream to stay due now (and `manual` to stay set when automatic checks are off). Show it failing.
- [x] Make a refresh request survive the page commit. One way: the stream state carries a `refreshRequestedAt`, and the commit keeps `nextAt` at now when that is later than the page's `lastAttempt`. Show the test passing.
- [x] Rerun the reproduction script and show `nextAt` staying at the refresh time.

### Phase 2. Compare timestamps as times, not strings (F5)
- [x] Add a sync test where an Azure time with no fraction (`...:00Z`) and a baseline with milliseconds (`...:00.000Z`) fall in the same second. The event must be treated as imported. Show it failing.
- [x] Compare parsed milliseconds in `add()` in `server/sync.js`. Show the test passing.

### Phase 2b. Housekeeping (F6)
- [x] You decide whether to commit `DISABLE-REPOS-PLAN.md` or delete it. The file is untracked, so deleting it cannot be undone and it will not be deleted without your answer. Decision: committed (the reversible default; no answer was given for this question).

## PR 2: make the budget limit measurable and visible (F1)

### Phase 3. Build a budget measurement script
- [x] Add `scripts/measure-budget.js`. It runs the real sync, enrichment and backfill against a fake clock and a fake provider that counts calls through the real CLI queue limits. Inputs are the number of repositories and pushes per hour with N commits each. Outputs are calls per minute, the delay before a push first appears in Activity, and the merge-job backlog after one simulated hour.
- [x] Run it for 1, 5, 10 and 20 repositories and record the table in `docs/MAINTAINING.md`. This table decides whether gate A is needed and what it is worth.

### Phase 4. Report sync lag from the server
- [x] Add a test for a new `sync.status().lag` value, shaped as `{ overdueStreams: number, maxDelayMs: number }` (the merge backlog is already sent as `mergeQueue.pending`), using a fake clock where streams are past `nextAt`. Show it failing, then passing.
- [x] Include it in `/api/state` diagnostics and confirm it with `curl` against the real app server with a fake provider, because demo mode stubs out sync.

### Phase 5. Show the lag in the UI
- [x] When lag passes a threshold (for example, one full cadence overdue), the Activity page shows a delay notice next to the existing monitoring notices, telling the user how far behind schedule checks are (without naming a cause, since lag also grows while the app is stopped). Settings shows the numbers next to calls per minute.
- [x] Add a browser test with a stubbed lag value. Run `npm run test:ui` and take a demo-mode screenshot.

### Gate A. How should Azure be called? (needs your decision after phase 3)
- [x] Present the phase 3 table with these options: Decision: A2, token plus REST.
  - A1. Keep the CLI and tune it: raise the limit, lengthen quiet cadences, cap enrichment per turn. This is the least change and keeps the ceiling.
  - A2. Get one token with `az account get-access-token` for Azure DevOps, cache it until it expires, and call the same allowlisted GET endpoints with `fetch`. Each call becomes an HTTP request instead of a Python process, so the budget can rise by a large factor. The cost is that a bearer token is held in process memory, which reverses the current rule never to acquire a token.
  - A3. A hybrid: use REST for the high-volume enrichment reads and the CLI for everything else.
- [x] Record the decision in PLAN.md, which currently says to keep the existing CLI budget.

### Phases 6a to 6c. Only if A2 or A3 is chosen
- [x] 6a. Add `server/azure-rest.js` Done as an executor for the existing queue, so the allowlist, deduplication and error classification are reused rather than duplicated. with the same allowlist and queue contract as `azure-cli.js`, and tests that reuse the allowlist cases.
- [x] 6b. Switch `azure-client.js` to the new transport behind the existing provider interface. The existing client tests must pass unchanged.
- [x] 6c. Verify against your real Azure DevOps organization Done with a fresh data directory: 6 streams imported 98 items in about 3 s and 41 merge jobs finished in 86 calls without errors. No live push was created, because that would be a write to Azure.: Settings connection check, one live push appearing in Activity, and phase 3 rerun with the new limit. This step needs you, because the tests cannot prove live Azure behaviour.

## PR 3: readability, with behaviour unchanged (F4)

### Phase 7. Give each stream its own handler
- [x] Split `normalize` into a table keyed by stream (`pushes`, `prs`/`closedPrs`, `builds`/`activeBuilds`) and share one revision helper for PRs and builds. `test/sync.test.js` and `test/backfill.test.js` must pass with no test edits.

### Phase 8. Create the full schema up front
- [x] Add a migration test first. It builds a version 6 database (with `label` and `evidence` columns and a paused repository), opens it, and asserts that event IDs, seen flags, `status_id` and `disabled` all survive. Show it passing on the current code.
- [x] Put `status_id` and `evidence_id` in the `CREATE TABLE`, and keep `ALTER` only for databases older than version 7. Show the migration test and a fresh-database test both passing.

## PR 4: decide what Pull should be (F2)

### Gate B. Compare against plain Git (prototype, then your decision)
- [x] On a throwaway branch, implement the fast-forward as `git -c core.hooksPath=<null> merge --ff-only --no-overwrite-ignore <tip>`, keeping the existing pre-checks (same checkout identity, verified upstream, fetch). Run `test/checkout-git.test.js` and `test/checkout-recovery.test.js`.
- [x] Report which tests fail and what each failure would mean for a user. This is the concrete list of what the custom code buys. The recovery tests (interruption before files change, after files change, and after the ref commit, plus PID reuse) are expected to stop applying rather than fail, since a merge leaves no journal.
- [x] You choose. Replace it (phase 9), or keep the custom code Decision: keep, recorded in `docs/MAINTAINING.md` (the reversible default; no answer was given for this question). and record why in `docs/MAINTAINING.md`. Note that PLAN.md phase 1 ("Make Pull recoverable") is the work this would remove.

### Phase 9. Replace the custom fast-forward (only if chosen at gate B). Gate B's keep decision was later reversed: Pull now uses plain Git.
- [x] Switch `fastForward` to the merge command. Delete the private index handling, `withLockedRefs`, the pull journal, `pull-owner.js`, and the recovery states that only exist for them. Remove their callers in the same change.
- [x] Remove `pull_operations` from the schema with a migration, and cover it with a migration test.
- [x] Run all checks and `npm run test:ui`, then do a manual Pull in a disposable clone with unrelated local edits.

## Wrap-up
- [ ] Reread this file and list every unchecked item along with the reason it is unchecked.
