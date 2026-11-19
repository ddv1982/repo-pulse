# Repository activity coverage

Repo Pulse records observable repository activity for the watched repos. It can miss actions between checks and cannot reconstruct a complete audit log. The [Azure API research](FULL-COVERAGE-RESEARCH.md) records endpoint behavior, source limits, and planned extensions.

## What is collected today

| Source | Collected facts | Important boundary |
| --- | --- | --- |
| Repository pushes | Push identity/time/pusher, branch ref old/new revisions, source links | Repository-wide, before PRs exist. A push is linked to a completed PR when a ref it moved now points at that PR's merge commit on the PR's target ref; the match uses stored records and makes no Azure call. Deeper analysis of the commits in a push no longer runs; evidence saved earlier is kept. On-demand commit lists remain available. An empty cached list is not proof that no code changed. |
| Remote branches and tags | Creation/deletion evidence from branch ref updates; tag creation, movement and deletion from pushes; periodic complete ref snapshots with peeled tag targets | Snapshot differences establish first observation or absence, not exact creation/deletion time or actor. A pushed tag may point at an annotated tag object; only the snapshot names the tagged commit. |
| Pull requests | Active snapshots and recent closures: status, draft flag, title, source revision, source/target refs, reviewers and votes, fork repository and project for PRs from forks, PR link | Snapshot changes produce activity, including reviewer vote changes seen between checks. A vote changed and changed back between checks is missed. Discussion thread counts and policy evaluation results are read only when a PR detail asks for them, and show the current state, not its history. Descriptions, labels and auto-complete configuration are not tracked. |
| Completed PR merge data | Source/target branch, source commit and, when supplied, resulting merge commit, pre-merge target commit, merge status and strategy | Completion metadata is retained on newly emitted completed-PR snapshots using the existing list/detail response. No extra Azure request is added. |
| CI runs | Recent and active primary-repository runs, status/result, source revision/ref, triggering reason and source link | Uses the watched repository's project and primary TfsGit repository identity. Not complete multi-repo/cross-project pipeline discovery. |
| Previously active entities | Limited exact-ID reconciliation for vanished active PRs and builds | Up to three PRs and twenty build IDs per completed reconciliation pass; more work can take later cycles. |

## What "Merged" means

Azure PR completion merges changes into the target branch. The UI can therefore present a cached
`status: completed` PR as a merged PR with its known source-to-target direction, even if an older
cached event lacks a merge hash. A source branch can remain after that merge or be deleted
separately; these are different facts.

An active PR can expose `lastMergeCommit` and `mergeStatus: succeeded` for a **preview** merge.
Those values alone do not mean that the PR completed. The sync stores actual merge-result fields
only for completed PRs. `targetCommit` is the target revision before the merge; `mergeCommit` is
Azure's resulting integrated revision and is optional for strategies/records where it is absent.

The PR creator comes from `createdBy`. When Azure supplies `closedBy`, the detail view labels it "PR closed by." That identity does not establish who performed a Git merge.

Sources: [Complete a PR](https://learn.microsoft.com/en-us/azure/devops/repos/git/complete-pull-requests?view=azure-devops),
[PR API fields](https://learn.microsoft.com/en-us/rest/api/azure/devops/git/pull-requests/get-pull-request?view=azure-devops-rest-7.1).

Evidence saved before deeper analysis stopped also enumerated ref ranges, because a push-associated commit list can be empty when a target branch moves to an already-created PR result. It read revisions reachable from the new tip excluding the old-tip history. The installed API was verified with `compareVersion=new` (walk tip) and `itemVersion=old` (base), both explicit commit descriptors. Candidates and proven introduced revisions remain separate in that evidence.

## Merge and branch gaps

- A direct `git merge`, squash, rebase or cherry-pick pushed without a PR is observed as a push.
  A completed PR association is shown only when the push's new tip is the PR's merge commit; multi-parent objects are no longer inspected. Neither invents source branch names or human commands. Fast-forward and squash intent can remain unknowable.
  The "Merge commit" row badge and filter are gone. A merge commit listed in evidence saved earlier still shows under "How this was merged" in the push detail.
- A commit inside a push that is not its new tip is searchable only through evidence saved earlier. Push tips, PR commits and build commits remain searchable.
- Branch rename has no semantic event model. History rewrites are no longer checked for new pushes.
  Evidence saved earlier read, for each moved branch, the commits the old tip reaches and the new
  tip does not: none is a fast-forward, any is a history rewrite, and an unreadable old tip leaves
  it unknown. Unequal tips alone are never called a rewrite, and a rewrite does not identify the
  command that caused it. Tag pushes become tag rows; a tag-only push is not shown as a push.
- A snapshot discovery and a later push record can both describe the same branch. They remain
  separate observations when the app cannot prove a shared branch lifetime/source identity.
- A branch created and deleted entirely between readable observations may be missed. Loss of ref
  visibility cannot safely be presented as confirmed deletion without direct evidence.

## Time, cache and completeness limits

- First import requests approximately seven days of pushes, PR closures and recent builds. Current
  active PRs/runs are also read, so old active entities can legitimately have much older source times.
  Ref import establishes a current baseline rather than the history of every pre-existing branch.
- Subsequent runs resume independent persisted checkpoints with overlap and paginated fixed windows;
  they do not reset the catch-up window to seven days on each restart. Catch-up still depends on
  Azure history availability, permissions and successful completion of every page.
- Polling can miss intermediate states, edits, votes or temporary entities. It cannot reconstruct
  every action that happened while the process was stopped or between successful checks.
- Activity uses server-side grouped SQLite pages, including older unseen records. Stable cursors exclude concurrent inserts, and acknowledgement uses only the exact shown matching raw IDs. Deep links resolve outside the first page.
- The browser polls local metadata and reloads the Activity window when its revision changes. Activity filters include types, statuses, and completed PR links from matching cached history, including items beyond the loaded page. Status filters match the displayed group after search and repository scope are applied. Seen actions still use the exact unseen updates in the shown groups. Manual refresh, navigation, and pagination can still request pages explicitly.
- Existing raw events remain immutable. Supplemental merge metadata preserves event identity, time and seen/imported flags, and creates no metadata-only notification. A schema migration removed the merge-analysis queue and marks evidence it left unfinished as incomplete. A later one deletes the commits and commit-to-PR lookups that analysis cached, then compacts the database file.
- Explicit 30/90-day or all-available-since-2010 import persists one bounded page at a time. Historical imports stop at the monitoring baseline and never rewind live checkpoints. Completed means requested pages succeeded, not universal source retention. Different ranges wait until the active import completes.
- The shared budget is 60 calls/minute with four in flight. Activity reads normally use one REST request
  made with an Azure CLI token (one retry after a token renewal); other commands still start `az`, which can make several requests
  internally. Normal checks are around three minutes, quiet/background checks five minutes and refs
  ten minutes, subject to queueing and backoff.
- The only background work is an explicit history import. It gets every turn when no live check is due and, under sustained live work, one turn after six live turns. These are scheduler turns, so queueing and provider response times still affect freshness.
- Effective Azure identity/cross-account cache isolation is not verified. Use one CLI context; an
  installation or cached account check is not proof of access to every repository/environment.

## Checkout diagnostics

**Check for updates** reports missing refs and access failures separately. A missing ref says what Git could find through the configured remote. Repo Pulse uses cached completed PRs first and can look up one bounded page in Azure on demand. When Git verifies that the target contains the recorded PR result and a clean checkout can switch to the matching local target, Repo Pulse offers **Switch to … and update**. The update requires a fast-forward and verifies the PR result against the newly fetched tip. If the switch succeeds and the update is blocked, the target stays checked out.

**Review old branch** shows whether the old tip is included, has local follow-up commits, or could not be verified. Removing the local branch requires confirmation and saves a Git recovery ref before removing the exact reviewed tip. A linear series of up to 30 verified follow-up commits can be selected for a new local branch. Git applies the commits in a separate worktree so a conflict can be continued or aborted there. These actions read the remote and update local Git data only.

Repo Pulse compares the last recorded upstream tip and the tip observed immediately before fetch against the new tip. It preserves those baselines if a check is interrupted and blocks Pull on a non-fast-forward rewrite or incomplete ancestry. The comparison shows up to 12 commits from the two versions. A graph rewrite does not identify the command that caused it. Azure's completion strategy can establish whether a particular PR used rebase. Repo Pulse reports an in-progress local rebase or merge and leaves it for the user to finish in Git. Repo Pulse leaves reconciliation and rebases to Git.

## Not implemented as complete coverage

Deployment provenance/current running version, YAML environments/classic releases/external deployers,
pipeline stages/jobs/logs/test results/artifact provenance, work-item/change correlations, full PR
review/policy history, multi-repository pipeline resources and cross-project pipeline mappings.
Unpushed work on other machines is invisible. Successful CI or a completed PR does not prove that
the code is deployed or ready for testing.

## Validation for merge and history milestones

Focused sync tests cover completed PR source/target/result/strategy, no extra provider reads,
no repeated notification for an unchanged completion, creator attribution, and active successful
preview/abandoned records never acquiring actual merge-result fields. No real Azure writes or
live-database edits were used for this validation.
