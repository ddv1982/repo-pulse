import { branchName } from './events.js';

/** @param {import('./activity.js').ActivityEvent} event */
export function activityBranch(event) {
  const { kind, data } = event;
  const update = kind === 'push' && data?.refUpdates?.length === 1 ? data.refUpdates[0] : undefined;
  const ref =
    kind === 'branch-created'
      ? data?.name
      : update && /^[a-f0-9]{40}$/i.test(update.newObjectId ?? '') && !/^0+$/.test(update.newObjectId ?? '')
        ? update.name
        : undefined;
  return typeof ref === 'string' && ref.startsWith('refs/heads/') && ref.length > 11 ? branchName(ref) : null;
}
