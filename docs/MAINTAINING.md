# Maintaining Repo Pulse

## Where changes belong

| Code | Responsibility |
| --- | --- |
| [server.js](../server.js) | Loopback HTTP, the access key, request validation, and runtime wiring |
| [server/azure-cli.js](../server/azure-cli.js), [server/azure-rest.js](../server/azure-rest.js) and [server/azure-client.js](../server/azure-client.js) | Azure command allowlist, queue, token-based REST reads, endpoint queries, and paging |
| [server/sync.js](../server/sync.js), [server/normalize.js](../server/normalize.js), [server/backfill.js](../server/backfill.js) and [server/rewrite-check.js](../server/rewrite-check.js) | Live polling, payload normalization, historical imports, and the one-call rewrite check for new pushes |
| [server/sync-status.js](../server/sync-status.js) | The per-repository and overall sync status sent with `/api/state` |
| [server/store.js](../server/store.js) and [server/merge-evidence.js](../server/merge-evidence.js) | SQLite events, migrations, atomic checkpoints, reset, and linking pushes to completed PRs by tip |
| [server/activity-query.js](../server/activity-query.js) | Scoped Activity rows, stable filter IDs, counts, and paging |
| [server/repositories.js](../server/repositories.js) and [server/checkout-git.js](../server/checkout-git.js) | Checkout discovery, local Git status, explicit fetch, and guarded fast-forward |
| [src/web.js](../src/web.js) and [src/ui/](../src/ui/) | Browser wiring, view rendering, refresh coordination, navigation, and exact seen actions |
| [web/app.css](../web/app.css), [web/styles/](../web/styles/) and [web/theme.js](../web/theme.js) | Modular CSS tokens, layouts, screen styles, light-mode glass, and System, Light, and Dark controls |

The app uses Node 26, built-in SQLite, plain JavaScript, and CSS. It has no runtime npm dependencies or build step. Live and demo databases are separate and ignored by Git. `PORT` fixes the loopback port; by default each start gets a free port from the OS. `REPO_PULSE_NO_BROWSER=1` stops `npm start` from opening the browser. `REPO_PULSE_DATA_DIR` changes the storage directory. Use one Azure CLI account context for each local data directory.

Keep Azure reads in the shared queue. `devops invoke` reads go over HTTPS with an Azure DevOps token from `az account get-access-token`, which is renewed five minutes before it expires and after a 401. The token stays inside `azure-rest.js`: it is never returned, logged or put in an error, and `run()` still refuses token commands. Other commands, such as `repos show` and the local CLI checks, still start `az`. A repository connection check also makes one REST read, so it fails the way activity reads would; an organization-only check uses `az` only. A `Retry-After` header pauses the whole queue (see `retryAfter` in `azure-cli.js`). Explicit Git operations must act on the linked checkout and its verified upstream. Store raw events and checkpoints together. Enrichment can add evidence to a record without changing its ID or seen state.

## Pull

Pull runs `git merge --ff-only --no-squash` after verifying the checkout identity, upstream and eligibility, then confirms HEAD reached the fetched commit. Git owns the update, so there is no app journal or lock handling. One accepted trade-off: Git does not re-confirm the branch at the moment it moves HEAD, so switching to another branch at the same commit in the instant between the last check and the merge would fast-forward that branch instead. Nothing is lost, and the reflog undoes it.

## Keep functions small

`npm run lint` fails when a function's cyclomatic complexity exceeds 30. When a change pushes a function over, split it into named steps or a small table of handlers, as `server/normalize.js` does, rather than raising the limit.

## Run checks

```sh
npm run check
npm run check:types
npm run lint
npm test
npm run test:ui
```

Browser tests use Chromium. Run `npx playwright install chromium` if needed, or set `CHROME` to a local executable. Tests use isolated databases and temporary Git repositories. They verify workflows and failure cases without proving live Azure permissions. See [coverage and limits](COVERAGE.md) for the distinction.

## Check local load

Run `node scripts/measure-activity.js` for synthetic local HTTP and SQLite timings. Add `--large` to include 75,000 events with both pushes and grouped builds. The script includes serialization and JSON parsing. It does not measure Azure or browser rendering.

## Check the Azure budget

Run `node scripts/measure-budget.js` to simulate live polling against the shared call limit (`--limit`, default 12 for the old CLI-only budget; the app now uses 60). It runs the real sync and Azure client code with a fake clock and a fake CLI. It does not run the rewrite check, which adds one call, plus any retries, for each existing branch a live push moves. Options set the repository counts, pushes per hour, the assumed duration of one CLI call, and the simulated minutes. The call duration of 1.5 s is an assumption, not a measurement.

The [historical local-load and Azure budget measurements](https://github.com/ddv1982/repo-pulse/blob/b8fb8561854d472bcc17543326df5c4644c53cd8/docs/MAINTAINING.md#check-local-load) remain in Git history. The old Azure runs included background merge analysis, so use a fresh simulation for the current sync design.

For verified Azure API details and future proof cases, see the [coverage research](FULL-COVERAGE-RESEARCH.md).
