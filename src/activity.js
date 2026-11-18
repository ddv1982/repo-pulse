// @ts-check

/** @typedef {'branch-created' | 'branch-deleted' | 'push' | 'pr' | 'build'} ActivityKind */
/** @typedef {{name?: string, oldObjectId?: string, newObjectId?: string}} RefUpdate */
/**
 * A completed PR in push merge evidence (server/merge-evidence.js). `id` and an object `closedBy` come from older rows.
 * @typedef {{ pullRequestId?: number|string, id?: number|string, url?: string, sourceRefName?: string, targetRefName?: string,
 *   closedBy?: string | { displayName?: string }, mergeStrategy?: string, mergeCommit?: string }} EvidencePr
 */
/** @typedef {{ commitId?: string, parents?: string[], branches?: (string|undefined)[] }} EvidenceCommit */
/**
 * Merge evidence that enrichment saves on a push; it is partial while enrichment runs.
 * @typedef {{ status?: string, checkedAt?: string, limitations?: string[], error?: string | { message?: string },
 *   prs?: EvidencePr[], commits?: EvidenceCommit[] }} MergeEvidenceData
 */
/**
 * Provider fields of an event, plus enrichment. Each kind fills its own subset (see server/sync.js normalizers).
 * @typedef {RefUpdate & { id?: number|string, buildId?: number|string, pushId?: number|string,
 *   status?: string, result?: string, reason?: string, isDraft?: boolean, evidence?: string,
 *   targetRefName?: string, refUpdates?: RefUpdate[], commits?: unknown[],
 *   definition?: {name?: string}, mergeEvidence?: MergeEvidenceData,
 *   pullRequestId?: number|string, sourceRefName?: string, sourceCommit?: string, targetCommit?: string,
 *   mergeCommit?: string, mergeStrategy?: string, closedBy?: string, sourceVersion?: string, sourceBranch?: string,
 *   commitId?: string, push?: { pushId?: number|string } }} EventData
 */
/**
 * @typedef {{ id: string, repoId: string, kind: ActivityKind, time: string, observedAt?: string,
 *   title?: string, actor?: string, branch?: string, summary?: string, url?: string,
 *   seen?: boolean, imported?: boolean, data?: EventData }} ActivityEvent
 */
/** @typedef {ActivityEvent & {groupKey: string, events: ActivityEvent[], eventIds: string[], unseenIds: string[], unseen: boolean}} ActivityItem */

/** @typedef {{ repoIds?: string[], view?: 'new'|'all', kind?: string, search?: string, limit?: number, cursor?: string }} ActivityRequest */
/** @typedef {{ items: ActivityItem[], nextCursor: string|null, total: number, newItems: number, newUpdates: number, filterOptions?: string[], counts?: Record<string,number>, newCounts?: Record<string,number> }} ActivityPage */

/** @param {Pick<ActivityEvent, 'seen' | 'imported'>} event */
export const isUnseen = event => !event.seen && !event.imported;
/** @param {string | undefined} value */
const timestamp = value => Date.parse(value ?? '') || 0;
/** @param {string | number | undefined} value */
const sourceId = value => {
  const id = Number(value);
  return /^\d+$/.test(String(value)) && Number.isSafeInteger(id) && id > 0 ? String(id) : null;
};

/** @param {ActivityEvent} a @param {ActivityEvent} b */
function newestFirst(a, b) {
  return (
    timestamp(b.observedAt) - timestamp(a.observedAt) ||
    timestamp(b.time) - timestamp(a.time) ||
    (String(a.id) < String(b.id) ? 1 : String(a.id) > String(b.id) ? -1 : 0)
  );
}

/** @param {ActivityEvent} event */
export function lifecycleKey(event) {
  if (!['branch-created', 'branch-deleted'].includes(event.kind)) return null;
  const { pushId, name, oldObjectId, newObjectId } = event.data || {};
  const id = sourceId(pushId);
  if (!id || !name?.startsWith('refs/heads/') || typeof oldObjectId !== 'string' || typeof newObjectId !== 'string') return null;
  /** @param {string} value */
  const zero = value => /^0+$/.test(value);
  if (event.kind === 'branch-created' ? !zero(oldObjectId) || zero(newObjectId) : !zero(newObjectId) || zero(oldObjectId)) return null;
  return JSON.stringify(['branch', event.repoId, id, name, event.kind, oldObjectId, newObjectId]);
}

/** @param {ActivityEvent} event */
export function supportingPushKey(event) {
  const data = event.data;
  if (
    event.kind !== 'push' ||
    !Array.isArray(data?.refUpdates) ||
    data.refUpdates.length !== 1 ||
    !Array.isArray(data.commits) ||
    data.commits.length
  )
    return null;
  const ref = data.refUpdates[0];
  const kind = /^0+$/.test(ref.oldObjectId || '') ? 'branch-created' : 'branch-deleted';
  // Push-list commit coverage is incomplete. A new branch may carry real work even
  // when its cached commits array is empty; only a deletion is unambiguously lifecycle-only.
  if (kind !== 'branch-deleted') return null;
  return lifecycleKey({ ...event, kind, data: { ...ref, pushId: data.pushId } });
}

/** @param {ActivityEvent} event */
export function activityKey(event) {
  const build = event.kind === 'build' ? sourceId(event.data?.buildId || event.data?.id) : null;
  return build
    ? JSON.stringify(['build', event.repoId, build])
    : lifecycleKey(event) || JSON.stringify(['event', event.repoId, event.kind, event.id]);
}

/** View-only grouping. Raw events and their exact acknowledgement flags remain untouched.
 * @param {ActivityEvent[]} events
 * @returns {ActivityItem[]}
 */
export function groupActivity(events) {
  const lifecycle = new Set(events.map(lifecycleKey).filter(Boolean));
  /** @type {Map<string, ActivityEvent[]>} */
  const groups = new Map();
  for (const event of events) {
    const push = supportingPushKey(event);
    const groupKey = push && lifecycle.has(push) ? push : activityKey(event);
    const items = groups.get(groupKey);
    if (items) items.push(event);
    else groups.set(groupKey, [event]);
  }
  return [...groups]
    .flatMap(([groupKey, items]) => projectActivity(groupKey, items) || [])
    .sort((a, b) => newestFirst(a.events[0], b.events[0]));
}

/**
 * @param {string} groupKey
 * @param {ActivityEvent[]} items
 * @param {string} [representativeId]
 * @returns {ActivityItem | undefined}
 */
export function projectActivity(groupKey, items, representativeId) {
  const ordered = [...items].sort(newestFirst);
  // A deletion is the primary fact when its supporting push is folded into the group.
  const representative = representativeId
    ? ordered.find(event => event.id === representativeId)
    : ordered.find(event => lifecycleKey(event) === groupKey) || ordered[0];
  if (!representative) return undefined;
  const unseenIds = [...new Set(ordered.filter(isUnseen).map(event => event.id))];
  return {
    ...representative,
    events: ordered,
    eventIds: [...new Set(ordered.map(event => event.id))],
    unseenIds,
    unseen: unseenIds.length > 0,
    seen: unseenIds.length === 0,
    imported: ordered.every(event => event.imported),
    groupKey,
  };
}
