# Feed row consistency plan

Goal: every row that belongs to a branch shows that branch the same way, as the monospace token on the line under the
title, and every row names its actor in the who-and-when line. Council (Fable 5.2, Opus 5.5, Sol 6.2) agreed on the
shape; this plan takes the Opus/Sol variant for the actor.

Interpretations:

- Rewrites happen at render time in the feed only. Stored titles, search, the detail page `h1` and the Seen button's
  accessible name keep the full title.
- The feed title for push, branch-created and branch-deleted rows is the stored title with a trailing ` to <branch>` or
  ` · <branch>` removed and a leading `<actor> ` removed, first letter upper-cased. A title that is only the branch name
  falls back to the row label. Titles that name several branches stay as they are, and the existing whole-word guard
  keeps the token hidden for them.
- A linked-PR push title becomes `Merge of PR N pushed to <target>`, so the same suffix rule applies and the PR is no
  longer written `Linked PR #N`.
- Short commit ids in row summaries use 7 characters, the length already stored by the server.

## Phase 1: branch token and actor on every branch row

- [x] Failing unit tests: push, branch-created and branch-deleted rows show the branch token, a title without the branch
      and without the actor, and `Pushed by <actor>` in the meta line; multi-branch push keeps its title and no token
- [x] Implement the feed headline in `src/ui/feed.js` (`row`), keep `activityTitle` for detail and aria-label
- [x] Linked-PR push title `Merge of PR N pushed to <target>` in `activityTitle`, tests updated (unit and e2e)

## Phase 2: column 3 wording

- [x] Failing tests: `New branch at <7 chars>` replaces `Branch starts at <8 chars>`; tag summaries use 7 characters
- [x] Failing test: push-evidence branch-created and branch-deleted rows have no echo summary ("New remote branch",
      "Remote branch deleted") in the feed row; listed-evidence rows keep theirs
- [x] Implement in `src/activity-text.js` and `rowSummary`

## Phase 3: PR chip stays with the branch

- [x] Branch token and PR chip share one non-wrapping group; the branch name ellipsizes first. Verified in the browser
      at 1280px and 390px with one and three repositories

## Phase 4: proof and docs

- [ ] `npm run check`, `check:types`, `lint`, `test`, `test:ui` green
- [ ] Screenshots of the demo in light and dark, desktop and 390px; README screenshots refreshed if rows changed
- [ ] Remove this plan once every item is ticked
