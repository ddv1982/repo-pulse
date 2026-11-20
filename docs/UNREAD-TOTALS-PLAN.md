# Unread totals plan

Goal: after marking the newest rows seen, the user can see what is still unread and clear it with one obvious action.
Follows the 2026-11-20 council (Claude Fable 5.2, GPT-6.2 Sol, Gemini 4 Neon), using Fable's recommendation.

Reported case: All activity, the newest 50 rows marked with Mark shown seen. The headline then read `0 new items shown`
while 235 older events stayed unread, and New updates listed them 50 at a time.

## Decisions

- D1 Unread stays per event. No watermark, no schema change. Unread totals never depend on paging.
- D2 The summary headline and the four tiles count every unread item in scope (`newItems`, `newUpdates`, `newCounts`
  from the server), not the loaded rows. `Showing X of Y items` stays as the paging hint.
- D3 Tile sub-lines: Branches (`N new · N deleted or unlisted`) comes from `newCounts`. The CI status line (running,
  queued, failed) only exists for loaded rows, so it shows only when every unread CI row is loaded.
- D4 One bulk catch-up button, `Mark all seen (N)`, or `Mark all matching seen (N)` when a repository subset, type or
  search is applied. N is `newUpdates`. It comes first in both views and is hidden at 0.
- D5 All activity drops `Mark shown seen`. New updates keeps it, after the catch-up button.
- D6 The catch-up marks only events recorded up to the page's snapshot (`asOf`, the `activity_members.sequence` the page
  was read at). Events recorded later, even with an older `time`, stay unread.
- D7 The confirmation names how many are below the shown rows and that later updates stay unread. Failed CI is not
  exempt. Undo restores the exact IDs, as today.
- D8 Out of scope: tab rename, watermarks, marking seen on view or scroll, sort/grouping/page size, server-side CI
  status counts.

## Batch 1: true totals

- [x] B1.1 Unit test: in the reported case (53 newer seen, 235 older unread) `queryActivity` totals are the same on
  page one and after a cursor page, in both views. Shown failing only if it fails today (it is a guard).
- [x] B1.2 Headline and tiles use the server totals (D2, D3). Presentation tests watched failing first.
- [x] B1.3 e2e: 150 unread in New updates; after Mark shown seen (50) the headline and Pushes tile read 100.
- [x] B1.4 Checks pass; screenshots of the reported case reviewed.

## Batch 2: one catch-up action with a snapshot

- [x] B2.1 Server returns `asOf`; `/api/activity/unseen` accepts `through` and excludes later events. Unit tests
  watched failing first, including a late event with an older `time`.
- [ ] B2.2 Bulk bar per D4 and D5; the dialog per D7.
- [ ] B2.3 e2e reproducing the reported case: All activity shows `Mark all seen (288)` before marking the top rows and
  `Mark all seen (235)` after; Load more keeps 235; confirm gives `No new updates`; Undo restores 235; an event
  recorded after the page loaded stays unread.
- [ ] B2.4 Existing e2e and README updated; full checks pass; screenshots reviewed.
