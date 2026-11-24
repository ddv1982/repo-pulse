# Maintaining Repo Pulse

## Where changes belong

| Code | Responsibility |
| --- | --- |
| [server.ts](../server.ts) | Loopback HTTP, the access key, request validation, and runtime wiring |
| [server/azure-cli.ts](../server/azure-cli.ts), [server/azure-rest.ts](../server/azure-rest.ts) and [server/azure-client.ts](../server/azure-client.ts) | Azure command allowlist, queue, token-based REST reads, endpoint queries, and paging |
| [server/sync.ts](../server/sync.ts), [server/normalize.ts](../server/normalize.ts), [server/backfill.ts](../server/backfill.ts), [server/rewrite-check.ts](../server/rewrite-check.ts) and [server/fork-origin.ts](../server/fork-origin.ts) | Live polling, payload normalization, historical imports, the one-call rewrite check for new pushes, and the fork origin check for new branches |
| [server/sync-status.ts](../server/sync-status.ts) | The per-repository and overall sync status sent with `/api/state` |
| [server/store.ts](../server/store.ts) and [server/merge-evidence.ts](../server/merge-evidence.ts) | SQLite events, migrations, atomic checkpoints, reset, and linking pushes to completed PRs by tip |
| [server/activity-query.ts](../server/activity-query.ts) | Scoped Activity rows, stable filter IDs, counts, and paging |
| [server/repositories.ts](../server/repositories.ts) and [server/checkout-git.ts](../server/checkout-git.ts) | Checkout discovery, Git runner and safety checks, status and cache, and the per-repository/shared-Git-dir write lock |
| [server/checkout-activity-switch.ts](../server/checkout-activity-switch.ts) and [server/checkout-switch-refs.ts](../server/checkout-switch-refs.ts) | Branch switches from Activity and Repositories, tracking-ref transactions, and rewrite recovery |
| [server/checkout-update.ts](../server/checkout-update.ts) and [server/checkout-branches.ts](../server/checkout-branches.ts) | Check, Pull, and PR branch follow-up workflows |
| [src/activity-tree.ts](../src/activity-tree.ts) and [src/ui/activity-tree.ts](../src/ui/activity-tree.ts) | The branch tree of All activity and New updates: lanes, fork and merge links from the rendered rows, and the SVG cell of each row. [server/activity-query.ts](../server/activity-query.ts) attaches the stored pull request to CI runs on a pull request ref |
| [src/web.ts](../src/web.ts) and [src/ui/](../src/ui/) | Browser wiring, view rendering, refresh coordination, navigation, and exact seen actions |
| [web/app.css](../web/app.css), [web/styles/](../web/styles/) and [web/theme.ts](../web/theme.ts) | Modular CSS tokens, layouts, screen styles, light-mode glass, and System, Light, and Dark controls |

The app uses Node 26, built-in SQLite, TypeScript, and CSS. Node runs the server, scripts and tests from `.ts` directly. It has no runtime npm dependencies and no bundler. Browser TypeScript is compiled with `tsc` to `dist/` (`npm run build:web`, which runs automatically before `npm start`, `npm run demo` and the tests; `npm run watch:web` rebuilds while editing), and the server serves `/src/` and `/web/theme.js` from there. The only third-party code is one vendored browser file (see [Vendored browser code](#vendored-browser-code)). Live and demo databases are separate and ignored by Git. `PORT` fixes the loopback port; by default each start gets a free port from the OS. `REPO_PULSE_NO_BROWSER=1` stops `npm start` from opening the browser. `REPO_PULSE_DATA_DIR` changes the storage directory. Use one Azure CLI account context for each local data directory.

[`tsconfig.json`](../tsconfig.json) checks the full project without emitting files. Browser, server and shared modules are separated by scoped rules in [`.oxlintrc.json`](../.oxlintrc.json). [`scripts/build-web.ts`](../scripts/build-web.ts) compiles only browser sources and keeps the early theme script in classic-script mode. The extensionless Git hook stays CommonJS and opts into type checking with `@ts-check`.

Keep Azure reads in the shared queue. `devops invoke` reads go over HTTPS with an Azure DevOps token from `az account get-access-token`, which is renewed five minutes before it expires and after a 401. The token stays inside `azure-rest.ts`: it is never returned, logged or put in an error, and `run()` still refuses token commands. Other commands, such as `repos show` and the local CLI checks, still start `az`. A repository connection check also makes one REST read, so it fails the way activity reads would; an organization-only check uses `az` only. A `Retry-After` header pauses the whole queue (see `retryAfter` in `azure-cli.ts`). Explicit Git operations must act on the linked checkout and its verified upstream. Store raw events and checkpoints together. Enrichment can add evidence to a record without changing its ID or seen state.

The Activity page query and unread snapshot share the same repository, search, people, and group filters. Row actions take their IDs from the rendered page. Acknowledgement returns only the IDs it changed so that Undo can restore those updates.

## Size frontend controls

Use the shared `.btn`, `.control`, `.ghost`, and `.search` classes. Choose one size for controls that share a row. The default is 36 CSS px on desktop and 44 CSS px below 768 px. Add `sm` to each control in a compact row for 28 CSS px on desktop and 36 CSS px below 768 px. Both sizes come from `web/styles/tokens.css`. Set layout, spacing, and wrapping in the feature stylesheet. Keep the shared height when mixing buttons with native selects or inputs.

## Local Git actions

Branch switches verify the destination ref, its fetch mapping, and the linked Git directory. Tracking-ref updates check the expected old value, and Repo Pulse checks the type of each ref while Git holds its transaction lock. For a confirmed rewrite, Repo Pulse writes and verifies recovery refs under `refs/repo-pulse/upstream-rewrites/` before updating the tracker. Later checks can use those refs to detect the rewrite on other local branches tracking the same upstream, including branches in linked worktrees. Git handles the worktree switch separately.

Pull checks the checkout, upstream and fetched tip before running `git merge --ff-only --no-squash`, then verifies that the checkout is still on the same branch and that HEAD is the fetched tip. A terminal branch change between the final check and Git's merge can still make Git fast-forward the other branch instead. Pull cannot tell which branch moved, so it reports the outcome as unclear rather than as an update.

## Render into the live page

`setHtml` in [src/ui/dom.ts](../src/ui/dom.ts) is the only `innerHTML` sink. It parses `SafeHtml` into a template and merges it into the element with idiomorph, so a node that still matches keeps its focus, caret, text selection and listeners. Do not add code that saves and restores focus or selection around a render; if a render loses them, find the markup that stopped matching. State a person changes on the page belongs in `ui` and the markup renders from it, as `ui.openMenu` does for the toolbar menus and the repository scope panel. A control whose state the markup does not carry, such as a ticked commit checkbox, is still protected by `refreshTarget` in [src/ui/browser-view.ts](../src/ui/browser-view.ts).

## Vendored browser code

[web/vendor/](../web/vendor/) holds browser modules copied byte for byte from a published release, with their licence and type declarations. [test/vendor.test.ts](../test/vendor.test.ts) pins each file's sha256 and names the release it came from. Oxlint, Prettier and `tsc` skip the folder. To update idiomorph, take `package/dist/idiomorph.esm.js` and `idiomorph.d.ts` (saved as `idiomorph.esm.d.ts`) from `npm pack idiomorph@<version>`, change the version and hash in the test in the same commit, and run every check, including `npm run test:ui`.

## Keep functions small

`npm run lint` fails when a function's cyclomatic complexity exceeds 30. When a change pushes a function over, split it into named steps or a small table of handlers, as `server/normalize.ts` does, rather than raising the limit.

## Test what the page shows

UI rendering tests read markup in Chromium through [e2e/fixtures/dom.ts](../e2e/fixtures/dom.ts), so a test breaks when what a person sees changes, not when the HTML is rearranged.

- Check text on the element that should hold it: `text(one(row(doc, 'listed'), '.event-main'))`. `text` leaves out screen-reader-only `.sr` text; `srText` includes it.
- Check that something is there, or not, with a selector: `one(doc, '[data-action="remove-repo"]')`, `all(row, '.event-origin').length`. `data-action` attributes are what the click handlers use, so they are fair to select on.
- Match exact markup only where the markup is the point: escaping in `test/escaping.test.ts`, and safety attributes such as `href` and `title`, read with `getAttribute`.

`npm run lint` rejects regular expressions over HTML (such as `/class="row/` or `/<div/`) in these test files.

## Run checks

```sh
npm run check
npm run check:types
npm run lint
npm test
npm run test:ui
```

CI runs the first four on Linux and Windows. Linux runs the full browser suite, and Windows runs the rendered DOM suite (`npm run test:dom`). Browser tests use Chromium. Run `npx playwright install chromium` if needed, or set `CHROME` to a local executable. Tests use isolated databases and temporary Git repositories. They verify workflows and failure cases without proving live Azure permissions. See [coverage and limits](COVERAGE.md) for the distinction.

## Match review to risk

Copy, CSS and layout changes get the checks above plus one review round. Changes to `server/checkout-*.ts`, migrations in `server/store.ts`, `server/sync.ts` and `server/azure-*.ts` keep the full cross-model review, because a mistake there can move a local branch, lose stored rows or stall the feed.

Before changing wording or a default, agree one representative row with the owner, and any search the change gives up, and state both in the PR description. When search terms change, raise `SEARCH_INDEX_VERSION` in `src/activity-text.ts` so stored rows are reindexed.

## Check local load

Run `node scripts/measure-activity.ts` for synthetic local HTTP and SQLite timings. Add `--large` to include 75,000 events with both pushes and grouped builds. The script includes serialization and JSON parsing. It does not measure Azure or browser rendering.

## Check the Azure budget

Use `node scripts/measure-budget.ts --limit 60` to compare simulated polling under the current request budget. Add `--refs-per-repo 1106` to measure a multi-page refs listing. The script runs the real scheduler and Azure client with a fake clock and a fake CLI, and reports time to initialize every stream. It serializes calls, uses an assumed 1.5 seconds per call by default, and omits the rewrite check and its retries. Use the results for relative comparisons between simulated polling changes. Live queue capacity and detection latency need separate measurements.

The [historical local-load and Azure budget measurements](https://github.com/ddv1982/repo-pulse/blob/b8fb8561854d472bcc17543326df5c4644c53cd8/docs/MAINTAINING.md#check-local-load) remain in Git history. The old Azure runs included background merge analysis, so compare current polling changes using the same simulator settings on both revisions.

For verified Azure API details and future proof cases, see the [coverage research](FULL-COVERAGE-RESEARCH.md).
