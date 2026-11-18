// @ts-check

import { renderMergeEvidence } from './merge-evidence.js';
import { groupActivity } from '../activity.js';
import {
  escape as e,
  branchName,
  labels,
  dateTime,
  azureLink,
  activityLabel,
  activityTone,
  activityTitle,
  activitySummary,
  triggerLabel,
  voteLabel,
} from './format.js';
import { renderTrail } from './activity-trail.js';
import { activityHref } from './navigation.js';

/** @typedef {import('../activity.js').ActivityEvent} ActivityEvent */
/** @typedef {import('../activity.js').ActivityItem} ActivityItem */
/** @typedef {import('../activity.js').EventData} EventData */
/** @typedef {import('../api.js').StateResponse['repos'][number]} Repo */
/** @typedef {number | string | undefined} PushId */
/** What the detail page shows after "Load push commits": the response, or the error the request threw. */
/** @typedef {import('../api.js').PushCommitsResponse | { error: string }} CommitsView */
/** What a PR detail shows after "Load discussion and policies". @typedef {import('../api.js').PrReviewResponse | { error: string }} ReviewView */
/** Data a detail page loaded on request: push commits for a push, review data for a PR. @typedef {CommitsView | ReviewView} LoadedView */
/** @typedef {{ events: ActivityEvent[], repos: Repo[] }} DetailState */

/** @param {string} value */
function commit(value) {
  return `<code title="${e(value)}">${e(value.slice(0, 8))}</code> <button class="ghost sm" type="button" data-action="copy-commit" data-value="${e(value)}" aria-label="Copy full commit ID">Copy</button>`;
}

/** @type {Record<string, string | undefined>} */
const mergeStrategies = {
  noFastForward: 'Merge commit',
  squash: 'Squash',
  rebase: 'Rebase and fast-forward',
  rebaseMerge: 'Rebase with merge commit',
};

/** @param {NonNullable<EventData['reviewers']>} reviewers */
const reviewerList = reviewers =>
  reviewers.map(reviewer => `${e(reviewer.name)}${reviewer.required ? ' (required)' : ''}: ${e(voteLabel(reviewer.vote))}`).join('<br>');

/**
 * A pushed tag can point at an annotated tag object rather than a commit; only the refs snapshot peels it.
 * @param {EventData} data
 */
function tagFields(data) {
  const object = data.change === 'deleted' ? data.oldObjectId || data.objectId : data.newObjectId || data.objectId;
  return [
    ...(object ? [['Points at', commit(object)]] : []),
    ...(data.peeledObjectId ? [['Tagged commit', commit(data.peeledObjectId)]] : []),
  ];
}

/**
 * @param {ActivityItem} record @param {Repo | undefined} repo @param {EventData} data
 * @param {string | undefined} sha @param {PushId} pushId
 */
function detailFields(record, repo, data, sha, pushId) {
  const pr = record.kind === 'pr',
    tag = record.kind === 'tag';
  const sameTime = new Date(record.time).valueOf() === new Date(record.observedAt ?? NaN).valueOf();
  const fields = [
    ['Repository', `${e(repo?.name)}${repo?.project ? ` · ${e(repo.project)}` : ''}`],
    [pr ? 'Source branch' : tag ? 'Tag' : 'Branch', e(branchName(record.branch) || 'Not supplied')],
    [pr ? 'Created by' : 'By', e(record.actor || 'Not supplied by Azure')],
    [sameTime ? 'Time' : 'Source time', e(dateTime(record.time))],
  ];
  if (!sameTime) fields.push(['Observed locally', e(dateTime(record.observedAt))]);
  if (pr && data.targetRefName) fields.push(['Target branch', e(branchName(data.targetRefName))]);
  if (sha) fields.push([pr ? 'Source commit' : 'Commit', commit(sha)]);
  if (tag) fields.push(...tagFields(data));
  if (pr && data.status === 'completed' && data.mergeCommit) fields.push(['Merge commit', commit(data.mergeCommit)]);
  if (data.mergeStrategy) fields.push(['Merge strategy', e(mergeStrategies[data.mergeStrategy] || 'Not supplied')]);
  if (pr && data.closedBy) fields.push(['PR closed by', e(data.closedBy)]);
  if (pr && data.reviewers?.length) fields.push(['Reviewers', reviewerList(data.reviewers)]);
  if (data.reason) fields.push(['Trigger', e(triggerLabel(data.reason))]);
  if (data.pullRequestId) fields.push(['Pull request', `#${e(data.pullRequestId)}`]);
  if (pushId) fields.push(['Push', `#${e(pushId)}`]);
  return fields;
}

/** @param {ActivityItem} record @param {Repo | undefined} repo @param {string} title */
function detailHead(record, repo, title) {
  const ids = e(JSON.stringify(record.eventIds));
  const ack = record.imported
    ? ''
    : `<button class="btn" data-action="ack-item" data-id="${e(record.id)}" data-event-ids="${ids}">Mark ${record.unseen ? 'seen' : 'unseen'}</button>`;
  return `<div class="dhead"><div><h1>${e(title)}</h1><div class="meta">${e(record.kind.startsWith('branch-') ? 'Branch' : labels[record.kind])} · ${e(repo?.name)} · ${e(branchName(record.branch))}</div></div><div class="actions">${azureLink(record.url, 'Open in Azure DevOps', 'btn')}${ack}</div></div>`;
}

/** @param {ActivityItem} record */
function seenChip(record) {
  if (record.unseen) return `${record.unseenIds.length} new update${record.unseenIds.length === 1 ? '' : 's'}`;
  return record.imported ? 'Imported history' : 'Seen';
}

/** @param {ActivityItem} record @param {string} tone */
function detailFacts(record, tone) {
  return `<div class="facts"><span class="chip status-chip ${tone}">${e(activityLabel(record))}</span><span class="chip">${seenChip(record)}</span>${record.kind === 'build' ? '<span class="chip name">CI outcome · deployment unknown</span>' : ''}</div>`;
}

/** @param {ActivityItem} record @param {Repo | undefined} repo @param {PushId} pushId @param {CommitsView | undefined} commits */
function pushCommits(record, repo, pushId, commits) {
  if (record.kind !== 'push' || !pushId) return '';
  return `<button class="btn" data-action="load-commits" data-repo-id="${e(record.repoId)}" data-push-id="${e(pushId)}">${commits ? 'Reload commits' : 'Load push commits'}</button><p class="help">Loads on request within the shared budget.</p>${commits ? renderCommits(commits) : ''}`;
}

/** Azure's policy evaluation status in words. @type {Record<string, string | undefined>} */
const policyStatus = {
  approved: 'passed',
  rejected: 'failed',
  running: 'running',
  queued: 'waiting',
  notApplicable: 'not applicable',
  broken: 'broken',
};

/** @param {ReviewView} review */
function renderReview(review) {
  if ('error' in review) return `<p class="status-bad">${e(review.error)}</p>`;
  const { open, resolved } = review.threads;
  const policies = review.policies.map(
    policy => `<li>${e(policy.name)}${policy.blocking ? ' (required)' : ''}: ${e(policyStatus[policy.status] || policy.status)}</li>`,
  );
  return `<p>Discussion: ${open} open, ${resolved} resolved thread${open + resolved === 1 ? '' : 's'}</p>${policies.length ? `<ul class="rows">${policies.join('')}</ul>` : '<p class="help">No branch policies apply to this pull request.</p>'}`;
}

/** @param {ActivityItem} record @param {EventData} data @param {ReviewView | undefined} review */
function prReview(record, data, review) {
  if (record.kind !== 'pr' || !data.pullRequestId) return '';
  return `<button class="btn" data-action="load-review" data-repo-id="${e(record.repoId)}" data-pr-id="${e(data.pullRequestId)}">${review ? 'Reload discussion and policies' : 'Load discussion and policies'}</button><p class="help">Loads the current state on request within the shared budget.</p>${review ? renderReview(review) : ''}`;
}

/**
 * @param {ActivityItem} record @param {Repo | undefined} repo @param {EventData} data @param {string[][]} fields
 * @param {PushId} pushId @param {LoadedView | undefined} loaded
 */
function detailData(record, repo, data, fields, pushId, loaded) {
  const summary = record.kind !== 'build' ? `<p>${e(activitySummary(record))}</p>` : '';
  const facts = fields.map(([name, value]) => `<div><dt>${name}</dt><dd>${value}</dd></div>`).join('');
  const completed =
    record.kind === 'pr' && data.status === 'completed'
      ? '<p class="help">Completed in Azure DevOps. Push details show separately checked commit and PR evidence.</p>'
      : '';
  const evidence = record.kind === 'push' ? renderMergeEvidence(data) : '';
  // A detail loads one kind of data, keyed by its event: commits for a push, review data for a PR.
  const extra =
    record.kind === 'pr'
      ? prReview(record, data, loaded && !('items' in loaded) ? loaded : undefined)
      : pushCommits(record, repo, pushId, loaded && !('threads' in loaded) ? loaded : undefined);
  return `<div class="detail-data">${summary}<dl class="detail-facts">${facts}</dl>${completed}${evidence}${renderTrail(record, { expanded: true })}${extra}</div>`;
}

/**
 * @param {ActivityEvent | undefined} event @param {DetailState} state @param {LoadedView | undefined} commits
 * @param {{ returnRoute?: string, label?: string }} [options]
 */
export function renderDetail(event, state, commits, { returnRoute = 'catchup', label = 'Back to New updates' } = {}) {
  const back = `<a class="ghost sm back" data-action="back-to-results" href="${activityHref(returnRoute)}">← ${e(label)}</a>`;
  if (!event) return `${back}<div class="card empty"><h1>Activity not found</h1></div>`;
  const record = groupActivity(state.events).find(item => item.eventIds.includes(event.id)) || groupActivity([event])[0];
  const repo = state.repos.find(item => item.id === record.repoId);
  const data = record.data || {};
  const pushId = data.pushId || data.push?.pushId;
  const sha = data.sourceVersion || data.sourceCommit || data.commitId;
  const fields = detailFields(record, repo, data, sha, pushId);
  return `<div class="crumb">${back}<span>${e(repo?.name)}</span></div><section class="card">${detailHead(record, repo, activityTitle(record))}
    ${detailFacts(record, activityTone(record))}
    ${detailData(record, repo, data, fields, pushId, commits)}</section>`;
}

/** @param {CommitsView} commits */
function renderCommits(commits) {
  if ('error' in commits && commits.error) return `<p class="status-bad">${e(commits.error)}</p>`;
  const items = 'items' in commits ? commits.items : [];
  return `<ul class="rows">${items.map(item => `<li class="push">${commit(item.commitId || '')} ${e(item.comment || '')}</li>`).join('')}</ul>${'nextCursor' in commits && commits.nextCursor ? '<p class="help">More commits are available in Azure DevOps.</p>' : ''}`;
}
