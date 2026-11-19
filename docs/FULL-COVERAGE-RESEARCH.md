# Complete observable coverage: Exa + Ref investigation

Investigated 17 November 2026 against the local implementation at `5f53aa7` and current public documentation. Research only: no application code, Azure configuration, credentials, live database or watched/seen state changed.

## Decision

Build **evidence-complete coverage of supported, accessible remote activity over an explicit time range**. Do not promise reconstruction of every human Git action. Treat unavailable evidence as a visible gap rather than an ordinary empty result.

Merge-aware enrichment and paged history are implemented. See [coverage and limits](COVERAGE.md) for current behavior and the [roadmap](../PLAN.md) for upcoming work. The later gates below cover broader repository, PR, and delivery evidence. Hooks and audit have separate operational requirements and do not replace reconciliation.

## Research method and corrections

Exa Agent completed a multi-source investigation; Exa search/fetch retrieved exact REST references. Ref MCP independently searched/read Microsoft documentation, official MicrosoftDocs source and Git documentation. The conclusions below were cross-checked against the actual adapter, sync, store and UI. Sources are listed at the end.

Important corrections to automated research:

- Pull Request Query is documented at **7.1**, not only 5.1. The 7.1 reference was fetched directly. It is a **read-only POST**, despite the operation being named Get. Historical: the adapter once allowed this and commit batch queries as narrowly validated read-only POST requests. Both POST paths were removed with the merge analysis, and the allowlist and REST executor now accept only GET reads. [S1](https://learn.microsoft.com/en-us/rest/api/azure/devops/git/pull-request-query/get?view=azure-devops-rest-7.1)
- A completed PR is already authoritative evidence that Azure records it as completed/merged. Observing its target push strengthens correlation; absence of a separately fetched push must not hide the PR completion. An active successful preview is different. [S2](https://learn.microsoft.com/en-us/rest/api/azure/devops/git/pull-requests/get-pull-request?view=azure-devops-rest-7.1)
- All four merge strategies are documented: `noFastForward`, `squash`, `rebase`, `rebaseMerge`. [S2](https://learn.microsoft.com/en-us/rest/api/azure/devops/git/pull-requests/get-pull-request?view=azure-devops-rest-7.1)
- Git PR metadata includes `closedBy`. Capture it as the **PR-closing identity**; do not assume it is the commit author, pusher, or a human who manually clicked Merge. The app now retains this field on completed PR snapshots. [S2](https://learn.microsoft.com/en-us/rest/api/azure/devops/git/pull-requests/get-pull-request?view=azure-devops-rest-7.1)
- The old 1,000-update boundary was in the UI query. The current feed pages through the local cache.
- An empty commit-to-PR match is not permanent proof of a direct merge: permissions, timing and later PR activity can affect the association. Cache negative results with expiry/reconciliation, not forever.
- Old/new commit ID filters called `fromCommitId`/`toCommitId` are lexical filters, not Git ancestry ranges. Use version descriptors or parent traversal for graph reasoning. [S3](https://learn.microsoft.com/en-us/rest/api/azure/devops/git/commits/get-commits?view=azure-devops-rest-7.1)

## Installed CLI and history observations

- Activity reads use a Microsoft Entra token from `az account get-access-token` and call the REST API directly, so the identity is the principal that token represents (the CLI account signed in when it was issued; a cached token can outlive an account switch until it is renewed). The DevOps extension's PAT fallback does not apply to these reads. A repository connection check also makes one REST read to prove access; an organization-only check uses `az` and does not.
- REST responses expose all headers. The adapter uses `x-ms-continuationtoken` for paging and honours `Retry-After` on any response: the shared queue starts no new read until the wait has passed (capped at ten minutes), and a 429 fails as a throttled read that the stream retries after its normal backoff while automatic checks are on.
- Historical, from the CLI-only transport: the inspected `az devops invoke` version parser accepted `7.1` and `7.1-preview` but rejected `7.1-preview.1`. Activity reads now go to REST directly.
- Build list windows can use queue time while displayed events use completion time. Historical imports filter against the overall requested range so a build crossing an internal page window is not lost.

## What complete means for this product

| Layer | Required observable scope | Completion boundary |
| --- | --- | --- |
| Remote Git | Repository-wide pushes, every ref update, introduced commits/parents, branch/tag creation/deletion/movement and history rewrites | Readable server records and objects, retained over the declared interval |
| PR integration | Incoming/outgoing PR lifecycle, merge result/strategy/source/target, closing identity where supplied, review/discussion/policy activity | Explicit supported fields, accessible projects/forks and observable revisions |
| Delivery | Related CI runs including repository resources, stages/jobs/tests/artifacts, YAML and classic deployment attempts | Known pipeline/project mappings and evidence tying revisions/artifacts to environments |
| Administration | Relevant repository/policy/security/pipeline-definition changes | Optional permitted audit/definition APIs, not assumed to be Git history |

Each repository and connector needs its own state: **current through time T, enriching, history importing, partial, access denied, unsupported, or gap**. Store ingestion coverage separately from semantic-enrichment coverage. A PR creator timestamp from last year does not establish continuous history coverage since last year.

## Verified API capabilities

All paths below are under `https://dev.azure.com/{org}/{project}/_apis` unless otherwise stated. Pin versions per endpoint and validate responses under the actual CLI configuration before shipping a connector.

| Capability | Official API / evidence | Product consequence |
| --- | --- | --- |
| Ref revision range | GET commits with explicit `compareVersion=new` and `itemVersion=old`, both `versionType=commit`, bounded top/skip | Live-verified direction for reachable-new excluding old history. Required for moves to already-existing PR result objects; push-associated commits alone can be empty. No lexical SHA bounds. [S3](https://learn.microsoft.com/en-us/rest/api/azure/devops/git/commits/get-commits?view=azure-devops-rest-7.1) |
| Pushed commits | GET `git/repositories/{repo}/commits?pushId=…`, with `top`/`skip` | Read every page for a push that needs enrichment; a cached empty list is not proof of no work. [S4](https://learn.microsoft.com/en-us/rest/api/azure/devops/git/commits/get-push-commits?view=azure-devops-rest-7.1) |
| Commit graph | GET a commit; GET commits by version descriptors; POST `…/commitsbatch` | Retain exact commit IDs and parents; batch only uncached objects. Explicit-ID search and version-range search are distinct request shapes. [S3](https://learn.microsoft.com/en-us/rest/api/azure/devops/git/commits/get-commits?view=azure-devops-rest-7.1), [S5](https://learn.microsoft.com/en-us/rest/api/azure/devops/git/commits/get-commits-batch?view=azure-devops-rest-7.1) |
| PR correlation | POST `…/pullrequestquery`, with `lastMergeCommit` or `commit` query types | Batch result-commit and constituent-commit associations. Validate returned PR status, repository and target before assigning meaning. Skip label enrichment unless needed. [S1](https://learn.microsoft.com/en-us/rest/api/azure/devops/git/pull-request-query/get?view=azure-devops-rest-7.1), [S6](https://learn.microsoft.com/en-us/azure/devops/release-notes/2025/repos/sprint-254-update) |
| PR completion | PR GET/list includes completion state, result/source/target commits, strategy and `closedBy` | Capture completion evidence from the existing responses; enrich older records separately without resetting seen state. [S2](https://learn.microsoft.com/en-us/rest/api/azure/devops/git/pull-requests/get-pull-request?view=azure-devops-rest-7.1) |
| Fork/outgoing PR scope | Project PR search supports `repositoryId` and `sourceRepositoryId` | Current target-repo filtering alone is insufficient for every fork/outgoing arrangement. Discover accessible target projects or allow explicit mappings. [S7](https://learn.microsoft.com/en-us/rest/api/azure/devops/git/pull-requests/get-pull-requests-by-project?view=azure-devops-rest-7.1) |
| Branches and tags | Refs list has continuation, `isLocked`, `peeledObjectId` and `peelTags`; push ref updates identify names and revisions | Preserve `refs/heads` and `refs/tags` separately. An annotated tag object is not automatically a commit. Do not classify a rename from equal tips alone. [S8](https://learn.microsoft.com/en-us/rest/api/azure/devops/git/refs/list?view=azure-devops-rest-7.1) |
| Multi-repo CI provenance | Pipeline run resources include repository refs/versions and pipeline resources | Primary-repository build filters are insufficient. Map pipelines and read their consumed resources; validate actual repository identifiers because reference/schema examples differ. [S9](https://learn.microsoft.com/en-us/rest/api/azure/devops/pipelines/runs/get?view=azure-devops-rest-7.1) |
| YAML deployment history | GET environments/{id}/environmentdeploymentrecords, paginated | Requires actual environment use and permissible access; retain attempts and resource/run links. The reference declares `vso.environment_manage` even though this is GET. Do not assume Code/Build read is enough. [S10](https://learn.microsoft.com/en-us/rest/api/azure/devops/distributedtask/environmentdeployment-records/list?view=azure-devops-rest-7.1) |
| Classic deployments | GET `https://vsrm.dev.azure.com/{org}/{project}/_apis/release/deployments` | Separate adapter, modified-time paging and release artifact-to-build/revision correlation. [S11](https://learn.microsoft.com/en-us/rest/api/azure/devops/release/deployments/list?view=azure-devops-rest-7.1) |

API `vso.*` labels describe documented scope requirements; they are not interchangeable with fine-grained Entra delegated scopes. Valid authentication still does not establish permission to every repository, project, environment or audit stream.

## Merge classification: what can be proved

| Case | Evidence needed | Honest presentation |
| --- | --- | --- |
| PR merge/no-fast-forward | Completed PR, source/target, result revision/strategy where present; correlate target update when available | Merged `source → target` via PR, strategy and source links |
| PR squash | Completed PR and squash metadata/result association | Merged via squash; not falsely called a two-parent Git merge |
| PR rebase/fast-forward | Completed PR and strategy metadata, relevant source/result revisions | Merged via rebase/fast-forward with PR evidence |
| Directly pushed merge commit | Newly introduced reachable commit with multiple parents in a branch update | Merge commit introduced into target; PR linkage/source branch unknown unless independently established |
| Merge commit inside a larger push | Inspect all introduced commits, not just the new tip | Push contains merge commit(s), with exact evidence |
| Fast-forward ref movement | Old tip is an ancestor of new tip | Fast-forward update. This alone does not prove a merge command was run |
| Squash/rebase/cherry-pick without PR evidence | Single-parent history/changed revisions only | Ordinary/rewritten commits; original integration intent unknown |
| Rewritten history | Both old/new objects readable and graph proves old is not an ancestor of new | Non-fast-forward/history rewrite; keep evidence, do not infer from unequal SHAs alone |
| New branch points at old history | Zero old ref and existing/new reachable history | Branch created; do not announce every historical merge as a new merge performed now |

Git stores graph structure, not a durable source-branch name for every operation. Fast-forward creates no merge commit; squash omits the merge structure. Commit timestamps/messages are not sufficient substitutes. Distinguish **when a commit was authored**, **when a ref received it**, and **when Repo Pulse observed/enriched it**. [S12](https://git-scm.com/docs/user-manual#fast-forwards), [S13](https://git-scm.com/docs/git-merge#Documentation/git-merge.txt---squash)

## Implementation sequence

### Gate 0: targeted capability and load proof

Prove commit parents, paginated pushed commits, exact-ID/version-range queries and batched PR association against the intended existing CLI context. Record endpoint version, response shape, permission result, effective identity status and latency. Avoid remote test writes in a real working project; destructive/change-creating scenarios belong in a controlled disposable test repository.

For read-only POSTs, allow only fixed `pullrequestquery` and `commitsbatch` read operations with validated bounded JSON. If invoke needs `--in-file`, use an app-created private temporary file containing query data only and remove it reliably. Never accept a browser-supplied path/body/command or enable arbitrary POSTs. If CLI cannot carry these operations reliably, document a minimal CLI-authenticated transport decision rather than silently changing credentials. (Historical: activity reads, including these two POSTs, moved to REST with the CLI's token. The POST paths were later removed with the merge analysis, and the allowlist and REST executor now accept only GET reads.)

Exit: no credential output, no extra sign-in, no Azure mutation, complete paging, correct scope, bounded error classification and measured request/process overhead. No new OAuth/app registration.

### Gate 1: merge-aware enrichment (implemented)

- Preserve raw push/ref ingestion and existing transactional checkpoints.
- Atomically queue enrichment with each newly ingested push/ref fact; commit parents cached by repository + SHA.
- Separate durable enrichment jobs/cursors from ingestion checkpoints, so a slow graph/PR lookup neither loses a job on restart nor blocks the feed from showing the push.
- Inspect each relevant branch's introduced range, including interior merge commits; handle creation/deletion and non-fast-forward paths explicitly.
- A missing parent field in a shallow/list response is unknown, not an empty-parent root commit. Hydrate it before classification. Do not use author-date filters to exclude old commits newly pushed today.
- Correlate commit batches to PRs using both supported query types. Require completed status for PR merge labels; never infer completion from preview success.
- Retain source/target/result/strategy, PR-closing identity and provenance links. Leave unavailable fields unknown.
- Keep PR creator/closer, pusher, commit author and committer as distinct identities. Prefer an explicit strategy; do not guess one from a single parent or missing metadata. Historical legacy strategy flags require documented interpretation.
- Enrich existing completed PR entities in bounded low-priority work. Preserve raw event IDs, timestamps, imported state and acknowledgement; do not generate new alerts solely for extra metadata.
- Show linked merge evidence inside the existing operation before trying aggressive cross-source row deduplication. Do not guess that same-name/same-SHA branch observations share a lifetime.

Exit: the merge cases below pass; no duplicate acknowledgement, no invented branch/actor, no extra repository mutations and no permanent negative PR-match cache.

Suggested code boundaries: extend `azure-client.js` with bounded commit/PR-query reads and
`azure-cli.js` with only those validated read-query operations. Reuse `entities` for immutable
commit metadata where practical; introduce a small versioned durable enrichment-job store rather
than replacing SQLite/sync. Keep ancestry and classification pure in a focused module and reuse
the existing queue/budget. Add local-history queries at the store/API boundary, not another cloud
service or a generic connector framework. Preserve the current simple Activity/Repositories/Settings UI.

### Gate 2: complete local-history browsing and backfill (implemented)

Replace client filtering over the latest 1000 raw rows with server-side local SQLite queries and cursor paging. New updates must query unseen data directly so an older-source-time update cannot disappear behind newer seen history. Keep UI grouping coherent across pages: use stable group/source indexes or fetch represented membership explicitly, with exact acknowledgement IDs and partial-history disclosure.

Offer resumable date-range backfill (for example 30/90 days or all available) as a background job, not one long HTTP request. Imported data stays imported; existing seen state is untouched. Record requested and verified source coverage separately for pushes, closures, refs baselines and active snapshots. Do not mistake an empty/denied response for a verified interval.

Exit: >1000 records, older unseen updates, group boundary cases, filtered paging, restart and overlapping backfill all preserve visibility and acknowledgement semantics.

### Gate 3: extended repository and PR coverage

Preserve tag updates/peeled targets and ref lock metadata. Add ancestry-based rewrite evidence, review votes, policy evaluations, conversations, linked work items, fork/source repository identity and outgoing/incoming PR scope. Capture only supported observed transitions; snapshot polling cannot recreate every intermediate/deleted comment.

Exit: a capability matrix per repo/project reports what was tested, denied or unsupported. No automatic resurrection of the removed Rules UI; this is collection coverage, not extra user setup.

### Gate 4: delivery coverage

Add explicit pipeline/project mappings plus consumed-repository resources so secondary repos and cross-project pipelines are included. Add stage/job/test/artifact evidence, then YAML environment and classic-release adapters. Trace each component `repo/revision → run → artifact → deployment attempt → environment` where the data supports it.

A recorded deployment does not prove current running bits or application health. Rollbacks, retries, skipped stages, manual/outside deployers and unresolved components must remain explicit.

### Gate 5: optional continuous event collection and administration

If short-lived/intermediate events are required while the local machine is off, use an always-on collector and supported service hooks. That requires a reachable receiver and subscription-management permission, plus durable acknowledgement, idempotent event IDs, health monitoring and reconciliation. It is a separate infrastructure choice from the lightweight local viewer.

Never treat `git.pullrequest.merged` by name as a completed PR: Microsoft documents it as **merge attempted**. Re-read/check completed status before presenting a completed merge. [S14](https://learn.microsoft.com/en-us/azure/devops/service-hooks/events?view=azure-devops#pull-request-merge-attempted)

Hooks can be retried, placed on probation or disabled; the docs explicitly say new events are lost during probation. Keep polling/backfill and show unrecoverable gaps. Hooks accelerate supported observations; they do not establish universal lossless coverage. [S15](https://learn.microsoft.com/en-us/azure/devops/service-hooks/troubleshoot?view=azure-devops#subscription-failures-and-probation-restricted)

Optional audit ingestion adds repository/policy/security/administrative evidence only for permitted events. Auditing has its own event catalog, Entra/permission requirements and 90-day retention unless exported; it is not a substitute for every Git push or merge record. [S16](https://learn.microsoft.com/en-us/azure/devops/organizations/audit/azure-devops-auditing?view=azure-devops), [S17](https://learn.microsoft.com/en-us/azure/devops/organizations/audit/auditing-events?view=azure-devops)

## Low-load contract

- Keep one shared queue, duplicate coalescing and per-repo fairness. The budget is 60 calls/minute with four in flight since activity reads moved to REST (it was 12 CLI starts/minute and two processes before); change it only after measuring with `scripts/measure-budget.js`.
- Enrich only uncached commit objects; batch across pending pushes and PR queries. No commit-parent request per branch per poll.
- Cache positive immutable objects indefinitely as appropriate; refresh mutable PR/entity metadata. Negative PR associations need expiry/invalidation on new closures or other relevant evidence.
- Avoid optional PR labels/statuses/work items until a feature actually needs them; Microsoft explicitly warns that label enrichment adds resource use. [S6](https://learn.microsoft.com/en-us/azure/devops/release-notes/2025/repos/sprint-254-update)
- Prioritize recent changes over backfill, bound per-job pages/time, and expose enrichment lag. Never silently drop a page because a work budget was exhausted.
- Validate 1/5/20 watched repos, many refs, many commits and burst pushes, including SDK discovery overhead. Eventual coverage and detection latency are separate acceptance criteria.

## Acceptance matrix

Tests below must exercise the provider contract, durable store/scheduler and visible Activity behavior; fixtures alone do not establish organization permissions or actual service payload shapes.

| Scenario | Required result |
| --- | --- |
| Completed no-FF PR | Named source/target, completed state, correct strategy/result and closing-identity provenance |
| Completed squash PR | Merged even with a single-parent result; linked via PR evidence |
| Completed rebase/rebaseMerge PR | Correct distinct strategy; no assumed unchanged source SHAs |
| Active successful preview | Still Open/Draft, never Merged |
| Direct two-or-more-parent merge, including octopus | Graph merge evidence surfaced without inventing a PR/source branch |
| Merge followed by ordinary commits in one push | Interior merge found; no new-tip-only shortcut |
| Ordinary fast-forward push | Ref advance; not falsely presented as a merge command |
| New branch at existing history | Creation shown; old merges not announced as newly performed |
| Multi-ref push | Each target ref attributed; shared commits do not produce unrelated duplicate operations |
| Source deleted after PR completion | Merge and deletion linked only by evidence; both facts retained |
| Old/new objects unavailable | Raw push retained; graph classification unknown, not fabricated |
| Non-fast-forward update | Ancestry proof and uncertainty reported separately from push identity |
| Tags: lightweight/annotated/moved/deleted | Correct namespace/object handling; no false branch merge |
| Fork/outgoing PR to another accessible project | Source and target repository/project scope retained |
| Multiple PRs/runs on the same SHA | Distinct operations; no collapse by commit alone |
| More than 1000 updates, including old-source-time unseen records | All pages/new items reachable; no hidden acknowledgement |
| Group spans page boundaries | Latest state and represented member IDs coherent; off-page/new arrivals remain safe |
| Overlapping backfill + live updates + restart | Idempotent recovery and unchanged seen/imported state |
| PR match initially empty, later available | Association refreshed; no permanent incorrect Direct classification |
| 403/404/429/transient failure/incomplete page | Visible partial/gap state, backoff, no checkpoint advance beyond verified work |
| CLI effective identity changes | Separate/blocked cache context; no unverified cross-account mixing |
| Secondary-repo/cross-project CI and deployment retry/rollback | Correct component provenance and unknown states |
| Hook duplicate/outage/probation/disabled subscription | Idempotent delivery, reconciliation and visible unrecoverable intervals |

## Remaining proof questions

1. Which of our organization's web/API branch/tag/lock operations produce readable push or hook records? Public docs do not establish universal coverage; validate in a controlled test repo.
2. Answered: activity reads now use REST directly. The transport sees continuation tokens and throttling headers. The adapter uses the continuation token, and a valid `Retry-After` pauses the shared queue.
3. Answered for activity reads: they use the CLI's Entra token, so the effective identity is the principal that token represents, and a repository connection check verifies access with a REST read. PAT-only setups are not supported for activity reads.
4. What historical push/commit/PR evidence remains available for long outages or removed objects? No universal durable Pushes retention guarantee was established.
5. Which pipeline/environment/external-deployer mappings and permissions actually exist? Documentation alone cannot prove a specific organization's coverage.

A reachable-commit graph snapshot can supplement historical pushes, but it cannot enumerate every
unreachable/deleted branch history or recover missing ref names/actions. Never label that snapshot
as complete historical activity merely because the remaining reachable graph was fully traversed.

## Sources

- S1: [Pull Request Query, REST 7.1](https://learn.microsoft.com/en-us/rest/api/azure/devops/git/pull-request-query/get?view=azure-devops-rest-7.1)
- S2: [Pull request fields and merge strategies](https://learn.microsoft.com/en-us/rest/api/azure/devops/git/pull-requests/get-pull-request?view=azure-devops-rest-7.1)
- S3: [Commit searches](https://learn.microsoft.com/en-us/rest/api/azure/devops/git/commits/get-commits?view=azure-devops-rest-7.1)
- S4: [Paginated pushed commits](https://learn.microsoft.com/en-us/rest/api/azure/devops/git/commits/get-push-commits?view=azure-devops-rest-7.1)
- S5: [Batched commit reads](https://learn.microsoft.com/en-us/rest/api/azure/devops/git/commits/get-commits-batch?view=azure-devops-rest-7.1)
- S6: [PR Query label-enrichment cost](https://learn.microsoft.com/en-us/azure/devops/release-notes/2025/repos/sprint-254-update)
- S7: [Project PR queries and source-repo scope](https://learn.microsoft.com/en-us/rest/api/azure/devops/git/pull-requests/get-pull-requests-by-project?view=azure-devops-rest-7.1)
- S8: [Refs and tag peeling](https://learn.microsoft.com/en-us/rest/api/azure/devops/git/refs/list?view=azure-devops-rest-7.1)
- S9: [Pipeline run resources](https://learn.microsoft.com/en-us/rest/api/azure/devops/pipelines/runs/get?view=azure-devops-rest-7.1) and [official consumed-resource example](https://learn.microsoft.com/en-us/azure/devops/release-notes/2022/sprint-209-update?tabs=yaml#consumed-resources-and-template-parameters-in-pipelines-runs-rest-api)
- S10: [YAML environment deployment records](https://learn.microsoft.com/en-us/rest/api/azure/devops/distributedtask/environmentdeployment-records/list?view=azure-devops-rest-7.1)
- S11: [Classic release deployments](https://learn.microsoft.com/en-us/rest/api/azure/devops/release/deployments/list?view=azure-devops-rest-7.1)
- S12: [Git fast-forward behavior](https://git-scm.com/docs/user-manual#fast-forwards)
- S13: [Git squash behavior](https://git-scm.com/docs/git-merge#Documentation/git-merge.txt---squash)
- S14: [Service-hook merge-attempt semantics](https://learn.microsoft.com/en-us/azure/devops/service-hooks/events?view=azure-devops#pull-request-merge-attempted)
- S15: [Hook retries, probation and lost events](https://learn.microsoft.com/en-us/azure/devops/service-hooks/troubleshoot?view=azure-devops#subscription-failures-and-probation-restricted)
- S16: [Auditing access/retention](https://learn.microsoft.com/en-us/azure/devops/organizations/audit/azure-devops-auditing?view=azure-devops)
- S17: [Audit event catalog](https://learn.microsoft.com/en-us/azure/devops/organizations/audit/auditing-events?view=azure-devops)

API references may still show legacy OAuth example metadata. This plan does not adopt that flow; the product continues to use the existing Azure CLI configuration.
