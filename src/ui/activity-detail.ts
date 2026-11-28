import { renderMergeEvidence } from './merge-evidence.ts';
import { groupActivity, isUnseen } from '../activity.ts';
import { activityBranch } from '../activity-branch.ts';
import { reviewerName } from '../activity-text.ts';
import {
  emptyHtml,
  html,
  branchName,
  labels,
  dateTime,
  fullDateTime,
  ciTime,
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
import { renderCheckoutBar } from './checkout-render.ts';
import { disclosure, type Groups } from './groups.ts';
import { activityHref } from './navigation.ts';
import type { ActivityEvent, ActivityItem, EventData } from '../activity.ts';
import type { HtmlValue } from './format.ts';
import type { StateResponse, PushCommitsResponse, PrReviewResponse, EventResponse } from '../contract.ts';
import { action } from './actions.ts';

export type Repo = StateResponse['repos'][number];
type PushId = number | string | undefined;

/** What the detail page shows after "Load push commits": the response, or the error the request threw. */
export type CommitsView = PushCommitsResponse | { error: string };
/** What a PR detail shows after "Load discussion and policies". */
type ReviewView = PrReviewResponse | { error: string };
/** Data a detail page loaded on request: push commits for a push, review data for a PR. */
export type LoadedView = CommitsView | ReviewView;
type DetailState = { enabledRepos: Repo[]; demo?: boolean };

/** What the detail page shows: the event the address names, the group it belongs to, and its related activity. */
export type DetailView = { event: ActivityEvent; record: ActivityItem; related: ActivityEvent[] };

/** The group of `events` that holds `event`, or the event alone when it belongs to no group there. */
function groupOf(events: ActivityEvent[], event: ActivityEvent) {
  return groupActivity(events).find(item => item.eventIds.includes(event.id)) ?? groupActivity([event])[0];
}

/**
 * The detail of event `id`: the group the server answered with (GET /api/activity/:id). Until that answer arrives, the
 * Activity row that holds the event gives its group, so a detail opened from a row shows at once; related activity
 * waits for the answer.
 */
export function detailView(
  state: {
    detail?: (Pick<EventResponse, 'related'> & { event: ActivityEvent; events: ActivityEvent[] }) | undefined;
    activity: { items: ActivityItem[] };
  },
  id: string | null,
): DetailView | undefined {
  const answer = state.detail;
  if (answer && answer.event.id === id) {
    const record = groupOf(answer.events, answer.event);
    return record && { event: answer.event, record, related: answer.related ?? [] };
  }
  const item = state.activity.items.find(row => id !== null && row.eventIds.includes(id));
  const event = item?.events.find(member => member.id === id);
  const record = item && event && groupOf(item.events, event);
  return event && record && { event, record, related: [] };
}

function commit(value: string) {
  return html`<code title="${value}">${value.slice(0, 8)}</code> <button class="ghost sm detail-copy" type="button" ${action('copy-commit')} data-value="${value}" aria-label="Copy full commit ID">Copy</button>`;
}

const mergeStrategies: Record<string, string | undefined> = {
  noFastForward: 'Merge commit',
  squash: 'Squash',
  rebase: 'Rebase and fast-forward',
  rebaseMerge: 'Rebase with merge commit',
};

function reviewerList(reviewers: NonNullable<EventData['reviewers']> | undefined) {
  if (!reviewers?.length) return emptyHtml;
  return html`<section class="detail-section"><h2>Reviewers</h2><ul class="detail-list">${reviewers.map(reviewer => {
    const rawName: unknown = reviewer.name;
    const name =
      typeof rawName === 'string' && rawName.trim() ? rawName : typeof rawName === 'number' ? String(rawName) : 'Unknown reviewer';
    const display = reviewerName(rawName);
    const tone = reviewer.vote > 0 ? 'ok' : reviewer.vote === -5 ? 'warn' : reviewer.vote < 0 ? 'crit' : 'neutral';
    return html`<li><span title="${name}">${display}</span>${reviewer.required ? html`<span class="chip">Required</span>` : emptyHtml}<span class="chip status-chip ${tone}">${voteLabel(reviewer.vote)}</span></li>`;
  })}</ul></section>`;
}

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

function factValue(value: HtmlValue, fallback = 'Not supplied') {
  if (!value || (typeof value === 'string' && /^unknown$/i.test(value))) {
    return html`<span class="dim">${value || fallback}</span>`;
  }
  return value;
}

function detailFields(
  record: ActivityItem,
  repo: Repo | undefined,
  data: EventData,
  sha: string | undefined,
  pushId: PushId,
): [string, [string, HtmlValue][]][] {
  const pr = record.kind === 'pr',
    tag = record.kind === 'tag';
  const sameTime = new Date(record.time).valueOf() === new Date(record.observedAt ?? NaN).valueOf();
  const label = activityActor(record);
  const actor = label && label !== record.actor ? html`<abbr title="${record.actor}">${label}</abbr>` : label;
  const change: [string, HtmlValue][] = [
    ['Repository', repo ? `${repo.name}${repo.project ? ` · ${repo.project}` : ''}` : html`<span class="dim">Not supplied</span>`],
    [pr ? 'Source branch' : tag ? 'Tag' : 'Branch', factValue(branchName(record.branch))],
  ];
  if (pr && data.targetRefName) change.push(['Target branch', branchName(data.targetRefName)]);
  if (data.mergeStrategy) change.push(['Merge strategy', factValue(mergeStrategies[data.mergeStrategy])]);
  if (data.reason) change.push(['Trigger', triggerLabel(data.reason)]);
  if (data.pullRequestId) change.push(['Pull request', `#${data.pullRequestId}`]);
  if (pushId) change.push(['Push', `#${pushId}`]);

  const commits: [string, HtmlValue][] = [];
  if (sha) commits.push([pr ? 'Source commit' : 'Commit', commit(sha)]);
  if (tag) commits.push(...tagFields(data));
  if (pr && data.status === 'completed' && data.mergeCommit) commits.push(['Merge commit', commit(data.mergeCommit)]);

  const people: [string, HtmlValue][] = [
    [pr ? 'Created by' : record.kind === 'push' ? 'Pushed by' : 'By', factValue(actor, 'Not supplied by Azure')],
    [sameTime ? 'Time' : 'Source time', dateTime(record.time)],
  ];
  if (!sameTime && record.observedAt) people.push(['Observed locally', dateTime(record.observedAt)]);
  if (pr && data.closedBy) people.push(['PR closed by', factValue(data.closedBy)]);

  return [
    ['Change', change],
    ['Commits', commits],
    ['People and time', people],
  ];
}

function detailHead(record: ActivityItem, repo: Repo | undefined, title: string, matching: ActivityEvent[]) {
  const unseen = matching.filter(isUnseen);
  const ids = (unseen.length ? unseen : matching.filter(event => !event.imported)).map(event => event.id);
  const ack = !ids.length
    ? emptyHtml
    : html`<button class="btn" ${action('ack-item')} data-mark-seen="${Boolean(unseen.length)}" data-event-id="${record.id}" data-event-ids="${JSON.stringify(ids)}">Mark ${unseen.length ? 'seen' : 'unseen'}</button>`;
  return html`<header class="dhead"><div class="detail-heading">${detailStatus(record, activityTone(record), matching)}<h1>${title}</h1><div class="meta">${record.kind.startsWith('branch-') ? 'Branch' : labels[record.kind]} · ${repo?.name} · ${branchName(record.branch)}</div></div><div class="actions">${azureLink(record.url, 'Open in Azure DevOps', 'btn')}${ack}</div></header>`;
}

function seenChip(matching: ActivityEvent[]) {
  const count = matching.filter(isUnseen).length;
  if (count) return `${count} new update${count === 1 ? '' : 's'}`;
  return matching.every(event => event.imported) ? 'Imported history' : 'Seen';
}

function detailStatus(record: ActivityItem, tone: string, matching: ActivityEvent[]) {
  const label = activityLabel(record);
  return html`<div class="facts"><span class="chip status-chip ${tone}${label === 'Merged' ? ' merged' : ''}">${label}</span><span class="chip">${seenChip(matching)}</span>${record.kind === 'build' ? html`<span class="chip name">CI outcome · deployment unknown</span>` : emptyHtml}</div>`;
}

function pushCommits(record: ActivityItem, repo: Repo | undefined, pushId: PushId, commits: CommitsView | undefined) {
  if (record.kind !== 'push' || !pushId) return emptyHtml;
  return html`<button class="btn" ${action('load-commits')} data-repo-id="${record.repoId}" data-push-id="${pushId}">${commits ? 'Reload commits' : 'Load push commits'}</button><p class="help">Loads on request within the shared budget.</p>${commits ? renderCommits(commits) : emptyHtml}`;
}

/** Azure policy status labels and tones. Unknown policy statuses stay neutral. */
const policyStatus = new Map([
  ['approved', ['passed', 'ok']],
  ['rejected', ['failed', 'crit']],
  ['running', ['running', 'info']],
  ['queued', ['waiting', 'warn']],
  ['notApplicable', ['not applicable', 'neutral']],
  ['broken', ['broken', 'crit']],
]);

function renderReview(review: ReviewView) {
  if ('error' in review) return html`<p class="status-bad" role="alert">${review.error}</p>`;
  const { open, resolved } = review.threads;
  return html`<div class="discussion-stats" role="group" aria-label="Discussion"><span class="${open ? 'status-text warn' : ''}"><strong>${open}</strong> open thread${open === 1 ? '' : 's'}</span><span><strong>${resolved}</strong> resolved</span></div>
    ${
      review.policies.length
        ? html`<ul class="detail-list">${review.policies.map(policy => {
            const [label, tone] = policyStatus.get(policy.status) ?? [policy.status, 'neutral'];
            return html`<li><span>${policy.name}</span>${policy.blocking ? html`<span class="chip">Required</span>` : emptyHtml}<span class="chip status-chip ${tone}">${label}</span></li>`;
          })}</ul>`
        : html`<p class="help">No branch policies apply to this pull request.</p>`
    }`;
}

function prReview(record: ActivityItem, data: EventData, review: ReviewView | undefined) {
  if (record.kind !== 'pr' || !data.pullRequestId) return emptyHtml;
  return html`<section class="detail-section"><div class="detail-section-head"><h2>Discussion and policies</h2><button class="btn sm" ${action('load-review')} data-repo-id="${record.repoId}" data-pr-id="${data.pullRequestId}">${review ? 'Reload discussion and policies' : 'Load discussion and policies'}</button></div><p class="help">Loads the current state on request within the shared budget.</p>${review ? renderReview(review) : emptyHtml}</section>`;
}

function detailData(
  record: ActivityItem,
  repo: Repo | undefined,
  data: EventData,
  fields: ReturnType<typeof detailFields>,
  pushId: PushId,
  loaded: LoadedView | undefined,
  related: ActivityEvent[],
  showRelated: boolean,
  groups: Groups,
) {
  const completed = record.kind === 'pr' && data.status === 'completed';
  const summary = record.kind !== 'build' ? activitySummary(record) : '';
  const evidence = record.kind === 'push' ? renderMergeEvidence(data) : emptyHtml;
  const trail = renderTrail(record, { expanded: true });
  const extra =
    record.kind === 'pr'
      ? prReview(record, data, loaded && !('items' in loaded) ? loaded : undefined)
      : pushCommits(record, repo, pushId, loaded && !('threads' in loaded) ? loaded : undefined);
  const timeline = relatedActivity(record, related, showRelated, groups);
  const hasMain = [evidence, trail, extra, timeline].some(section => section !== emptyHtml);
  const main = hasMain
    ? html`<div class="detail-main">
    ${evidence !== emptyHtml ? html`<div class="detail-section">${evidence}</div>` : emptyHtml}${trail !== emptyHtml ? html`<div class="detail-section">${trail}</div>` : emptyHtml}
    ${record.kind === 'push' && extra !== emptyHtml ? html`<div class="detail-section">${extra}</div>` : extra}${timeline}</div>`
    : emptyHtml;
  const metadata = html`<div class="detail-metadata"><div class="detail-facts">${fields.filter(([, values]) => values.length).map(([name, values]) => html`<section class="detail-section"><h2>${name}</h2><dl>${values.map(([label, value]) => html`<div><dt>${label}</dt><dd>${value}</dd></div>`)}</dl></section>`)}</div>
    ${record.kind === 'pr' ? reviewerList(data.reviewers) : emptyHtml}${completed ? html`<p class="help detail-note">Completed in Azure DevOps. Push details show separately checked commit and PR evidence.</p>` : emptyHtml}</div>`;
  return html`${summary ? html`<div class="detail-outcome"><strong>${summary}</strong>${completed && data.targetRefName ? html`<span><code>${branchName(record.branch) || 'Source not supplied'}</code> → <code>${branchName(data.targetRefName)}</code></span>${data.mergeCommit ? html`<code title="${data.mergeCommit}">${data.mergeCommit.slice(0, 8)}</code>` : emptyHtml}<time datetime="${record.time}" title="${fullDateTime(record.time)}">${dateTime(record.time)}</time>` : emptyHtml}</div>` : emptyHtml}
    <div class="detail-data ${record.kind === 'pr' && hasMain ? 'pr-detail-data' : ''}">${record.kind === 'pr' ? html`${main}${metadata}` : html`${metadata}${main}`}</div>`;
}

function relatedActivity(record: ActivityItem, events: ActivityEvent[], showRelated: boolean, groups: Groups) {
  if (!events.length) return emptyHtml;
  const days = new Map<string, ActivityEvent[]>();
  for (const event of events) {
    const day = new Date(event.time).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
    const group = days.get(day);
    if (group) group.push(event);
    else days.set(day, [event]);
  }
  return html`<details class="detail-section detail-related" ${disclosure(groups, `related-${record.id}`, showRelated)}><summary ${action('toggle-group')}>${showRelated ? 'Related CI runs' : 'Related activity'} · ${events.length}</summary>
    ${[...days].map(
      ([day, entries]) =>
        html`<h3>${day}</h3><ul class="detail-list">${entries.map(event => {
          const label = activityLabel(event);
          const title = activityTitle(event);
          const samePr =
            record.kind === 'pr' &&
            event.kind === 'pr' &&
            record.data?.pullRequestId &&
            String(record.data.pullRequestId) === String(event.data?.pullRequestId) &&
            title === activityTitle(record);
          const name = samePr ? 'Pull request update' : title;
          const time = new Date(event.time);
          const clock = Number.isNaN(time.valueOf())
            ? dateTime(event.time)
            : time.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
          return html`<li><span class="chip status-chip ${activityTone(event)}${label === 'Merged' ? ' merged' : ''}">${label}</span>
        <a href="#event/${encodeURIComponent(event.id)}" title="${title}" aria-label="${samePr ? `${name} · ` : ''}${label} · ${title}">${name}</a>
        ${event.kind === 'build' ? ciTime(event.time, true) : html`<time datetime="${event.time}" title="${fullDateTime(event.time)}">${clock}</time>`}</li>`;
        })}</ul>`,
    )}
  </details>`;
}

export function renderDetail(
  view: DetailView | undefined,
  state: DetailState,
  commits: LoadedView | undefined,
  {
    returnUnseenOnly = false,
    returnToGraph = false,
    showRelated = false,
    matchingIds,
    checkouts,
    groups = new Map(),
  }: {
    returnUnseenOnly?: boolean;
    returnToGraph?: boolean;
    showRelated?: boolean;
    matchingIds?: string[] | undefined;
    checkouts?: Record<string, import('./checkout.ts').CheckoutSnapshot>;
    /** Which disclosures the reader opened; none before the reader chooses. */
    groups?: Groups;
  } = {},
) {
  const back = returnToGraph
    ? html`<a class="ghost sm back" ${action('back-to-graph')} href="#graph">← Back to Git Graph</a>`
    : html`<a class="ghost sm back" ${action('back-to-results')} href="${activityHref(returnUnseenOnly)}">← Back to Activity</a>`;
  if (!view) return html`${back}<div class="card empty"><h1>Activity not found</h1></div>`;
  const { event, record, related } = view;
  const repo = state.enabledRepos.find(item => item.id === record.repoId);
  const data = record.data || {};
  const pushId = data.pushId || data.push?.pushId;
  const sha = data.sourceVersion || data.sourceCommit || data.commitId;
  const fields = detailFields(record, repo, data, sha, pushId);
  const matching = matchingIds ? record.events.filter(item => matchingIds.includes(item.id)) : record.events;
  const branch = !state.demo && repo?.localPath ? activityBranch(event) : null;
  const checkoutBar = branch ? renderCheckoutBar(event.repoId, checkouts?.[event.repoId], branch) : emptyHtml;
  return html`<div class="crumb">${back}<span>${repo?.name}</span></div><section class="card">${detailHead(record, repo, activityTitle(record), matching)}${checkoutBar}
    ${detailData(record, repo, data, fields, pushId, commits, related, showRelated, groups)}</section>`;
}

export function renderCommits(commits: CommitsView) {
  if ('error' in commits && commits.error) return html`<p class="status-bad">${commits.error}</p>`;
  const items = 'items' in commits ? commits.items : [];
  return html`<ul class="rows">${items.map(item => html`<li class="push">${commit(item.commitId || '')} ${item.comment || ''}</li>`)}</ul>${'nextCursor' in commits && commits.nextCursor ? html`<p class="help">More commits are available in Azure DevOps.</p>` : emptyHtml}`;
}
