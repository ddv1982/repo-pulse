# Maintaining Repo Pulse

## Where changes belong

| Code | Responsibility |
| --- | --- |
| [server.ts](../server.ts) | The command line entry: port, browser launch and shutdown |
| [server/http.ts](../server/http.ts) and [server/errors.ts](../server/errors.ts) | Loopback HTTP: local-request checks, the access key and launch token, static files, dispatch from the route map, and the one mapping from `AppError` kinds to statuses |
| [src/contract.ts](../src/contract.ts) | The JSON the server and browser share, the stream and kind lists, and the route map (`ROUTES` and what each route takes and answers) that both `request()` in [src/api.ts](../src/api.ts) and the server use |
| [server/routes/](../server/routes/) | One module per route group (state, activity, filters, repositories, checkout, history). Each validates its request once and answers the type the route map names |
| [server/runtime.ts](../server/runtime.ts) and [server/demo.ts](../server/demo.ts) | Building the app from its route groups and starting live or demo mode. Demo mode implements the same sync and Azure read interfaces, and the routes it cannot serve answer 403 from one table |
| [server/azure-cli.ts](../server/azure-cli.ts) | The one Azure queue and its budget for `az` commands (`run`) and REST reads (`read`), the `az` command allowlist, the failure messages, and `classifyCliError` for real `az` output |
| [server/azure-reads.ts](../server/azure-reads.ts), [server/azure-rest.ts](../server/azure-rest.ts) and [server/azure-client.ts](../server/azure-client.ts) | The typed `AzureRead` and the one table of reads it may name, the token-based REST reader that maps each HTTP status to a failure by number, and the endpoint queries and paging the client builds from them |
| [server/sync.ts](../server/sync.ts) and [server/sync-lookups.ts](../server/sync-lookups.ts) | Live polling: the scheduler, fairness, cadence and refresh generations, and the lookups by ID of cached active PRs and in-progress builds the active listing no longer holds |
| [server/normalize.ts](../server/normalize.ts), [server/backfill.ts](../server/backfill.ts) and [server/read-warnings.ts](../server/read-warnings.ts) | Payload normalization (one normalizer, built in `runtime.ts` and shared by sync and history import), historical imports, and the unreadable-record warnings both report |
| [server/jobs.ts](../server/jobs.ts), [server/rewrite-check.ts](../server/rewrite-check.ts) and [server/fork-origin.ts](../server/fork-origin.ts) | The rewrite and fork check jobs and the fork job builder, the one-call rewrite check for new pushes, and the fork origin check for new branches |
| [server/sync-status.ts](../server/sync-status.ts) | The per-repository and overall sync status sent with `/api/state` |
| [server/store.ts](../server/store.ts) and [server/store-db.ts](../server/store-db.ts) | The store facade: one SQLite connection and its one transaction owner, composing the modules below. Every write it offers is one transaction, and a sync page (`commitPage`) commits its events, entities, jobs and checkpoint together |
| [server/store-migrations.ts](../server/store-migrations.ts) | The copy before an upgrade, the schema, and the migrations in version order. Each migration names the live helpers it calls; one whose result must not follow later changes keeps its own copy |
| [server/store-state.ts](../server/store-state.ts) and [server/store-records.ts](../server/store-records.ts) | Repositories, streams, entities, jobs and settings, with the checks each stored row is read through. Every per-repository settings key (baseline, checkout observation, follow-up plan) is built from `repoSettingKeys`, and removing a repository deletes every key with those prefixes |
| [server/store-events.ts](../server/store-events.ts), [server/store-links.ts](../server/store-links.ts) and [server/merge-evidence.ts](../server/merge-evidence.ts) | Event rows, their Activity membership and search labels, enrichment and acknowledgement, and linking pushes to completed PRs by tip |
| [server/store-queries.ts](../server/store-queries.ts) | Read models over stored events: the branch picker, related activity, the commits the Git graph annotates, checkout pull candidates, and fork check candidates |
| [server/activity-query.ts](../server/activity-query.ts) | Scoped Activity rows, stable filter IDs, counts, and paging |
| [server/git.ts](../server/git.ts) | The Git runner and the primitives every checkout workflow shares (commit and ancestry checks, ref reads, branch switch, upstream comparison, tracking mapping, upstream validation and fetch). It imports no workflow |
| [server/repositories.ts](../server/repositories.ts), [server/checkout-git.ts](../server/checkout-git.ts), [server/checkout-status.ts](../server/checkout-status.ts) and [server/checkout-context.ts](../server/checkout-context.ts) | Checkout discovery; the checkout facade that builds one `CheckoutContext` for the workflows, holds the per-repository and shared Git directory write locks, and caches status; the config guard and status reading |
| [server/checkout-activity-switch.ts](../server/checkout-activity-switch.ts) and [server/checkout-switch-refs.ts](../server/checkout-switch-refs.ts) | Branch switches from Activity and Repositories, tracking-ref transactions, and rewrite recovery |
| [server/checkout-update.ts](../server/checkout-update.ts) and [server/checkout-branches.ts](../server/checkout-branches.ts) | Check, Pull, and PR branch follow-up workflows |
| [src/activity-tree.ts](../src/activity-tree.ts) and [src/ui/activity-tree.ts](../src/ui/activity-tree.ts) | The branch tree in Activity: lanes, fork and merge links from the rendered rows, and the SVG cell of each row. [server/activity-query.ts](../server/activity-query.ts) attaches the stored pull request to CI runs on a pull request ref |
| [src/web.ts](../src/web.ts) | Browser composition: builds the shared services, the route controllers and the one action table, renders, routes and starts the page |
| [src/ui/activity-controller.ts](../src/ui/activity-controller.ts), [detail-controller.ts](../src/ui/detail-controller.ts), [git-graph.ts](../src/ui/git-graph.ts), [repositories-controller.ts](../src/ui/repositories-controller.ts) and [settings-controller.ts](../src/ui/settings-controller.ts) | One controller per page: its state outside `ui` and the actions its controls name. [saved-filter-actions.ts](../src/ui/saved-filter-actions.ts) and [header-actions.ts](../src/ui/header-actions.ts) hold the actions of features shared across pages. [shell.ts](../src/ui/shell.ts) is the context they share |
| [src/ui/actions.ts](../src/ui/actions.ts), [menus.ts](../src/ui/menus.ts), [dialog.ts](../src/ui/dialog.ts) and [groups.ts](../src/ui/groups.ts) | The action list and its one dispatcher, the menu manager, the dialog helper, and disclosure open state |
| [src/ui/](../src/ui/) (other modules) | View rendering, refresh coordination, navigation, checkout reads, and exact seen actions |
| [web/app.css](../web/app.css), [web/styles/](../web/styles/) and [web/theme.ts](../web/theme.ts) | Modular CSS tokens, layouts, screen styles, light-mode glass, and System, Light, and Dark controls |

The app uses Node 26, built-in SQLite, TypeScript, and CSS. Node runs the server, scripts and tests from `.ts` directly. It has no runtime npm dependencies and no bundler. Browser TypeScript is compiled with `tsc` to `dist/` (`npm run build:web`, which runs automatically before `npm start`, `npm run demo` and the tests; `npm run watch:web` rebuilds while editing), and the server serves `/src/` and `/web/theme.js` from there. The only third-party code is one vendored browser file (see [Vendored browser code](#vendored-browser-code)). Live and demo databases are separate and ignored by Git. `PORT` fixes the loopback port; by default each start gets a free port from the OS. `REPO_PULSE_NO_BROWSER=1` stops `npm start` from opening the browser. `REPO_PULSE_DATA_DIR` changes the storage directory. Use one Azure CLI account context for each local data directory.

[`tsconfig.json`](../tsconfig.json) checks the full project without emitting files. Browser, server and shared modules are separated by scoped rules in [`.oxlintrc.json`](../.oxlintrc.json). [`scripts/build-web.ts`](../scripts/build-web.ts) compiles only browser sources and keeps the early theme script in classic-script mode. The extensionless Git hook stays CommonJS and opts into type checking with `@ts-check`.

Keep Azure reads in the shared queue. The client builds each activity read as a typed `AzureRead`, which `read()` admits only if `azure-reads.ts` lists its area and resource. Reads go over HTTPS with an Azure DevOps token from `az account get-access-token`, which is renewed five minutes before it expires and after a 401. The token stays inside `azure-rest.ts`: it is never returned, logged or put in an error, and `run()` still refuses token commands. A failed read is classified by its HTTP status (401 sign-in, 403 permission, 404 not found, 429 throttled, 5xx unavailable), and a request with no answer as unavailable or timed out. Other commands, such as `repos show` and the local CLI checks, still start `az`, and only their output goes through `classifyCliError`. [test/azure-status.test.ts](../test/azure-status.test.ts) pins what each failure becomes, up to the sync status a person sees. A repository connection check also makes one REST read, so it fails the way activity reads would; an organization-only check uses `az` only. A `Retry-After` header pauses the whole queue (see `retryAfter` in `azure-cli.ts`). Explicit Git operations must act on the linked checkout and its verified upstream. Store raw events and checkpoints together. Enrichment can add evidence to a record without changing its ID or seen state.

The Activity page query and unread snapshot share the same repository, search, people, and group filters. Row actions take their IDs from the rendered page. Acknowledgement returns only the IDs it changed so that Undo can restore those updates.

## Size frontend controls

Use the shared `.btn`, `.control`, `.ghost`, and `.search` classes. Choose one size for controls that share a row. The default is 36 CSS px on desktop and 44 CSS px below 768 px. Add `sm` to each control in a compact row for 28 CSS px on desktop and 36 CSS px below 768 px. Both sizes come from `web/styles/tokens.css`. Set layout, spacing, and wrapping in the feature stylesheet. Keep the shared height when mixing buttons with native selects or inputs.

## Local Git actions

Branch switches verify the destination ref, its fetch mapping, and the linked Git directory. Tracking-ref updates check the expected old value, and Repo Pulse checks the type of each ref while Git holds its transaction lock. For a confirmed rewrite, Repo Pulse writes and verifies recovery refs under `refs/repo-pulse/upstream-rewrites/` before updating the tracker. Later checks can use those refs to detect the rewrite on other local branches tracking the same upstream, including branches in linked worktrees. Git handles the worktree switch separately.

Pull checks the checkout, upstream and fetched tip before running `git merge --ff-only --no-squash`, then verifies that the checkout is still on the same branch and that HEAD is the fetched tip. A terminal branch change between the final check and Git's merge can still make Git fast-forward the other branch instead. Pull cannot tell which branch moved, so it reports the outcome as unclear rather than as an update.

## Render into the live page

`setHtml` in [src/ui/dom.ts](../src/ui/dom.ts) is the only `innerHTML` sink. It parses `SafeHtml` into a template and merges it into the element with idiomorph, so a node that still matches keeps its focus, caret, text selection and listeners.

State a person changes on the page belongs in `ui`, or in the data the markup renders from, and the markup renders from it: `ui.openMenu` for the toolbar menus and the repository picker's list, `ui.groups` for every `<details data-group>`, `ui.headerMenuOpen` for the phone check menu, and the checkout snapshot's `carry` list for ticked follow-up commits. Do not save and restore focus, selection or open state around a render. If a control that is still on the page loses focus, find the markup that stopped matching.

- A control names what it does with `action('name')` from [src/ui/actions.ts](../src/ui/actions.ts). Add the name to `ACTIONS` under the event that runs it (click, change or input) and the handler to the controller that owns it; the type check fails until both exist. Do not add another listener convention.
- A menu or popover registers with the menu manager in [src/ui/menus.ts](../src/ui/menus.ts), which listens on the document once and closes the open menu when the reader acts outside it. Its own keyboard handling stays with it.
- A dialog uses `createDialog` in [src/ui/dialog.ts](../src/ui/dialog.ts): it returns focus to the control that opened it, marks its Cancel button `data-dialog-cancel`, and counts in `anyDialogOpen()`. A confirmation is never replaced while it waits.
- A disclosure renders its attributes with `disclosure(groups, id, default)` from [src/ui/groups.ts](../src/ui/groups.ts) and a summary that names `toggle-group`. Its ID is stable, never its English title. It keeps the state it first rendered with, or the reader's choice, while it stays on the page.
- Rendering starts no request. A controller loads what its page needs when the page is entered or a state answer changes it, as the Git Graph does.

Focus moves on purpose only when the focused control leaves the page or the render hides it. `renderPage` in [src/ui/browser-view.ts](../src/ui/browser-view.ts) then focuses a replacement: the control `replacementFocus` names, such as a menu's toggle for one of its options or the Filters disclosure when that toggle is collapsed inside it below 640 px, or the nearest Seen toggle when a row leaves with its own. Add a case to `replacementFocus` when a new control can leave while focused. `refreshTarget` in the same file still skips a background render while a dialog is open, a command is pending, or a form control whose value the markup may not carry has focus.

## Vendored browser code

[web/vendor/](../web/vendor/) holds browser modules copied byte for byte from a published release, with their licence and type declarations. [test/vendor.test.ts](../test/vendor.test.ts) pins each file's sha256 and names the release it came from. Oxlint, Prettier and `tsc` skip the folder. To update idiomorph, take `package/dist/idiomorph.esm.js` and `idiomorph.d.ts` (saved as `idiomorph.esm.d.ts`) from `npm pack idiomorph@<version>`, change the version and hash in the test in the same commit, and run every check, including `npm run test:ui`.

## Keep functions small

`npm run lint` fails when a function's cyclomatic complexity exceeds 30. When a change pushes a function over, split it into named steps or a small table of handlers, as `server/normalize.ts` does, rather than raising the limit.

## Test what the page shows

UI rendering tests read markup in Chromium through [e2e/fixtures/dom.ts](../e2e/fixtures/dom.ts), so a test breaks when what a person sees changes, not when the HTML is rearranged.

- Check text on the element that should hold it: `await text(one(row(doc, 'listed'), '.event-main'))`. `text` leaves out screen-reader-only `.sr` text; `srText` includes it.
- Check that something is there, or not, with a selector: `await one(doc, '[data-action="remove-repo"]').handle()`, `(await all(row, '.event-origin')).length`. `data-action` attributes are what the click handlers use, so they are fair to select on.
- Match exact markup only where the markup is the point: escaping in `test/escaping.test.ts`, and safety attributes such as `href` and `title`, read with `await element.getAttribute(name)`.

`npm run lint` rejects regular expressions over HTML (such as `/class="row/` or `/<div/`) in these test files.

## Run checks

```sh
npm run check:types
npm run lint
npm test
npm run test:ui
```

CI runs the first three on Linux and Windows. Linux runs the full browser suite, and Windows runs the rendered DOM suite (`npm run test:dom`). Browser tests use Chromium. Run `npx playwright install chromium` if needed, or set `CHROME` to a local executable. Tests use isolated databases and temporary Git repositories. They verify workflows and failure cases without proving live Azure permissions. See [coverage and limits](COVERAGE.md) for the distinction.

## Match review to risk

Copy, CSS and layout changes get the checks above plus one review round. Changes to `server/git.ts` and `server/checkout-*.ts`, `server/store-migrations.ts` and the per-repository key list in `server/store-state.ts`, `server/sync.ts` and `server/sync-lookups.ts`, and `server/azure-*.ts` keep the full cross-model review, because a mistake there can move a local branch, lose stored rows or stall the feed.

Before changing wording or a default, agree one representative row with the owner, and any search the change gives up, and state both in the PR description. When search terms change, raise `SEARCH_INDEX_VERSION` in `src/activity-text.ts` so stored rows are reindexed.

## Check local load

Run `node scripts/measure-activity.ts` for synthetic local HTTP and SQLite timings. Add `--large` to include 75,000 events with both pushes and grouped builds. The script includes serialization and JSON parsing. It does not measure Azure or browser rendering.

## Check the Azure budget

Use `node scripts/measure-budget.ts --limit 60` to compare simulated polling under the current request budget. Add `--refs-per-repo 1106` to measure a multi-page refs listing and `--recent-pushes 2500` for an active initial window. The script runs the real scheduler and Azure client with a fake clock and a fake CLI, and reports time to the first Activity page with rows, time to initialize every stream, and simulated request-budget wait. It serializes calls, uses an assumed 1.5 seconds per call by default, and omits the rewrite check and its retries. Use the results for relative comparisons between simulated polling changes. Live queue capacity and detection latency need separate measurements.

The [historical local-load and Azure budget measurements](https://github.com/ddv1982/repo-pulse/blob/b8fb8561854d472bcc17543326df5c4644c53cd8/docs/MAINTAINING.md#check-local-load) remain in Git history. The old Azure runs included background merge analysis, so compare current polling changes using the same simulator settings on both revisions.

For verified Azure API details and future proof cases, see the [coverage research](FULL-COVERAGE-RESEARCH.md).
