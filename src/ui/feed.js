// @ts-check

import {
  emptyHtml,
  html,
  branchName,
  dateTime,
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
import { renderSummary } from './activity-summary.js';
import { icons } from './icons.js';
import { renderTrail } from './activity-trail.js';
import { activityHref } from './navigation.js';
import { renderTypeFilter } from './type-filter.js';
import { currentActivityFilters, isSavedFilterModified, renderSavedFilters } from './saved-filters.js';
import { mergeEvidenceBadge } from './merge-evidence.js';
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
      </div><p class="help" id="feed-search-help">Enter a partial name or other search term. Separate terms with commas to match any. Use <code>people:Ali, Jo</code> to search recorded names only.</p>
    </div>
  </div>`;
}

/** @param {ActivityItem} record @param {PageState} state */
function row(record, state) {
  const repo = state.repos.find(item => item.id === record.repoId);
  const tone = activityTone(record);
  const failed = record.kind === 'build' && buildState(record).tone === 'crit';
  const ids = JSON.stringify(record.eventIds);
  const title = activityTitle(record);
  const actor = activityActor(record);
  return html`<li class="row ${failed ? 'crit' : record.unseen ? 'new' : ''} tone-${tone}" data-event-id="${record.id}" data-event-ids="${ids}" data-group-key="${record.groupKey}">
    <span class="kind ${tone}">${record.kind === 'branch-created' ? icons.branch : html`<span class="d"></span>`}${activityLabel(record)}</span>
    <div class="subject"><button class="feed-title" type="button" data-action="detail" data-id="${record.id}"><span class="title">${title}</span><span class="subref">${repo?.name || 'Unknown repository'}${record.branch ? ` / ${branchName(record.branch)}` : ''}</span></button></div>
    <div class="event">${activitySummary(record)}${mergeEvidenceBadge(record)}<div class="help">${actor ? `${record.kind === 'pr' ? 'Created by ' : record.kind === 'push' ? 'Pushed by ' : ''}${actor} · ` : ''}<time datetime="${record.time}">${dateTime(record.time)}</time></div>${renderTrail(record)}</div>
    <div class="counts">${record.unseen ? html`<b>${record.unseenIds.length > 1 ? `${record.unseenIds.length} new` : 'New'}</b>` : record.imported ? 'History' : 'Seen'}</div>
    <div class="rowact">${azureLink(record.url)}${record.imported ? emptyHtml : html`<button class="ghost sm" type="button" data-action="ack-item" data-id="${record.id}" data-event-ids="${ids}" aria-label="Mark ${title} ${record.unseen ? 'seen' : 'unseen'}">${record.unseen ? '✓ Seen' : '↶ Unseen'}</button>`}</div></li>`;
}

/** @param {string} title @param {ActivityItem[]} records @param {PageState} state @param {{ open?: boolean, description?: string }} [options] */
function group(title, records, state, { open = true, description = '' } = {}) {
  if (!records.length) return emptyHtml;
  return html`<section class="group"><details data-group="${title}" ${open ? html`open` : emptyHtml}><summary class="ghead">${title} <span class="pill u">${records.length}</span><span class="note">${description}</span></summary><ul class="rows">${records.map(record => row(record, state))}</ul></details></section>`;
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
  const imported = records.filter(record => record.imported);
  const content =
    ui.route === 'activity'
      ? html`${group(
          'Activity',
          records.filter(record => !record.imported),
          state,
        )}${group('Imported history', imported, state, { open: hasQuery, description: 'Captured before monitoring started' })}`
      : group('New updates', unseen, state);
  const current = html`aria-current="page"`;
  const viewControl = html`<h1 class="sr">Activity</h1><div class="activity-view"><nav class="seg" aria-label="Activity view" aria-describedby="activity-view-help"><a href="${activityHref('catchup')}" ${ui.route !== 'activity' ? current : emptyHtml}>New updates</a><a href="${activityHref('activity')}" ${ui.route === 'activity' ? current : emptyHtml}>All activity</a></nav><p class="help activity-view-help" id="activity-view-help">${ui.route === 'activity' ? 'Browse recorded updates, including seen and imported history.' : 'Updates you haven’t marked seen yet. Opening a page marks nothing.'}</p></div>`;
  return html`${viewControl}${renderSummary(records, state, ui, partial)}${statusBanner(state, attention)}${filterControls(ui, state)}
    <section class="card feed" aria-label="Repository activity">${records.length ? content : html`<div class="empty"><p class="big">${state.activity?.loading ? 'Loading activity…' : state.activity?.error ? 'Activity could not load' : hasQuery || ui.repoIds?.length === 0 ? 'No activity matches these filters' : partial ? 'No activity loaded yet' : ui.route === 'activity' ? 'No activity recorded yet' : 'No new updates'}</p><p class="dim">${state.activity?.error ? state.activity.error : state.activity?.loading ? 'Reading your locally stored history.' : partial ? 'This does not confirm that nothing changed. Check repository status.' : 'Use All activity to browse history, or adjust your filters.'}</p>${state.activity?.error ? html`<button class="btn sm" type="button" data-action="retry-activity">Try again</button>` : emptyHtml}</div>`}${state.activity?.nextCursor ? html`<div class="foot"><button class="btn" type="button" data-action="load-more-activity">Load more</button><span>Showing ${records.length} of ${state.activity.total} recorded items.</span></div>` : emptyHtml}<div class="foot"><button class="btn sm" type="button" data-action="ack-shown" ${unseen.length ? emptyHtml : html`disabled`}>Mark shown seen (${unseen.reduce((sum, record) => sum + record.unseenIds.length, 0)})</button><span>Only the shown updates. Opening this page marks nothing.</span></div></section>`;
}
