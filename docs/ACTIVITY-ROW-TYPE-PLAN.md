# Activity row type and alignment plan

Goal: every Activity row reads on one shared line rhythm. The ref line (column 2, line 2) sits on the same baseline as the meta line (column 3, line 2), the row's sizes form one clear scale, and the agreed wording fixes land.

Council (Claude Opus 5.5, Claude Fable 5.2, GPT Sol 6.2) measured the demo in Chromium. Today no row aligns: the meta baseline is 3 to 4px below the ref baseline on one-line rows, 16 to 17px above it when the title wraps, and about 20px above it when column 3 has no summary. Font size is not the cause (both lines are 12px). Line heights (18 vs 20), top margins (2 vs 4) and the two columns flowing independently are.

Scope: Activity rows (`src/ui/feed.js`, `src/activity-text.js`, `web/styles/feed.css`, `web/styles/tokens.css`) and the header scope label (`src/ui/header.js`). `.subref` is also used on the Repositories page (`src/ui/checkout-render.js:223`), so row CSS is scoped to `.feed-title .subref`.

## Phase 0: measurement check first

- [x] Add an e2e check at 1280px: for every demo row with a ref line, the ref baseline and meta baseline differ by at most 1px, and title and summary share a top. Run it on main and show it failing.

## Phase 1: wording (must-have)

- [x] New branch rows with a known fork point show "Started at <sha>, the tip of <base>" as the column 3 top line, in the summary style (13px, foreground, no branch icon), with the meta line below. Listed-only branches keep their caveat. Unit test fails first.
- [x] The push that creates a branch says "Tip at <sha>" instead of "New branch at <sha>" (not "Now at", which reads wrong on an old row). Unit test fails first.
- [x] The header says "1 repository" when exactly one repository exists; "All N repositories" stays for N > 1. Unit test fails first.
- [x] Update affected e2e strings; `npm test`, `npm run test:ui` pass.

## Phase 2: one 20px line rhythm (must-have, CSS)

- [ ] Ref line: 12/20, items baseline aligned (branch, repo token and PR chip share a baseline), 2px gap above it, matching the meta line.
- [ ] Meta line, origin notes and update trail: 12/20 with the same 2px gap (meta loses `.help`'s 4px).
- [ ] PR chip 11px to 12px; chips inside the summary line held to a 20px line (no 22px growth).
- [ ] Type label and Azure/Seen centred on the title's first line (label box to 20px, control offset), tree dot offset adjusted so the existing tree geometry test passes.
- [ ] Phase 0 check passes for every one-line-title row with a summary; screenshots light and dark at 1280 and 390 show stacked spacing unchanged.

## Phase 3: column balance (must-have)

- [ ] Swap the subject/event split from 1.3fr/1.7fr to about 1.7fr/1.3fr with a minimum event width, so PR titles and multi-repo ref lines wrap less. Verify at 1024 and 1280: count wrapped titles before and after, meta lines do not wrap for demo names.

## Phase 4: shared row tracks (decision gate)

- [ ] From 1024px up, give `.row` row tracks shared through subgrid by the subject, title button and event; wrap origin notes and trail in one `.event-notes` element in track 3. Fix the three prototype defects: `.event-main` aligned to start, origin note not auto-placed into an empty first cell, chips not stretching track 1.
- [ ] Phase 0 check passes for every row, including wrapped titles, rows with no summary and multi-repo ref wraps.
- [ ] Gate: screenshots before and after this phase. Wrapped-title rows gain a blank line between summary and meta; keep this phase only if it reads better after phase 3, and attach both screenshots to the PR so the owner can overrule. Check Firefox and WebKit if available.

## Phase 5: finish (nice-to-have)

- [ ] Below 640px, centre the type label against the Seen control (6px off today).
- [ ] Trial a softer summary colour (`--foreground-soft`, the actor's existing mix, as a token) so the summary does not compete with the title. Keep it only if light and dark screenshots read better; otherwise record why it was dropped.
- [ ] Refresh `docs/screenshots/activity-{light,dark}.png` and any README wording that changed.
- [ ] Full gate: `npm run check`, `check:types`, `lint`, `test`, `test:ui`.

## Out of scope

- Commit messages as push titles (the pushes API we call returns no commits).
- Monospace commit ids in column 3 (needs structured summaries).
- Font-size tokens (the CSS uses literal sizes throughout).
