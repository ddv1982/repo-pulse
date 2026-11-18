# Maintaining Repo Pulse

## Where changes belong

| Code | Responsibility |
| --- | --- |
| [server.js](../server.js) | Loopback HTTP, request validation, CSRF, and runtime wiring |
| [server/azure-cli.js](../server/azure-cli.js) and [server/azure-client.js](../server/azure-client.js) | Azure command allowlist, queue, endpoint queries, and paging |
| [server/sync.js](../server/sync.js), [server/backfill.js](../server/backfill.js), and [server/enrichment.js](../server/enrichment.js) | Live polling, historical imports, and evidence collection |
| [server/store.js](../server/store.js) | SQLite events, migrations, atomic checkpoints, and Pull journal |
| [server/activity-query.js](../server/activity-query.js) | Scoped Activity rows, stable filter IDs, counts, and paging |
| [server/repositories.js](../server/repositories.js) and [server/checkout-git.js](../server/checkout-git.js) | Checkout discovery, local Git status, explicit fetch, and guarded fast-forward |
| [src/web.js](../src/web.js) and [src/ui/](../src/ui/) | Browser wiring, view rendering, refresh coordination, navigation, and exact seen actions |
| [web/app.css](../web/app.css) and [web/theme.js](../web/theme.js) | Day and night backgrounds, light-mode glass, and System, Light, and Dark controls |

The app uses Node 26, built-in SQLite, plain JavaScript, and CSS. It has no runtime npm dependencies or build step. Live and demo databases are separate and ignored by Git. `PORT` changes the loopback port. `REPO_PULSE_DATA_DIR` changes the storage directory. Use one Azure CLI account context for each local data directory.

Keep Azure reads in the shared CLI queue. Explicit Git operations must act on the linked checkout and its verified upstream. Store raw events and checkpoints together. Enrichment can add evidence to a record without changing its ID or seen state.

## Recover an interrupted Pull

Repo Pulse records a Pull in SQLite before it locks or changes the checkout. On restart it clears that record if the branch, index, and working files are already consistent at the recorded starting or target commit. On Linux it checks the recorded process start time as well as the PID. If it cannot verify a still-live PID belongs to a different process, it keeps the checkout blocked. Recovery never writes to the checkout or removes locks.

If the repository shows **Pull interrupted**, first make sure no Git operation is still running there. Review the branch and changes with `git status`, `git diff`, and `git diff --cached` before making changes. The app keeps Pull blocked while an index lock exists or the recorded branch is inconsistent. If a stale lock remains, verify its ownership before resolving it manually in Git. Save any edits made after the interruption before restoring or finishing the update.

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

For verified Azure API details and future proof cases, see the [coverage research](FULL-COVERAGE-RESEARCH.md).
