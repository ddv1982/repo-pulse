# Quality and maintainability pass

Follow-up to the review fixes (pull requests #3 to #6). Delivered in #7 (CI), #8 (stream state), #9 (plain Git Pull), #10 (CI timing fix), #11 (route table), #12 (migrations) and #13 (formatting and docs). The goal is higher quality with less code: run the
checks on every pull request, remove the over-built parts, and make the subtle parts easier to change.
Each pull request ends with its checks green in CI, a Sol review, and the bot reviews handled.

## Out of scope

- Switching to TypeScript, adding a framework or runtime dependencies, changing the database, or adding a worker.
- New Azure coverage from the PLAN.md roadmap.

## PR A: run the checks on every pull request (item 1)
- [x] Add a GitHub Actions workflow that runs `npm ci`, `check`, `check:types`, `lint`, `test` and `test:ui` (with Chromium) on Node 26 for pull requests and pushes to main.
- [x] Watch the workflow run green on its own pull request.

## PR B: delete the custom Pull fast-forward (item 3)
- [x] Replace `fastForward` with `git merge --ff-only --no-overwrite-ignore` after the existing pre-checks, keeping the user-facing error messages the tests expect.
- [x] Delete what only served it: the private index and lock handling, `withLockedRefs`, the pull journal, `pull-owner.js`, the interrupted and running recovery states, and their UI and server wiring.
- [x] Drop the `pull_operations` table with a migration covered by a migration test.
- [x] Delete tests that only exercised the removed mechanism; every behavioural checkout test still passes.
- [x] Update `docs/MAINTAINING.md` (remove the interrupted Pull recovery section and the "why Pull keeps" note).
- [x] Manual Pull in a disposable clone with unrelated local edits, through the real app.

## PR C: one checked shape for sync stream state (item 2)
- [x] Define the stream state type once and add `server/sync.js` to the type check.
- [x] Express the transitions (page complete, next page, failure, refresh requested) as small pure functions used by `runPage` and `refresh`.
- [x] Sync and backfill tests pass without edits; budget simulation output unchanged.

## PR D: migrations as an ordered list (item 4)
- [x] Replace the inline `if (version < N)` blocks in `server/store.js` with numbered steps applied in order, recording the version after each.
- [x] All migration tests pass without edits; a fresh database and each tested old version reach the latest version.

## PR E: request handling as a route table (item 6)
- [x] Replace the chain of `if (req.method ...)` checks in `server.js` with a table of method, path and handler.
- [x] Server and browser tests pass without edits.

## PR F: formatting enforced by a tool, and tidy docs (items 5 and 7)
- [x] Add a formatter as a dev dependency with a config close to the current style, wire it into lint, and reformat in one commit.
- [x] Move completed plans (`DISABLE-REPOS-PLAN.md`, `REVIEW-FIXES-PLAN.md`) into `docs/plans/` and fix links.
- [x] All checks pass; the reformat commit changes no behaviour (tests unchanged).

## Wrap-up
- [ ] Reread this file and list every unchecked item with its reason.
