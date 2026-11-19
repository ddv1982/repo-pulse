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

export const azureDevOpsService = 'Microsoft.VisualStudio.Services.TFS';

/** @param {ActivityEvent} event */
export function activityActor(event) {
  return event.kind === 'push' && event.actor === azureDevOpsService ? 'Azure DevOps service' : event.actor;
}

/**
 * @param {ActivityEvent['data']} data
 * @param {import('./activity.js').EvidencePr} pr
 */
export function matchesPushResult(data, pr) {
  const result = pr.mergeCommit?.toLowerCase();
  return Boolean(
    result &&
      pr.targetRefName &&
      pr.relationship === 'result-introduced' &&
      data?.refUpdates?.some(ref => ref.name === pr.targetRefName && ref.newObjectId?.toLowerCase() === result),
  );
}

/** @param {ActivityEvent['data']} data */
export const matchingPushResults = data => (data?.mergeEvidence?.prs || []).filter(pr => matchesPushResult(data, pr));

/** @param {ActivityEvent} event */
export function activityTitle(event) {
  if (event.kind === 'branch-deleted') return `${activityLabel(event)}${event.branch ? ` · ${branchName(event.branch)}` : ''}`;
  if (event.kind === 'push') {
    const prs = matchingPushResults(event.data);
    const pr = prs?.[0];
    const id = pr?.pullRequestId ?? pr?.id;
    if (prs.length === 1 && id) {
      return `Push to ${branchName(pr.targetRefName)} · Linked PR #${id}`;
    }
    if (event.actor === azureDevOpsService && event.title?.startsWith(`${azureDevOpsService} pushed`)) {
      return event.title.replace(azureDevOpsService, 'Azure DevOps service');
    }
  }
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
  if (event.kind === 'push' && event.actor === azureDevOpsService && !refs?.length && !event.branch) {
    return 'Branch details unavailable';
  }
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

/** @param {Set<string>} terms @param {unknown} value */
function addSearchTerm(terms, value) {
  if (typeof value !== 'string' && typeof value !== 'number') return;
  const text = String(value).trim().toLowerCase();
  if (text && !/^0+$/.test(text)) terms.add(text);
}

/** @param {Set<string>} terms @param {import('./activity.js').MergeEvidenceData | undefined} evidence */
function addEvidenceSearchTerms(terms, evidence) {
  if (!evidence) return;
  for (const pr of evidence.prs || []) {
    addSearchTerm(terms, pr.pullRequestId ?? pr.id);
    addSearchTerm(terms, pr.sourceRefName);
    addSearchTerm(terms, pr.targetRefName);
    addSearchTerm(terms, pr.mergeCommit);
    addSearchTerm(terms, pr.mergeStrategy);
    addSearchTerm(terms, typeof pr.closedBy === 'string' ? pr.closedBy : pr.closedBy?.displayName);
  }
  for (const commit of evidence.commits || []) {
    addSearchTerm(terms, commit.commitId);
    for (const parent of commit.parents || []) addSearchTerm(terms, parent);
    for (const branch of commit.branches || []) addSearchTerm(terms, branch);
  }
  for (const id of evidence.introducedCommitIds || []) addSearchTerm(terms, id);
  for (const range of evidence.refRanges || []) {
    addSearchTerm(terms, range.name);
    addSearchTerm(terms, range.oldObjectId);
    addSearchTerm(terms, range.newObjectId);
    addSearchTerm(terms, range.update?.status);
    for (const id of range.commitIds || []) addSearchTerm(terms, id);
  }
  for (const item of evidence.rewrite || []) {
    addSearchTerm(terms, item.ref);
    addSearchTerm(terms, item.status);
    if (item.status === 'rewrite') terms.add('history rewritten');
  }
}

/** @param {Set<string>} terms @param {import('./activity.js').EventData | undefined} data */
function addDataSearchTerms(terms, data) {
  if (!data) return;
  for (const value of [
    data.pushId,
    data.push?.pushId,
    data.pullRequestId,
    data.buildId,
    data.id,
    data.name,
    data.sourceRefName,
    data.targetRefName,
    data.sourceBranch,
    data.oldObjectId,
    data.newObjectId,
    data.commitId,
    data.objectId,
    data.peeledObjectId,
    data.sourceCommit,
    data.targetCommit,
    data.mergeCommit,
    data.sourceVersion,
    data.definition?.name,
    data.status,
    data.result,
    data.reason,
    data.closedBy,
    data.mergeStrategy,
    data.fork?.repository,
    data.fork?.project,
  ])
    addSearchTerm(terms, value);
  for (const reviewer of data.reviewers || []) addSearchTerm(terms, reviewer.name);
  for (const change of data.voteChanges || []) addSearchTerm(terms, change.name);
  for (const ref of data.refUpdates || []) {
    addSearchTerm(terms, ref.name);
    addSearchTerm(terms, ref.oldObjectId);
    addSearchTerm(terms, ref.newObjectId);
  }
  for (const commit of data.commits || []) {
    if (!commit || typeof commit !== 'object') continue;
    const entry = /** @type {{ commitId?: unknown, comment?: unknown }} */ (commit);
    addSearchTerm(terms, entry.commitId);
    addSearchTerm(terms, entry.comment);
  }
  addEvidenceSearchTerms(terms, data.mergeEvidence);
}

/** @param {ActivityEvent} event */
export function activitySearchText(event) {
  /** @type {Set<string>} */
  const terms = new Set();
  for (const value of [
    event.title,
    event.branch,
    event.actor,
    event.summary,
    activityLabel(event),
    activitySummary(event),
    activityMergeBadge(event),
  ])
    addSearchTerm(terms, value);
  addDataSearchTerms(terms, event.data);
  return [...terms].join(' ');
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
    const id = evidenceIds.get(value.slice(9)) || value.slice(9);
    // A retired filter, such as one restored from an older session, shows everything instead of nothing.
    return Object.hasOwn(evidenceLabels, id) ? { type: 'evidence', id } : { type: 'all' };
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
