# Fork evidence backfill plan

Goal: check the branch creations already stored, so the tree stops showing the dotted "origin not checked" line for
most rows, and decide the two other follow-ups from data. Follows [FORK-EVIDENCE-PLAN.md](FORK-EVIDENCE-PLAN.md).

## Findings (live database, read-only, 2026-11-20)

- 95 `branch-created` rows. In the enabled repository: 16 live and 61 imported push creations without a result, 1
  checked, 1 snapshot. In the 3 disabled repositories: 1 live and 14 imported push creations without a result.
- Every imported row comes from the first sync's 7-day import (baseline minus 7 days to baseline). There are no rows
  from an explicit history import.
- Excluding imported rows would leave 61 of the 77 unchecked creations in the enabled repository dotted. The earlier
  copy run that resolved 69 of 77 with 206 reads covered both groups, so its "77 live branch creations" wording in
  FORK-EVIDENCE-PLAN.md is wrong: 16 were live and 61 imported.
- A late pull request: 81 of 93 push creations have a PR, and the first PR row is often stored after the creation
  (live: up to 25 hours later). But in 81 of 81 the PR target is the repository's most common target, which is
  already a candidate. A re-check on PR arrival would change no row today.
- Default branch: the most common PR target is `main` in 4 of 4 repositories (109 of 114 PRs in the enabled one).

## Decisions

- Backfill: do, including the first sync's import window. A push missing before that window leaves the parent with no
  recorded tip, so the claim fails safe ("no branch match found") instead of going stale. History import stays
  excluded: its older pushes arrive after its newer ones, and its volume is unbounded.
- New repositories and "Start from scratch" queue checks for their first-sync import too, so stored rows and new rows
  follow one rule (`!state.historical` instead of `!event.imported`).
- No new pacing. The backlog is about 250 reads, once, in the same one-call background turns history import already
  uses. The copy run in phase 2 measures sync lag; pacing is added only if that run shows live streams falling behind.
- Re-check on PR arrival: skip. Revisit when a repository's PRs often target a branch other than its most common target.
- Default branch: skip. Revisit for a repository with no stored PRs.

## Phases

Each phase starts with a test seen failing and ends with `npm test`, `npm run check:types` and `npm run lint`.

### Phase 1: check first-sync imported creations from now on

- [x] Export a `forkJob(event)` builder from `server/fork-origin.js` and use it in `server/normalize.js`, so the
      job shape is defined once.
- [x] Queue fork jobs for branch creations on any page that is not a history import (`!state.historical`). Check: split
      "imported branch creations are never checked" in `test/fork-origin.test.js` into a first-sync import that is
      checked (fails today) and a history-import page that queues no fork job.
- [x] Update the "Branches the check did not cover" bullet in `docs/COVERAGE.md`.

### Phase 2: migration 15 queues the stored creations

- [x] Add store migration 15: for every repository, insert a fork job with `INSERT OR IGNORE` on `fork:<eventId>` for
      each push `branch-created` row with a valid tip and push ID, no `forkOrigin`, that is live or imported at or after
      its repository's baseline minus 7 days. Check: a v14-to-v15 migration test in `test/store.test.js` with a live row,
      a checked row, an imported row inside and one outside the window, a snapshot row and a malformed row; only the
      first and third get jobs, and reopening adds none.
- [x] Run the migration on a copy of the live database and count the queued jobs (expected 92: 77 enabled, 15
      disabled). Then tick the real check on that copy with real Azure reads and record the status counts, the read
      count and how far the live streams fell behind.
- [x] Correct the "77 live branch creations" wording in `docs/FORK-EVIDENCE-PLAN.md`.

### Phase 3: record the skipped follow-ups

- [x] Add the late-PR and default-branch measurements with their revisit triggers to `docs/FORK-EVIDENCE-PLAN.md`.

## Risks

- Up to about 5 imported rows whose candidates have no recorded tip move from the dotted line to "no branch match
  found".
- New live creations wait a few minutes behind the backlog, once.
- `demo.sqlite` runs the migration too; demo branch rows that qualify get jobs that never run, because demo mode has no
  Azure client.

## Out of scope

Re-checking on PR arrival, reading the default branch, snapshot-discovered branches, local clones, pacing unless phase 2
shows it is needed.

## Result (2026-11-20)

The real app in live mode on a copy of the live database queued 92 jobs (77 in the enabled repository) and drained
the 77 in 280 seconds with no live stream overdue (maximum delay 0 ms), so no pacing was added. Results: 46 tip
matches and 23 contained, all solid; 1 tie, 1 not on the PR target, 2 with no checkable candidate and 1 merge, all
without a line; 3 unknown.
