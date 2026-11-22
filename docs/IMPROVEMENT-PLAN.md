# Improvement plan

Written 2026-11-22 from a council review by Claude Opus 5.5, Gemini 4 Neon and GPT Sol 6.2. Each read the code independently and read-only. One line per verifiable unit; tick a box only after its check has run.

Sources of each item are marked: **O** Opus, **N** Neon, **S** Sol. "Reproduced" means a delegate ran it; "read" means it was found by reading the code.

## Phase 1: Feed reliability

A stalled stream makes the feed quietly incomplete, which would spoil the usage evidence phase 4 collects. So this comes first.

- [ ] 1.1 A cached active PR that Azure no longer returns must not stall the `prs` stream. Today `provider.pullRequest` throws (`server/azure-client.js:398-414`), the page never commits, and the same first three PRs are retried every turn (`server/sync.js:275-283`). Fix: leave that one PR unresolved, commit its readable siblings, and rotate the lookups so later PRs get a turn. Check: a test in `test/sync.test.js` that fails first. (S reproduced, N read)
- [ ] 1.2 A failed read must not discard a newer refresh request. Today the failure handler saves the older state and clears the pending request (`server/sync.js:335-340`). Check: a test that fails first, with automatic checks off. (S reproduced)
- [ ] 1.3 Auth and other whole-stream failures still surface as a problem after 1.1. Check: existing failure tests stay green plus one assertion for an auth error during the per-PR lookup. (S)
- [ ] 1.4 Probe what Azure returns from `buildsById` for a build removed by retention. Only if it is omitted and the build is re-queried forever (`server/sync.js:267-273`): mark it terminal. Check: probe result recorded in `docs/probe-results.md`; a failing-first test if a fix is needed. (N, unverified against Azure)

## Phase 2: Protect data and local work

- [ ] 2.1 Copy the database before running migrations. When `user_version` is behind, run `VACUUM INTO` a `pre-v<N>` file first and keep only the last one. Migrations 12 and 14 delete rows, and a logically wrong migration still commits (`server/store.js:296-322`). Check: a test that migrates an older fixture and opens the copy; then one run on a copy of the real database. (O)
- [ ] 2.2 Rebuild search text when the indexed terms change. Search text is computed once at insert (`server/store.js:115-139`), so a wording change leaves old rows stale. Fix: a search index version constant; rerun the existing reindex loop when it changes. Check: a failing-first test where an old row matches a new term after restart. (O, N agrees on the cause)
- [ ] 2.3 Pass `submodule.recurse=false` to `worktree add` and `cherry-pick` in carry (`server/checkout-branches.js:288,295`), as Pull already does (`server/checkout-update.js:108`). Check: a test with `submodule.recurse=true` set. (N read, confirmed)
- [ ] 2.4 Pull: after the fast-forward, verify the branch as well as the commit, and report an unclear outcome as unclear (`server/checkout-update.js:124,210-230`). This narrows the race `docs/MAINTAINING.md:34` already documents; it does not close it. Check: a disposable-checkout test that switches branch before the final check and asserts neither branch moved. (S; O would leave the Git layer alone)
- [ ] 2.5 Set a SQLite busy timeout so a second process reading the database does not make a write fail at once (`server/store.js:68`). Low value in WAL mode; do it only because it is one line. Check: a test where a write waits instead of throwing. (N)

## Phase 3: Working agreement

- [ ] 3.1 Write a two-tier review rule into `docs/MAINTAINING.md`: copy, CSS and layout changes get CI plus one review; changes to `server/checkout-*.js`, `server/store.js` migrations, `server/sync.js` and `server/azure-*.js` keep the full cross-model loop. Check: the next three copy or layout PRs took one review round. (O, N, S)
- [ ] 3.2 For a wording or default change, agree one representative row and any search trade-off before coding. Check: the PR description states the agreed row. (S)

## Phase 4: Use, then decide

- [ ] 4.1 Two weeks of daily use. Fix bugs found in use; no new polish. Keep `docs/usage-log.md` with one dated line per friction point. Check: the log exists and covers ten working days. (O, N, S)
- [ ] 4.2 Record database size at the start, after one week and after two weeks (10.1 MB for 1,982 events on 2026-11-21). Check: three readings in the log. (O)
- [ ] 4.3 Decide retention and packaging from that data, as `PLAN.md` already says, and pick at most one recurring problem to work on next. Check: `PLAN.md` updated, including a decision to do nothing. (O, S, N)

## Fix only if use shows it

- A checkout refused over harmless local config such as `http.postBuffer` (`server/checkout-git.js:62-87`): allowlist that one key when it happens. (O, N suspected)
- `ls-files --stage` cost on each status read (`server/checkout-git.js:341`). (O, N suspected)
- `refs/pull/*` pages read and then discarded (`server/azure-client.js:269-273`): measure with `scripts/measure-budget.js` first. (N)
- The delete guard hook copied to the temp folder fails where that folder forbids execution (`server/checkout-branches.js:220-235`). (N)
- Recovery refs under `refs/repo-pulse/` are never cleaned up. (O)
- Cached history can mix if the Azure account changes, because repository IDs carry no account identity. (S)

## Leave alone

- Stored titles and summaries: display code already overrides them where it matters. (all three)
- The size of `e2e/ui.test.js` and exact-text assertions: PR 86's test edits were the assertions on the text that changed. (all three)
- Token handling, the HTTP server lockdown, shell-free Git and Azure CLI calls, branch deletion guards: read and found sound. (all three)
- Search by build number: dropped on purpose in PR 86.
