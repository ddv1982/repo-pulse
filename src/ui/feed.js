// @ts-check

import {
  emptyHtml,
  html,
  dateTime,
  fullDateTime,
  azureLink,
  activityActor,
  activityLabel,
  activityTone,
  activityTitle,
  activitySummary,
  buildState,
} from './format.js';
import { syncRepoName } from './health.js';
import { worstStatus } from '../sync-worst.js';
import { emptyActivityMessage, renderSummary } from './activity-summary.js';
import { icons } from './icons.js';
import { renderTrail } from './activity-trail.js';
import { activityHref } from './navigation.js';
import { renderTypeFilter } from './type-filter.js';
import { activityScopeQuery } from './activity-data.js';
import { activityFilterLabel, activityRef, prForkSource, prTarget, prVoteChanges } from '../activity-text.js';
import { scopeName } from './header.js';
import { currentActivityFilters, isSavedFilterModified, renderSavedFilters } from './saved-filters.js';
import { mergeEvidenceBadge } from './merge-evidence.js';
import { buildActivityTree } from '../activity-tree.js';
import { forkText, renderTreeCell, treeLegend } from './activity-tree.js';
export { renderDetail } from './activity-detail.js';

/** @typedef {import('./refresh.js').PageState} PageState */
/** @typedef {import('../activity.js').ActivityItem} ActivityItem */
/** @typedef {Pick<import('./navigation.js').NavigationState, 'route' | 'repoIds' | 'search' | 'kind' | 'filtersOpen'>} FeedView */

/** @param {FeedView & {savedFilterId: string}} ui @param {PageState} state */
export function filterControls(ui, state) {
  const desktop = globalThis.matchMedia?.('(min-width: 640px)').matches ?? true;
  const active = Number(Boolean(ui.search)) + Number(Boolean(ui.kind));
  const open = desktop || ui.filtersOpen === true;
  const presets = state.savedFilters ?? [];
  const saved = presets.find(filter => filter.id === ui.savedFilterId);
  const modified = Boolean(saved && isSavedFilterModified(saved.filters, currentActivityFilters(ui), state.watched));
  return html`<div class="activity-filter-bar">
    <button class="btn filters-toggle" id="activity-filters-toggle" data-action="toggle-activity-filters" type="button"
      aria-expanded="${open}" aria-controls="activity-filters">Filters${active ? ` · ${active}` : ''}</button>
    ${renderSavedFilters(presets, ui.savedFilterId, modified)}
    <div class="filters-box" id="activity-filters" ${open ? emptyHtml : html`hidden`}>
      <div class="toolbar"><input id="feed-search" class="search" type="search" aria-label="Search activity" aria-describedby="feed-search-help" placeholder="Search branch, commit, person or repository…" value="${ui.search}">
        ${renderTypeFilter(ui.kind, state.activity.filterOptions, state.activity.loading)}
        ${active ? html`<button class="btn" id="clear-filters" type="button" data-action="clear-filters">Clear search and type</button>` : emptyHtml}
      </div><p class="help" id="feed-search-help">Commas match any term · <code>people:Ali, Jo</code> searches names only</p>
    </div>
  </div>`;
}

/** What the named person did, per kind. A branch or tag event comes from a push. @type {Record<import('../activity.js').ActivityKind, string>} */
const actorRoles = {
  pr: 'Created by',
  build: 'Requested by',
  push: 'Pushed by',
  'branch-created': 'Pushed by',
  'branch-deleted': 'Pushed by',
  tag: 'Pushed by',
};

/**
 * Who and when. The actor is left out when the title already starts with them ("Ana pushed to main"); an unknown
 * actor has no role to name.
 * @param {ActivityItem} record @param {string} title
 */
function renderMeta(record, title) {
  const actor = activityActor(record);
  const shown = actor && !title.startsWith(`${actor} `);
  const role = actor === 'Unknown' ? '' : `${actorRoles[record.kind]} `;
  return html`<div class="help event-meta">${shown ? html`${role}<span class="actor">${actor}</span> · ` : emptyHtml}<time datetime="${record.time}" title="${fullDateTime(record.time)}">${dateTime(record.time)}</time></div>`;
}

/**
 * The event column in tiers: what happened with its evidence chips, then who and when, then where the branch started.
 * @param {ActivityItem} record @param {string} title @param {string} origin
 */
function renderEvent(record, title, origin) {
  const pr =
    record.kind === 'pr' && record.data && (record.data.targetRefName || record.data.voteChanges?.length) ? record.data : undefined;
  const votes = pr ? prVoteChanges(pr) : [];
  const summary = votes.length
    ? html`${votes.map(change => html`<span class="status-text ${voteTone(change.vote)}"><span class="status-dot" aria-hidden="true"></span>${change.text}</span>`)}`
    : pr
      ? prTarget(pr)
      : rowSummary(record);
  const badge = mergeEvidenceBadge(record);
  const origins = [pr ? prForkSource(pr.fork) : '', origin].filter(Boolean);
  return html`<div class="event">${summary || badge !== emptyHtml ? html`<div class="event-main">${typeof summary === 'string' ? (summary ? html`<span>${summary}</span>` : emptyHtml) : summary}${badge}</div>` : emptyHtml}${renderMeta(record, title)}${origins.map(
    text => html`<div class="help event-origin">${icons.branch}<span>${text}</span></div>`,
  )}${renderTrail(record)}</div>`;
}

/** A reviewer vote's tone; the words carry the meaning, the color repeats it. @param {number} vote */
const voteTone = vote => (vote > 0 ? 'ok' : vote === -5 ? 'warn' : vote < 0 ? 'crit' : 'neutral');

/** A CI run without a known trigger has nothing to summarise in its row; the detail page still names the gap. @param {ActivityItem} record */
function rowSummary(record) {
  const summary = activitySummary(record);
  return record.kind === 'build' && summary === 'Not supplied' ? '' : summary;
}

/** Whether the title names the ref as a whole word, so `main` is not found inside `main-old`. @param {string} title @param {string} ref */
const namesRef = (title, ref) => new RegExp(`(^|[\\s,(])${ref.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[\\s,)])`).test(title);

/**
 * The line under a row's title says where it happened: repository, branch and pull request as separate tokens.
 * The hidden words keep the button's accessible name readable after its title. A push, branch or tag title already
 * names its ref, so the line leaves it out; a PR or CI title can contain a branch name by accident, so those keep it.
 * @param {ActivityItem} record @param {string} title the row's shown title
 * @param {string} repoName empty when the row needs no repository name
 */
function renderRefLine(record, title, repoName) {
  const ref = record.branch ? activityRef(record) : { branch: '' };
  const named = !['pr', 'build'].includes(record.kind) && Boolean(ref.branch) && namesRef(title, ref.branch);
  const { branch, pullRequestId } = named ? { ...ref, branch: '' } : ref;
  if (!repoName && !branch && !pullRequestId) return emptyHtml;
  return html`<span class="subref">${repoName ? html`<span class="ref-repo"><span class="sr"> · repository </span>${repoName}</span>` : emptyHtml}${
    branch
      ? html`<span class="ref-branch" title="${branch}">${icons.branch}<span class="sr"> · branch </span><span class="ref-name">${branch}</span></span>`
      : emptyHtml
  }${pullRequestId ? html`<span class="chip ref-pr"><span class="sr"> · </span>PR ${pullRequestId}</span>` : emptyHtml}</span>`;
}

/**
 * @param {ActivityItem} record @param {PageState} state @param {import('../activity-tree.js').TreeRow} [tree]
 * @param {boolean} [showRepo] whether more than one repository is in view, so the row has to say which one it belongs to
 */
function row(record, state, tree, showRepo = true) {
  const repo = state.repos.find(item => item.id === record.repoId);
  const tone = activityTone(record);
  const failed = record.kind === 'build' && buildState(record).tone === 'crit';
  const ids = JSON.stringify(record.eventIds);
  const unreadIds = JSON.stringify(record.unseenIds);
  const ackIds = record.unseen ? unreadIds : JSON.stringify(record.events.filter(event => !event.imported).map(event => event.id));
  const title = activityTitle(record);
  const origin = forkText(tree?.fork ?? null);
  return html`<li class="${['row', failed ? 'crit' : '', record.unseen ? 'new' : '', `tone-${tone}`].filter(Boolean).join(' ')}" data-event-id="${record.id}" data-event-ids="${ids}" data-group-key="${record.groupKey}" data-unseen-ids="${unreadIds}">${tree ? renderTreeCell(tree, tone) : emptyHtml}
    <span class="kind ${tone}">${record.kind === 'branch-created' ? icons.branch : html`<span class="d"></span>`}${activityLabel(record)}</span>
    <div class="subject"><button class="feed-title" type="button" data-action="detail" data-id="${record.id}"><span class="title">${title}${record.unseenIds.length > 1 ? html` <span class="pill u new-count">${record.unseenIds.length} new</span>` : emptyHtml}</span>${renderRefLine(record, title, showRepo ? repo?.name || 'Unknown repository' : '')}</button></div>
    ${renderEvent(record, title, origin)}
    <div class="rowact">${azureLink(record.url)}${record.imported ? emptyHtml : html`<button class="ghost sm seen-toggle" type="button" id="seen-${record.id}" data-action="ack-item" data-id="${record.id}" data-mark-seen="${record.unseen}" data-event-ids="${ackIds}" aria-pressed="${!record.unseen}" aria-label="Seen: ${title}">${icons.seenBox}Seen</button>`}</div></li>`;
}

/** @param {string} title @param {ActivityItem[]} records @param {PageState} state @param {{ open?: boolean, description?: string, tree?: import('../activity-tree.js').ActivityTree, showRepo?: boolean }} [options] */
function group(title, records, state, { open = true, description = '', tree, showRepo = true } = {}) {
  if (!records.length) return emptyHtml;
  return html`<section class="group"><details data-group="${title}" ${open ? html`open` : emptyHtml}><summary class="ghead">${title} <span class="pill u">${records.length}</span><span class="note">${description}</span></summary><ul class="rows${tree ? ' with-tree' : ''}" ${tree ? html`data-tree-lanes="${tree.width}"` : emptyHtml}>${records.map((record, index) => row(record, state, tree?.rows[index], showRepo))}</ul></details></section>`;
}

/**
 * All activity: both groups carry a branch tree. They share one width so their columns line up.
 * @param {ActivityItem[]} records @param {PageState} state @param {boolean} hasQuery @param {boolean} showRepo
 */
function historyGroups(records, state, hasQuery, showRepo) {
  const lists = [records.filter(record => !record.imported), records.filter(record => record.imported)];
  const trees = lists.map(list => buildActivityTree(list));
  const width = Math.max(...trees.map(tree => tree.width));
  const [recorded, imported] = trees.map(tree => ({ ...tree, width }));
  return html`${group('Activity', lists[0], state, { tree: recorded, showRepo })}${group('Imported history', lists[1], state, { open: hasQuery, description: 'Captured before monitoring started', tree: imported, showRepo })}`;
}

/**
 * One banner when the shown repositories need the reader's attention. Plain text: #sync-live already announces sync changes.
 * @param {PageState} state @param {import('./health.js').SyncStatus & { repoId: string } | undefined} status
 */
function statusBanner(state, status) {
  if (!status) return emptyHtml;
  const name = syncRepoName(state.repos, status);
  const where = name ? `${name}: ` : '';
  if (status.state === 'problem')
    return html`<div class="banner crit"><div><strong>Problem</strong>${where}${status.reason} <a href="#repositories">See Repositories</a></div></div>`;
  if (status.state === 'delayed')
    return html`<div class="banner warn"><div><strong>Delayed</strong>${where}${status.reason}. Showing the activity stored so far.</div></div>`;
  if (status.state === 'paused')
    return html`<div class="banner info"><div><strong>Paused</strong>Automatic checks are off. <a href="#settings">Turn them on</a> or refresh manually.</div></div>`;
  return emptyHtml;
}

/** @param {PageState} state @param {FeedView} ui @param {string[]} repoIds */
function matchingAction(state, ui, repoIds) {
  const total = state.activity.newUpdates;
  if (!total) return emptyHtml;
  const query = activityScopeQuery({ ...ui, repoIds });
  // Stop at the snapshot this page was read at, so updates recorded later stay unread.
  if (state.activity.asOf !== undefined) query.set('through', String(state.activity.asOf));
  const search = ui.search.trim();
  const scope = `${scopeName(state, ui)} · ${activityFilterLabel(ui.kind)}${search ? ` · Search “${search}”` : ''}`;
  const label = ui.search || ui.kind || ui.repoIds !== null ? 'Mark all matching seen' : 'Mark all seen';
  return html`<button class="btn sm" type="button" data-action="ack-matching" data-query="${query.toString()}" data-scope="${scope}">${label} (${total})</button>`;
}

/** @param {PageState} state @param {FeedView & {savedFilterId: string}} ui */
export function renderFeed(state, ui) {
  const records = state.activity.items;
  const hasQuery = Boolean(ui.search || ui.kind);
  const shown = state.repos.filter(repo => ui.repoIds === null || ui.repoIds.includes(repo.id));
  // Until every shown repository is synced, an empty or short list does not prove that nothing changed.
  const partial = shown.some(repo => state.syncStatus.repos[repo.id]?.state !== 'synced');
  const overall = state.syncStatus.overall;
  const attention =
    worstStatus(
      shown.flatMap(repo => (state.syncStatus.repos[repo.id] ? [{ ...state.syncStatus.repos[repo.id], repoId: repo.id }] : [])),
    ) ??
    // A problem that belongs to no repository, such as a failed reset with none enabled, still needs the banner.
    (overall.state === 'problem' && !('repoId' in overall) ? { ...overall, repoId: '' } : undefined);
  const unseen = records
    .filter(record => record.unseen)
    .sort((a, b) => Number(b.kind === 'branch-created') - Number(a.kind === 'branch-created'));
  // With one repository in view every row would repeat its name, so rows name it only when several are shown.
  const showRepo = shown.length > 1;
  // New updates lists new branches first, so its rows are not in time order and it gets no tree.
  const content =
    ui.route === 'activity' ? historyGroups(records, state, hasQuery, showRepo) : group('New updates', unseen, state, { showRepo });
  const current = html`aria-current="page"`;
  const emptyMessage = emptyActivityMessage(ui, partial);
  const bulk = matchingAction(
    state,
    ui,
    shown.map(repo => repo.id),
  );
  const viewControl = html`<h1 class="sr">Activity</h1><div class="activity-view"><nav class="seg" aria-label="Activity view" aria-describedby="activity-view-help"><a href="${activityHref('catchup')}" ${ui.route !== 'activity' ? current : emptyHtml}>New updates</a><a href="${activityHref('activity')}" ${ui.route === 'activity' ? current : emptyHtml}>All activity</a></nav><p class="help activity-view-help" id="activity-view-help">${ui.route === 'activity' ? 'Browse recorded updates, including seen and imported history.' : 'Updates you haven’t marked seen yet. Opening a page marks nothing.'}</p></div>`;
  return html`${viewControl}${renderSummary(records, state, ui, partial)}${statusBanner(state, attention)}${filterControls(ui, state)}
    <section class="card feed" aria-label="Repository activity">${bulk === emptyHtml ? emptyHtml : html`<div class="foot feed-actions">${bulk}</div>`}${ui.route === 'activity' && records.length ? treeLegend : emptyHtml}${records.length ? content : html`<div class="empty"><p class="big">${state.activity?.loading ? 'Loading activity…' : state.activity?.error ? 'Activity could not load' : emptyMessage}</p><p class="dim">${state.activity?.error ? state.activity.error : state.activity?.loading ? 'Reading your locally stored history.' : partial ? 'This does not confirm that nothing changed. Check repository status.' : 'Use All activity to browse history, or adjust your filters.'}</p>${state.activity?.error ? html`<button class="btn sm" type="button" data-action="retry-activity">Try again</button>` : emptyHtml}</div>`}${state.activity?.nextCursor ? html`<div class="foot"><button class="btn" type="button" data-action="load-more-activity">Load more</button><span>Showing ${records.length} of ${state.activity.total} recorded items.</span></div>` : emptyHtml}</section>`;
}
