import { branchName } from './events.js';

const LIVE = /^[a-f0-9]{40}$/i;

/** @param {unknown} ref */
const headName = ref => (typeof ref === 'string' && ref.startsWith('refs/heads/') && ref.length > 11 ? branchName(ref) : null);

/**
 * The one branch an activity leaves to switch to, or null when it names none or several. A completed pull request
 * leaves its target, an active one from this repository its source. A push that also deletes branches still names the
 * one branch it moved.
 * @param {import('./activity.js').ActivityEvent} event
 */
export function activityBranch(event) {
  const { kind, data } = event;
  if (kind === 'branch-created') return headName(data?.name);
  if (kind === 'build') return headName(data?.sourceBranch);
  if (kind === 'pr') {
    if (data?.status === 'completed') return headName(data.targetRefName);
    return data?.status === 'active' && !data.fork ? headName(data.sourceRefName) : null;
  }
  if (kind !== 'push') return null;
  const updates = data?.refUpdates ?? [];
  const moved = updates.filter(update => LIVE.test(update.newObjectId ?? '') && !/^0+$/.test(update.newObjectId ?? ''));
  const deleted = updates.filter(update => /^0+$/.test(update.newObjectId ?? ''));
  if (moved.length !== 1 || moved.length + deleted.length !== updates.length) return null;
  return headName(moved[0].name);
}
