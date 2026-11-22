# Maintaining Repo Pulse

## Where changes belong

| Code | Responsibility |
| --- | --- |
| [server.js](../server.js) | Loopback HTTP, the access key, request validation, and runtime wiring |
| [server/azure-cli.js](../server/azure-cli.js), [server/azure-rest.js](../server/azure-rest.js) and [server/azure-client.js](../server/azure-client.js) | Azure command allowlist, queue, token-based REST reads, endpoint queries, and paging |
| [server/sync.js](../server/sync.js), [server/normalize.js](../server/normalize.js), [server/backfill.js](../server/backfill.js), [server/rewrite-check.js](../server/rewrite-check.js) and [server/fork-origin.js](../server/fork-origin.js) | Live polling, payload normalization, historical imports, the one-call rewrite check for new pushes, and the fork origin check for new branches |
| [server/sync-status.js](../server/sync-status.js) | The per-repository and overall sync status sent with `/api/state` |
| [server/store.js](../server/store.js) and [server/merge-evidence.js](../server/merge-evidence.js) | SQLite events, migrations, atomic checkpoints, reset, and linking pushes to completed PRs by tip |
| [server/activity-query.js](../server/activity-query.js) | Scoped Activity rows, stable filter IDs, counts, and paging |
| [server/repositories.js](../server/repositories.js) and [server/checkout-git.js](../server/checkout-git.js) | Checkout discovery, Git runner and safety checks, status and cache, and the per-repository/shared-Git-dir write lock |
| [server/checkout-activity-switch.js](../server/checkout-activity-switch.js) and [server/checkout-switch-refs.js](../server/checkout-switch-refs.js) | Branch switches from Activity and Repositories, tracking-ref transactions, and rewrite recovery |
| [server/checkout-update.js](../server/checkout-update.js) and [server/checkout-branches.js](../server/checkout-branches.js) | Check, Pull, and PR branch follow-up workflows |
| [src/activity-tree.js](../src/activity-tree.js) and [src/ui/activity-tree.js](../src/ui/activity-tree.js) | The branch tree of All activity: lanes, fork and merge links from the rendered rows, and the SVG cell of each row. [server/activity-query.js](../server/activity-query.js) attaches the stored pull request to CI runs on a pull request ref |
| [src/web.js](../src/web.js) and [src/ui/](../src/ui/) | Browser wiring, view rendering, refresh coordination, navigation, and exact seen actions |
| [web/app.css](../web/app.css), [web/styles/](../web/styles/) and [web/theme.js](../web/theme.js) | Modular CSS tokens, layouts, screen styles, light-mode glass, and System, Light, and Dark controls |

The app uses Node 26, built-in SQLite, plain JavaScript, and CSS. It has no runtime npm dependencies or build step; the only third-party code is one vendored browser file (see [Vendored browser code](#vendored-browser-code)). Live and demo databases are separate and ignored by Git. `PORT` fixes the loopback port; by default each start gets a free port from the OS. `REPO_PULSE_NO_BROWSER=1` stops `npm start` from opening the browser. `REPO_PULSE_DATA_DIR` changes the storage directory. Use one Azure CLI account context for each local data directory.

Keep Azure reads in the shared queue. `devops invoke` reads go over HTTPS with an Azure DevOps token from `az account get-access-token`, which is renewed five minutes before it expires and after a 401. The token stays inside `azure-rest.js`: it is never returned, logged or put in an error, and `run()` still refuses token commands. Other commands, such as `repos show` and the local CLI checks, still start `az`. A repository connection check also makes one REST read, so it fails the way activity reads would; an organization-only check uses `az` only. A `Retry-After` header pauses the whole queue (see `retryAfter` in `azure-cli.js`). Explicit Git operations must act on the linked checkout and its verified upstream. Store raw events and checkpoints together. Enrichment can add evidence to a record without changing its ID or seen state.

The Activity page query and unread snapshot share the same repository, search, people, and group filters. Row actions take their IDs from the rendered page. Acknowledgement returns only the IDs it changed so that Undo can restore those updates.

## Size frontend controls

Use the shared `.btn`, `.control`, `.ghost`, and `.search` classes. Choose one size for controls that share a row. The default is 36 CSS px on desktop and 44 CSS px below 768 px. Add `sm` to each control in a compact row for 28 CSS px on desktop and 36 CSS px below 768 px. Both sizes come from `web/styles/tokens.css`. Set layout, spacing, and wrapping in the feature stylesheet. Keep the shared height when mixing buttons with native selects or inputs.

## Local Git actions

Branch switches verify the destination ref, its fetch mapping, and the linked Git directory. Tracking-ref updates check the expected old value, and Repo Pulse checks the type of each ref while Git holds its transaction lock. For a confirmed rewrite, Repo Pulse writes and verifies recovery refs under `refs/repo-pulse/upstream-rewrites/` before updating the tracker. Later checks can use those refs to detect the rewrite on other local branches tracking the same upstream, including branches in linked worktrees. Git handles the worktree switch separately.

Pull checks the checkout, upstream and fetched tip before running `git merge --ff-only --no-squash`, then verifies that the checkout is still on the same branch and that HEAD is the fetched tip. A terminal branch change between the final check and Git's merge can still make Git fast-forward the other branch instead. Pull cannot tell which branch moved, so it reports the outcome as unclear rather than as an update.

## Render into the live page

`setHtml` in [src/ui/dom.js](../src/ui/dom.js) is the only `innerHTML` sink. It parses `SafeHtml` into a template and merges it into the element with idiomorph, so a node that still matches keeps its focus, caret, text selection and listeners. Do not add code that saves and restores focus or selection around a render; if a render loses them, find the markup that stopped matching. State a person changes on the page belongs in `ui` and the markup renders from it, as `ui.openMenu` does for the toolbar menus and the repository scope panel. A control whose state the markup does not carry, such as a ticked commit checkbox, is still protected by `refreshTarget` in [src/ui/browser-view.js](../src/ui/browser-view.js).

## Vendored browser code

[web/vendor/](../web/vendor/) holds browser modules copied byte for byte from a published release, with their licence and type declarations. [test/vendor.test.js](../test/vendor.test.js) pins each file's sha256 and names the release it came from. ESLint, Prettier and `tsc` skip the folder. To update idiomorph, take `package/dist/idiomorph.esm.js` and `idiomorph.d.ts` (saved as `idiomorph.esm.d.ts`) from `npm pack idiomorph@<version>`, change the version and hash in the test in the same commit, and run every check, including `npm run test:ui`.

## Keep functions small

`npm run lint` fails when a function's cyclomatic complexity exceeds 30. When a change pushes a function over, split it into named steps or a small table of handlers, as `server/normalize.js` does, rather than raising the limit.

## Test what the page shows

UI unit tests render markup and read it through [test/fixtures/dom.js](../test/fixtures/dom.js), so a test breaks when what a person sees changes, not when the HTML is rearranged.

- Check text on the element that should hold it: `text(one(row(doc, 'listed'), '.event-main'))`. `text` leaves out screen-reader-only `.sr` text; `srText` includes it.
- Check that something is there, or not, with a selector: `one(doc, '[data-action="remove-repo"]')`, `all(row, '.event-origin').length`. `data-action` attributes are what the click handlers use, so they are fair to select on.
- Match exact markup only where the markup is the point: escaping in `test/escaping.test.js`, and safety attributes such as `href` and `title`, read with `getAttribute`.

`npm run lint` rejects regular expressions over HTML (such as `/class="row/` or `/<div/`) in these test files.

## Run checks

```sh
npm run check
npm run check:types
npm run lint
npm test
npm run test:ui
```

CI runs the first four on Linux and Windows, and the browser tests on Linux only. Browser tests use Chromium. Run `npx playwright install chromium` if needed, or set `CHROME` to a local executable. Tests use isolated databases and temporary Git repositories. They verify workflows and failure cases without proving live Azure permissions. See [coverage and limits](COVERAGE.md) for the distinction.

## Check local load

Run `node scripts/measure-activity.js` for synthetic local HTTP and SQLite timings. Add `--large` to include 75,000 events with both pushes and grouped builds. The script includes serialization and JSON parsing. It does not measure Azure or browser rendering.

## Check the Azure budget

Use `node scripts/measure-budget.js --limit 60` to compare simulated polling under the current request budget. The script runs the real sync and Azure client code with a fake clock and a fake CLI. It serializes calls, uses an assumed 1.5 seconds per call by default, and omits the rewrite check and its retries. Use the results for relative comparisons between simulated polling changes. Live queue capacity and detection latency need separate measurements.

The [historical local-load and Azure budget measurements](https://github.com/ddv1982/repo-pulse/blob/b8fb8561854d472bcc17543326df5c4644c53cd8/docs/MAINTAINING.md#check-local-load) remain in Git history. The old Azure runs included background merge analysis, so compare current polling changes using the same simulator settings on both revisions.

For verified Azure API details and future proof cases, see the [coverage research](FULL-COVERAGE-RESEARCH.md).
