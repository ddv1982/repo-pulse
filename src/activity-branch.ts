import { branchName } from './events.ts';

const LIVE = /^[a-f0-9]{40}$/i;

const headName = (ref: unknown) => (typeof ref === 'string' && ref.startsWith('refs/heads/') && ref.length > 11 ? branchName(ref) : null);

/**
 * The one branch an activity leaves to switch to, or null when it names none or several. A completed pull request
 * leaves its target, an active one whose row shows it comes from this repository its source. A push that also deletes branches still names the
 * one branch it moved.
 */
export function activityBranch(event: import('./activity.ts').ActivityEvent) {
  const { kind, data } = event;
  if (kind === 'branch-created') return headName(data?.name);
  if (kind === 'build') return headName(data?.sourceBranch);
  if (kind === 'pr') {
    if (data?.status === 'completed') return headName(data.targetRefName);
    // Only a row that recorded both repositories can show the source branch is not a fork's branch of the same name.
    const { sourceRepositoryId: source, targetRepositoryId: target } = data ?? {};
    const local = typeof source === 'string' && typeof target === 'string' && source.toLowerCase() === target.toLowerCase();
    return data?.status === 'active' && local ? headName(data.sourceRefName) : null;
  }
  if (kind !== 'push') return null;
  const updates = data?.refUpdates ?? [];
  const moved = updates.filter(update => LIVE.test(update.newObjectId ?? '') && !/^0+$/.test(update.newObjectId ?? ''));
  const deleted = updates.filter(update => /^0+$/.test(update.newObjectId ?? ''));
  const [only] = moved;
  if (!only || moved.length !== 1 || moved.length + deleted.length !== updates.length) return null;
  return headName(only.name);
}
