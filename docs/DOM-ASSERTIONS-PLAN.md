# UI test assertions plan

Goal: UI unit tests check what a reader sees (text on the element that should hold it, elements found by selector) instead of matching rendered HTML with regular expressions, so harmless markup changes stop breaking tests while real regressions still do.

Scope: the three test files that render UI: `test/merge-ui.test.js`, `test/sync-status-ui.test.js`, `test/presentation.test.js`. `test/escaping.test.js` stays exact on purpose. Regex checks on server, CLI and git text in other files are out of scope.

## Step 1: helper, rules and guard

- [x] Add `linkedom@0.18.15` as an exact dev dependency; the app keeps no runtime dependencies.
- [x] Add `test/fixtures/dom.js` with `parse(html)`, `row(doc, id)`, `text(el)` (visible text, whitespace normalised, `.sr` left out) and `srText(el)`; unit test the helper itself.
- [x] Write the rules in `docs/MAINTAINING.md`: text on the element that should hold it; selectors for presence (including `data-action`); exact matches only for escaping and safety attributes (`href`, `title`).
- [x] Add an ESLint `no-restricted-syntax` rule for the migrated files that rejects regex literals containing markup (`class="`, `<div`, `<span`, `<li`, `<path`, `<circle`). Show it firing on a sample.

## Step 2: migrate, proving coverage per file

For each file: record which code each test protects, apply scripted mutations to that code, and show the old and new tests both fail on each mutation; keep or raise the assertion count per test.

- [x] `test/merge-ui.test.js` migrated, mutations shown failing before and after.
- [x] `test/sync-status-ui.test.js` migrated, mutations shown failing before and after.
- [x] `test/presentation.test.js` migrated, mutations shown failing before and after.
- [x] Lint guard enabled for all three files.

## Step 3: finish

- [x] Full gate: `npm run check`, `check:types`, `lint`, `test`, `test:ui`.
- [x] Re-read this plan; list anything unchecked.
