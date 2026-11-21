# UI refresh plan: update the page in place instead of replacing it

Outcome of a council (Claude Opus 5.5, Claude Fable 5.2, GPT Sol 6.2) on 2026-11-21. Remove this file when every item is ticked.

## Why

`PLAN.md` asks the UI to "preserve keyboard focus, visibility, and scroll across refreshes". Today it does that by skipping
renders: `refreshTarget` (`src/ui/browser-view.js:158-161`) returns `null` whenever focus sits inside `#page`, so a keyboard
user on a row title or Seen toggle sees no new activity until focus moves (reproduced by all three members). When a render
does run, `setHtml` replaces the whole `#page` subtree (about 580 elements for one new event), and focus, caret, selection
and menu state are restored by hand in five places.

## Decision

Keep `SafeHtml`, every template and the linkedom unit tests. Change the single sink, `setHtml` in `src/ui/dom.js`, so it
merges new markup into the live DOM (morphing) instead of replacing it. Then delete the guard clause and the restoration
code that only exists because nodes were replaced.

Rejected:
- **lit-html** (proposed earlier): rewrites about 120 templates, about 26 to 29 holes sit inside a tag where lit cannot bind,
  replaces `SafeHtml` escaping, and linkedom cannot render it, so `test/fixtures/dom.js` from PR #84 would need jsdom or
  happy-dom. Revisit only if phase 3 fails (see kill criteria).
- **Preact + htm**: a larger rewrite and a component model that pulls state out of `refresh.state`.
- **Hand patching per region** (Sol's pick): fixes search but each region grows its own restore code; morphing gives the
  same result through one sink. Kept as the fallback if phase 1 is killed.

Not render damage, so out of scope: `navigation.takeRestoration` and `takeCheckoutFocus` (route changes),
`replacementFocus` and `seenToggleNeighbours` (focus fallback when a control really disappears).

Out of scope throughout: template rewrites, lit or Preact, splitting `src/web.js`, CSS, the server, polling cadence.

## Decision D1 (settled 2026-11-21: vendor idiomorph)

- D1: vendor idiomorph 0.8.0 (one 0BSD ESM file, 53 KB, no imports, used by Turbo 8) pinned by sha256, or write a
  house morph of roughly 150 lines. Vendoring is not an npm dependency but bends the spirit of `PLAN.md:30`. Recommended:
  vendor it now (proven in two prototypes), and treat replacing it as a separate, optional decision once phase 2 shows the
  gain.

## Phase 0: failing tests (test-only)

- [x] e2e: focus a row's `.feed-title`, post `/api/demo/event`; assert the new row appears and focus stays on the same `data-event-id`. Seen failing on main.
- [x] e2e: same with focus on a row's Seen toggle. Seen failing on main.
- [x] e2e: tag the `#feed-search` node and a row node with a JS property, trigger an incoming event; assert both nodes survive. Seen failing on main.
- [x] e2e: with a backward selection in the search box, release a background refresh; assert value, focus and selection direction survive. Seen failing on main.
- [x] e2e: select text inside a row, trigger an incoming event; assert `getSelection()` is unchanged. Seen failing on main.
- Kill: if none of these can be made to fail on main, the problem is not real. Stop.

## Phase 1: morphing sink

- [x] Vendor `idiomorph` 0.8.0 ESM and its `.d.ts` into a vendor folder served by the existing static allowlist; record version and source URL in a header comment.
- [x] Unit test pinning the vendored file's sha256, seen failing on a changed byte.
- [x] Exclude the vendor folder from `tsconfig.json`, ESLint and Prettier; `npm run check:types` and `npm run lint` green.
- [x] `setHtml` parses `SafeHtml.unwrap(markup)` into a `<template>` (still the only innerHTML sink) and morphs its content into the element. Do not use `ignoreActiveValue` (it also skips the focused element's children); protect only `value` on the focused field through `beforeAttributeUpdated`. Deviation found in phase 2: protecting the focused value kept stale text in the repository picker after it reset its query (new e2e test, passes on main, failed with the guard), and every rendered input already writes typed text into state on each input event, so the guard was removed.
- [x] Replace the fake element in the `setHtml` test (`test/escaping.test.js:641`) with a linkedom element.
- [x] Change `e2e/ui.test.js:1355-1359` to detect a refresh by the pill's text or the `/api/state` response, not by the old node leaving the document.
- [x] The node-survival and row-selection tests from phase 0 pass. Deviation: the backward search-selection test still fails here because `renderPage` restores the range without its direction; it passes in phase 2 once that restore is removed. The vendored file keeps no header comment so its bytes match the release; version, source URL and hash live in `test/vendor.test.js`.
- [x] Full check: `npm run check && npm run check:types && npm run lint && npm test && npm run test:ui`, no CSP console errors, alignment tests unchanged.
- Kill: any existing e2e failure that is a behaviour regression rather than a test tied to node replacement. Revert the one commit and fall back to hand patching the Activity search region.

## Phase 2: delete what replacement made necessary

- [x] Drop the `page.contains(focused) && focused !== document.body` clause from `refreshTarget`; the two row-focus tests from phase 0 pass.
- [x] Remove same-element focus, caret and selection restore in `renderPage` (`browser-view.js:82-146`), one mechanism per commit, each removal backed by a test that fails if replacement were back. Removed: the search caret and selection restore (backward-selection test). Kept under the kill rule: `restoreFocus`, because it also moves focus when a control disappears and dropping only its same-element case needs a new condition; the `<details data-group>` open state, which the markup does not carry (phase 3 territory).
- [x] Remove header focus restore in `render` (`browser-view.js:170-180`) if the header test still passes. New header test, seen failing with `innerHTML` put back. The overflow menu's open state is kept: the markup does not carry it.
- [x] Remove `restoringFocus` in `src/ui/repository-picker.js` and the focus restore in `checkout.js:62-72` under the same rule. Picker restore removed (two picker tests fail with `innerHTML` put back). `checkout.js` kept: like `restoreFocus`, it is the fallback when the focused checkout control disappears.
- [x] Full check green (74 e2e, 453 unit); complexity before and after: `renderPage` 27 to 23, header `render` 10 to 6, picker `render` 29 to 25.
- Kill per item: if a deletion needs a new special case to stay green, keep that code.

## Phase 3: move open state into `ui` (gated on phase 2)

- [x] e2e: open each menu or `<details>`, trigger an incoming event; assert it stays open with focus inside. Seen failing once its guard is removed. Type menu and scope panel tests are new in `e2e/ui.test.js`; the saved-filter deferral test in `e2e/history.test.js` now asserts the response renders with the menu open (seen failing on main).
- [x] Type filter, saved filters and scope panel rendered from `ui` state, one menu per commit. One new field, `ui.openMenu`. Saved filters and scope panel share a `web.js` hunk, so they landed in one commit. Crossing the mobile breakpoint clears `ui.openMenu` to keep the old close-on-resize behaviour.
- [x] Delete `deferredSavedFilterRender` and the `interacting` guard list in `src/web.js`. `deferredSavedFilterRender`, its flush and `onClose` are deleted. Kept: the `interacting` list, which guards modal dialogs, in-flight actions and the repository picker, whose host the page markup leaves empty, so none of it is menu state.
- [x] Full check green (76 e2e, 453 unit).
- Kill: if three or more new flags appear, stop and reconsider lit-html for that region only.

## Phase 4: dependencies (added on request, 2026-11-21)

- [x] `npm outdated` and `npm view` show every devDependency at its latest version except prettier (3.6.2, latest 3.10.1); upgrade it, run `npm run format` if its output changed, and run the full check. 3.10.1 re-indents boolean chains in 4 files; `npm outdated` is now empty.
- [ ] CI actions pinned to the latest release SHAs: `actions/checkout` v4.4.0 to v7.0.1 (`3d3c42e5`), `actions/setup-node` v4.4.0 to v7.1.0 (`949feb24`); both CI jobs green on the PR.

## Phase 5: docs

- [ ] `PLAN.md` constraint line updated for the vendored file; vendoring and update rule in `docs/MAINTAINING.md`.
- [ ] README and `docs/screenshots` checked against the result; update only what changed visibly.
- [ ] Remove this plan file.
