import type { ActivityItem } from '../activity.ts';
import { singleNamedPushResult } from '../activity-text.ts';
import { checkedUpdates } from './merge-evidence.ts';

function mergeKey(item: ActivityItem) {
  const { mergeCommit, pullRequestId, status, targetRefName } = item.data ?? {};
  if (item.kind === 'pr' && status === 'completed' && pullRequestId && targetRefName && mergeCommit) {
    return JSON.stringify([item.repoId, String(pullRequestId), targetRefName, mergeCommit.toLowerCase()]);
  }
}

function pushKey(item: ActivityItem) {
  if (item.kind !== 'push' || item.events.length !== 1 || item.data?.refUpdates?.length !== 1) return;
  if (checkedUpdates(item.data).some(range => range.update.status === 'rewrite')) return;
  const result = singleNamedPushResult(item.data);
  if (result?.pr.mergeCommit) {
    return JSON.stringify([item.repoId, String(result.id), result.pr.targetRefName, result.pr.mergeCommit.toLowerCase()]);
  }
}

/** Links are a presentation of the loaded mixed feed. Search, totals and underlying event identities stay independent. */
export function linkedMergePushes(items: ActivityItem[]) {
  const links = new Map<string, ActivityItem>();
  const pushes = new Map<string, ActivityItem | null>();
  for (const item of items) {
    const key = pushKey(item);
    if (key) pushes.set(key, pushes.has(key) ? null : item);
  }
  for (const item of items) {
    const key = mergeKey(item);
    if (!key) continue;
    const push = pushes.get(key);
    // An unseen push beside an already-seen PR deserves a visible row of its own.
    if (!push || push.relatedCi?.length || (push.unseen && !item.unseen)) continue;
    links.set(item.id, push);
    pushes.delete(key);
  }
  return links;
}
