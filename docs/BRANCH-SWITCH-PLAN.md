# Branch switch plan

Goal: let the user switch the linked checkout to `main` (and other watched branches) from the places where a branch is
clearly named: Activity details and the Repositories page. Council: Claude Opus 5.5, GPT-6.2 Sol, Gemini 4 Neon,
2026-11-20.

## Findings

- `activityBranch` (`src/activity-branch.js:4`) names a branch only for `branch-created` and for a `push` with exactly
  one ref update to a live commit. The client (`src/ui/activity-detail.js:200`, `src/web.js:163`) and the server
  (`server.js:487`) both use it. `test/activity-branch.test.js:16` asserts that a PR gives `null`.
- Events tied to `main` in a read-only copy of the live database: 79 single-ref pushes (button shown), 79 completed
  PRs, 113 active PRs, 4 abandoned PRs and 127 builds (no button). The tree draws a completed PR and a build on the
  `main` lane (`src/activity-tree.js:150`), but the detail page gives no switch. This is the gap the user hit.
- A push that updates `main` and deletes the source branch in one push has two ref updates, so it gives `null` too.
- When the checkout is already on the branch, the button reads "View in Repositories" (`activity-detail.js:203`).
  That is correct but can read as "not possible".
- The tree lanes are an `aria-hidden` SVG with no pointer events. Rows only open the detail page (`src/ui/feed.js:67`).
- The server switch (`server/checkout-activity-switch.js:211`, `switchAt`) already checks everything by branch name:
  ref format, symbolic refs, upstream source and fetch mapping, live `ls-remote`, rewrite and divergence review with an
  HMAC token, occupied worktrees, and checkout identity under the lock. The event ID only feeds the token
  (`:205`). A branch-name entry point can reuse it unchanged.
- The Repositories checkout status re-renders every few seconds (`src/ui/checkout.js:51`). An open `<dialog>` pauses
  background refresh (`src/web.js:208`), so a picker belongs in a dialog, not inline in the status block.
- Stored `ref` entities (`server/normalize.js:415`) list each repository's watched branches with no Azure or Git call.
  No default branch is stored.

## Decisions

- D1 Activity names a branch for:
  - a completed PR, which gives its target (`main`);
  - a build on `refs/heads/*`, which gives that branch (`refs/pull/*` gives none);
  - a push with exactly one live `refs/heads/*` update, with deletions ignored.

  Abandoned PRs, tags, deletions and pushes that update several branches still give none.
- D2 (approved 2026-11-20): an active PR from the same repository gives its source branch, so a reviewer can
  switch to it. Opus and Neon include it; Sol defers it. Fork PRs give none.
- D3 The button names its target: "Switch to main…". A completed PR otherwise gives no hint whether it means source or
  target.
- D4 Repositories gets a "Switch branch…" button beside the current branch. It opens a dialog with:
  - a filter box;
  - `main`/`master` pinned first, then the other branches newest first;
  - each branch marked Current (disabled), Local or Remote only.

  The list comes from stored active refs, plus one local `git for-each-ref refs/heads` read for the Local mark. A
  choice runs the same confirm and review flow as Activity, then stays on Repositories and focuses the checkout.
- D5 The server accepts a branch name only when the repository has an active stored ref `refs/heads/<name>` (an
  allowlist, the same guarantee event anchoring gives). It then calls `switchAt`. The review token binds the operation,
  so a token from one entry point cannot confirm the other.
- D6 No switch control on feed or search rows, tree lanes, demo mode, or unlinked or disabled repositories. The detail
  page is one click away, and a Git write from a dense list invites misclicks.

## Phases

Each phase starts with a test seen failing and ends with `npm test`, `npm run check:types` and `npm run lint`.

### Phase 1: Activity names `main`

- [x] Tests in `test/activity-branch.test.js` for completed PR to target, build on `refs/heads/main`, build on
      `refs/pull/1/merge` (null), push of `main` plus a source deletion, push of two live branches (null), abandoned
      PR (null), and tag (null). Then extend `activityBranch`.
- [x] Server test: a completed-PR `eventId` reaches `switchToActivityBranch` with `main`, and a client-sent branch is
      still ignored.
- [x] D2: active same-repository PR gives its source branch, fork PR gives none.
- [x] Button label "Switch to <branch>…" (D3). Check: `test/presentation.test.js` or render test, and
      `npm run test:ui`.

### Phase 2: switch by branch name on the server

- [x] Tests for `operation: 'switch-branch'`:
  - 400 for a name with no active stored ref, and for an inactive ref;
  - 403 in demo mode;
  - success with the right name;
  - a review token from `switch-activity` is refused.

  Then implement it in `server.js` reusing `switchAt`, and bind the operation into the token.
- [x] Branch list endpoint `GET /api/repos/:id/checkout/branches`. It returns the stored active refs, pinned
      `main`/`master` first, then newest first, each marked local or not. The picker marks the current branch from the checkout status it already holds. Check: tests for order, marks, an
      inactive ref left out, and the demo and unlinked refusals.

### Phase 3: Repositories picker

- [x] Move the Activity confirm and review flow in `src/ui/checkout-actions.js` into one shared function. Check: the
      existing Activity switch tests and e2e pass unchanged.
- [x] Branch dialog and "Switch branch…" button, hidden for demo and for unlinked, unavailable, detached and
      in-progress checkouts. Check: e2e covering filter, keyboard, Current disabled, a clean switch, the divergence
      review confirm, focus return on cancel, and phone width.
- [x] Run the app on a temporary Git fixture and switch to `main` from both entry points. Check: screenshot and the
      checkout status read back.

### Phase 4: docs

- [x] Update the switch text in `README.md` and `docs/COVERAGE.md`, and refresh the screenshots if the Repositories
      card changed. Check: read back. The screenshots show demo Activity, which has no checkout, so they did not change.

## Out of scope

- local-only branches with no watched remote;
- switching from detached HEAD;
- creating branches;
- stash or force options;
- pull as part of a general switch;
- reading the default branch from Azure;
- links from multi-branch pushes to the picker;
- interactive tree lanes.
