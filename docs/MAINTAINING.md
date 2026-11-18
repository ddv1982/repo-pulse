# Maintaining Repo Pulse

## Where changes belong

| Code | Responsibility |
| --- | --- |
| [server.js](../server.js) | Loopback HTTP, request validation, CSRF, and runtime wiring |
| [server/azure-cli.js](../server/azure-cli.js), [server/azure-rest.js](../server/azure-rest.js) and [server/azure-client.js](../server/azure-client.js) | Azure command allowlist, queue, token-based REST reads, endpoint queries, and paging |
| [server/sync.js](../server/sync.js), [server/backfill.js](../server/backfill.js), and [server/enrichment.js](../server/enrichment.js) | Live polling, historical imports, and evidence collection |
| [server/store.js](../server/store.js) | SQLite events, migrations, and atomic checkpoints |
| [server/activity-query.js](../server/activity-query.js) | Scoped Activity rows, stable filter IDs, counts, and paging |
| [server/repositories.js](../server/repositories.js) and [server/checkout-git.js](../server/checkout-git.js) | Checkout discovery, local Git status, explicit fetch, and guarded fast-forward |
| [src/web.js](../src/web.js) and [src/ui/](../src/ui/) | Browser wiring, view rendering, refresh coordination, navigation, and exact seen actions |
| [web/app.css](../web/app.css) and [web/theme.js](../web/theme.js) | Day and night backgrounds, light-mode glass, and System, Light, and Dark controls |

The app uses Node 26, built-in SQLite, plain JavaScript, and CSS. It has no runtime npm dependencies or build step. Live and demo databases are separate and ignored by Git. `PORT` changes the loopback port. `REPO_PULSE_DATA_DIR` changes the storage directory. Use one Azure CLI account context for each local data directory.

Keep Azure reads in the shared queue. `devops invoke` reads go over HTTPS with an Azure DevOps token from `az account get-access-token`, which is renewed five minutes before it expires and after a 401. The token stays inside `azure-rest.js`: it is never returned, logged or put in an error, and `run()` still refuses token commands. Other commands, such as the connection check and `repos show`, still start `az`. Explicit Git operations must act on the linked checkout and its verified upstream. Store raw events and checkpoints together. Enrichment can add evidence to a record without changing its ID or seen state.

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

In the earlier engineering run, the 12-repository fixture had 25,000 events and 2,500 pending merge jobs. Compact metadata reduced the polling response from 246,494 to 820 bytes in that fixture. An idle tab queried metadata without rereading its 250 loaded Activity items. A separate fake-clock test confirmed that history and merge work both get turns under a sustained live workload. Rerun the checks for current results. These measurements do not establish live Azure latency or an upstream request count.

The hardening run used 20 sequential samples after three warm-ups per workload. The 25,000-event fixture measured 55 ms for the first page, 25 ms for search, and 108 ms to refresh 250 items, all at p95. The 75,000-event mixed fixture measured 200 ms, 103 ms, and 421 ms respectively. The query plan showed repeated grouping, so the query now builds the visible groups once for the page, counts, and filter choices. The measured workload does not justify a database change or a worker.

## Check the Azure budget

Run `node scripts/measure-budget.js` to simulate live polling and merge enrichment against the shared call limit (`--limit`, default 12 for the old CLI-only budget; the app now uses 60). It runs the real sync, enrichment and Azure client code with a fake clock and a fake CLI. Options set the repository counts, pushes per hour, commits per push, the assumed duration of one CLI call, and the simulated minutes. The call duration of 1.5 s is an assumption, not a measurement, and the fake CLI returns commits without parents as the real list APIs do.

On 2026-11-18, 120 simulated minutes with the tab in the foreground and 4 pushes per hour per repository gave:

| Repositories | Commits per push | Calls per minute | Push delay p95 | Merge jobs left of pushes |
| --- | --- | --- | --- | --- |
| 1 | 5 | 1.9 | 4.1 min | 0 of 8 |
| 5 | 5 | 9.3 | 4.7 min | 1 of 40 |
| 10 | 5 | 12.0 | 6.6 min | 74 of 80 |
| 20 | 5 | 12.0 | 10.7 min | 154 of 160 |
| 5 | 20 | 12.0 | 5.0 min | 29 of 40 |
| 20 | 20 | 12.0 | 10.8 min | 159 of 160 |

Live polling keeps priority, so a saturated budget mainly delays merge evidence, which stops keeping up from about 10 repositories, or 5 with larger pushes. Push detection slows more gradually.

With REST reads the app allows 60 calls per minute with four in flight. One live REST read measured 113 ms against 1,012 ms for the same `az devops invoke`. With `--limit 60 --call-ms 150` the same scenarios gave:

| Repositories | Commits per push | Calls per minute | Push delay p95 | Merge jobs left of pushes |
| --- | --- | --- | --- | --- |
| 10 | 5 | 19.1 | 4.8 min | 0 of 80 |
| 20 | 5 | 37.7 | 4.7 min | 7 of 160 |
| 10 | 20 | 33.4 | 4.8 min | 0 of 80 |
| 20 | 20 | 57.4 | 4.7 min | 107 of 160 |

A live run against a real organization imported 98 activity items for one new repository in about 3 seconds and finished its 41 merge jobs in 86 calls within two minutes, without errors.

For verified Azure API details and future proof cases, see the [coverage research](FULL-COVERAGE-RESEARCH.md).
