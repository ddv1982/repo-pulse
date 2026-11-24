# Post-migration plan

Written 2026-11-24 from a council review by Claude Opus 5.5 (7.5/10), Gemini 4 Neon (8.0/10) and GPT-6.2 Sol
(7.5/10) of `main` at `9ca407a`, after the [TypeScript migration](typescript-migration.md) finished. Each
reviewer read the code independently and read-only. One line per verifiable unit; tick a box only after its
check has run and its output has been shown.

Sources are marked **O** (Opus), **N** (Neon) and **S** (Sol). "Reproduced" means a reviewer ran it;
"verified" means it was confirmed against the code after the review; "read" means it was found by reading.

The council agreed that the migration converted the syntax faithfully but kept the JavaScript-era data
model: the strict compiler flags protect internal code, while data from Azure and SQLite still enters as
`any`. Sol also found two sync bugs that make the feed quietly wrong. This plan fixes those first, then
makes the boundaries typed, then cleans up what the migration left behind.

This plan sits next to the [improvement plan](IMPROVEMENT-PLAN.md), whose phase 4 (two weeks of use, until
2026-12-07, "fix bugs found in use; no new polish") is still running. D1 records how the two fit together.

## Decisions

- **D1** Timing: all phases now (option B), decided by the owner on 2026-11-24. The usage period keeps
  running; a regression these PRs cause is logged as such in `docs/usage-log.md`. The alternatives were Phase 1
  now and the rest after 2026-12-07 (A), or everything after 2026-12-07 (C).
- **D2** PR grouping: 1.1 to 1.3 ship with 2.1, because handling a malformed Azure record is the Azure guard
  work. 1.4 and 1.5 are separate PRs. 2.2 to 2.6 ship together because they all change the store's reads.
  Phase 3 comes last, because 3.1 touches nearly every file.

## Phase 1: Sync correctness

Every behaviour fix starts with a failing test. These touch `server/sync.ts`, `server/store.ts` and
`server/azure-*.ts`, so each gets the full cross-model review from `docs/MAINTAINING.md`.

- [x] 1.1 A push record without `pushId` must not disappear while the stream reports success. Today
      `server/normalize.ts:161` returns silently, and the page commits with `error: null` and an advanced
      `lastSuccess`. Check: a test in `test/sync.test.ts` that reproduces Sol's probe and fails first. (S
      reproduced, line verified) Done: "a push Azure returns without a pushId is skipped with a warning instead of a
      clean success" failed first with `error: null`, the advanced `lastSuccess` and no warning, and now passes.
- [x] 1.2 Decide and implement how an unreadable Azure record is handled. Proposal: follow the precedent of
      improvement plan 1.1. Commit the readable siblings, keep the stream from claiming a clean success, and
      show a problem that names the stream and the missing field. A retry cannot repair an API shape change,
      so failing the whole page would only stall the stream. Check: the interpretation is stated in the PR
      before coding, plus the test from 1.1 passes. (S) Done as proposed: the page commits its readable records and
      advances the checkpoint; the stream keeps a `warning` (`UNREADABLE_RECORDS`, with the fields and a count); sync
      status shows it as `problem` with the warning's message and the stream. The warning describes the last
      completed read: a read sums the counts and joins the fields of every page, and only its completion replaces the
      warning, or clears it when every page read clean, so a clean later page of the same read does not clear it. A
      refs snapshot with unreadable records is incomplete, so it adds and updates its readable refs but reports none
      as no longer listed. Tests that failed first: the 1.1 test, "a stream warning stands until a later page of that
      stream commits with no unreadable records", the sync-status "is a problem naming the stream, not synced", "a
      warning found on any page of a read stands when the read completes, and only a later clean read clears it" and
      "a ref Azure returns unreadable is not reported as no longer listed".
- [x] 1.3 A malformed `refUpdates` must fail with a named error, not the generic `SYNC_FAILED`, and follow the
      1.2 handling. Check: a failing-first test with `refUpdates` set to an object. (S reproduced) Done: "a push
      whose refUpdates is not a list is skipped with a warning instead of failing the page" failed first with
      `SYNC_FAILED`, and now passes with a warning naming `refUpdates`. The warning follows the 1.2 rules: it lasts
      for the whole read that found it, and an unreadable ref does not make its refs snapshot report deletions.
- [ ] 1.4 A read still in flight must not write into a watch that was removed and added again. Today the old
      read inserts an event and initializes the replacement stream, and the re-add hits the old refresh
      cooldown (`server/sync.ts:218`, `server/sync.ts:434`, `server/store.ts:646`). Fix: tie each commit and the
      cooldown to a watch generation. Check: a deterministic test that defers a push read, removes and re-adds
      the repository, then completes the read; it fails first. (S reproduced, not yet reproduced by us)
- [x] 1.5 Two app instances must not open the same data directory. Today nothing prevents it, and checkout
      write locks live in each instance (`server.ts:697`). Fix: an exclusive lock on the data directory with
      recovery from a lock left by a crashed run. Check: a failing-first test that starts a second app on the
      same directory and expects a clear refusal, plus a test that a stale lock is taken over. (S reproduced,
      no lock verified) Done as SQLite's exclusive file lock on `live.sqlite.lock` or `demo.sqlite.lock`, which
      the OS drops when the holder dies, so nothing goes stale. Two starts at once could both be refused (Sol: 37 of 100 runs), because each kept the shared lock the other needed; the lock now closes and retries with a short random pause until a 2 s deadline, and a 12-round race test with two processes, which failed on round 0 before, expects exactly one winner each round. A start that fails after taking the lock now releases it and the store (a failing-first EADDRINUSE retry test). A database file symlinked into another data directory is not protected, as the code says. Live and demo
      keep separate locks: the `access-key` file that `startApp` removes is a leftover nothing reads, so they
      share no state. The three new tests in `test/server.test.ts` (second start refused, also from the CLI with
      exit code 1 and no stack trace; a SIGKILLed holder's lock taken over; close then restart) failed with
      "the start was not refused" before the fix and pass after it; `npm test` 473/473 and `npm run test:ui`
      86/86 on Linux. Windows CI has not run yet.

## Phase 2: Typed boundaries

See D2 for the PRs. Data from outside the program enters as `unknown` and is checked by hand-written guards
(no zod or valibot: zero runtime dependencies stays a constraint). Items 2.1 and 2.2 touch the sync, store
and Azure code, so they get the full cross-model review.

- [x] 2.1 Replace `AzureRecord = any` (`src/contract.ts:11`, 36 references) with minimal response types per
      stream (`pushes`, `refs`, `prs`, `closedPrs`, `builds`, `activeBuilds`) and guards where a page is read
      (`server/azure-client.ts:70`). The normalizers take the typed records. Check: `grep -rn AzureRecord`
      finds nothing, the Phase 1 tests stay green, and a test per stream feeds one malformed record to its
      guard. (O, N, S; verified) Done: `git grep -n AzureRecord -- '*.ts'` finds nothing (`grep -rn` still finds
      this plan's own text and `docs/typescript-migration.md:134`); the guards are in `server/azure-records.ts`; the
      six per-stream tests in `test/azure-client.test.ts` fail on the code before this change and pass after; the
      Phase 1 tests, 483 unit tests and 86 browser tests pass.
- [ ] 2.2 Replace the store's `parse = (...): any` (`server/store.ts:48`) and `undefined as any`
      (`server/store.ts:132`) with one reader per persisted type that reports a corrupt row by table and id.
      Check: no `any` left in `server/store.ts`, plus a test that a corrupt stored row gives that error. (O, N, S;
      verified)
- [ ] 2.3 Type entity data per entity type instead of `data: any` (`server/normalize.ts:31`, `:38`, `:145`,
      `server/sync.ts:27`). Check: those `any`s are gone and `check:types` passes. (N, verified)
- [ ] 2.4 Make `Job` a union per job type and type `listJobs` per type (`server/store.ts:26-34`, `:664`), which
      removes `as unknown as` at `server/fork-origin.ts:163` and `server/rewrite-check.ts:47`. Check: `grep -rn
      "as unknown as" server/` finds nothing. (O, N, S; verified)
- [ ] 2.5 Type settings by key, including the template keys such as `checkout:${id}`, so `getSetting`
      returns the stored type. This removes the casts at `server.ts:183-190`, `server.ts:258-259` and
      `server/saved-activity-filters.ts:40`. Check: those casts are gone and `check:types` passes. (N, verified)
- [ ] 2.6 Measure the result. Check: `git ls-files '*.ts' | xargs grep -nE ': any\b|= any\b|as any\b'` lists
      only the two diagnostic parameters in `scripts/probe-coverage.ts`, or nothing.

## Phase 3: Cleanup the migration left behind

One PR for the phase, after Phase 2 merges. CI plus one review.

- [ ] 3.1 Replace the 220 inline `= import('…')` type aliases with `import type`. It is a JSDoc leftover, and
      the change is mechanical, so use a script. Check: `git ls-files '*.ts' | xargs grep -cE "= import\('"`
      totals 0, and `check:types`, `lint` and all tests pass. (O, N; count verified)
- [ ] 3.2 Turn on Oxlint's correctness category and fix or justify each of its 22 warnings. Triage the 11
      `no-base-to-string` warnings first: a value that can really print `[object Object]` gets a failing test.
      The `await cli?.close()` at `server.ts:773` awaits a method that returns nothing; drop the `await`.
      Check: `npm run lint` is clean with the category on. (N; 22 verified)
- [ ] 3.3 Keep `src/ui/dom.type-test.ts` type-checked but out of the browser build, and stop emitting an empty
      `dist/src/contract.js`. Check: neither file is in `dist/` after `npm run build:web`, the type test still
      fails on a planted violation, and the e2e suite passes. (N, verified)
- [ ] 3.4 A rejection from `onStarted` after a history import has started must be reported, not left
      unhandled (`src/ui/history-import.ts:76`). Check: a failing-first test that the accepted import stays
      acknowledged and the follow-up failure is shown. (S, from the Phase 9 review)
- [ ] 3.5 Correct `docs/typescript-migration.md:8-10`, which says a greenfield design "would be close to this
      one". The toolchain would be close; the data model would not, as this plan shows. Check: the paragraph
      links here. (O)

## When the code is next touched

Not scheduled. Do each one as part of a change that already touches the code, and not on its own.

- `EventData` as a union on `kind` instead of 34 optional fields (`src/activity.ts:69-104`, 61 `data?.`
  reads). Stored rows from older versions still need lenient reads. About 2 to 3 days. (O, N, S)
- One route table shared by `server.ts` and `src/api.ts`, keyed by method and path and covering request
  bodies. It replaces the hand-matched `ResponseFor` (`src/api.ts:17-61`), gives `request()` a checked
  result instead of `let value: any` (`src/api.ts:124`), and covers the four routes without `satisfies`
  (`server.ts:314`, `:320`, `:325`, `:580`). Do it with the next route added. (O, N, S)
- A smaller `/api/state` response that leaves out stored stream internals. (S)
- Split `createApp` (`server.ts`, about 610 lines) into route groups and `createStore` (about 700 lines) into
  query modules. (O, N)
- New tests use narrow typed fakes instead of `stub<T>()`, which asserts a partial object as a complete one
  (`test/fixtures/typed.ts`). (N, S)
- Move commit checkbox selections into `ui` state so a refresh can proceed while they are ticked (`src/web.ts`,
  `src/ui/browser-view.ts:163`). (S)

## Only if use shows it

- SQLite JSON scans: `people:` search parses JSON per row (`server/activity-query.ts:268-270`) and
  `branchTipsBefore` expands every prior push (`server/store.ts:743-757`). Revisit with the retention decision
  in improvement plan 4.3. (N)
- Pull can fast-forward the wrong branch if a terminal switches branches at the wrong moment. This is
  documented and accepted in `docs/MAINTAINING.md`; Pull reports the outcome as unclear. (O, S)
- Browser tests run only on Linux in CI. Add a Windows run only if a Windows-only UI bug appears. (O)

## Leave alone

All three reviewers, unanimously:

- `node:http` with the route table, not Hono, Fastify or Express.
- `SafeHtml` templates with Idiomorph, not React, Lit, Solid or Preact.
- `tsc` emit to `dist/` with Node type stripping, and no bundler.
- `node:sqlite` with JSON columns and the existing migrations, not an ORM or a schema rewrite.
- `node:test`, linkedom and Playwright, not Vitest.
- Zero runtime dependencies.
- The CommonJS Git hook checked against its `.d.cts`.

## Rules

- A behaviour change gets a failing test first, shown failing, then passing.
- Phases 2 and 3 do not change behaviour except where an item says so; the full test suite proves it.
- Review follows `docs/MAINTAINING.md`: full cross-model review for sync, store, Azure and checkout code, CI
  plus one review for the rest.
- Nothing outside this plan goes into its PRs.

## Effort

Phase 1 about 2 days, Phase 2 about 2 to 3 days, Phase 3 about 1 day. The council expected Phases 1 and 2
to move the project from about 7.5 to about 9.
