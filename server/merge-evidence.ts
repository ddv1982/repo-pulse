import type { RefUpdate } from '../src/activity.ts';

export type { RefUpdate };
export type PushEvent = { data?: { refUpdates?: RefUpdate[] } };
/** A branch update that moved an existing branch to another existing object. */
export type MergeUpdate = RefUpdate & { name: string; oldObjectId: string; newObjectId: string };

const ZERO = /^0+$/;
const branchUpdates = (event: PushEvent) => (event.data?.refUpdates || []).filter(ref => ref.name?.startsWith('refs/heads/'));

export function mergeUpdates(event: PushEvent): MergeUpdate[] {
  return branchUpdates(event).filter((ref): ref is MergeUpdate =>
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
 * already uses (src/activity.ts). Tip identity proves the push set the target to the PR's result, so no query is involved.
 */
export function localPrLink({
  url,
  data = {},
}: {
  url?: string;
  data?: {
    pullRequestId?: number | string;
    sourceRefName?: string;
    targetRefName?: string;
    sourceCommit?: string;
    targetCommit?: string;
    mergeCommit?: string | undefined;
    mergeStrategy?: string;
    closedBy?: string;
  };
}) {
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
