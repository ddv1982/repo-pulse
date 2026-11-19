// @ts-check

import { branchName } from './events.js';

/** @typedef {import('./activity.js').ActivityEvent} ActivityEvent */
/** @typedef {'info'|'ok'|'crit'|'warn'|'neutral'} ActivityTone */

/** @type {Record<string, string>} */
const statusLabels = {
  'new-branch': 'New branch',
  'branch-deleted': 'Branch deleted',
  unlisted: 'No longer listed',
  'new-tag': 'New tag',
  'tag-moved': 'Tag moved',
  'tag-deleted': 'Tag deleted',
  push: 'Push',
  merged: 'Merged',
  'pr-abandoned': 'PR abandoned',
  'draft-pr': 'Draft PR',
  'open-pr': 'Open PR',
  'pr-updated': 'PR updated',
  queued: 'Queued',
  running: 'Running',
  canceling: 'Canceling',
  succeeded: 'Succeeded',
  failed: 'Failed',
  canceled: 'Canceled',
  'partially-succeeded': 'Partially succeeded',
  skipped: 'Skipped',
  unknown: 'Unknown',
  activity: 'Activity',
};
/** @type {Record<string, string>} */
const evidenceLabels = { 'pr-linked': 'Completed PR linked' };
const statusIds = new Map(Object.entries(statusLabels).map(([id, label]) => [label, id]));
const evidenceIds = new Map(Object.entries(evidenceLabels).map(([id, label]) => [label, id]));

export const labels = {
  'branch-created': statusLabels['new-branch'],
  'branch-deleted': statusLabels['branch-deleted'],
  tag: 'Tag',
  push: statusLabels.push,
  pr: 'Pull request',
  build: 'CI run',
};

/** @type {Record<string, [string, ActivityTone]>} */
const buildStates = {
  notStarted: ['queued', 'info'],
  postponed: ['queued', 'info'],
  inProgress: ['running', 'info'],
  cancelling: ['canceling', 'warn'],
  succeeded: ['succeeded', 'ok'],
  failed: ['failed', 'crit'],
  canceled: ['canceled', 'warn'],
  partiallySucceeded: ['partially-succeeded', 'warn'],
  succeededWithIssues: ['partially-succeeded', 'warn'],
  skipped: ['skipped', 'neutral'],
};

/** @param {Pick<ActivityEvent, 'data'>} event */
function buildPresentation(event) {
  const { status, result } = event.data || {};
  const key = status === 'completed' || !status ? result || status : status;
  return key && Object.hasOwn(buildStates, key) ? buildStates[key] : /** @type {const} */ (['unknown', 'neutral']);
}

/** @param {Pick<ActivityEvent, 'data'>} event */
export function buildState(event) {
  const [id, tone] = buildPresentation(event);
  return { label: statusLabels[id], tone };
}

/** @param {ActivityEvent} event */
export function activityStatusId(event) {
  if (event.kind === 'build') return buildPresentation(event)[0];
  if (event.kind === 'branch-created') return 'new-branch';
  if (event.kind === 'branch-deleted') return ['snapshot', 'refs'].includes(event.data?.evidence ?? '') ? 'unlisted' : 'branch-deleted';
  if (event.kind === 'tag') {
    if (event.data?.change === 'deleted') return event.data.evidence === 'snapshot' ? 'unlisted' : 'tag-deleted';
    return event.data?.change === 'moved' ? 'tag-moved' : 'new-tag';
  }
  if (event.kind === 'pr') {
    if (event.data?.status === 'completed') return 'merged';
    if (event.data?.status === 'abandoned') return 'pr-abandoned';
    return event.data?.isDraft ? 'draft-pr' : event.data?.status === 'active' ? 'open-pr' : 'pr-updated';
  }
  return event.kind === 'push' ? 'push' : 'activity';
}

/** @param {ActivityEvent} event */
export const activityLabel = event => statusLabels[activityStatusId(event)];

/** One status palette for live rows, imported history, detail chips and update trails. */
/** @param {ActivityEvent} event @returns {ActivityTone} */
export function activityTone(event) {
  if (event.kind === 'build') return buildState(event).tone;
  if (event.kind === 'branch-created') return 'info';
  if (event.kind === 'push') return 'info';
  if (event.kind === 'branch-deleted') return ['snapshot', 'refs'].includes(event.data?.evidence ?? '') ? 'warn' : 'crit';
  // Tags usually stay put, so a moved or deleted tag is worth a second look.
  if (event.kind === 'tag') return event.data?.change === 'created' ? 'info' : 'warn';
  if (event.kind === 'pr') {
    if (event.data?.status === 'completed') return 'ok';
    if (event.data?.status === 'abandoned') return 'warn';
    return event.data?.status === 'active' && !event.data?.isDraft ? 'info' : 'neutral';
  }
  return 'neutral';
}

/** @param {ActivityEvent} event */
export function activityTitle(event) {
  if (event.kind === 'branch-deleted') return `${activityLabel(event)}${event.branch ? ` · ${branchName(event.branch)}` : ''}`;
  const run = event.data?.buildId || event.data?.id;
  if (event.kind === 'build' && run) return event.title || `${event.data?.definition?.name || 'CI run'} · #${run}`;
  return event.title || branchName(event.branch);
}

/** @param {string | undefined} value */
export function triggerLabel(value) {
  /** @type {Record<string, string>} */
  const descriptions = {
    manual: 'Triggered manually',
    individualCI: 'Triggered by a push',
    batchedCI: 'Triggered by grouped pushes',
    pullRequest: 'Pull request validation',
    schedule: 'Scheduled',
    scheduleForced: 'Scheduled',
    buildCompletion: 'Triggered by a pipeline',
    resourceTrigger: 'Triggered by a resource',
  };
  return descriptions[value ?? ''] || 'Not supplied';
}

/** @type {Record<string, string>} */
const votes = { 10: 'approved', 5: 'approved with suggestions', 0: 'no vote', '-5': 'waiting for author', '-10': 'rejected' };
/** Azure's reviewer vote in words, so it never depends on color. @param {number} vote */
export const voteLabel = vote => votes[vote] || 'unknown vote';

/** @param {{ repository?: string, project?: string } | undefined} fork */
const forkText = fork => (fork ? `From fork ${fork.repository || 'of unknown name'}${fork.project ? ` in ${fork.project}` : ''} · ` : '');

/** A vote change on an open PR is the news; otherwise the summary names where the PR goes. @param {NonNullable<ActivityEvent['data']>} data */
function prSummary(data) {
  const changes = data.status === 'active' ? data.voteChanges || [] : [];
  if (changes.length)
    return `${forkText(data.fork)}${changes.map(change => `${change.name}: ${change.vote ? voteLabel(change.vote) : 'vote reset'}`).join(' · ')}`;
  return `${forkText(data.fork)}${data.status === 'completed' ? 'Merged into' : 'Target:'} ${branchName(data.targetRefName)}`;
}

/** @param {NonNullable<ActivityEvent['data']>} data */
function pushedTagSummary({ change, oldObjectId = '', newObjectId = '' }) {
  if (change === 'deleted') return 'Remote tag deleted';
  return change === 'moved' ? `${oldObjectId.slice(0, 8)} → ${newObjectId.slice(0, 8)}` : `Points at ${newObjectId.slice(0, 8)}`;
}

/** @param {ActivityEvent} event */
export function activitySummary(event) {
  if (event.kind === 'build') return triggerLabel(event.data?.reason);
  if (event.kind === 'pr' && event.data && (event.data.targetRefName || event.data.voteChanges?.length)) return prSummary(event.data);
  const listed = ['snapshot', 'refs'].includes(event.data?.evidence ?? '');
  if (event.kind === 'branch-created') return listed ? 'First seen remotely; creation time not supplied' : 'New remote branch';
  if (event.kind === 'branch-deleted') return listed ? 'Not in the latest branch list; deletion not confirmed' : 'Remote branch deleted';
  if (event.kind === 'tag' && event.data?.evidence === 'push') return pushedTagSummary(event.data);
  const refs = event.data?.refUpdates;
  if (refs?.length === 1 && /^0+$/.test(refs[0].newObjectId || '')) return 'Remote branch deleted';
  if (refs?.length === 1 && /^0+$/.test(refs[0].oldObjectId || '')) return `Branch starts at ${(refs[0].newObjectId || '').slice(0, 8)}`;
  return event.summary || '';
}

/** @typedef {{kind?: string, data?: { mergeEvidence?: { prs?: unknown[] } } }} EvidencedEvent */
/** @param {EvidencedEvent} event */
export function activityEvidenceId(event) {
  if (event.kind !== 'push') return '';
  return event.data?.mergeEvidence?.prs?.length ? 'pr-linked' : '';
}

/** @param {EvidencedEvent} event */
export const activityMergeBadge = event => evidenceLabels[activityEvidenceId(event)] || '';

/** @param {ActivityEvent} event */
export function activitySearchText(event) {
  return [
    event.title,
    event.branch,
    event.actor,
    event.summary,
    activityLabel(event),
    activitySummary(event),
    activityMergeBadge(event),
    JSON.stringify(event.data || {}),
  ]
    .join(' ')
    .toLowerCase();
}

/** @typedef {{ type: 'all' } | { type: 'kind' | 'status' | 'evidence', id: string }} ActivityFilter */

/** @param {string} value @returns {ActivityFilter} */
export function parseActivityFilter(value) {
  if (!value) return { type: 'all' };
  if (value.startsWith('status:')) {
    const id = value.slice(7);
    return { type: 'status', id: statusIds.get(id) || id };
  }
  if (value.startsWith('evidence:')) {
    const id = value.slice(9);
    return { type: 'evidence', id: evidenceIds.get(id) || id };
  }
  return { type: 'kind', id: value };
}

/** @param {string} value */
export function canonicalActivityFilter(value) {
  const filter = parseActivityFilter(value);
  if (filter.type === 'all') return '';
  return filter.type === 'kind' ? filter.id : `${filter.type}:${filter.id}`;
}

/** @param {string} value */
export function activityFilterLabel(value) {
  const filter = parseActivityFilter(value);
  if (filter.type === 'all') return 'All types';
  if (filter.type === 'status') return statusLabels[filter.id] || filter.id;
  if (filter.type === 'evidence') return evidenceLabels[filter.id] || filter.id;
  // Widening only: labels is a string table, and an unknown id falls back to the id itself.
  return /** @type {Record<string, string>} */ (labels)[filter.id] || filter.id;
}
