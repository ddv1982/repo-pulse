# Repo Pulse roadmap

Repo Pulse helps testers see what changed across watched Azure DevOps repositories and open the source evidence. The app runs locally, uses the existing Azure CLI sign-in, and reads Azure activity.

Branch and push monitoring, PR merge evidence, grouped Activity, resumable history import, and local checkout status are implemented. The [coverage guide](docs/COVERAGE.md) describes what the app can establish today.

## Codebase improvement phases

Done: Pull is plain Git, Activity filters match the displayed rows, the important boundaries are type-checked, and local Activity load is measured in the [maintainer guide](docs/MAINTAINING.md).

### Next: make the API contract exact and enforce escaping

Every browser module is type-checked, but some server types describe less than the server sends, so the UI fills the gap with its own view types and casts. Each phase is its own PR. A phase is done when `npm run check`, `check:types`, `lint`, `npm test` and `npm run test:ui` pass, plus the check named on its line. Rendered HTML must not change unless a line says so. Where render code changes, compare old and new output on the same inputs with a throwaway script and report the counts.

Count the casts with `grep -rnE '@type \{[^}]*\} \*/ \(' src web | grep -v '@type {const}' | wc -l` (35 on cd7d7b0).

Phase 1: server types describe what routes send

- [x] `CheckoutStatus` (server/checkout-git.js) includes the `followup` that `branches.decorate` adds. Check: a probe file that reads `followup` from `CheckoutsResponse` fails `tsc` before the change and passes after it.
- [x] `StateResponse.jobs` is typed `HistoryJob[]`, since the route only lists backfill jobs, and the `HistoryJob` cast in src/ui/repositories.js is removed. Check: the cast count drops by 1 and `tsc` passes.
- [x] The demo provider's `checkConnection` returns a `ConnectionStatus`, so `ConnectionResponse` is a single type and not a union with a demo-only shape. Check: the demo e2e tests pass, and Settings in `npm run demo` shows the same connection text as before.
- [x] `CheckoutSnapshot` and `ConnectionResult` in src/ui are built from the tightened server types instead of restating their fields. Check: `tsc` passes and the render comparison for checkout.js and connection.js reports 0 differences.

Phase 2: casts become checks

- [x] Casts that hide a possible null or undefined are replaced by `required()`, `instanceof` or an explicit early return: src/web.js:318 (`find` result), src/web.js:441 (`closest` result), and src/ui/type-filter.js:20-24 (`root`). Check: `tsc` passes and the cast count drops by at least 6.
- [x] `/** @type {Error} */ (error)` casts in src/web.js use `error instanceof Error ? error.message : String(error)`, as src/ui/refresh.js does. Check: the cast count drops by 2.
- [x] Element casts on `querySelector` and `querySelectorAll` in src/web.js, src/ui/browser-view.js and src/ui/type-filter.js narrow with `instanceof` or `required()`. Check: the cast count is at most 8, and every remaining cast has a one-line comment saying why it holds.
- [x] The never-set `checking` branch in `connectionResult` (src/ui/connection.js) is removed. Check: `grep -rn checking src` finds nothing and the render comparison reports 0 differences.

Phase 3: escaping is tested, not assumed

- [x] A unit test renders the feed, detail, repositories, settings, header and checkout views with every text field from Azure or Git set to `<x-probe>`, and asserts that the output never contains that tag unescaped. Check: the test fails when one `e()` call in activity-detail.js is removed, and passes when it is restored.
- [x] Any unescaped field the test finds is fixed at the point where its fragment is built. Check: the new test passes, and the render comparison with ordinary input reports 0 differences. The test found none, so no render code changed.

Phase 4: split checkout.js

- [x] The checkout markup functions move to src/ui/checkout-render.js, and src/ui/checkout.js keeps `createCheckoutPanel`. Check: the render comparison for `renderCheckout` reports 0 differences and the Repositories e2e tests pass.

Out of scope: validating API responses at runtime. The browser only talks to its own local server, and `/api/state` is already checked in `readMetadata`. Revisit this if the API ever serves another client.

## Product roadmap after hardening

1. **Extend repository and PR coverage.** Preserve tags and distinguish confirmed history rewrites from ordinary ref changes. Investigate outgoing and fork PRs, review votes, discussions, and policy changes. Show gaps when events or permissions are missing.
2. **Trace deployments to revisions.** Start with whichever mechanism the target organization uses, YAML Environments or classic Releases. Follow a known revision through its run and artifact into a named environment. Verify failed attempts, retries, and rollbacks before presenting deployment evidence.
3. **Add broader build and test context.** Verify how shared pipelines and secondary repositories appear in Azure. Link test results and artifacts when their relationship to the run is known.

## Constraints

- Watch whole repositories by default. Filters affect the Activity view and opening an item never marks it seen.
- Keep one budget for all Azure reads. Activity reads use REST with an Azure CLI token since 2026-11-18, decided after `scripts/measure-budget.js` showed merge evidence falling behind from about 10 repositories on the CLI-only budget. Measure with that script before changing the polling model.
- Keep status labels readable without color. Preserve keyboard focus, visibility, and scroll across refreshes.
- A successful build or merged PR does not establish deployment. Partial evidence should stay visible as partial evidence.
- Service hooks, audit ingestion, notifications, and packaging can wait for a demonstrated need.

See [Azure API research](docs/FULL-COVERAGE-RESEARCH.md) for endpoints, source references, and proof cases. See [maintainer notes](docs/MAINTAINING.md) for architecture, checks, and local measurements.
