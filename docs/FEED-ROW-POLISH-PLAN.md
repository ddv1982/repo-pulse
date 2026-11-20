# Feed row polish plan

Goal: make the Activity row's second subject line and its event column easy to
scan. The subject's second line says where (repo, branch, PR). The event column
says what happened, then who and when. No data model or server changes; stored
titles (including the CI `pipeline · buildNumber` title) stay as they are.

Each phase ends with `npm test`; phases that touch markup also run
`npm run test:ui` and a visual check with `npm run demo` in light and dark at
1280px and 390px wide. A new or rewritten test is watched failing before the
change that makes it pass.

## Phase 1: repo name only when several repositories are shown

- [x] Add a presentation test: one shown repo renders no repo name in the row's
      second line; two shown repos do. Watch it fail.
- [x] Pass `showRepo = shown.length > 1` (the selected scope from
      `renderFeed`, `src/ui/feed.js:132`, not the rows on the current page)
      through `historyGroups()` and `group()` into `row()`.
- [x] Update `test/presentation.test.js:404-405` and
      `e2e/ui.test.js:1607` to the new text.
- [x] Confirm `test/escaping.test.js` still sees the `repo.name` probe in a
      one-repo feed (via the status banner) or extend its fixture to two repos.
- [x] Run `npm test` and `npm run test:ui` (includes `e2e/ui.test.js:220,248`,
      which select `.subref` by repo name in multi-repo views).

## Phase 2: repo, branch and PR as separate tokens

- [x] Change `activityRef` (`src/activity-text.js:196`, only caller is
      `feed.js`) to return `{ branch, pr }` instead of a joined string.
- [x] Render up to three spans inside `.subref`: `.ref-repo` (sans, 12px,
      weight 500, muted), `.ref-branch` (`icons.branch` 12px, aria-hidden,
      plus monospace name), `.ref-pr` (compact `.chip`, `PR 21431`, tabular
      numerals). Drop the ` / ` and ` · ` separators in favour of a flex gap.
      Tokens stay non-interactive inside the detail button.
- [x] Add `.sr` words between tokens ("repository", "branch") so the button's
      accessible name still starts with the title.
- [x] CSS scoped to `.feed-title .subref` so the checkout panel's `.subref`
      (`src/ui/checkout-render.js:223`, `web/styles/repositories.css:111`) is
      unchanged. Tokens wrap to the next line as whole units
      (`flex-wrap: wrap`); a single token wider than the column ends in an
      ellipsis and the branch keeps its full name in `title`.
- [x] Token-level unit tests replace the flat-string assertions; rewrite the
      `e2e/ui.test.js:1607` assertion per token.
- [x] Visual check: the long branch from the screenshot with a PR chip, in a
      multi-repo view, at 1280px and 390px, both themes; checkout panel
      unchanged.

## Phase 3: drop the branch token when the title already names it

- [x] Unit tests per kind: push, branch-created, branch-deleted and tag rows
      whose title contains the branch render no `.ref-branch`; PR and CI rows
      always keep it (a PR titled "Fix main menu" from branch `main` still
      shows `main`). Watch them fail.
- [x] Rule in `row()`: omit the branch when the kind is not `pr` or `build`
      and the title contains `branchName(record.branch)`. Omit `.subref`
      entirely when no tokens remain.
- [x] Run `npm test`, `npm run test:ui`; visual check of push and branch rows.

## Phase 4: event column in tiers

- [x] `.event-main`: the `rowSummary` text, then `mergeEvidenceBadge` chips in
      a wrapping flex row with a gap (today the badge touches the text).
- [x] `.event-origin`: the tree's `forkText` (for example "Started at 3f9a2c1,
      the tip of main") on its own muted line with the branch glyph, below
      who and when, instead of trailing the time.
- [x] `.event-meta` (who and when) holds only `role actor · time`, with the
      name in medium weight. Every kind gets a role label, not only PR and
      push: "Created by" (PR), "Requested by" (CI run, Azure's
      `requestedFor`), "Pushed by" (push, branch, tag). An actor of
      `Unknown` keeps showing without a role label. Drop the actor only when
      the title already starts with it ("X pushed to …"); keep it for
      "Push to main · Linked PR #12" (`e2e/history.test.js:505`).
- [x] `<time>` gets a `title` with the full date including the year;
      `dateTime()` itself is unchanged.
- [x] A row with no summary (CI run, unknown trigger) aligns its meta line
      with the title instead of floating.
- [x] Update `test/presentation.test.js:464` and `test/escaping.test.js:412`
      (both expect the summary directly after `<div class="event">`).
- [x] Run `npm test`, `npm run test:ui`; visual check of the Failed row, a
      row with a merge chip and a row with an origin line at 390px.

## Phase 5 (optional, decide after phase 4): PR detail in the event column

- [ ] Vote changes as one item per reviewer with `voteLabel` words
      ("Ana approved"), status tone as a redundant cue only.
- [ ] "From fork X" moves from the summary prefix to the origin tier, while
      `activitySummary` keeps returning the same string for detail and search.
- [ ] Unit tests for both; `activitySummary` assertions in
      `test/presentation.test.js` pass unchanged.

## Phase 5b: redacted names in the demo data

Requested during implementation so the README screenshots show no
person-like names.

- [ ] In `server/demo.js`, replace each person with `Redacted N`, one number
      per person used consistently in actors, reviewer votes, `closedBy` and
      titles: Sam Ortega → Redacted 1, Priya Nair → Redacted 2,
      Lars de Wit → Redacted 3, Demo developer → Redacted 4.
- [ ] Update the e2e assertions that name them (`e2e/ui.test.js:1437-1438`).
- [ ] Run `npm test` and `npm run test:ui`; grep confirms no old names remain
      in `server/demo.js` and `e2e/`.

## Phase 6: screenshots

- [ ] Regenerate `docs/screenshots/activity-dark.png` and
      `activity-light.png` from `npm run demo`.
- [ ] Update README.md wherever it describes the row layout or the
      repository / branch line.

## Out of scope

- Shortening CI titles to `Run <number>` when the pipeline name equals the
  repo name (Sol): loses the pipeline identity when a repo has two pipelines.
- Relative times: need a re-render ticker and make tests time-dependent.
- Swapping the 1.3fr/1.7fr subject/event grid widths at 1024px and up.
- Hiding "Branch starts at X" when the origin line says the same thing.
