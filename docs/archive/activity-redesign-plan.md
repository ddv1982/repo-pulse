# Activity feed redesign: phased plan

Archived on 2026-11-28. One item is open: the owner's review of the before and after screenshots (5.1). The row layout is described in [MAINTAINING.md](../MAINTAINING.md#activity-rows).

Source: three council rounds on 2026-11-28 (Claude Fable 5.2 and Gemini 4 Neon) over the owner's screenshot of the Activity feed. Goal from the owner: keep the information, make it read cleanly, with far fewer date and time stamps. Chosen design: "B · Status cell" with the existing lane tree kept intact and CI trouble on its own line (2B). Mockups (scratchpad, not tracked): `design5-round2.html`, `council-fable-r3/b-tree.html`, `council-neon-r3/b-tree.html`.

Every phase leaves `npm run lint`, `npm run check:types`, `npm test` and `npm run test:ui` green. A behaviour change gets a test that fails first. One PR per phase, merged before the next starts. Per [MAINTAINING.md](../MAINTAINING.md#match-review-to-risk), the layout phases get CI and one review round. The server phase gets the same, because `server/activity-ci-summary.ts` is not on the full-review list.

## Decisions

- [x] D1 Usage period conflict. Decided 2026-11-28: start now. The owner asked for implementation with full send; the redesign is an agreed exception to the no-polish rule.
  Original question: [BACKLOG.md](../BACKLOG.md#usage-period) says the usage period (until 2026-12-07) fixes bugs and adds no new polish, and this plan is polish. The owner must confirm either "start now" or "start after 2026-12-07", and the answer is recorded here.
- [x] D2 Representative row (accepted 2026-11-28 as proposed), agreed before coding per the working agreement. It is PR 21935 merged with three runs, which becomes:
  - left cell: `PR merged` / `CI · 3 runs ›`;
  - line 1: `PR 21935 · DAT-12014: run only the critical tests in the ADF dbt run`;
  - line 2: `feature/DAT-9278-adf-critical-tests → main f8ed0f1e9 · author Jelmer van Amen`;
  - right: `17:24 ↗ ☐`, under the day header `Yesterday · Fri 27 Nov`.
- [x] D3 Layout B: the left cell holds the kind label and CI; the main cell holds the title, the facts line and an optional line 3; the right cell holds the time, the Azure link and Seen.
- [x] D4 The lane tree stays as it is: same lanes, nodes, curves, legend and Open Git Graph link, with no change to `src/activity-tree.ts`. It stays hidden below 640px.
- [x] D5 CI trouble goes on its own full-width line under line 2 (2B). The left cell stays at two lines.
- [x] D6 Within a pipeline, the latest completed attempt decides the result (current behaviour), and while a retry is queued or running the last completed failure stays visible next to it (`server/activity-ci-summary.ts:81`), shown as the failure line plus a running line. In a mixed state every line names its pipeline. A failure fixed by a retry shows as a muted "passed again".
- [x] D7 Unread is shown by a blue tint, a bold title, a blue Seen box and the "N new" pill, with no left bar while the tree shows, because lane 1 and `--info` are the same colour in dark. Below 640px a 2px left bar is added.
- [x] D8 No runtime switch between the old and new layouts: a switch would keep two row renderers alive. Compare by running a phase branch and `main` on two separate writable copies of the same database snapshot (the app locks and writes its data directory), plus the screenshots of P0.2.

## Phase 0: Baseline

- [x] 0.1 Record D1 and D2 above with the owner's answers.
- [x] 0.2 Baseline screenshots of the current feed in demo mode: 360, 640, 1100 and 1265px, light and dark, Activity and Imported history, one row with CI history open. Store them in `test-results/activity-redesign/before/`. Check: the files exist and the list is in the PR description of phase 1.

## Phase 1: Small fixes that do not need the new layout (S)

- [x] 1.1 Reviewer names in the row drop the `[Group]\` prefix, as the detail page does (`src/activity-text.ts` `prVoteChanges`, the same rule as `src/ui/activity-detail.ts:89`). Check: a unit test with `[Cloudforce Team Data]\Cloudforce Team Data Team` fails first, then passes.
- [x] 1.2 Moved to 4b.5 (2026-11-28): the cutout colour can only match a flat row background, and today's rows use gradients over a translucent hover colour. 4b.5 makes the tints flat, so the fix lands there. Cost: the faint dark dots on tinted rows stay until 4b.

## Phase 2: Day headers and clock times in the current layout (M)

- [x] 2.1 `renderTreePassThrough(row)` in `src/ui/activity-tree.ts` draws straight lane segments for the lanes entering a row from above: `through`, plus `node`, `forkFrom` and `mergeFrom` where `up` is true. Check: a unit test over a built tree where every lane crossing the boundary appears once, in its colour.
- [x] 2.2 `group()` in `src/ui/feed.ts` inserts an `li.day` before the first row of each local day ("Today", "Yesterday · Fri 27 Nov", "Thu 26 Nov"), with the pass-through cell built from the row below. It is not sticky, the tree row indexes are unchanged, and the Activity and Imported history groups each start their own headers. Check: an e2e test in demo mode counts the day headers and asserts that no lane breaks. The selector `.with-tree svg.tree` in `e2e/activity-feed.test.ts:12` is narrowed to row cells.
- [x] 2.3 Row times show only the clock. Run times show the clock, plus the date when the run is on another day than its row. The full date stays in the `title`. Check: unit tests for the formatter, with one run on the same day and one across midnight.
- [x] 2.4 Screenshot comparison against 0.2 at the four widths. Check: a visual review in the PR, and lanes continuous across headers at 1100 and 1265px. Done 2026-11-28: the multi-day fixture at 360, 1100 and 1265px (light and dark) next to the demo baseline; lanes run unbroken across every header in both groups, and the e2e test checks the lane sets at 1100 and 1265px.

## Phase 3: CI summary keeps every pipeline's current result (S, server)

- [x] 3.1 `applyCiSummary` keeps the passing results of other pipelines next to a problem, instead of dropping them (`server/activity-ci-summary.ts:125-126`). The headline order is problems first, then passes. `historyCount` counts only the runs that are not in the headline. Only pipelines with a known ID add their pass, and a pipeline with a problem in any phase keeps its passes in the history: runs without a pipeline ID cannot be told apart from retries. Check: a test with dbt-build failed and adf-deploy passed on one merge fails first, then shows both.
- [x] 3.2 A recovered pipeline keeps its "passing again" outcome in the summary, instead of being turned into "passed" (`activity-ci-summary.ts:39`), so the row can say "passed again". Check: a test with failed, then passed on the same sha, gives one result marked as recovered, with the failure only in the history.
- [x] 3.3 Clients that read `ciSummary` still render: the detail page and the CI panel. Check: `npm run test:ui` green, and the detail page of a recovered run in demo shows no regression.

## Phase 4: Row layout B (L, split into PRs 4a and 4b)

### 4a: Structure, facts line and status cell

- [x] 4a.1 Grid from 1100px: `calc(9.25rem + tree width) minmax(0,1fr) auto`. The event column is removed and its content moves to line 2 and line 3. Check: an e2e test measures that the title column is wider than in the baseline at 1100px with 4 lanes.
- [x] 4a.2 Left cell: the kind label (coloured by kind as today), then `CI · N runs ›` in muted text, which opens the run list under line 2. Rows without CI show only the kind. Check: e2e on the demo PR rows.
  Done with the CI fixtures in `e2e/activity-feed.test.ts`, since the demo PR rows carry no CI. N counts every run. Passing results fold into the count; a result with a problem stays in view and the count opens the runs not shown. With nothing more to open, the count is plain text.
- [x] 4a.3 Line 2 grammar, in this order: repository (only when several repositories are shown), `branch → target`, the merge sha once landed, `author X` / `pushed by X` / `requested by X`, then the row summary or vote tally. Check: unit tests for each kind (PR open, PR merged, push, tag, branch created or deleted, CI row).
- [x] 4a.4 Branch names are shortened with an ellipsis, and the full name is in the `title`. Check: an e2e test with a long branch asserts no horizontal overflow at 1100px.
- [x] 4a.5 The node sits on the kind label's first line: `--tree-label-y` is set from the new row padding. Check: the cell-span assertion at `e2e/activity-feed.test.ts:30` keeps passing, and a new e2e assertion that the node's centre is within 2px of the kind label's first-line centre fails first, then passes at 1100 and 1265px.
  The stale offset was exactly 2px out, so a 2px check passed it. The test holds the node to 1px, failed at -2px, and passes at 800, 1100 and 1265px.
- [x] 4a.6 Right cell: the clock time, the Azure link and Seen, top-aligned. Imported rows keep no Seen box. Check: an existing seen e2e test passes, and an imported row asserts that there is no checkbox.

### 4b: Trouble, line 3, colour and widths

- [x] 4b.1 Trouble line (D5): a failing, running, partially succeeded or stale result gets one full-width line under line 2. In a mixed state every pipeline is named ("✕ dbt-build failed · ✓ adf-deploy passed"), and CI notes (revision unknown, retry order unknown, trigger unverified) follow in muted text. Check: e2e rows for failed, running, stale, mixed and noted results.
  Done: `.ci-trouble` under line 2 (and under the vote list when open). A lone result reads `✕ Post-merge CI failed · <pipeline>`; in a mixed state each part names its pipeline. Failures red, runs in progress and partial results amber, passes and notes muted. The run's time moved to the part's title. Covered by the DOM test with mixed, retry, noted, stale and recovered results, and the real-data e2e in `activity-details.test.ts`.
- [x] 4b.2 A recovered run shows "✓ passed again" in the left cell, muted. Phase 3 found that `passing again` is set only for PR validation runs (`server/activity-highlights.ts:277`), also when a pass on a new revision fixes an earlier failure, so the wording is "passed again" rather than "passed on retry". Post-merge retries still show a plain pass. Check: e2e on a demo or fixture row from 3.2.
  Done: the CI count reads `CI · 2 runs · ✓ again ›`, muted, with "passed again" in its title and name, so the left cell keeps two lines (R4). In a mixed state the part reads `passed again`; the run list keeps `passed`.
- [x] 4b.3 Line 3 holds tokens of one shape in a fixed order: updates trail, linked push or linked tag build, fork origin or branch-start note, Load commits. It appears only when it has content. Check: e2e on a row with three extras at once, and on a row with none (no empty line 3).
  Done: `.row-line3` tokens open panels under line 3 through `aria-controls`, as the CI count does. No stored PR has a trail, so the three-token check is a DOM test that gives a fork PR three updates; the e2e uses the awkward-rows fixture (`e2e/fixtures/ui-app.ts`).
- [x] 4b.4 Vote lists: the tally on line 2 opens the named votes under line 2. The names are not repeated on line 3. Check: e2e on an active PR with two votes.
  Done: line 2 is now a sibling of the title button. The button's name is the title, line 2 is its description, and a click on line 2 still opens the detail. The tally counts each vote kind (`1 approval, 1 waiting for author ›`) and is amber or red only for a vote that asks for changes.
- [x] 4b.5 Colour (D7): kind labels keep their tone. Passing CI and approvals are muted. Only failures, running and warnings are coloured. Unread gets the blue tint and a bold title, with no left bar from 640px. Row tints become flat colours in a `--row-bg` custom property, and ring cutouts and node strokes in `web/styles/activity-tree.css` use `var(--row-bg)` instead of `var(--card)` (from 1.2). Check: e2e computed colours on one row of each state, both themes, and an unread row's `.hole` fill equals its background, failing first.
  Done: `--row-unread` and `--row-failed` in `tokens.css` per theme (light failed tint 5%, the others 7 to 8%), hover mixes 4% foreground into the row's tint. Light mode lost its inset bar and its bold titles on every row, so bold means unread in both themes. A completed PR link on line 2 and passing runs in the run list are muted. The glass theme styles only chrome, so rows keep the opaque card.
- [x] 4b.6 Rare pieces each get a place, checked against the inventory (`src/ui/feed.ts`, `merge-evidence.ts`, `linked-*.ts`, `activity-trail.ts`):
  - the merge evidence badge (line 2, the rewrite warning coloured);
  - the `ciHost` "View pull request" link (trouble line);
  - "View all CI runs" (run list);
  - the "N new" pill (line 1);
  - the PR chip on CI rows (line 2);
  - branch-start notes (line 3).

  Check: the demo data or fixtures cover each one, and an e2e test asserts that each is present.
  Done: `each rare piece of a row has its place` (awkward-rows fixture) plus View all CI runs in the highlights test. The rewrite chip is outlined amber.
- [x] 4b.7 The legend strip: "Mark all matching seen", the lane key toggle and Open Git Graph share one top line, keeping the DOM that `e2e/dom/presentation.ts:365` and `e2e/git-graph.test.ts:62` expect. Check: those tests pass unchanged.
  Done: `.feed-top` holds `.feed-actions` and the guide; `e2e/dom/presentation.ts` and `e2e/git-graph.test.ts` pass unchanged.
- [x] 4b.8 640 to 1099px: the tree is in the left padding, kind and CI are top left, time and actions top right, with the main cell below. Below 640px: no tree, the kind glyph is shown, kind and time share the top line, Seen is 16px and unread has a 2px bar. Check: e2e at 360 and 800px, with no horizontal overflow.
  Done, plus the 4a gap: a row without an Azure link or Seen toggle keeps an invisible copy of it, so times line up at every width. Below 640px the Seen toggle shows only its 16px box and keeps its full name for screen readers.

### 4b review fixes

- [x] R1 At 360px the vote tally wraps and the vote list shrinks, so neither is clipped by the row. Check: e2e measures both inside the row at 360px, failing first.
- [x] R2 An unread failed row keeps the unread tint; a seen failed row keeps the red one. Check: e2e computed backgrounds of both, failing first.
- [x] R3 Origin notes stay on line 3 when the row has no summary. Check: the demo hotfix assertion moves to line 3, failing first.
- [x] R4 A recovered run keeps the left cell at two lines: the recovery mark joins the CI count. Check: e2e line count of the status cell at 1265px, failing first.
- [x] R5 A pipeline that appears in two phases on one trouble line names its phase. Check: a DOM test, failing first.
- [x] R6 Tree cutouts and the row background change colour together on hover. Check: the row has no background transition.
- [x] R7 The trouble line's title test names the run's exact time.
- [x] R8 Find why the full e2e run times out in `e2e/checkout.test.ts` on this branch and not on main. Check: timings from full runs on both.
  Found 2026-11-28: not this branch. Under the same machine load main failed the same test (2 of 3 full runs, plus Git Graph and Repositories once), at the same 5-second steps. Each e2e file alone takes 227 s wall and 121 s user CPU in total on main, 223 s and 113 s on this branch; `checkout.test.ts` alone takes 33.8 s and 34.3 s. With the load average near 4 the branch passed 192 of 192 twice.

## Phase 5: Verify and close

- [x] 5.1 Screenshots of the new feed in `test-results/activity-redesign/after/`, at the widths and themes of 0.2. Done 2026-11-28: the demo at 360, 640, 1100 and 1265px in both themes, next to `before/`. Like the baseline, they show Imported history closed and no CI history open; those states are covered by the phase 4 screenshots and e2e tests.
  - [ ] The owner reviews the before and after comparison. Open: requested in the final report.
- [x] 5.2 One run on a `VACUUM INTO` copy of the live database in the scratchpad, at 1265px, with the copy deleted afterwards. Check: count timestamps on the first screen against the 13 of the owner's screenshot, and read the rows for clipped or missing pieces. Done 2026-11-28: on a copy of the live database at 1265px, the first screen shows 8 clock-only times under the Today and Yesterday headers, against the 13 dated ones in the owner's screenshot. The page has no horizontal scroll, and PR 21935 reads as D2 describes. The copy was deleted.
- [x] 5.3 `docs/MAINTAINING.md` describes the row layout and the day headers. `docs/BACKLOG.md` drops this item. This plan moves to `docs/archive/`. Check: the link probe finds 0 broken links. Done 2026-11-28: `docs/MAINTAINING.md` has an Activity rows section, the backlog item is removed, and this plan is archived.
- [x] 5.4 The README screenshots (`docs/screenshots/activity-light.png` and `activity-dark.png`, 1280px demo) are retaken with the new feed, plus `pr-detail-*` if the detail page changed. Check: the README images show day headers and the new row, viewed in both themes. Done 2026-11-28: `activity-light.png` and `activity-dark.png` were retaken at 1280px from a fictional two-day feed (en-GB, demo banner hidden), and the README alt text was updated. Phase 1 moved the detail page to the shared reviewer-name helper with the same output, so `pr-detail-*` still matches and stays.

## Not doing

- Folding a PR's milestones into one row: it changes Seen and the lane graph, and is a separate decision.
- Relative times ("19h ago").
- Sticky day headers.
- Any change to `buildActivityTree`.
- A runtime layout switch (D8).
