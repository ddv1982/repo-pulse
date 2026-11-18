# Repo Pulse roadmap

Repo Pulse helps testers see what changed across watched Azure DevOps repositories and open the source evidence. The app runs locally, uses the existing Azure CLI sign-in, and reads Azure activity.

Branch and push monitoring, PR merge evidence, grouped Activity, resumable history import, and local checkout status are implemented. The [coverage guide](docs/COVERAGE.md) describes what the app can establish today.

## Codebase improvement phases

Done: Pull is plain Git, Activity filters match the displayed rows, all server and browser code is type-checked against one server-to-browser contract, browser casts are replaced by runtime checks, escaping of Azure and Git text is tested, and local Activity load is measured in the [maintainer guide](docs/MAINTAINING.md).

## Product roadmap after hardening

1. **Extend repository and PR coverage.** Preserve tags and distinguish confirmed history rewrites from ordinary ref changes. Investigate outgoing and fork PRs, review votes, discussions, and policy changes. Show gaps when events or permissions are missing.
2. **Trace deployments to revisions.** Start with whichever mechanism the target organization uses, YAML Environments or classic Releases. Follow a known revision through its run and artifact into a named environment. Verify failed attempts, retries, and rollbacks before presenting deployment evidence.
3. **Add broader build and test context.** Verify how shared pipelines and secondary repositories appear in Azure. Link test results and artifacts when their relationship to the run is known.

### Next: repository and PR coverage (item 1)

Today the refs stream and the push normalizer read `refs/heads/` only, so tags never arrive. A moved branch shows `old → new` without saying whether history was rewritten. PR polling covers PRs that target the watched repository and reads no reviewers, threads or policy evaluations. A stream that fails shows "Check failed" whether the cause is a 403 or a timeout.

Each phase is its own PR. A phase is done when `npm run check`, `check:types`, `lint`, `npm test` and `npm run test:ui` pass, plus the check named on its line. Every item that adds an Azure request also adds a fake handler to `scripts/measure-budget.js` and reports calls/min and p95 delay at 1, 5 and 20 repositories before and after. Each phase updates the matching row in [docs/COVERAGE.md](docs/COVERAGE.md). Fixtures do not prove Azure payload shapes, so Phase 1 records real responses first and later fixtures copy their shape.

Phase 1: prove the Azure responses (read-only)

- [x] A read-only probe script (`scripts/probe-coverage.js`) reads, for one watched repository: refs with `filter=tags/` and `peelTags=true`, one push containing a tag update, a pull request's `reviewers`, its `threads`, its policy evaluations, and project PRs filtered by `sourceRepositoryId`. It writes status code, field names and latency per request, with no identities, names or IDs, to `docs/probe-results.md`. Check: the script makes only GET or allowlisted read POST requests (asserted by a unit test on its request list), and the results file shows a status for all six reads.

Phase 1 findings (2 enabled repositories, 18 November 2026): one repository has three lightweight tags and 7 tag updates in its last 100 pushes, and push ref updates carry only name, old and new object IDs. The PR list already carries reviewers with `vote`, `hasDeclined` and `isFlagged`, and its only timestamp is `creationDate`, so thread reads need the sweep rule in Phase 7. Every thread on the sampled PRs was a system thread (vote, reviewer and ref updates). Policy evaluations returned `approved` and `queued` for comment requirements and minimum reviewers. `sourceRepositoryId` matched no PRs in either repository, including active PRs from the repository itself, because Azure sets a PR's source repository only for fork PRs (`forkSource`), and no PR came from a fork.

Phase 2: access gaps are visible

- [x] Stream errors keep the HTTP class. Already true on 2a8c6e1: `classifyCliError` turns 403 into `FORBIDDEN` and 404 into `NOT_FOUND` (test/azure-rest.test.js), and `failPage` stores that code on the stream. No separate `unsupported` state was added, because a 404 on a repository route means the repository is missing or hidden, which `NOT_FOUND`'s message already says.
- [x] The Repositories health chip names what cannot be read ("No access to recent CI runs") instead of "Check failed" when a read is refused, and keeps "Check failed" for other failures. Check: presentation test and the demo e2e test (billing-web's refused CI read) both fail on the old label and pass with the new one.
- [x] A refused stream marks Activity as partial. Already true on 2a8c6e1: the feed counts every stream error as partial coverage (src/ui/feed.js) and says "This does not confirm that nothing changed". Failed streams need nothing more, because checkpoints do not advance on failure and the overlap recovers the window.

Phase 3: tags

- [x] The push normalizer keeps `refs/tags/` updates as one `tag` kind whose `change` is created, moved or deleted, and a tag-only push produces tag rows only, with no push row and no merge job. One kind with three statuses replaces the three kinds first planned, so the type filter offers a single "Tag" entry. Check: sync test with a lightweight tag, an annotated tag, a moved tag, a deleted tag and a mixed branch and tag push; it fails when the tag-only early return is removed.
- [x] The refs snapshot reads all refs with `peelTags=true` instead of `heads/` only, stores `peeledObjectId`, and reports first-seen and no-longer-listed tags with `evidence: 'snapshot'`. A `ref-baseline` entity marks the first snapshot that recorded tags, so upgrading does not announce every existing tag. Check: sync test for an install from before tags, which fails without the baseline. No request was added: it is the same refs read, which pages only past 100 refs. Read through the app's client against Azure, the two enabled repositories returned 12 and 5 refs, including 3 tags, in one page each.
- [x] Activity shows tag rows with labels and tones, a "Tag" type filter, and a detail view that names the tag, what it points at, and the tagged commit only when the snapshot peeled it. Check: presentation test for the four tag labels and an e2e test that filters to tags on a seeded demo row and opens its detail.

Phase 4: history rewrites

- [x] The background merge job classifies each moved branch update as `fast-forward`, `rewrite` or `unknown`. After a ref's forward range completes, one more read (`droppedCommits`, the range read reversed, one page) lists commits the old tip reaches and the new tip does not: none means fast-forward, some means rewrite with their count, and a 404 means unknown. Other failures retry the job. Check: enrichment tests for each result and the retry; the rewrite test fails when the classification always answers fast-forward. Against Azure, the reversed read agreed with local `git merge-base --is-ancestor` on all 20 pairs of real branch tips tried (15 not ancestors, 5 ancestors), and classified all 42 real branch moves from the last 30 days as fast-forwards.
- [x] Push rows show "History rewritten · N commits dropped", and the merge evidence lists each checked branch as fast-forward, rewritten or unknown. A fast-forward adds nothing to the row. Check: e2e test on the demo's rewritten main push and its fast-forward push; it fails without the UI change. `scripts/measure-budget.js --limit 60` at 1, 5 and 20 repositories: calls/min 2.0, 10.2 and 24.5 after against 2.0, 9.9 and 24.6 before, and p95 delay 3.9, 4.7 and 5.2 minutes against 4.1, 4.8 and 5.3.

Phase 5: fork and outgoing pull requests

- [ ] Every PR snapshot keeps its source repository and project, and a PR from another repository into the watched one is labelled as a fork PR. No new request. Check: sync test with a fork PR, and a test that adding the field does not change existing PR fingerprints (no burst of activity on upgrade).
- [x] ~~A new `outgoingPrs` stream reads PRs whose source is the watched repository.~~ Not built. Azure only links PRs across repositories through forks, and Phase 1 found no fork PRs, so the stream would cost one read per repository every few minutes for nothing observable. Revisit when a watched repository has forks.

Phase 6: review votes

- [ ] PR snapshots keep reviewers with vote and required flag from the existing list response, and a vote change produces PR activity ("Approved by", "Waiting for author", "Rejected by"). Check: sync tests for a new vote and a reset vote, and a test that the first sync after upgrade does not emit vote activity for every open PR.
- [ ] The PR detail view lists reviewers and their votes, readable without color. Check: e2e test on a seeded PR with mixed votes.

Phase 7: discussions and policy evaluations (budget-gated)

- [ ] Measure first: with fake handlers for one threads read and one policy evaluations read per active PR, record calls/min and p95 delay at 1, 5 and 20 repositories with 10 active PRs each. Write the numbers and the decision into this file. Check: the numbers are recorded. If p95 delay at 20 repositories rises by more than 1 minute, the remaining items in this phase change to "read on opening the PR detail" before any code is written.
- [ ] Threads are read for a PR when its snapshot changed and otherwise on a slow sweep (30 minutes), unless Phase 1 found an update timestamp on the PR response that makes a cheaper rule possible. New and resolved threads produce PR activity with counts, not comment text. Check: sync tests for a new thread, a resolved thread, and an unchanged PR making no thread read before its sweep is due.
- [ ] Policy evaluations (build validation, required reviewers, comment resolution) show as passed, failed, running or not applicable on the PR detail. Check: enrichment or sync test for each state, and an e2e test on a seeded PR.

Not in this item: policy configuration changes and other administration events (they need audit access, see Gate 5 in the research), linked work items, comment text, and a restructuring of the per-kind branching in `src/activity-text.js` and `src/ui`. Tags add three kinds that mirror the branch kinds, so the existing pattern holds. Revisit a per-kind table if Phase 7 adds more kinds.

## Constraints

- Watch whole repositories by default. Filters affect the Activity view and opening an item never marks it seen.
- Keep one budget for all Azure reads. Activity reads use REST with an Azure CLI token since 2026-11-18, decided after `scripts/measure-budget.js` showed merge evidence falling behind from about 10 repositories on the CLI-only budget. Measure with that script before changing the polling model.
- Keep status labels readable without color. Preserve keyboard focus, visibility, and scroll across refreshes.
- A successful build or merged PR does not establish deployment. Partial evidence should stay visible as partial evidence.
- Service hooks, audit ingestion, notifications, and packaging can wait for a demonstrated need.

See [Azure API research](docs/FULL-COVERAGE-RESEARCH.md) for endpoints, source references, and proof cases. See [maintainer notes](docs/MAINTAINING.md) for architecture, checks, and local measurements.
