import { branchName } from './events.ts';
import type { ActivityEvent } from './activity.ts';

export type { ActivityEvent };
export type ActivityTone = 'info' | 'ok' | 'crit' | 'warn' | 'neutral';

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
} satisfies Record<string, string>;
type StatusId = keyof typeof statusLabels;
/** The same table, for a status ID read from a filter, which may name no status. */
const statusLabelsById: Record<string, string> = statusLabels;
const evidenceLabels: Record<string, string> = { 'pr-linked': 'PR evidence' };
const statusIds = new Map(Object.entries(statusLabels).map(([id, label]) => [label, id]));
const evidenceIds = new Map(Object.entries(evidenceLabels).map(([id, label]) => [label, id]));
// Keep old filter links and persisted search text compatible with the broader display label.
const legacyPrEvidenceTerm = 'Completed PR linked';
evidenceIds.set(legacyPrEvidenceTerm, 'pr-linked');

export const labels = {
  'branch-created': statusLabels['new-branch'],
  'branch-deleted': statusLabels['branch-deleted'],
  tag: 'Tag',
  push: statusLabels.push,
  pr: 'Pull request',
  build: 'CI run',
};

const buildStates: Record<string, [StatusId, ActivityTone]> = {
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

function buildPresentation(event: Pick<ActivityEvent, 'data'>) {
  const { status, result } = event.data || {};
  const key = status === 'completed' || !status ? result || status : status;
  const state = key && Object.hasOwn(buildStates, key) ? buildStates[key] : undefined;
  return state ?? (['unknown', 'neutral'] as const);
}

export function buildState(event: Pick<ActivityEvent, 'data'>) {
  const [id, tone] = buildPresentation(event);
  return { label: statusLabels[id], tone };
}

export function activityStatusId(event: ActivityEvent) {
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

export const activityLabel = (event: ActivityEvent) => statusLabels[activityStatusId(event)];

/** One status palette for live rows, imported history, detail chips and update trails. */
export function activityTone(event: ActivityEvent): ActivityTone {
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

export function activityActor(event: ActivityEvent) {
  return event.kind === 'push' && event.actor === azureDevOpsService ? 'Azure DevOps service' : event.actor;
}

export function matchesPushResult(data: ActivityEvent['data'], pr: import('./activity.ts').EvidencePr) {
  const result = pr.mergeCommit?.toLowerCase();
  return Boolean(
    result &&
    pr.targetRefName &&
    pr.relationship === 'result-introduced' &&
    data?.refUpdates?.some(ref => ref.name === pr.targetRefName && ref.newObjectId?.toLowerCase() === result),
  );
}

export const matchingPushResults = (data: ActivityEvent['data']) =>
  (data?.mergeEvidence?.prs || []).filter(pr => matchesPushResult(data, pr));

export function activityTitle(event: ActivityEvent) {
  if (event.kind === 'branch-deleted') return `${activityLabel(event)}${event.branch ? ` · ${branchName(event.branch)}` : ''}`;
  if (event.kind === 'push') {
    const prs = matchingPushResults(event.data);
    const [pr] = prs;
    const id = pr?.pullRequestId ?? pr?.id;
    if (pr && prs.length === 1 && id) {
      return `Merge of PR ${id} pushed to ${branchName(pr.targetRefName)}`;
    }
    if (event.actor === azureDevOpsService && event.title?.startsWith(`${azureDevOpsService} pushed`)) {
      return event.title.replace(azureDevOpsService, 'Azure DevOps service');
    }
  }
  const run = event.data?.buildId || event.data?.id;
  if (event.kind === 'build' && run) return event.data?.definition?.name || event.title || 'CI run';
  return event.title || branchName(event.branch);
}

export function triggerLabel(value: string | undefined) {
  const descriptions: Record<string, string> = {
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

const votes: Record<string, string> = {
  10: 'approved',
  5: 'approved with suggestions',
  0: 'no vote',
  '-5': 'waiting for author',
  '-10': 'rejected',
};
/** Azure's reviewer vote in words, so it never depends on color. */
export const voteLabel = (vote: number) => votes[vote] || 'unknown vote';

/** Where a PR's source branch lives when it comes from a fork. */
export const prForkSource = (fork: { repository?: string; project?: string } | undefined) =>
  fork ? `From fork ${fork.repository || 'of unknown name'}${fork.project ? ` in ${fork.project}` : ''}` : '';

/** The vote changes that are an open PR's news, each in words. */
export const prVoteChanges = (data: NonNullable<ActivityEvent['data']>) =>
  (data.status === 'active' ? data.voteChanges || [] : []).map(change => ({
    vote: change.vote,
    text: `${change.name}: ${change.vote ? voteLabel(change.vote) : 'vote reset'}`,
  }));

/** Where the PR goes. */
export const prTarget = (data: NonNullable<ActivityEvent['data']>) =>
  `${data.status === 'completed' ? 'Merged into' : 'Target:'} ${branchName(data.targetRefName)}`;

/** A vote change on an open PR is the news; otherwise the summary names where the PR goes. */
function prSummary(data: NonNullable<ActivityEvent['data']>) {
  const changes = prVoteChanges(data);
  const source = prForkSource(data.fork);
  return `${source ? `${source} · ` : ''}${changes.length ? changes.map(change => change.text).join(' · ') : prTarget(data)}`;
}

function pushedTagSummary({ change, oldObjectId = '', newObjectId = '' }: NonNullable<ActivityEvent['data']>) {
  if (change === 'deleted') return 'Remote tag deleted';
  return change === 'moved' ? `${oldObjectId.slice(0, 7)} → ${newObjectId.slice(0, 7)}` : `Points at ${newObjectId.slice(0, 7)}`;
}

/**
 * The branch a row names, and its pull request when it has one. A CI run on a pull request ref names the PR's source
 * branch and the PR when the stored PR is attached.
 */
export function activityRef(event: ActivityEvent): { branch: string; pullRequestId?: number | string } {
  const pr = event.kind === 'build' ? event.data?.pullRequest : undefined;
  return pr?.sourceRefName ? { branch: branchName(pr.sourceRefName), pullRequestId: pr.id } : { branch: branchName(event.branch) };
}

function refUpdateSummary(event: ActivityEvent) {
  const refs = event.data?.refUpdates;
  if (event.kind === 'push' && event.actor === azureDevOpsService && !refs?.length && !event.branch) {
    return 'Branch details unavailable';
  }
  const only = refs?.length === 1 ? refs[0] : undefined;
  if (only && /^0+$/.test(only.newObjectId || '')) return 'Remote branch deleted';
  if (only && /^0+$/.test(only.oldObjectId || '')) return `Tip at ${(only.newObjectId || '').slice(0, 7)}`;
  return event.summary || '';
}

export function activitySummary(event: ActivityEvent) {
  if (event.kind === 'build') return triggerLabel(event.data?.reason);
  if (event.kind === 'pr' && event.data && (event.data.targetRefName || event.data.voteChanges?.length)) return prSummary(event.data);
  const listed = ['snapshot', 'refs'].includes(event.data?.evidence ?? '');
  if (event.kind === 'branch-created') return listed ? 'First seen remotely; creation time not supplied' : 'New remote branch';
  if (event.kind === 'branch-deleted') return listed ? 'Not in the latest branch list; deletion not confirmed' : 'Remote branch deleted';
  if (event.kind === 'tag' && event.data?.evidence === 'push') return pushedTagSummary(event.data);
  return refUpdateSummary(event);
}

export type EvidencedEvent = { kind?: string; data?: { mergeEvidence?: { prs?: unknown[] } } };
export function activityEvidenceId(event: EvidencedEvent) {
  if (event.kind !== 'push') return '';
  return event.data?.mergeEvidence?.prs?.length ? 'pr-linked' : '';
}

export const activityMergeBadge = (event: EvidencedEvent) => evidenceLabels[activityEvidenceId(event)] || '';

function addSearchTerm(terms: Set<string>, value: unknown) {
  if (typeof value !== 'string' && typeof value !== 'number') return;
  const text = String(value).trim().toLowerCase();
  if (text && !/^0+$/.test(text)) terms.add(text);
}

function addEvidenceSearchTerms(terms: Set<string>, evidence: import('./activity.ts').MergeEvidenceData | undefined) {
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

function addDataSearchTerms(terms: Set<string>, data: import('./activity.ts').EventData | undefined) {
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
    const entry = commit as { commitId?: unknown; comment?: unknown };
    addSearchTerm(terms, entry.commitId);
    addSearchTerm(terms, entry.comment);
  }
  addEvidenceSearchTerms(terms, data.mergeEvidence);
}

/** Raise this when activitySearchText changes which terms it indexes, so the store rebuilds search text saved before. */
export const SEARCH_INDEX_VERSION = 1;

export function activitySearchText(event: ActivityEvent) {
  const terms: Set<string> = new Set();
  for (const value of [
    event.title,
    event.branch,
    event.actor,
    event.summary,
    activityLabel(event),
    activitySummary(event),
    activityEvidenceId(event) ? legacyPrEvidenceTerm : '',
  ])
    addSearchTerm(terms, value);
  addDataSearchTerms(terms, event.data);
  return [...terms].join(' ');
}

export type ActivityFilter = { type: 'all' } | { type: 'kind' | 'status' | 'evidence'; id: string };

export function parseActivityFilter(value: string): ActivityFilter {
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

export function canonicalActivityFilter(value: string) {
  const filter = parseActivityFilter(value);
  if (filter.type === 'all') return '';
  return filter.type === 'kind' ? filter.id : `${filter.type}:${filter.id}`;
}

export function activityFilterLabel(value: string) {
  const filter = parseActivityFilter(value);
  if (filter.type === 'all') return 'All types';
  if (filter.type === 'kind' && filter.id === 'build') return 'CI runs';
  if (filter.type === 'status' && filter.id === 'failed') return 'Failed CI runs';
  if (filter.type === 'status') return statusLabelsById[filter.id] || filter.id;
  if (filter.type === 'evidence') return evidenceLabels[filter.id] || filter.id;
  // Widening only: labels is a string table, and an unknown id falls back to the id itself.
  return (labels as Record<string, string>)[filter.id] || filter.id;
}
