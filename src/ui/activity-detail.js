// @ts-check

import { renderMergeEvidence } from './merge-evidence.js';
import { groupActivity } from '../activity.js';
import {
  emptyHtml,
  html,
  joinHtml,
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
/** @typedef {import('./format.js').HtmlValue} HtmlValue */
/** What the detail page shows after "Load push commits": the response, or the error the request threw. */
/** @typedef {import('../api.js').PushCommitsResponse | { error: string }} CommitsView */
/** What a PR detail shows after "Load discussion and policies". @typedef {import('../api.js').PrReviewResponse | { error: string }} ReviewView */
/** Data a detail page loaded on request: push commits for a push, review data for a PR. @typedef {CommitsView | ReviewView} LoadedView */
/** @typedef {{ events: ActivityEvent[], repos: Repo[] }} DetailState */

/** @param {string} value */
function commit(value) {
  return html`<code title="${value}">${value.slice(0, 8)}</code> <button class="ghost sm" type="button" data-action="copy-commit" data-value="${value}" aria-label="Copy full commit ID">Copy</button>`;
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
  joinHtml(
    reviewers.map(reviewer => html`${reviewer.name}${reviewer.required ? ' (required)' : ''}: ${voteLabel(reviewer.vote)}`),
    html`<br>`,
  );

/**
 * A pushed tag can point at an annotated tag object rather than a commit; only the refs snapshot peels it.
 * @param {EventData} data @returns {[string, HtmlValue][]}
 */
function tagFields(data) {
  const object = data.change === 'deleted' ? data.oldObjectId || data.objectId : data.newObjectId || data.objectId;
  return [
    ...(object ? /** @type {[string, HtmlValue][]} */ ([['Points at', commit(object)]]) : []),
    ...(data.peeledObjectId ? /** @type {[string, HtmlValue][]} */ ([['Tagged commit', commit(data.peeledObjectId)]]) : []),
  ];
}

/**
 * @param {ActivityItem} record @param {Repo | undefined} repo @param {EventData} data
 * @param {string | undefined} sha @param {PushId} pushId @returns {[string, HtmlValue][]}
 */
function detailFields(record, repo, data, sha, pushId) {
  const pr = record.kind === 'pr',
    tag = record.kind === 'tag';
  const sameTime = new Date(record.time).valueOf() === new Date(record.observedAt ?? NaN).valueOf();
  /** @type {[string, HtmlValue][]} */
  const fields = [
    ['Repository', `${repo?.name || ''}${repo?.project ? ` · ${repo.project}` : ''}`],
    [pr ? 'Source branch' : tag ? 'Tag' : 'Branch', branchName(record.branch) || 'Not supplied'],
    [pr ? 'Created by' : 'By', record.actor || 'Not supplied by Azure'],
    [sameTime ? 'Time' : 'Source time', dateTime(record.time)],
  ];
  /** @param {unknown} condition @param {string} label @param {() => HtmlValue} value */
  const add = (condition, label, value) => {
    if (condition) fields.push([label, value()]);
  };
  add(!sameTime, 'Observed locally', () => dateTime(record.observedAt));
  add(pr && data.targetRefName, 'Target branch', () => branchName(data.targetRefName));
  add(sha, pr ? 'Source commit' : 'Commit', () => commit(/** @type {string} */ (sha)));
  if (tag) fields.push(...tagFields(data));
  add(pr && data.status === 'completed' && data.mergeCommit, 'Merge commit', () => commit(/** @type {string} */ (data.mergeCommit)));
  add(data.mergeStrategy, 'Merge strategy', () => mergeStrategies[data.mergeStrategy ?? ''] || 'Not supplied');
  add(pr && data.closedBy, 'PR closed by', () => data.closedBy);
  add(pr && data.reviewers?.length, 'Reviewers', () => reviewerList(/** @type {NonNullable<EventData['reviewers']>} */ (data.reviewers)));
  add(data.reason, 'Trigger', () => triggerLabel(data.reason));
  add(data.pullRequestId, 'Pull request', () => `#${data.pullRequestId}`);
  add(pushId, 'Push', () => `#${pushId}`);
  return fields;
}

/** @param {ActivityItem} record @param {Repo | undefined} repo @param {string} title */
function detailHead(record, repo, title) {
  const ids = JSON.stringify(record.eventIds);
  const ack = record.imported
    ? emptyHtml
    : html`<button class="btn" data-action="ack-item" data-id="${record.id}" data-event-ids="${ids}">Mark ${record.unseen ? 'seen' : 'unseen'}</button>`;
  return html`<div class="dhead"><div><h1>${title}</h1><div class="meta">${record.kind.startsWith('branch-') ? 'Branch' : labels[record.kind]} · ${repo?.name} · ${branchName(record.branch)}</div></div><div class="actions">${azureLink(record.url, 'Open in Azure DevOps', 'btn')}${ack}</div></div>`;
}

/** @param {ActivityItem} record */
function seenChip(record) {
  if (record.unseen) return `${record.unseenIds.length} new update${record.unseenIds.length === 1 ? '' : 's'}`;
  return record.imported ? 'Imported history' : 'Seen';
}

/** @param {ActivityItem} record @param {string} tone */
function detailFacts(record, tone) {
  return html`<div class="facts"><span class="chip status-chip ${tone}">${activityLabel(record)}</span><span class="chip">${seenChip(record)}</span>${record.kind === 'build' ? html`<span class="chip name">CI outcome · deployment unknown</span>` : emptyHtml}</div>`;
}

/** @param {ActivityItem} record @param {Repo | undefined} repo @param {PushId} pushId @param {CommitsView | undefined} commits */
function pushCommits(record, repo, pushId, commits) {
  if (record.kind !== 'push' || !pushId) return emptyHtml;
  return html`<button class="btn" data-action="load-commits" data-repo-id="${record.repoId}" data-push-id="${pushId}">${commits ? 'Reload commits' : 'Load push commits'}</button><p class="help">Loads on request within the shared budget.</p>${commits ? renderCommits(commits) : emptyHtml}`;
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
  if ('error' in review) return html`<p class="status-bad">${review.error}</p>`;
  const { open, resolved } = review.threads;
  const policies = review.policies.map(
    policy => html`<li>${policy.name}${policy.blocking ? ' (required)' : ''}: ${policyStatus[policy.status] || policy.status}</li>`,
  );
  return html`<p>Discussion: ${open} open, ${resolved} resolved thread${open + resolved === 1 ? '' : 's'}</p>${policies.length ? html`<ul class="rows">${policies}</ul>` : html`<p class="help">No branch policies apply to this pull request.</p>`}`;
}

/** @param {ActivityItem} record @param {EventData} data @param {ReviewView | undefined} review */
function prReview(record, data, review) {
  if (record.kind !== 'pr' || !data.pullRequestId) return emptyHtml;
  return html`<button class="btn" data-action="load-review" data-repo-id="${record.repoId}" data-pr-id="${data.pullRequestId}">${review ? 'Reload discussion and policies' : 'Load discussion and policies'}</button><p class="help">Loads the current state on request within the shared budget.</p>${review ? renderReview(review) : emptyHtml}`;
}

/**
 * @param {ActivityItem} record @param {Repo | undefined} repo @param {EventData} data @param {[string, HtmlValue][]} fields
 * @param {PushId} pushId @param {LoadedView | undefined} loaded
 */
function detailData(record, repo, data, fields, pushId, loaded) {
  const summary = record.kind !== 'build' ? html`<p>${activitySummary(record)}</p>` : emptyHtml;
  const facts = fields.map(([name, value]) => html`<div><dt>${name}</dt><dd>${value}</dd></div>`);
  const completed =
    record.kind === 'pr' && data.status === 'completed'
      ? html`<p class="help">Completed in Azure DevOps. Push details show separately checked commit and PR evidence.</p>`
      : emptyHtml;
  const evidence = record.kind === 'push' ? renderMergeEvidence(data) : emptyHtml;
  // A detail loads one kind of data, keyed by its event: commits for a push, review data for a PR.
  const extra =
    record.kind === 'pr'
      ? prReview(record, data, loaded && !('items' in loaded) ? loaded : undefined)
      : pushCommits(record, repo, pushId, loaded && !('threads' in loaded) ? loaded : undefined);
  return html`<div class="detail-data">${summary}<dl class="detail-facts">${facts}</dl>${completed}${evidence}${renderTrail(record, { expanded: true })}${extra}</div>`;
}

/**
 * @param {ActivityEvent | undefined} event @param {DetailState} state @param {LoadedView | undefined} commits
 * @param {{ returnRoute?: string, label?: string }} [options]
 */
export function renderDetail(event, state, commits, { returnRoute = 'catchup', label = 'Back to New updates' } = {}) {
  const back = html`<a class="ghost sm back" data-action="back-to-results" href="${activityHref(returnRoute)}">← ${label}</a>`;
  if (!event) return html`${back}<div class="card empty"><h1>Activity not found</h1></div>`;
  const record = groupActivity(state.events).find(item => item.eventIds.includes(event.id)) || groupActivity([event])[0];
  const repo = state.repos.find(item => item.id === record.repoId);
  const data = record.data || {};
  const pushId = data.pushId || data.push?.pushId;
  const sha = data.sourceVersion || data.sourceCommit || data.commitId;
  const fields = detailFields(record, repo, data, sha, pushId);
  return html`<div class="crumb">${back}<span>${repo?.name}</span></div><section class="card">${detailHead(record, repo, activityTitle(record))}
    ${detailFacts(record, activityTone(record))}
    ${detailData(record, repo, data, fields, pushId, commits)}</section>`;
}

/** @param {CommitsView} commits */
function renderCommits(commits) {
  if ('error' in commits && commits.error) return html`<p class="status-bad">${commits.error}</p>`;
  const items = 'items' in commits ? commits.items : [];
  return html`<ul class="rows">${items.map(item => html`<li class="push">${commit(item.commitId || '')} ${item.comment || ''}</li>`)}</ul>${'nextCursor' in commits && commits.nextCursor ? html`<p class="help">More commits are available in Azure DevOps.</p>` : emptyHtml}`;
}
