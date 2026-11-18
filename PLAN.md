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

- [x] A read-only probe script (`scripts/probe-coverage.js`) reads, for each enabled watched repository: refs with `filter=tags/` and `peelTags=true`, the last 100 pushes with ref updates, active PRs with their `reviewers`, one PR's `threads` and policy evaluations, and project PRs filtered by `sourceRepositoryId`. It writes status code, field names, counts and latency per request to `docs/probe-results.md`, with no identities, names or IDs; policy and thread types outside Azure's built-in names are written as "other", and a failure prints a fixed message. Check: a unit test that every request is a GET, tests that names and IDs stay out of the summaries, and a results file with a status for all six reads.

Phase 1 findings (2 enabled repositories, 18 November 2026): one repository has three lightweight tags and 7 tag updates in its last 100 pushes, and its tag updates carry name, old and new object IDs and repository ID. The PR list already carries reviewers with `vote`, `hasDeclined` and `isFlagged`, and its only timestamp is `creationDate`, so thread reads cannot be limited to PRs that changed. Every thread on the two sampled PRs carried Azure's `CodeReviewThreadType` property (vote, reviewer and ref updates), so none was a person's comment. Policy evaluations returned `approved` and `queued` for comment requirements and minimum reviewers. A project-scoped `sourceRepositoryId` search returned no PRs in either repository, not even each repository's own active PR, and no sampled PR had a `forkSource`.

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

- [x] A PR from a fork keeps the fork's repository and project name (`data.fork`, from `forkSource`), and its summary says "From fork … · Target: …". No new request, and the field stays out of the snapshot fingerprint. Check: sync test where learning the fork source creates no PR update (it fails when the fork joins the fingerprint) and a later real change records the fork; presentation test for the summary.
- [x] ~~A new `outgoingPrs` stream reads PRs whose source is the watched repository.~~ Not built. In both sampled repositories the `sourceRepositoryId` search returned nothing, even for their own active PRs, and no PR came from a fork, so the stream would cost one read per repository every few minutes with nothing observed to show. This sample does not rule out PRs that target another project. Revisit when a watched repository has forks or such PRs.

Phase 6: review votes

- [x] PR snapshots keep reviewers with their vote and required flag from the existing list response, and the fingerprint includes votes, so a vote change produces PR activity whose summary says who voted what ("Ana: approved · Sam: vote reset"). A snapshot saved before votes were recorded adopts the current votes without an update. Check: sync test for a new vote and a reset vote, and an upgrade test that fails when the adoption rule is removed. No new request.
- [x] The PR detail lists reviewers with "(required)" and their vote in words. Check: e2e test on the demo PR with an approval, a "waiting for author" vote and a group with no vote; it fails without the detail field.

Phase 7: discussions and policy evaluations (budget-gated)

- [x] Measure first. `scripts/measure-budget.js --limit 60 --active-prs 10` adds one threads read and one policy evaluations read per active PR to the shared queue. At 1, 5 and 20 repositories, p95 push delay was 3.9, 4.7 and 5.2 minutes without them. Reading every 3 minutes gave 4.3 and 8.6 minutes, and at 20 repositories no push reached Activity within the hour. Reading every 30 minutes gave 4.0, 4.8 and 8.2 minutes. Both exceed the 1-minute limit at 20 repositories, so the remaining items read on opening the PR detail instead of polling.
- [x] A PR detail has "Load discussion and policies", which makes two reads through the shared queue (`pullRequests/{id}/threads` and the preview `policy/evaluations`), both newly allowlisted as GET only. It shows open and resolved discussion threads, without Azure's own vote, reviewer and ref-update threads, and no comment text. Check: client test for the counts (it fails when system threads are counted), REST route test (it fails on the old allowlist), and an e2e test on the demo PR. Read through the app's client against Azure for 8 real PRs: threads such as `{"open":0,"resolved":7}` and policies such as "Minimum number of reviewers: queued, blocking".
- [x] Each policy evaluation shows as passed, failed, running, waiting, not applicable or broken, with "(required)" for blocking policies, in the same section. Disabled and deleted policies are left out. Check: the same client test and e2e test.

Not in this item: policy configuration changes and other administration events (they need audit access, see Gate 5 in the research), linked work items, comment text, and a restructuring of the per-kind branching in `src/activity-text.js` and `src/ui`. Tags add three kinds that mirror the branch kinds, so the existing pattern holds. Revisit a per-kind table if Phase 7 adds more kinds.

## Constraints

- Watch whole repositories by default. Filters affect the Activity view and opening an item never marks it seen.
- Keep one budget for all Azure reads. Activity reads use REST with an Azure CLI token since 2026-11-18, decided after `scripts/measure-budget.js` showed merge evidence falling behind from about 10 repositories on the CLI-only budget. Measure with that script before changing the polling model.
- Keep status labels readable without color. Preserve keyboard focus, visibility, and scroll across refreshes.
- A successful build or merged PR does not establish deployment. Partial evidence should stay visible as partial evidence.
- Service hooks, audit ingestion, notifications, and packaging can wait for a demonstrated need.

See [Azure API research](docs/FULL-COVERAGE-RESEARCH.md) for endpoints, source references, and proof cases. See [maintainer notes](docs/MAINTAINING.md) for architecture, checks, and local measurements.
