# Backlog

The open work for Repo Pulse, in one list. Add an item when it is agreed and remove it when it ships. Finished plans are kept in [archive/](archive/) as a record.

## Product

The product roadmap and the product follow-ups that wait for a decision are in [PLAN.md](../PLAN.md): see [Product roadmap](../PLAN.md#product-roadmap) and [Deferred follow-ups](../PLAN.md#deferred-follow-ups).

## Usage period

From the [improvement plan](archive/IMPROVEMENT-PLAN.md#phase-4-use-then-decide). Started 2026-11-23 and runs until 2026-12-07.

- Two weeks of daily use. Fix bugs found in use and add no new polish. Keep [usage-log.md](usage-log.md) with one dated line per friction point. Done when the log covers ten working days.
- Record the database size at the start, after one week and after two weeks (10.1 MB for 1,982 events on 2026-11-21). Done when the log has three readings.
- Decide retention and packaging from that data, as [PLAN.md](../PLAN.md#deferred-follow-ups) says, and pick at most one recurring problem to work on next. Done when `PLAN.md` records the decision, including a decision to do nothing.

## Working agreement

From the [improvement plan](archive/IMPROVEMENT-PLAN.md#phase-3-working-agreement). Both rules are written in [MAINTAINING.md](MAINTAINING.md#match-review-to-risk); they stay open until pull requests show them applied.

- Copy, CSS and layout changes get CI plus one review round; changes to `server/git.ts` and `server/checkout-*.ts`, `server/store-migrations.ts` and the per-repository key list in `server/store-state.ts`, `server/sync.ts` and `server/sync-lookups.ts`, and `server/azure-*.ts` keep the full cross-model review. Done when the next three copy or layout PRs took one review round.
- For a wording or default change, agree one representative row and any search trade-off before coding. Done when the PR description states the agreed row.

## Architecture refactor

Approved on 2026-11-27 after a council review at `a0c73ea`. Phases 0 and 1 (user-visible bug fixes and mechanical hygiene), phase 2 (server boundary and one contract), phase 3 (browser shell: route controllers, page state in `ui`, one action dispatcher, one menu manager, a dialog helper, and typed navigation and state) and phase 4 (server internals: the store split, `server/git.ts` with one checkout context, typed Azure reads, PR and build reconciliation out of `server/sync.ts`, and per-repository settings keys owned by the store) are done. Each later phase is one PR, merged before the next starts, and its pull request lists the items and their checks.

- Phase 5, presentation, naming and tests: stylesheets split with shared tokens and documented breakpoints, stable graph status IDs, identifier renames, and a split sync test with shared fixtures.

## When the code is next touched

From the [post-migration plan](archive/post-migration-plan.md#when-the-code-is-next-touched). Do each one as part of a change that already touches the code, not on its own.

- `EventData` as a union on `kind` instead of optional fields (`src/activity.ts`). Stored rows from older versions still need lenient reads. About 2 to 3 days.
- `request()` in `src/api.ts` trusts the response body to match the route map; validating it before returning is still open.
- A smaller `/api/state` response that leaves out stored stream internals.
- New tests use narrow typed fakes instead of `stub<T>()`, which asserts a partial object as a complete one (`test/fixtures/typed.ts`).
- `activityTitle` (`src/activity-text.ts`) renders the raw stored build `definition.name`, so a value that cannot be converted to text can break the page.

## Only if use shows it

From the [improvement plan](archive/IMPROVEMENT-PLAN.md#fix-only-if-use-shows-it) and the [post-migration plan](archive/post-migration-plan.md#only-if-use-shows-it).

- A checkout refused over harmless local config such as `http.postBuffer` (`server/checkout-status.ts`): allowlist that one key when it happens.
- The cost of `ls-files --stage` on each status read (`server/checkout-status.ts`).
- `refs/pull/*` pages read and then discarded (`server/azure-client.ts`): measure with `scripts/measure-budget.ts` first.
- The delete guard hook copied to the temp folder fails where that folder forbids execution (`server/checkout-branches.ts`).
- Recovery refs under `refs/repo-pulse/` are never cleaned up.
- Cached history can mix if the Azure account changes, because repository IDs carry no account identity.
- SQLite JSON scans: `people:` search parses JSON per row (`server/activity-query.ts`) and `branchTipsBefore` expands every prior push (`server/store-queries.ts`). Revisit with the retention decision.
- Pull can fast-forward the wrong branch if a terminal switches branches at the wrong moment. This is documented in [MAINTAINING.md](MAINTAINING.md#local-git-actions), and Pull reports the outcome as unclear.
- Browser workflow tests run only on Linux in CI; Windows runs the rendered DOM suite. Add a Windows browser run only if a Windows-only UI bug appears.
