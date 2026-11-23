/** @typedef {import('../src/activity.ts').RefUpdate} RefUpdate */
/** @typedef {{ data?: { refUpdates?: RefUpdate[] } }} PushEvent */
/** A branch update that moved an existing branch to another existing object. */
/** @typedef {RefUpdate & { name: string, oldObjectId: string, newObjectId: string }} MergeUpdate */

const ZERO = /^0+$/;
/** @param {PushEvent} event */
const branchUpdates = event => (event.data?.refUpdates || []).filter(ref => ref.name?.startsWith('refs/heads/'));

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

/**
 * A completed PR whose merge commit is the new tip of a ref the push moved, in the EvidencePr shape saved evidence
 * already uses (src/activity.js). Tip identity proves the push set the target to the PR's result, so no query is involved.
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
