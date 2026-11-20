# Drop Mark shown seen plan

Goal: one bulk action everywhere. New updates loses `Mark shown seen`; `Mark all seen (N)` (or `Mark all matching
seen (N)`) is the only bulk action. Requested by the user on 2026-11-20 after PR #76.

## Decisions

- D1 Remove the `Mark shown seen` button, its `ack-shown` action and its live label update. Keep the per-row Seen
  toggle and Undo unchanged.
- D2 `Mark all seen` skips the confirmation when every update it would mark is on screen (none below the shown rows),
  so a short New updates list clears in one click, as `Mark shown seen` did. When some are below the shown rows it
  still confirms and says how many. Undo covers both.
- D3 Tests that used `Mark shown seen` to exercise shared behaviour (250-ID batches, partial failure, Undo retry,
  arrivals during a write, filtered group members, held state refresh) move to `Mark all seen`. The test of a
  DOM-derived ID race that only `Mark shown seen` had is removed, because the snapshot (`through`) now covers that race
  and has its own test.
- D4 README and docs/COVERAGE.md describe one bulk action; the README screenshots are regenerated (they still show the
  pre-#76 summary and button).

## Steps

- [x] S1 e2e: New updates has no `Mark shown seen`; with every unread update on screen, `Mark all seen (N)` marks them
  without a dialog. Watched failing first.
- [x] S2 Remove the button and action (D1) and skip the dialog when nothing is below (D2).
- [x] S3 Migrate the existing tests (D3); full checks pass.
- [x] S4 README, docs/COVERAGE.md and both README screenshots updated and reviewed.
