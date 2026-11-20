# UX polish plan

Goal: act on the 2026-11-20 council UX review (Claude Opus 5.5, Claude Fable 5.2, GPT-6.2 Sol) of the Activity feed and
its surroundings. Polish only, no new features.

## Decisions

- D1 The per-row status column (`New` / `Seen` / `2 new` / `History`) goes. Unread state moves onto the row: only
  unread rows get the wash (failed CI keeps its red), unread titles are bold, and a `N new` pill follows the title when
  a grouped row has more than one unread update.
- D2 The per-row seen button becomes a constant-label toggle `Seen` with a box (empty when unread, ticked when seen),
  `aria-pressed`, and the accessible name `Seen: {title}`. The detail page keeps `Mark seen` / `Mark unseen`.
- D3 Focus stays on the toggle after it is used. In New updates, where the row leaves, focus moves to the next row's
  toggle, else the previous one.
- D4 The search help is one line: `Commas match any term · people:Ali, Jo searches names only`. No info icon.
- D5 The bulk label `Mark shown seen (N)` keeps its wording (it pairs with `Mark all matching as seen`); only its
  position changes.
- D6 Out of scope: the mobile header rework (council item 7, effort M) and new search features such as token chips.

## Batch 1: the three questions

- [x] B1.1 Row wash shows unread state only (failed CI stays red); unread titles are bold.
- [x] B1.2 Status column removed at all widths; `N new` pill beside the title when more than one unread update.
- [x] B1.3 Seen toggle replaces `Mark seen` / `Mark unseen` in rows, with `aria-pressed` and an id.
- [x] B1.4 Focus returns to the toggle in All activity and moves to a neighbour in New updates.
- [x] B1.5 Search help shortened to one line.
- [x] B1.6 e2e covers B1.3 and B1.4; full checks pass; screenshots reviewed (light, dark, 390px).

## Batch 2: summary and list structure

- [x] B2.1 Summary headline stops repeating the count: drop `Showing X of X` when equal, drop the totals line when it
  equals the headline, drop the repository count already shown in the header.
- [x] B2.2 Bulk seen actions sit above the rows instead of only below them.
- [x] B2.3 Collapsible group headers show a chevron that turns when open.
- [x] B2.4 Checks pass; screenshots reviewed.

## Batch 3: small items

- [x] B3.1 Tree legend shortened.
- [x] B3.2 Dark-mode banners are opaque enough that stars do not show through.
- [x] B3.3 The feed hides a build summary of `Not supplied`.
- [x] B3.4 One name for automatic checks; Settings row titles share one weight.
  Deviation: search stays after Save filter. The saved-filter control is a preset picker that fills search and type,
  so leading with it is deliberate, and moving it would also move Save filter below the search box on mobile.
- [x] B3.5 Checks pass; screenshots reviewed.
