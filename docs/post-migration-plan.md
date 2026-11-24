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
      improvement plan 1.1. Commit the readable siblings, keep the stream from claiming a clean success, and show a
      problem that names the stream and the missing field. A retry cannot repair an API shape change, so failing the
      whole page would only stall the stream. Check: the interpretation is stated in the PR before coding, plus the
      test from 1.1 passes. (S) Done as proposed: the page commits its readable records and advances the checkpoint;
      the stream keeps a `warning` (`UNREADABLE_RECORDS`, with the fields and a count); sync status shows it as
      `problem` with the warning's message and the stream. The warning describes the last completed read: a read sums
      the counts and joins the fields of every page in `unreadable`, and only its completion replaces the warning, or
      clears it when every page read clean. A page in progress, a failed read and a restarted read (a refresh during
      the read, or a refs snapshot restarted at page one) leave the last completed warning as it was, and a restart
      drops what the discarded pages left out. Rules for records read by ID: a PR or build the active list returns
      unreadable but with a readable ID is still active, so it is counted once and not looked up; a PR lookup whose
      ID or repository cannot be read is unreadable, while an answer that is not an object or a readable ID of
      another PR stays `INVALID_RESPONSE` and a readable other repository stays `WRONG_REPOSITORY`; a PR or build
      whose lookup came back unreadable with a readable ID is kept in `unreadableLookups` and counted in every read
      until it reads, its lookup finds it deleted, moved or gone, or the active list holds it again (a build lookup
      answer with more pages or with unreadable builds without an ID settles neither, so the build stays remembered),
      while an unreadable answer without a readable ID counts only in its own read and is never remembered (a PR
      lookup answer included); a looked-up build is given up
      only when Azure's answer leaves its ID out, and no build is given up in a lookup that returned a build whose ID
      cannot be read, since that answer may be any build asked for. Missing PRs (3 a read) and builds (20 a read) are
      looked up least recently looked up first: an ID joins the end of the order when it goes missing and moves to
      the end when it is looked up, so neither IDs that stay unreadable nor newer IDs that keep going missing can
      hold every turn. The order is kept per repository and forgotten once the repository is no longer watched, so a
      repository removed and added again starts it afresh. The order is dropped on the next scheduler turn that finds
      the repository unwatched, so a repository removed and added again before that turn inherits the old order until
      item 1.4's `forget` lands, which clears it on removal. An unreadable build without a readable ID is not counted
      again for a remembered build asked for in the same lookup: the count is the remembered builds plus the
      anonymous ones beyond the remembered builds that lookup asked for, and the anonymous ones' fields join the
      warning's fields either way. In the same read, anonymous unreadable records a PR or build lookup returns count
      only beyond the anonymous unreadable records the active list of that stream returned, which they may be. A build without a `repository.id` is unreadable; a build
      of another repository is still left out. A ref with an empty `name` or `objectId` is unreadable. A refs
      snapshot with unreadable records is incomplete: it adds and updates its readable refs and reports none as no
      longer listed. While the baseline is being established, an incomplete snapshot is no baseline, so the stream
      stays uninitialized and no tag baseline is written. It also creates no ref: it updates the refs that exist,
      which only a push can have recorded by then. The first complete snapshot therefore
      behaves as on `main`: it records every ref without a "first seen" event, which the standing warning makes
      visible, reports none as no longer listed, and leaves a ref a push recorded for the next complete snapshot,
      which reports it as no longer listed. A stream initialized before tags were tracked has no tag baseline, and
      `main` took its next snapshot for that baseline even when it was incomplete. So an incomplete snapshot of such
      a stream establishes the tag baseline from its readable tags exactly as `main` did: it writes
      `ref-baseline:tags`, creates and updates its readable tags, puts away the tags it omits without an event and
      announces no tag as first seen. The exception is an uncertain tag, one its unreadable refs may be: a tag one
      of them names, or every tag once one has no readable name. That snapshot neither puts away a stored uncertain
      tag nor creates an uncertain one, and keeps the set (`ref-baseline:tags-uncertain`, names or `all`). Further
      incomplete snapshots before a complete one join their sets to it. The next complete snapshot creates an
      uncertain tag it lists without a "first seen" event, reports a stored uncertain tag it omits as no longer
      listed, as `main` does with a baseline, and clears the set. Later snapshots then behave as on `main` with an
      established baseline. Once the baseline is established,
      an incomplete snapshot still creates the readable refs it is the first to list and announces them. Refs saved mid-snapshot are
      checked again when the snapshot resumes. A history import that skips unreadable records keeps them on its job
      in `warnings`, one per stream with the count and fields, and the repository's import status shows each message
      in Details; the always visible chip names the count while running, retrying or finished ("History sync finished
      · 2 records skipped"), and the finished chip turns to a warning. A warning names its stream the way errors do
      ("pull requests", "builds", "branches"), for stream and history import warnings alike. A repository's Details list a stream warning
      beside its failed checks, under "Last check problems". Tests that failed first: the 1.1 test, "a stream warning
      stands until a later read of that stream completes with no unreadable records", the sync-status "a stream that
      skipped unreadable Azure records is a problem naming the stream, not synced", "a warning found on any page of a
      read stands when the read completes, and only a later clean read clears it" and "a ref Azure returns unreadable
      is not reported as no longer listed, and neither is any ref until a complete snapshot" (which fails on `main`
      with a false deletion). The review round added, each failing first: "a read that finds other unreadable records
      and then fails keeps the warning of the last completed read", the two restart tests, the two "counted once and
      not looked up by ID" tests, three build lookup tests, "a PR lookup that comes back without a pullRequestId is
      counted and does not stop a readable sibling", "a PR whose lookup came back unreadable stays in the warning on
      reads whose lookups skip it, until it reads", the `repository.id` build test, the empty ref test, the two
      "first refs snapshot" tests and "refs saved from a snapshot in progress are checked again when the snapshot
      resumes". The second review round added, each failing first: "no build is given up in a lookup that returns a
      build whose ID cannot be read", "a build whose lookup came back unreadable stays in the warning on reads whose
      lookups skip it" (its counts were 1 twenty times, then none, then 1), "an older build is still looked up while
      20 newer builds leave the active list every read (lookup unreadable once)" (build 1 was never asked for again),
      the earlier form of "a branch listed only by an incomplete first snapshot is not saved, and no event follows when
      complete snapshots omit it", the non-object answers in the PR lookup client test, "the Details of a repository list a stream warning
      the way they list a failed check", "records Azure returns unreadable during a history import are counted on the
      job with their stream and fields" and "the repository import row shows the records the import skipped as a
      warning". One added test passed before its change and stays as a guard: "a build whose lookup came back
      unreadable leaves the warning once it reads, is gone, or is listed again". The third review round added, each
      failing first: "a branch a push recorded before the first complete refs snapshot is reported once a later
      snapshot still does not list it" (no event; `main` reports it), the two "stays in the warning when a later
      lookup of it is inconclusive" tests (build 42 was forgotten), "a repository removed and added again starts its
      PR lookup order afresh" (it asked for 4, 1, 2) and "the repository import chip says how many records the import
      skipped, since its warnings show only in Details". It removed the `throws once` variant of the older build
      test, which passes with the turn order disabled. The `unreadable once` variant also passes with the turn order
      disabled, since build 1 sorts first; it stays as the guard that a build whose lookup came back unreadable is
      asked for again. The turn order's own guard is "an older build that sorts after the newer ones is still looked
      up while 20 of them leave the active list every read": with numeric order only, build 1000 was never asked for
      again; with the turn order it completes. The fourth review round replaced the rule that put away, without an
      event, the refs an incomplete snapshot saved before the baseline, since it hid a real deletion, with the rule
      above, and added, each failing first: "a branch and tag a push recorded and an incomplete snapshot listed are
      reported once complete snapshots omit them" (the snapshot dropped their push `evidence`, and no event followed;
      `main` reports both) and "an unreadable build without an ID is not counted again for a remembered build asked in
      the same lookup" (it counted 2). It adapted the put-away test to the new rule, which failed first because the
      incomplete snapshot saved the branch. The fifth review round applied the branch rule to tags before the tag
      baseline and added, each failing first: "before the tag baseline, a tag a push recorded and an incomplete
      snapshot listed is reported once a complete snapshot omits it" (the snapshot dropped the push `evidence`, and
      no event followed; `main` reports it), "before the tag baseline, a tag a push records after an incomplete
      snapshot is reported once a complete snapshot omits it" (no event; `main` reports v3, and puts v1 away at the
      incomplete snapshot, which it reads as complete) and "an unreadable build without an ID that may be a remembered
      build adds its fields to the warning without counting again" (the warning named only `status`). "before the tag
      baseline, a tag a push recorded that the first complete snapshot omits is put away without an event, as on
      main" passed before the change and stays as the guard that a complete-only sequence matches `main`. The sixth
      review round limited what makes a record unreadable to the fields the code needs for its identity or meaning
      (see 2.1), leaving a malformed display field out of the record; the seventh round passes it through instead. It added, failing first: "a push with a malformed web link still reports its tag deletion, without
      a warning, as on main" (the push was skipped with a warning naming `_links.web`, so its tag deletion was lost;
      `main` reports it). A tag deletion can show twice: a complete snapshot reports "Tag no longer listed · v1", and a
      deletion push read later adds "Tag deleted · v1". This matches `main` once the tag baseline is established:
      checked on `origin/main` 844c7b6, an initialized refs stream with the tag baseline, a tag a push created, a
      complete snapshot that omits it and then its deletion push give both rows there as well, so no change was made.
      Known limit: a ref deleted and created again within one incomplete poll, with no push recording it, is not
      reported, since an incomplete snapshot reports nothing as no longer listed and Azure records ref deletions as
      pushes. The seventh review round added, each failing first on 71ef4d6: "before the tag baseline, a tag that no
      unreadable ref of an incomplete snapshot could be is put away without an event, as on main" (Sol's probe: a
      named branch with a malformed `objectId` made every tag uncertain, so v1 was reported; `main` puts it away),
      "a PR lookup answer without a readable ID counts only in its own read and is not remembered" (the second read
      still warned for PR 1), "an active PR without a readable ID in both the list and its lookup counts once" and
      "an in-progress build without a readable ID in both the active list and its lookup counts once" (both counted
      2), and the friendly stream names in the PR, build and history import warning messages (they said `prs`,
      `activeBuilds` and `closedPrs`). "before the tag baseline, a tag that an unreadable ref of any incomplete
      snapshot may be is reported once a complete snapshot omits it" passed before and stays as the guard that a
      named unreadable tag, and the names of an earlier incomplete snapshot, keep the report. The round-5 tag tests
      needed no change: their pages name no unreadable ref, which is the case where every tag stays uncertain. The
      round removed the `evidence` an incomplete snapshot kept on the refs it updated: nothing reads a ref's
      `evidence`, and with it removed only the three assertions on it failed, while every event those tests check
      still passed, so those assertions were dropped. A tag deletion can still show twice as described above.
      Display fields now pass through as Azure sent them (see 2.1), which "a push with a malformed web link still
      reports its tag deletion, without a warning, as on main" still confirms. The eighth review round replaced the
      `ref-baseline:tags-incomplete` marker with the rule above, since the marker kept a stream without the tag
      baseline from reporting a tag that `main` reports. It added two tests that failed first on a61c444: "before the
      tag baseline, an incomplete snapshot is the tag baseline for its readable tags, so a tag it listed is reported
      once a complete snapshot omits it, as on main", and its variant where a push records the tag between the two
      snapshots (Sol's probes: the incomplete snapshot lists v1 and its only unreadable ref is a named branch; both
      gave no event, while `main` reports "Tag no longer listed · v1"). Four tag tests asserted that an incomplete
      snapshot writes no tag baseline, which the new rule reverses, and failed on that assertion alone. They now
      assert that it is the baseline, and check the new rule further. "a tag a push recorded and an incomplete
      snapshot listed" checks that v2, uncertain, is not created, and that a later complete snapshot that lists v2
      announces it, so the set was cleared (with the clear removed, that test fails). The round-7 guard "a tag that
      no unreadable ref of an incomplete snapshot could be" checks that v1 is put away at the incomplete snapshot,
      and that no event follows, as on `main`. "a tag that an unreadable ref of any incomplete snapshot may be"
      checks that neither incomplete snapshot puts v1 away. "a tag unreadable in the first refs snapshot with
      tags is not announced as first seen once it reads" checks that the incomplete snapshot records v0 but not v1,
      and that v1 reappears without a "first seen" event. "a tag a push records after an incomplete snapshot" passed
      unchanged; it now also checks that v1, uncertain, stays active. The same probes, the round-7 guard and the
      reappearing tag were run on a throwaway `origin/main` 844c7b6 worktree, and each gives the same tag events
      there. `npm test` 572/572 and `npm run test:ui` 86/86.
- [x] 1.3 A malformed `refUpdates` must fail with a named error, not the generic `SYNC_FAILED`, and follow the
      1.2 handling. Check: a failing-first test with `refUpdates` set to an object. (S reproduced) Done: "a push
      whose refUpdates is not a list is skipped with a warning instead of failing the page" failed first with
      `SYNC_FAILED`, and now passes with a warning naming `refUpdates`. The warning follows the 1.2 rules: only a
      completed read replaces or clears it, and an unreadable ref makes its refs snapshot incomplete, so it reports
      no deletions and sets no baseline. Before the baseline it creates no ref, so the first complete snapshot sets
      the baseline as on `main`. On a stream without the tag baseline it is that baseline for its readable tags, as
      on `main`, except the tags its unreadable refs may be (see 1.2). With an established baseline an incomplete
      snapshot still announces the readable refs it is the first to list. `npm test` 572/572.
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
      Phase 1 tests, 572 unit tests and 86 browser tests pass. A page also names the PRs and builds it left out whose
      ID can be read, with the field each could not be read for (`unreadableIds`), and a build's `repository.id` and
      a ref's `name` and `objectId` are required. A PR lookup checks that the answer is an object before its fields.
      Only a field the code needs for a record's identity or meaning makes it unreadable: IDs, ref names and object
      IDs (`peeledObjectId` too), `refUpdates` and `commits`, statuses, results, `isDraft`, `mergeStatus`, merge
      strategy, reviewer IDs, votes and `isRequired`, dates, source and target refs, source versions and branches,
      merge commits, the repository and fork source (whose names place a fork PR's source in the activity tree). A
      number must be finite. A display field the code shows with a fallback is typed `unknown`, reads whatever its
      value, and reaches the normalizers as Azure sent it, so the fallback code, the fingerprints and the IDs see what
      `main` saw: `_links` (the link falls back to one the code builds), people (`pushedBy`, `createdBy`,
      `closedBy`, `requestedFor`, `requestedBy`, shown as Unknown), a PR's `title` (Untitled, and part of the PR
      fingerprint) and a reviewer's `displayName` (Unknown reviewer), and a build's `definition` (Pipeline) and
      `reason`. Where `main` put a value that is not text into an event's actor or a build's title, the event holds
      its text, since those fields are typed as text; the fingerprints and IDs do not use them. A value String()
      cannot convert, such as `{"toString":null}`, failed the read with `SYNC_FAILED` on a61c444. `main` stored it,
      but its page could not show it, since its HTML escape converts with String(). The event now holds the text
      `main` shows for a missing value (Unknown, Pipeline). Three table rows (a tag-only push's `pushedBy`, a branch
      push's `pushedBy` and a build's `definition.name`) failed first on a61c444 with "Cannot convert object to
      primitive value". On `main` the tag-only push and the build are stored with the object, and the branch push
      fails as well, since its title interpolates the actor. A build row still takes its title from
      `data.definition.name`, which holds the object as on `main`, so that row still cannot be shown, on `main` and
      here alike. "a PR with a malformed
      title keeps the fingerprint and IDs main gave it, so it is not reported again live or on re-import" failed on
      71ef4d6 (Sol's probe: the live ID hashed to `6f9e774806a44a3f8c0c1860` instead of `main`'s
      `6dd098039132df677cced0d5`, so a replay after the upgrade added a second row, and a re-import missed `main`'s
      history row). The table in `test/azure-client.test.ts` checks both sides per stream: its first 15 display rows keep
      the record whole and show what `origin/main` 844c7b6 shows, checked by running the same rows there (12 match
      exactly; the 3 whose actor or build title `main` filled with `7`, `7` and `["A"]` hold `"7"`, `"7"` and `"A"`),
      and all 15 failed on 71ef4d6. Checkout advice reads completed PRs with its own reader of only the fields it uses
      (ID, status, source and target refs, repositories, head, merge result, strategy, link), so a field only the
      activity stream reads cannot hide a candidate, and a candidate whose checkout fields cannot be read keeps the
      advice unverified. "completed PRs from one head into different targets keep the advice unverified, whatever
      fields checkout does not use" failed on 71ef4d6 (Sol's probe gave `verified: true`; `main` gives `false`); its
      two cases with an unreadable target or merge result are stricter than `main`, which drops such a candidate.
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
