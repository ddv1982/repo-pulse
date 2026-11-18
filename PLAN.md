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

- [ ] A read-only probe script (`scripts/probe-coverage.js`) reads, for one watched repository: refs with `filter=tags/` and `peelTags=true`, one push containing a tag update, a pull request's `reviewers`, its `threads`, its policy evaluations, and project PRs filtered by `sourceRepositoryId`. It writes status code, field names and latency per request, with no identities, names or IDs, to `docs/probe-results.md`. Check: the script makes only GET or allowlisted read POST requests (asserted by a unit test on its request list), and the results file shows a status for all six reads.

Phase 2: access gaps are visible

- [ ] Stream errors keep the HTTP class: 401/403 become `access-denied`, 404 on a supported route becomes `unsupported`, everything else stays `failed`. Check: a sync test where the refs read throws HTTP 403 stores `access-denied`, and the same test with HTTP 500 stores `failed`.
- [ ] The Repositories health chips say what cannot be read ("No access to tags", "Pull request threads not supported") instead of "Check failed" for those two states, and the label is readable without color. Check: an e2e test seeds a denied stream in demo mode and finds the text; a failed stream still shows "Check failed".
- [ ] A denied or unsupported stream marks the repository's Activity as partial, so an empty or short feed is not read as "nothing happened". Check: e2e test shows the partial notice for a denied stream and not for a healthy one. Failed streams do not need this, because checkpoints do not advance on failure and the overlap recovers the window.

Phase 3: tags

- [ ] The push normalizer keeps `refs/tags/` updates and emits `tag-created`, `tag-moved` and `tag-deleted`, and never queues a merge job for them. Check: sync tests for a lightweight tag, an annotated tag (object ID is the tag object, not a commit), a moved tag and a deleted tag, plus a test that a tag-only push queues zero merge jobs.
- [ ] The refs snapshot also reads `tags/` with `peelTags=true`, stores `peeledObjectId`, and reports first-seen and no-longer-listed tags with `evidence: 'snapshot'`, as branches do. Check: sync test with a mixed heads and tags snapshot, and the budget measurement shows the extra refs read every 10 minutes keeps p95 delay within 1 minute of the baseline at 20 repositories.
- [ ] Activity shows tag rows with labels, a "Tags" type filter and a detail view naming the tagged commit when it is known. Check: presentation tests for the three labels, and an e2e test that filters to tags on seeded demo rows.

Phase 4: history rewrites

- [ ] The background merge job classifies each moved branch update as `fast-forward`, `rewrite` or `unknown`. It reads the range reachable from the old tip excluding the new tip (`refRangeCommits` reversed, `$top=1`): empty means fast-forward, non-empty means rewrite, unreadable objects mean unknown. Unequal SHAs alone never mean rewrite. Check: enrichment tests for each of the three results, including a 404 on the old object giving `unknown`.
- [ ] Push rows show "History rewritten" with the count of dropped commits it could read, and nothing extra for a fast-forward. Check: e2e test on a seeded rewrite row and a seeded fast-forward row, and the budget measurement shows the extra read per moved branch.

Phase 5: fork and outgoing pull requests

- [ ] Every PR snapshot keeps its source repository and project, and a PR from another repository into the watched one is labelled as a fork PR. No new request. Check: sync test with a fork PR, and a test that adding the field does not change existing PR fingerprints (no burst of activity on upgrade).
- [ ] A new `outgoingPrs` stream reads PRs whose source is the watched repository within its project (`sourceRepositoryId`), and the normalizer stops dropping PRs that target another repository. Check: sync test that an outgoing PR is kept with its target repository, and the budget measurement at 20 repositories. Cross-project targets stay out unless Phase 1 shows the org uses them.

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
