/** @typedef {import('../src/activity.js').RefUpdate} RefUpdate */
/** @typedef {{ data?: { refUpdates?: RefUpdate[] } }} PushEvent */
/** A branch update that moved an existing branch to another existing object. */
/** @typedef {RefUpdate & { name: string, oldObjectId: string, newObjectId: string }} MergeUpdate */
/** Azure commit objects; `parents` is present only once a commit has been hydrated. */
/**
 * @typedef {{ commitId: string, parents?: string[], comment?: string, author?: unknown, committer?: unknown,
 *   remoteUrl?: string, url?: string }} CommitRecord
 */
/** Reachability lookups may be asked for an id a parent list did not supply. */
/** @typedef {ReadonlyMap<string | undefined, CommitRecord>} CommitGraph */
/**
 * Whether a moved branch kept its old tip. `dropped` counts the commits read from the old tip that the new tip
 * no longer reaches, up to one page; `more` says the page was full.
 * @typedef {{ status: 'fast-forward' | 'rewrite' | 'unknown', dropped?: number, more?: boolean }} HistoryUpdate
 */
/** @typedef {{ name?: string, oldObjectId: string, newObjectId: string, commitIds: string[], complete: boolean, update?: HistoryUpdate }} RefRange */
/** @typedef {import('./azure-client.js').PullRequestAssociation} PullRequestAssociation */
/**
 * @typedef {{ checkedAt?: string, associationExpiresAt?: string, complete?: boolean, limitations?: string[],
 *   graphRecords?: CommitRecord[], refRanges?: RefRange[] }} ClassifyOptions
 */
/** @typedef {NonNullable<ReturnType<typeof completedPr>>} CompletedPr */
/**
 * @typedef {{ commitId: string, parents: string[], branches: (string | undefined)[], comment?: string, author?: unknown,
 *   committer?: unknown, url?: string, evidence: 'commit-parents', oldBoundaryVerified: boolean }} MergeCommit
 */
/**
 * @typedef {{ status: 'not-applicable'|'complete'|'partial', checkedAt?: string, associationExpiresAt?: string,
 *   candidateCommitIds?: string[], introducedCommitIds: string[], introducedCommitCount: number,
 *   refRanges?: RefRange[], commits: MergeCommit[], prs: CompletedPr[], limitations: string[] }} MergeEvidence
 */

const ZERO = /^0+$/;
/** @param {PushEvent} event */
const branchUpdates = event => (event.data?.refUpdates || []).filter(ref => ref.name?.startsWith('refs/heads/'));
/** @param {unknown} value */
const normalizedId = value => String(value || '').toLowerCase();

/** @param {PushEvent} event @returns {MergeUpdate[]} */
export function mergeUpdates(event) {
  return branchUpdates(event).filter(
    /** @returns {ref is MergeUpdate} */
    ref =>
      Boolean(
        ref.oldObjectId &&
          ref.newObjectId &&
          ref.oldObjectId !== ref.newObjectId &&
          !ZERO.test(ref.oldObjectId) &&
          !ZERO.test(ref.newObjectId),
      ),
  );
}

/** @param {RefRange[] | undefined} ranges @param {MergeUpdate} ref */
const rangeFor = (ranges, ref) =>
  ranges?.find(range => range.name === ref.name && range.oldObjectId === ref.oldObjectId && range.newObjectId === ref.newObjectId);

/**
 * Reachability is restricted to known introduced objects, never guessed from dates/messages.
 * @param {string} head @param {string} target @param {CommitGraph} commits
 */
function reaches(head, target, commits) {
  const pending = [head],
    visited = new Set();
  while (pending.length) {
    const id = pending.pop();
    if (id === target) return true;
    if (visited.has(id)) continue;
    visited.add(id);
    const commit = commits.get(id);
    if (Array.isArray(commit?.parents)) pending.push(...commit.parents);
  }
  return false;
}

/** @param {string} head @param {CommitGraph} commits */
function knownBoundary(head, commits) {
  const pending = [head],
    visited = new Set();
  while (pending.length) {
    const id = pending.pop();
    if (visited.has(id)) continue;
    visited.add(id);
    const commit = commits.get(id);
    if (!Array.isArray(commit?.parents)) return false;
    pending.push(...commit.parents);
  }
  return true;
}

/**
 * @param {{ azureId: string }} repo @param {PullRequestAssociation} association @param {CommitGraph} introduced
 * @param {MergeUpdate[]} updates @param {RefRange[] | undefined} refRanges
 */
function completedPr(repo, association, introduced, updates, refRanges) {
  const pr = association.pullRequest;
  if (
    pr?.status !== 'completed' ||
    !pr.repository?.id ||
    normalizedId(pr.repository.id) !== normalizedId(repo.azureId) ||
    !updates.some(ref => ref.name === pr.targetRefName) ||
    !introduced.has(association.commitId)
  )
    return null;
  const result = pr.lastMergeCommit?.commitId;
  return {
    pullRequestId: pr.pullRequestId,
    status: 'completed',
    title: pr.title,
    sourceRefName: pr.sourceRefName,
    targetRefName: pr.targetRefName,
    sourceCommit: pr.lastMergeSourceCommit?.commitId,
    targetCommit: pr.lastMergeTargetCommit?.commitId,
    mergeCommit: result,
    mergeStrategy: pr.completionOptions?.mergeStrategy,
    createdBy: pr.createdBy,
    closedBy: pr.closedBy,
    closedDate: pr.closedDate,
    url: pr._links?.web?.href || pr.url,
    relationship:
      result &&
      introduced.has(result) &&
      updates.some(
        ref =>
          ref.name === pr.targetRefName &&
          (refRanges === undefined
            ? reaches(ref.newObjectId, result, introduced)
            : rangeFor(refRanges, ref)?.complete && rangeFor(refRanges, ref)?.commitIds.includes(result)),
      )
        ? 'result-introduced'
        : 'constituent-related',
    associatedCommits: [association.commitId],
    queryTypes: [association.queryType],
  };
}

/**
 * Pure classification: "no PR match" never establishes that a merge was direct/unlinked.
 * @param {{ azureId: string }} repo @param {PushEvent} event @param {CommitRecord[]} records
 * @param {PullRequestAssociation[]} [associations] @param {ClassifyOptions} [options]
 * @returns {MergeEvidence}
 */
export function classifyMergeEvidence(
  repo,
  event,
  records,
  associations = [],
  { checkedAt, associationExpiresAt, complete = true, limitations = [], graphRecords = records, refRanges } = {},
) {
  const updates = mergeUpdates(event);
  const introduced = new Map(records.filter(commit => commit?.commitId).map(commit => [commit.commitId, commit]));
  const graph = new Map(graphRecords.filter(commit => commit?.commitId).map(commit => [commit.commitId, commit]));
  const notes = [...limitations];
  if (!updates.length) {
    return {
      status: 'not-applicable',
      checkedAt,
      introducedCommitIds: [],
      introducedCommitCount: 0,
      commits: [],
      prs: [],
      limitations: ['Branch creation/deletion alone does not establish a merge performed in this push.'],
    };
  }
  const incomplete = [...introduced.values()].some(commit => !Array.isArray(commit.parents));
  let graphGap = incomplete;
  if (incomplete) notes.push('Some introduced commit parents are unavailable; graph classification is incomplete.');
  const commits = [...introduced.values()]
    .filter(
      /** @returns {commit is CommitRecord & { parents: string[] }} */
      commit => Array.isArray(commit.parents) && commit.parents.length > 1,
    )
    .flatMap(
      /** @returns {MergeCommit[]} */
      commit => {
        const reachable = updates.filter(ref => reaches(ref.newObjectId, commit.commitId, graph));
        const refs = reachable.filter(ref => {
          const range = rangeFor(refRanges, ref);
          return range?.complete ? range.commitIds.includes(commit.commitId) : !reaches(ref.oldObjectId, commit.commitId, graph);
        });
        const branches = refs.map(ref => ref.name);
        if (!branches.length) {
          if (!reachable.length) {
            graphGap = true;
            notes.push('A merge object was returned but could not be assigned to a changed branch from the available graph.');
          }
          return [];
        }
        const oldBoundaryVerified = refs.every(ref => {
          const range = rangeFor(refRanges, ref);
          return range?.complete ? range.commitIds.includes(commit.commitId) : knownBoundary(ref.oldObjectId, graph);
        });
        if (!oldBoundaryVerified) {
          graphGap = true;
          notes.push(
            'The old branch ancestry boundary is incomplete; merge objects do not prove a merge operation performed in this push.',
          );
        }
        return [
          {
            commitId: commit.commitId,
            parents: [...commit.parents],
            branches,
            comment: commit.comment,
            author: commit.author,
            committer: commit.committer,
            url: commit.remoteUrl || commit.url,
            evidence: 'commit-parents',
            oldBoundaryVerified,
          },
        ];
      },
    );
  /** @type {Map<string, CompletedPr>} */
  const prs = new Map();
  for (const association of associations) {
    const item = completedPr(repo, association, introduced, updates, refRanges);
    if (!item) continue;
    const key = `${item.pullRequestId}:${item.targetRefName}`;
    const previous = prs.get(key);
    if (previous) {
      previous.associatedCommits = [...new Set([...previous.associatedCommits, ...item.associatedCommits])];
      previous.queryTypes = [...new Set([...previous.queryTypes, ...item.queryTypes])];
    } else prs.set(key, item);
  }
  if (commits.length && !prs.size)
    notes.push('No completed PR association observed at this check; source branch and integration intent remain unknown.');
  if ([...prs.values()].some(pr => pr.relationship === 'constituent-related'))
    notes.push('A completed PR is related, but its resulting revision was not established among the introduced commits.');
  // A range whose old tip Azure could not read leaves that update's introduced commits unproven.
  const unproven = (refRanges || []).some(range => range.complete === false && range.update?.status === 'unknown');
  if (unproven) notes.push('Azure could not list the commits a branch update introduced; coverage for that update is unproven.');
  const introducedCommitIds =
    refRanges === undefined ? [...introduced.keys()] : [...new Set(refRanges.flatMap(range => range.commitIds || []))];
  return {
    status: complete && !graphGap && !unproven ? 'complete' : 'partial',
    checkedAt,
    associationExpiresAt,
    candidateCommitIds: [...introduced.keys()],
    introducedCommitIds,
    introducedCommitCount: introducedCommitIds.length,
    refRanges,
    commits,
    prs: [...prs.values()],
    limitations: [...new Set(notes)],
  };
}

/**
 * A completed PR whose merge commit is the new tip of a ref the push moved, written into `prs` in the shape
 * `completedPr` writes. Tip identity proves the push set the target to the PR's result, so no query is involved.
 * @param {{ url?: string, data?: { pullRequestId?: number | string, sourceRefName?: string, targetRefName?: string,
 *   sourceCommit?: string, targetCommit?: string, mergeCommit?: string, mergeStrategy?: string, closedBy?: string } }} event
 */
export function localPrLink({ url, data = {} }) {
  return {
    pullRequestId: data.pullRequestId,
    status: 'completed',
    sourceRefName: data.sourceRefName,
    targetRefName: data.targetRefName,
    sourceCommit: data.sourceCommit,
    targetCommit: data.targetCommit,
    mergeCommit: data.mergeCommit,
    mergeStrategy: data.mergeStrategy,
    closedBy: data.closedBy,
    url,
    relationship: 'result-introduced',
    associatedCommits: [data.mergeCommit],
    queryTypes: [],
  };
}
