// @ts-check

import {
  escape as e,
  branchName,
  dateTime,
  azureLink,
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
import { mergeEvidenceBadge } from './merge-evidence.js';
export { renderDetail } from './activity-detail.js';

/** @typedef {import('./refresh.js').PageState} PageState */
/** @typedef {import('../activity.js').ActivityItem} ActivityItem */
/** @typedef {Pick<import('./navigation.js').NavigationState, 'route' | 'repoIds' | 'search' | 'kind' | 'filtersOpen'>} FeedView */

/** @param {Pick<FeedView, 'search' | 'kind' | 'filtersOpen'>} ui @param {PageState['activity'] | undefined} activity */
export function filterControls(ui, activity) {
  const desktop = globalThis.matchMedia?.('(min-width: 640px)').matches ?? true;
  const active = Number(Boolean(ui.search)) + Number(Boolean(ui.kind));
  return `<details class="filters-box" data-filter-panel ${desktop || ui.filtersOpen === true ? 'open' : ''}><summary class="btn sm">Filters${active ? ` · ${active}` : ''}</summary><div class="toolbar"><input id="feed-search" class="search" type="search" aria-label="Search activity" placeholder="Search branch, commit, person or repository…" value="${e(ui.search)}">
    ${renderTypeFilter(ui.kind, activity?.filterOptions, activity?.loading)}
    <span class="spacer"></span><button class="btn sm" type="button" data-action="clear-filters">Clear filters</button></div></details>`;
}

/** @param {ActivityItem} record @param {PageState} state */
function row(record, state) {
  const repo = state.repos.find(item => item.id === record.repoId);
  const tone = activityTone(record);
  const failed = record.kind === 'build' && buildState(record).tone === 'crit';
  const ids = e(JSON.stringify(record.eventIds));
  const title = activityTitle(record);
  return `<li class="row ${failed ? 'crit' : record.unseen ? 'new' : ''} tone-${tone}" data-event-id="${e(record.id)}" data-event-ids="${ids}" data-group-key="${e(record.groupKey)}">
    <span class="kind ${tone}">${record.kind === 'branch-created' ? icons.branch : '<span class="d"></span>'}${e(activityLabel(record))}</span>
    <div class="subject"><button class="feed-title" type="button" data-action="detail" data-id="${e(record.id)}"><span class="title">${e(title)}</span><span class="subref">${e(repo?.name || 'Unknown repository')}${record.branch ? ' / ' + e(branchName(record.branch)) : ''}</span></button></div>
    <div class="event">${e(activitySummary(record))}${mergeEvidenceBadge(record)}<div class="help">${record.actor ? `${record.kind === 'pr' ? 'Created by ' : ''}${e(record.actor)} · ` : ''}<time datetime="${e(record.time)}">${e(dateTime(record.time))}</time></div>${renderTrail(record)}</div>
    <div class="counts">${record.unseen ? `<b>${record.unseenIds.length > 1 ? `${record.unseenIds.length} new` : 'New'}</b>` : record.imported ? 'History' : 'Seen'}</div>
    <div class="rowact">${azureLink(record.url)}${record.imported ? '' : `<button class="ghost sm" type="button" data-action="ack-item" data-id="${e(record.id)}" data-event-ids="${ids}" aria-label="Mark ${e(title)} ${record.unseen ? 'seen' : 'unseen'}">${record.unseen ? '✓ Seen' : '↶ Unseen'}</button>`}</div></li>`;
}

/** @param {string} title @param {ActivityItem[]} records @param {PageState} state @param {{ open?: boolean, description?: string }} [options] */
function group(title, records, state, { open = true, description = '' } = {}) {
  if (!records.length) return '';
  return `<section class="group"><details data-group="${e(title)}" ${open ? 'open' : ''}><summary class="ghead">${e(title)} <span class="pill u">${records.length}</span><span class="note">${e(description)}</span></summary><ul class="rows">${records.map(record => row(record, state)).join('')}</ul></details></section>`;
}

/**
 * One banner when the shown repositories need the reader's attention. Plain text: #sync-live already announces sync changes.
 * @param {PageState} state @param {import('./health.js').SyncStatus & { repoId: string } | undefined} status
 */
function statusBanner(state, status) {
  if (!status) return '';
  const name = syncRepoName(state.repos, status);
  const where = name ? `${e(name)}: ` : '';
  if (status.state === 'problem')
    return `<div class="banner crit"><div><strong>Problem</strong>${where}${e(status.reason)} <a href="#repositories">See Repositories</a></div></div>`;
  if (status.state === 'delayed')
    return `<div class="banner warn"><div><strong>Delayed</strong>${where}${e(status.reason)}. Showing the activity stored so far.</div></div>`;
  if (status.state === 'paused')
    return '<div class="banner info"><div><strong>Paused</strong>Automatic checks are off. <a href="#settings">Turn them on</a> or refresh manually.</div></div>';
  return '';
}

/** @param {PageState} state @param {FeedView} ui */
export function renderFeed(state, ui) {
  const records = state.activity.items;
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
      ? `${group(
          'Activity',
          records.filter(record => !record.imported),
          state,
        )}${group('Imported history', imported, state, { open: Boolean(ui.search || ui.kind), description: 'Captured before monitoring started' })}`
      : group('New updates', unseen, state);
  const viewControl = `<h1 class="sr">Activity</h1><div class="activity-view"><nav class="seg" aria-label="Activity view" aria-describedby="activity-view-help"><a href="${activityHref('catchup')}" ${ui.route !== 'activity' ? 'aria-current="page"' : ''}>New updates</a><a href="${activityHref('activity')}" ${ui.route === 'activity' ? 'aria-current="page"' : ''}>All activity</a></nav><p class="help activity-view-help" id="activity-view-help">${ui.route === 'activity' ? 'Browse recorded updates, including seen and imported history.' : 'Updates you haven’t marked seen yet. Opening a page marks nothing.'}</p></div>`;
  return `${viewControl}${renderSummary(records, state, ui, partial)}${statusBanner(state, attention)}${filterControls(ui, state.activity)}
    <section class="card feed" aria-label="Repository activity">${records.length ? content : `<div class="empty"><p class="big">${state.activity?.loading ? 'Loading activity…' : state.activity?.error ? 'Activity could not load' : ui.search || ui.kind || ui.repoIds?.length === 0 ? 'No activity matches these filters' : partial ? 'No activity loaded yet' : ui.route === 'activity' ? 'No activity recorded yet' : 'No new updates'}</p><p class="dim">${state.activity?.error ? e(state.activity.error) : state.activity?.loading ? 'Reading your locally stored history.' : partial ? 'This does not confirm that nothing changed. Check repository status.' : 'Use All activity to browse history, or adjust your filters.'}</p>${state.activity?.error ? '<button class="btn sm" type="button" data-action="retry-activity">Try again</button>' : ''}</div>`}${state.activity?.nextCursor ? `<div class="foot"><button class="btn" type="button" data-action="load-more-activity">Load more</button><span>Showing ${records.length} of ${state.activity.total} recorded items.</span></div>` : ''}<div class="foot"><button class="btn sm" type="button" data-action="ack-shown" ${unseen.length ? '' : 'disabled'}>Mark shown seen (${unseen.reduce((sum, record) => sum + record.unseenIds.length, 0)})</button><span>Only the shown updates. Opening this page marks nothing.</span></div></section>`;
}
