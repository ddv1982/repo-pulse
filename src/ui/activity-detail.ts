import { renderMergeEvidence } from './merge-evidence.ts';
import { groupActivity, isUnseen } from '../activity.ts';
import { activityBranch } from '../activity-branch.ts';
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
  activityActor,
  activitySummary,
  triggerLabel,
  voteLabel,
} from './format.ts';
import { renderTrail } from './activity-trail.ts';
import { activityHref, repositoryHref } from './navigation.ts';
import type { ActivityEvent, ActivityItem, EventData } from '../activity.ts';
import type { StateResponse, PushCommitsResponse, PrReviewResponse } from '../api.ts';
import type { HtmlValue } from './format.ts';

export type { ActivityEvent, ActivityItem, EventData, HtmlValue };

export type Repo = StateResponse['repos'][number];
export type PushId = number | string | undefined;

/** What the detail page shows after "Load push commits": the response, or the error the request threw. */
export type CommitsView = PushCommitsResponse | { error: string };
/** What a PR detail shows after "Load discussion and policies". */
export type ReviewView = PrReviewResponse | { error: string };
/** Data a detail page loaded on request: push commits for a push, review data for a PR. */
export type LoadedView = CommitsView | ReviewView;
export type DetailState = { events: ActivityEvent[]; repos: Repo[]; demo?: boolean };

function commit(value: string) {
  return html`<code title="${value}">${value.slice(0, 8)}</code> <button class="ghost sm" type="button" data-action="copy-commit" data-value="${value}" aria-label="Copy full commit ID">Copy</button>`;
}

const mergeStrategies: Record<string, string | undefined> = {
  noFastForward: 'Merge commit',
  squash: 'Squash',
  rebase: 'Rebase and fast-forward',
  rebaseMerge: 'Rebase with merge commit',
};

const reviewerList = (reviewers: NonNullable<EventData['reviewers']>) =>
  joinHtml(
    reviewers.map(reviewer => html`${reviewer.name}${reviewer.required ? ' (required)' : ''}: ${voteLabel(reviewer.vote)}`),
    html`<br>`,
  );

/**
 * A pushed tag can point at an annotated tag object rather than a commit; only the refs snapshot peels it.
 */
function tagFields(data: EventData): [string, HtmlValue][] {
  const object = data.change === 'deleted' ? data.oldObjectId || data.objectId : data.newObjectId || data.objectId;
  return [
    ...(object ? ([['Points at', commit(object)]] as [string, HtmlValue][]) : []),
    ...(data.peeledObjectId ? ([['Tagged commit', commit(data.peeledObjectId)]] as [string, HtmlValue][]) : []),
  ];
}

function detailFields(
  record: ActivityItem,
  repo: Repo | undefined,
  data: EventData,
  sha: string | undefined,
  pushId: PushId,
): [string, HtmlValue][] {
  const pr = record.kind === 'pr',
    tag = record.kind === 'tag';
  const sameTime = new Date(record.time).valueOf() === new Date(record.observedAt ?? NaN).valueOf();
  const label = activityActor(record);
  const actor = label && label !== record.actor ? html`<abbr title="${record.actor}">${label}</abbr>` : label;
  const fields: [string, HtmlValue][] = [
    ['Repository', `${repo?.name || ''}${repo?.project ? ` · ${repo.project}` : ''}`],
    [pr ? 'Source branch' : tag ? 'Tag' : 'Branch', branchName(record.branch) || 'Not supplied'],
    [pr ? 'Created by' : record.kind === 'push' ? 'Pushed by' : 'By', actor || 'Not supplied by Azure'],
    [sameTime ? 'Time' : 'Source time', dateTime(record.time)],
  ];
  const add = (condition: unknown, label: string, value: () => HtmlValue) => {
    if (condition) fields.push([label, value()]);
  };
  add(!sameTime, 'Observed locally', () => dateTime(record.observedAt));
  add(pr && data.targetRefName, 'Target branch', () => branchName(data.targetRefName));
  add(sha, pr ? 'Source commit' : 'Commit', () => commit(sha as string));
  if (tag) fields.push(...tagFields(data));
  add(pr && data.status === 'completed' && data.mergeCommit, 'Merge commit', () => commit(data.mergeCommit as string));
  add(data.mergeStrategy, 'Merge strategy', () => mergeStrategies[data.mergeStrategy ?? ''] || 'Not supplied');
  add(pr && data.closedBy, 'PR closed by', () => data.closedBy);
  add(pr && data.reviewers?.length, 'Reviewers', () => reviewerList(data.reviewers as NonNullable<EventData['reviewers']>));
  add(data.reason, 'Trigger', () => triggerLabel(data.reason));
  add(data.pullRequestId, 'Pull request', () => `#${data.pullRequestId}`);
  add(pushId, 'Push', () => `#${pushId}`);
  return fields;
}

function detailHead(record: ActivityItem, repo: Repo | undefined, title: string, matching: ActivityEvent[], branchAction: HtmlValue) {
  const unseen = matching.filter(isUnseen);
  const ids = (unseen.length ? unseen : matching.filter(event => !event.imported)).map(event => event.id);
  const ack = !ids.length
    ? emptyHtml
    : html`<button class="btn" data-action="ack-item" data-mark-seen="${Boolean(unseen.length)}" data-id="${record.id}" data-event-ids="${JSON.stringify(ids)}">Mark ${unseen.length ? 'seen' : 'unseen'}</button>`;
  return html`<div class="dhead"><div><h1>${title}</h1><div class="meta">${record.kind.startsWith('branch-') ? 'Branch' : labels[record.kind]} · ${repo?.name} · ${branchName(record.branch)}</div></div><div class="actions">${branchAction}${azureLink(record.url, 'Open in Azure DevOps', 'btn')}${ack}</div></div>`;
}

function seenChip(matching: ActivityEvent[]) {
  const count = matching.filter(isUnseen).length;
  if (count) return `${count} new update${count === 1 ? '' : 's'}`;
  return matching.every(event => event.imported) ? 'Imported history' : 'Seen';
}

function detailFacts(record: ActivityItem, tone: string, matching: ActivityEvent[]) {
  return html`<div class="facts"><span class="chip status-chip ${tone}">${activityLabel(record)}</span><span class="chip">${seenChip(matching)}</span>${record.kind === 'build' ? html`<span class="chip name">CI outcome · deployment unknown</span>` : emptyHtml}</div>`;
}

function pushCommits(record: ActivityItem, repo: Repo | undefined, pushId: PushId, commits: CommitsView | undefined) {
  if (record.kind !== 'push' || !pushId) return emptyHtml;
  return html`<button class="btn" data-action="load-commits" data-repo-id="${record.repoId}" data-push-id="${pushId}">${commits ? 'Reload commits' : 'Load push commits'}</button><p class="help">Loads on request within the shared budget.</p>${commits ? renderCommits(commits) : emptyHtml}`;
}

/** Azure's policy evaluation status in words. */
const policyStatus: Record<string, string | undefined> = {
  approved: 'passed',
  rejected: 'failed',
  running: 'running',
  queued: 'waiting',
  notApplicable: 'not applicable',
  broken: 'broken',
};

function renderReview(review: ReviewView) {
  if ('error' in review) return html`<p class="status-bad">${review.error}</p>`;
  const { open, resolved } = review.threads;
  const policies = review.policies.map(
    policy => html`<li>${policy.name}${policy.blocking ? ' (required)' : ''}: ${policyStatus[policy.status] || policy.status}</li>`,
  );
  return html`<p>Discussion: ${open} open, ${resolved} resolved thread${open + resolved === 1 ? '' : 's'}</p>${policies.length ? html`<ul class="rows">${policies}</ul>` : html`<p class="help">No branch policies apply to this pull request.</p>`}`;
}

function prReview(record: ActivityItem, data: EventData, review: ReviewView | undefined) {
  if (record.kind !== 'pr' || !data.pullRequestId) return emptyHtml;
  return html`<button class="btn" data-action="load-review" data-repo-id="${record.repoId}" data-pr-id="${data.pullRequestId}">${review ? 'Reload discussion and policies' : 'Load discussion and policies'}</button><p class="help">Loads the current state on request within the shared budget.</p>${review ? renderReview(review) : emptyHtml}`;
}

function detailData(
  record: ActivityItem,
  repo: Repo | undefined,
  data: EventData,
  fields: [string, HtmlValue][],
  pushId: PushId,
  loaded: LoadedView | undefined,
) {
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

export function renderDetail(
  event: ActivityEvent | undefined,
  state: DetailState,
  commits: LoadedView | undefined,
  {
    returnUnreadOnly = false,
    matchingIds,
    checkouts,
  }: {
    returnUnreadOnly?: boolean;
    matchingIds?: string[] | undefined;
    checkouts?: Record<string, import('./checkout.ts').CheckoutSnapshot>;
  } = {},
) {
  const back = html`<a class="ghost sm back" data-action="back-to-results" href="${activityHref(returnUnreadOnly)}">← Back to Activity</a>`;
  if (!event) return html`${back}<div class="card empty"><h1>Activity not found</h1></div>`;
  const record = groupActivity(state.events).find(item => item.eventIds.includes(event.id)) || groupActivity([event])[0];
  // Grouping one event always yields its group.
  if (!record) return html`${back}<div class="card empty"><h1>Activity not found</h1></div>`;
  const repo = state.repos.find(item => item.id === record.repoId);
  const data = record.data || {};
  const pushId = data.pushId || data.push?.pushId;
  const sha = data.sourceVersion || data.sourceCommit || data.commitId;
  const fields = detailFields(record, repo, data, sha, pushId);
  const matching = matchingIds ? record.events.filter(item => matchingIds.includes(item.id)) : record.events;
  const branch = !state.demo && repo?.localPath ? activityBranch(event) : null;
  const branchAction = !branch
    ? emptyHtml
    : checkouts?.[event.repoId]?.branch === branch
      ? html`<a class="btn" id="activity-branch-action" href="${repositoryHref(event.repoId)}">View in Repositories</a>`
      : html`<button class="btn" type="button" id="activity-branch-action" data-action="switch-activity-branch">Switch to ${branch}…</button>`;
  return html`<div class="crumb">${back}<span>${repo?.name}</span></div><section class="card">${detailHead(record, repo, activityTitle(record), matching, branchAction)}
    ${detailFacts(record, activityTone(record), matching)}
    ${detailData(record, repo, data, fields, pushId, commits)}</section>`;
}

function renderCommits(commits: CommitsView) {
  if ('error' in commits && commits.error) return html`<p class="status-bad">${commits.error}</p>`;
  const items = 'items' in commits ? commits.items : [];
  return html`<ul class="rows">${items.map(item => html`<li class="push">${commit(item.commitId || '')} ${item.comment || ''}</li>`)}</ul>${'nextCursor' in commits && commits.nextCursor ? html`<p class="help">More commits are available in Azure DevOps.</p>` : emptyHtml}`;
}
