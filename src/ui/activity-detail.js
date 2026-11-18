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

/**
 * @param {ActivityItem} record @param {Repo | undefined} repo @param {EventData} data
 * @param {string | undefined} sha @param {PushId} pushId
 */
function detailFields(record, repo, data, sha, pushId) {
  const pr = record.kind === 'pr';
  const sameTime = new Date(record.time).valueOf() === new Date(record.observedAt ?? NaN).valueOf();
  const fields = [
    ['Repository', `${e(repo?.name)}${repo?.project ? ` · ${e(repo.project)}` : ''}`],
    [pr ? 'Source branch' : 'Branch', e(branchName(record.branch) || 'Not supplied')],
    [pr ? 'Created by' : 'By', e(record.actor || 'Not supplied by Azure')],
    [sameTime ? 'Time' : 'Source time', e(dateTime(record.time))],
  ];
  if (!sameTime) fields.push(['Observed locally', e(dateTime(record.observedAt))]);
  if (pr && data.targetRefName) fields.push(['Target branch', e(branchName(data.targetRefName))]);
  if (sha) fields.push([pr ? 'Source commit' : 'Commit', commit(sha)]);
  if (pr && data.status === 'completed' && data.mergeCommit) fields.push(['Merge commit', commit(data.mergeCommit)]);
  if (data.mergeStrategy) fields.push(['Merge strategy', e(mergeStrategies[data.mergeStrategy] || 'Not supplied')]);
  if (pr && data.closedBy) fields.push(['PR closed by', e(data.closedBy)]);
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
  return `<button class="btn" data-action="load-commits" data-repo-id="${e(repo?.id)}" data-push-id="${e(pushId)}">${commits ? 'Reload commits' : 'Load push commits'}</button><p class="help">Loads on request within the shared budget.</p>${commits ? renderCommits(commits) : ''}`;
}

/**
 * @param {ActivityItem} record @param {Repo | undefined} repo @param {EventData} data @param {string[][]} fields
 * @param {PushId} pushId @param {CommitsView | undefined} commits
 */
function detailData(record, repo, data, fields, pushId, commits) {
  const summary = record.kind !== 'build' ? `<p>${e(activitySummary(record))}</p>` : '';
  const facts = fields.map(([name, value]) => `<div><dt>${name}</dt><dd>${value}</dd></div>`).join('');
  const completed =
    record.kind === 'pr' && data.status === 'completed'
      ? '<p class="help">Completed in Azure DevOps. Push details show separately checked commit and PR evidence.</p>'
      : '';
  const evidence = record.kind === 'push' ? renderMergeEvidence(data) : '';
  return `<div class="detail-data">${summary}<dl class="detail-facts">${facts}</dl>${completed}${evidence}${renderTrail(record, { expanded: true })}${pushCommits(record, repo, pushId, commits)}</div>`;
}

/**
 * @param {ActivityEvent | undefined} event @param {DetailState} state @param {CommitsView | undefined} commits
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
