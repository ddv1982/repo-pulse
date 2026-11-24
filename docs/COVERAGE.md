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
  A push gets a new PR link only when it moved a branch to the merge commit of a completed PR in the same repository whose target is that branch. The link is skipped when complete saved evidence shows the push did not introduce that commit. Multi-parent objects are no longer inspected. PR links saved by the removed merge analysis are still shown. Neither invents source branch names or human commands. Fast-forward and squash intent can remain unknowable.
  The "Merge commit" row badge and filter are gone. A merge commit listed in evidence saved earlier still shows under "How this was merged" in the push detail.
- A commit inside a push that is not its new tip is searchable only through evidence saved earlier. Push tips, PR commits and build commits remain searchable.
- Branch rename has no semantic event model. A new push that moves an existing branch is checked once
  per moved branch, in the background while automatic checks are on: one Azure read of the commits
  the old tip reaches and the new tip does not. None is a fast-forward, any is a history rewrite
  ("History rewritten"), and an old tip Azure no longer has, or a read that keeps failing, leaves it
  unknown. Imported pushes, from the first sync or a history import, are not checked. Unequal tips
  alone are never called a rewrite, and a rewrite does not identify the command that caused it. Tag pushes become tag rows; a tag-only push is not shown as a push.
- Azure records each refresh of a pull request's merge preview as a push of `refs/pull/N/merge`. A push that
  moves only such refs is not shown or counted, because it is not repository work. Service pushes without a
  branch that were saved before this rule are hidden. The same rows pushed by a person stay, shown as
  "Repository push", because their saved record does not say which ref moved.
- A snapshot discovery and a later push record can both describe the same branch. They remain
  separate observations when the app cannot prove a shared branch lifetime/source identity.
- The branch tree in **All activity** and **New updates** follows the newest-first rows on the page. A lane joins
  nearby rows in the same branch lifetime and ends when the branch is quiet for more than 12 rows. Cached push-confirmed
  creations and deletions separate lifetimes even when those rows are hidden by filters, pagination, or seen state.
- A branch created by a push, live or from the first sync's 7-day import, is checked in the background, during the automatic-check turns when no
  rewrite check is due, and waits while the repository's push stream is still paging through a window. Imported rows
  stored before fork checks existed stay unchecked in a repository that had run an explicit history import, because
  its imported rows cannot be told apart. The
  check reads commits from the created tip back past the ones that push brought,
  one read per commit and at most 8, to find the commit the branch started at. A solid fork means that
  commit was the latest recorded tip of exactly one other branch before the push ("the tip of main"), or,
  when no recorded tip matched, that exactly one checked branch already contained it ("already on main").
  The checked branches are the branch's stored pull request targets and the repository's most common
  pull request target, at most three, one read each. Git records no branch parentage, so neither proves
  which branch the author started from, and a recorded tip can be stale when pushes are missing from the
  store. Several matching branches, a pull request target that did not hold the commit, no matching
  branch, an orphan branch or a first commit that is a merge draw no fork and say so in the row text.
- Branches the check did not cover (an explicit history import, snapshot
  discoveries, and checks that failed before finding the start commit) may show a dotted fork to the target of a visible
  open pull request from the branch, labelled "origin not checked". A
  completed pull request draws a merge from its own source and target refs. A CI run on a pull
  request ref (`refs/pull/N/merge`) is placed on the source branch of that pull request, read from the
  stored pull request records, and its row names that branch and the pull request. Multi-branch pushes and builds on tags
  use separate markers. A branch with a single
  row on the page keeps a grey dot, so a merge that restarts validation for many open pull requests shows
  as many separate dots. A line can pass rows of other branches. Filters, paging and
  the four-lane limit can remove links, so a missing line never shows that branches are unrelated. Below 640px the layout
  uses the compact markers and retains the row's fork text.
- A branch created and deleted entirely between readable observations may be missed. Loss of ref
  visibility cannot safely be presented as confirmed deletion without direct evidence.

## Time, cache and completeness limits

- First import requests approximately seven days of pushes, PR closures and recent builds. Current
  active PRs/runs are also read, so old active entities can legitimately have much older source times.
  Ref import establishes a current baseline rather than the history of every pre-existing branch.
- Pushes, PR closures and recent builds use independent checkpoints with overlapping time ranges.
  A page-one retry extends the upper bound to the retry time. Later pages keep the original range
  while the read makes progress. A ten-minute gap between pages, or retrying a failed window that
  opened at least ten minutes ago, restarts at page one with the original lower bound and a new upper bound. A completed read that took longer than the normal check interval
  is immediately due for another check while automatic checks are on. Catch-up still depends on
  Azure history availability, permissions and successful completion of every page.
- Current refs, active PRs and active builds restart at page one if a saved partial listing is
  at least two minutes old and its read failed, the app restarted, or the listing stopped being
  due because the repository was disabled or automatic checks were paused. A two-minute gap
  between live turns also expires old listings. Healthy listings keep paging while they stay due. A refs scan requests up to 1,000 refs per page and defers to a push
  observed since the scan started. “Branch no longer listed” means the branch was missing from
  the refs listing. It does not identify a rewrite or establish the time or actor of a removal.
- Polling can miss intermediate states, edits, votes or temporary entities. It cannot reconstruct
  every action that happened while the process was stopped or between successful checks.
- Activity uses server-side grouped SQLite pages, including older unseen records. Stable cursors exclude concurrent inserts. **Mark all seen** (**Mark all matching seen** with filters) collects the matching unread IDs across pages up to the snapshot the page was read at. It confirms when some are below the rendered rows, and otherwise marks them at once. Deep links resolve outside the first page.
- The browser polls local metadata and reloads the Activity window when its revision changes. Activity filters include types, statuses, and completed PR links from matching cached history, including items beyond the loaded page. Status filters match the displayed group after search and repository scope are applied. Manual refresh, navigation, and pagination can still request pages explicitly.
- Existing raw events remain immutable. Supplemental merge metadata preserves event identity, time and seen/imported flags, and creates no metadata-only notification. A schema migration removed the merge-analysis queue and marks evidence it left unfinished as incomplete. A later one deletes the commits and commit-to-PR lookups that analysis cached, then compacts the database file.
- Explicit 30/90-day or all-available-since-2010 import persists one bounded page at a time. Historical imports stop at the monitoring baseline and never rewind live checkpoints. Completed means requested pages succeeded, not universal source retention. Different ranges wait until the active import completes.
- The shared budget is 60 calls/minute with four in flight. Activity reads normally use one REST request
  made with an Azure CLI token (one retry after a token renewal); other commands still start `az`, which can make several requests
  internally. Normal checks are around three minutes, quiet/background checks five minutes and refs
  ten minutes, subject to queueing and backoff. After a successful turn, live checks that are already
  due can start the next turn after 100 ms. They still use the same shared budget.
- When any REST response carries a valid positive `Retry-After` header, the shared queue starts no new
  read for any repository until that wait has passed, up to ten minutes. A read that was already waiting
  for a token fails as throttled. A failed live sync read is retried after its normal backoff only while
  automatic checks are on; with them off, a manual refresh ends when its read fails. An explicit history
  import retries either way.
- Background work is the rewrite check for new pushes and an explicit history import, taking turns.
  The fork origin check of new branches uses the rewrite check's turn when no rewrite check is due.
  Rewrite and fork checks wait while automatic checks are off; a history import keeps running. Background work
  gets every turn when no live check is due and, under sustained live work, one turn after six live
  turns. These are scheduler turns, so queueing and provider response times still affect freshness.
- The server derives one sync status per enabled repository. The header shows the one that needs the
  most attention, in the order Problem, Delayed, Syncing, Paused, Synced. A repository takes the first
  status that applies: **Paused** when automatic checks are off and no manual refresh or history import
  is outstanding; **Problem** when the latest read failed for a reason other than throttling and the
  stream has failed at least twice since its last completed check, or at once when sign-in or access is
  refused or the Azure CLI or its extension is missing; **Delayed** while Azure DevOps asked for a pause,
  when a stream's last read was throttled, or when a check is more than three minutes late or its data
  is older than ten minutes (twenty for refs); **Syncing** while a first read, page, refresh or import
  is still running; otherwise **Synced**. While Start from scratch deletes data every repository shows
  Syncing, and after it fails, Problem. Demo mode always shows Synced. Streams catching up right after a start or resume count as
  syncing, not delayed. Until every shown repository is synced, an empty or short Activity list does
  not prove that nothing changed.
- **Start from scratch** in Settings deletes stored activity, seen marks, imported history, sync
  checkpoints and pending jobs, keeps repositories, linked checkouts and settings, and then runs the
  first import again. History imports are refused while the reset is pending or clearing data, and
  accepted again during the first import that follows. Demo mode does not offer it.
- Effective Azure identity/cross-account cache isolation is not verified. Use one CLI context; an
  installation or cached account check is not proof of access to every repository/environment.

## Checkout diagnostics

**Switch to …** on an Activity detail names the branch the activity leaves: a new branch, a push that moved one branch (deleted branches in the same push are ignored), a build on a branch, the source of an active pull request whose row records that it comes from this repository, or the target of a completed one. Abandoned pull requests, active pull requests from a fork or stored before their source repository was recorded, tags, and pushes that moved several branches offer no switch. **Switch branch…** in Repositories lists the repository's watched branches from stored refs, with no Azure call, and marks which exist locally; the server accepts only a branch the repository still lists. Both use the linked checkout and the branch's current remote tip. It refreshes the local tracking ref before switching. A rewritten upstream or a diverged local branch requires review. On confirmation of a rewrite, Repo Pulse saves the previous tip in a local recovery ref before advancing the tracker. An existing local branch keeps its commits. Git carries compatible edits and can refuse the switch if it would overwrite local files. If the tracker refresh succeeds and Git refuses the switch, Repo Pulse reports the partial result.

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
