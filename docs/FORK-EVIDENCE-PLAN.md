# Fork evidence plan

Goal: replace the dotted fork "assumed from the pull request target" with evidence about where a branch started, and
show no fork when that evidence is missing, ambiguous or contradicts the target.

Git records no branch parentage. The strongest honest claim is "started from commit X, which branch P held at the
time". No phase may word a fork as "branched from P".

## Findings this plan rests on

- `forkOrigin` (`src/activity-tree.js:227`) uses `tip` evidence only when the creating push's `newObjectId` appears on
  the page as another branch's tip. Otherwise it takes the PR target.
- Live database, 2026-11-20: 92 branches created by a push, 2 by snapshot. Only 4 of the 92 have their
  `newObjectId` recorded on another ref anywhere in stored pushes. The rest were created with new commits, so tip
  matching alone, even database-wide, cannot help. The dotted PR fork is what nearly every row shows today.
- The commit the branch is based on (`F`) is the parent, outside the creation push, of the commits that push
  introduced. Matching `F` against recorded branch tips, or testing whether `F` is an ancestor of a candidate's tip
  at creation time, is evidence for the remaining cases.
- `droppedCommits(old, new)` (`server/azure-client.js:420`) is a live-verified ancestry test: an empty page means
  `old` is an ancestor of `new`. `pushCommits` (`:455`) and `GET commits/{id}` are already allowed reads.
- `server/rewrite-check.js` is the precedent for a bounded background read: live pushes only, one call per tick,
  retries, `NOT_FOUND` settles as unknown, result saved on the event.
- Probed 2026-11-20 (`docs/probe-results.md`): `commits?pushId=` returns no `parents` and is not in topological
  order. `GET commits/{id}` returns `parents` and `push.pushId`. PR iterations carry `commonRefCommit`; no retarget
  iteration was available to inspect. Merge bases return `commitId` items.
- A read-only walk over 29 stored creations: following the tip's single parent while `push.pushId` equals the
  creation push reached `F` for 27 (usually 2 reads, at most 8); 1 hit a merge, 1 passed the cap. The walked commits
  equalled the push's commit list every time. `F` was the latest recorded tip of exactly one other branch for 14 of
  the 29.

## Deviations from the first draft

- Phase 1 derives `F` by walking `GET commits/{id}` instead of from `pushCommits`, which has no parents. Cost: one
  read per new commit on the chain, capped at 8.
- Phases 2 and 3 run inside the same background job and store the final claim on the event, instead of matching at
  query time, because phase 3 needs phase 2's answer before it spends reads. `activity-query.js` needs no change:
  enrichment already reaches `event.data`.
- No default branch is stored for a repository. The candidate set is this branch's stored PR targets, oldest first,
  then the repository's most common stored PR target, at most three.
- A checked result replaces the PR assumption: when the job found `F`, the PR target is never drawn as a fork.
- The check shares the existing automatic-check background turn and runs when no rewrite check is due, instead of
  adding a third background kind to `server/sync.js`.

## Evidence levels and wording

| Level | Evidence | Line | Row text |
| --- | --- | --- | --- |
| `tip` | `F` (or the created tip) was the latest recorded tip of exactly one other branch P before the creation push | solid | Started at `abc1234`, the tip of P |
| `contained` | `F` is an ancestor of exactly one capped candidate's recorded tip before creation | solid | Started at `abc1234`, already on P |
| ambiguous | Several branches qualify | none | Started at `abc1234`, on P and Q |
| refuted | `F` is not on the PR target T | none | PR 7 targets T, which did not contain `abc1234` |
| `pr` (unchecked) | No check ran yet (imported, failed, demo, offline) | dotted | PR 7 targets T, origin not checked |
| unknown | Nothing above | none | (no fork text) |

Decision D1 (open): whether the unchecked `pr` level keeps a dotted line or shows text only. Recommendation: keep
it until phase 3 ships, then decide from how many rows still fall back to it.

## Phases

Each phase ends with `npm test`, `npm run check:types` and `npm run lint` plus the phase's own check. New tests are
written first and seen to fail.

### Phase 0: probe the payloads (read-only)

- [x] Extend `scripts/probe-coverage.js` with read-only probes for `commits?pushId=` on a branch-creation push with
      new commits and one without, `GET commits/{id}`, PR iterations of a normal and a retargeted PR, and merge
      bases.
- [x] Record dated, anonymised results in `docs/probe-results.md`. Check: each unverified item above is answered
      or marked unavailable.

### Phase 1: base commit from the creation push

- [x] Add `commit(repo, id)` to the Azure client (parents and `push.pushId`). Check: client test.
- [x] Add a `fork` job modelled on `rewrite-check.js`, queued only for live (not imported) `branch-created` push
      events. One read per tick walks from the tip while the commit belongs to the creation push; the first commit
      outside it is `F`. No parent means orphan, several mean merge, more than 8 reads means unknown. Check: tests
      for queueing, skip of imported rows, created at an existing commit, linear walk, merge, orphan, cap,
      `NOT_FOUND`, retries and reset.

### Phase 2: match the base against recorded tips (zero Azure calls)

- [x] Store query for the latest recorded tip of each branch before push N, and the fork candidates of a branch.
      Check: store tests for a tip that moved before creation (no claim), a deleted branch, and candidate order.
- [x] The job matches `F` against those tips and saves the claim on the event. Check: job tests for a unique match
      and two branches sharing the tip (ambiguous).
- [ ] `forkOrigin` in the tree prefers the stored claim over page-only sightings and the PR target. Check:
      `test/activity-tree.test.js` cases for an off-page parent, a stacked branch drawn to feature-a, an ambiguous
      tie that draws nothing, and a checked branch whose PR target is not drawn.

### Phase 3: verify or refute candidates by ancestry

- [x] When phase 2 finds no tip match, test `F` with `droppedCommits(F, tip)` against at most three candidates:
      PR target, original PR target if retargeted in stored history, default branch. Use their recorded tips
      before creation. Exactly one container gives `contained`; a PR target that does not contain `F` is
      `refuted`. Check: tests for cut from main with PR into release/x (refuted), cut from an older commit of main
      (contained), and a test proving the walk stops after 8 reads. A creation costs at most 8 commit reads and 3 ancestry reads,
      usually 1 to 3 in total.

### Phase 4: wording, legend and docs

- [ ] Rewrite `forkText` and the legend in `src/ui/activity-tree.js` to the table above, add demo fixtures for each
      level in `server/demo.js`, and update `docs/COVERAGE.md` and the README tree sentence. Check:
      `test/presentation.test.js`, `npm run test:ui`, and a demo screenshot per level.
- [ ] Resolve D1 using a count of live rows per level.

### Phase 5 (optional, separate decision)

- [ ] Snapshot-discovered branches: PR iterations `commonRefCommit` or merge bases, shown as text only
      ("shares history with P from `abc1234`"), never a fork line.
- [ ] Local clones as a zero-call accelerator for ancestry, only when the objects are present and with the
      existing `checkout-git.js` guards. Never fetch.

## Out of scope

Lane layout, merge curves, CI placement, and any change to how branches are discovered.
