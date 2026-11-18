import { escape as e, branchName, dateTime, azureLink, activityLabel, activityTone, activityTitle, activitySummary, buildState, streamLabel } from './format.js';
import { streamHealth } from './health.js';
import { renderSummary } from './activity-summary.js';
import { icons } from './icons.js';
import { renderTrail } from './activity-trail.js';
import { activityHref } from './navigation.js';
import { renderTypeFilter } from './type-filter.js';
import { mergeEvidenceBadge } from './merge-evidence.js';
export { renderDetail } from './activity-detail.js';

export function filterControls(ui, activity) {
  const desktop = globalThis.matchMedia?.('(min-width: 640px)').matches ?? true;
  const active = Number(Boolean(ui.search)) + Number(Boolean(ui.kind));
  return `<details class="filters-box" data-filter-panel ${desktop || ui.filtersOpen === true ? 'open' : ''}><summary class="btn sm">Filters${active ? ` · ${active}` : ''}</summary><div class="toolbar"><input id="feed-search" class="search" type="search" aria-label="Search activity" placeholder="Search branch, commit, person or repository…" value="${e(ui.search)}">
    ${renderTypeFilter(ui.kind, activity?.filterOptions, activity?.loading)}
    <span class="spacer"></span><button class="btn sm" type="button" data-action="clear-filters">Clear filters</button></div></details>`;
}

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

function group(title, records, state, { open = true, description = '' } = {}) {
  if (!records.length) return '';
  return `<section class="group"><details data-group="${e(title)}" ${open ? 'open' : ''}><summary class="ghead">${e(title)} <span class="pill u">${records.length}</span><span class="note">${e(description)}</span></summary><ul class="rows">${records.map(record => row(record, state)).join('')}</ul></details></section>`;
}

function healthFor(state, ui) {
  const streams = state.streams.filter(stream => ui.repoIds === null || ui.repoIds.includes(stream.repoId));
  const paused = state.repos.filter(repo => repo.paused && (ui.repoIds === null || ui.repoIds.includes(repo.id)));
  const pausedIds = new Set(paused.map(repo => repo.id));
  const status = streams.map(stream => ({ stream,
    ...streamHealth(stream, { scheduled: state.settings.refreshEnabled !== false && !pausedIds.has(stream.repoId), resumedAt: state.settings.refreshResumedAt }),
  }));
  const errors = status.filter(item => item.error);
  const pending = status.filter(item => item.pending);
  const resuming = status.some(item => item.resuming);
  const stale = status.filter(item => item.stale && !item.pending);

  return { paused, errors, pending, resuming, stale, problemStreams: [...new Set([...errors, ...stale])],
    partial: Boolean(errors.length || pending.length || resuming || stale.length || paused.length || state.settings.refreshEnabled === false) };
}

function monitoringNotice(state, health) {
  const message = state.settings.refreshEnabled === false ? '<strong>Automatic Azure checks are off</strong>Showing cached activity. <a href="#settings">Enable checks</a> or refresh manually.'
    : health.paused.length ? `<strong>${health.paused.length} selected repositories paused</strong>Showing cached activity. <a href="#repositories">Manage repositories</a>.` : '';
  const error = health.errors[0];
  return `${message ? `<div class="banner info"><div>${message}</div></div>` : ''}${error ? `<div class="banner warn" role="status"><div><strong>Some activity could not refresh</strong>${e(streamLabel(error.stream.stream))}: ${e(error.error)} <a href="#repositories">Check repository details</a>.</div></div>` : health.stale.length ? '<div class="banner warn"><div><strong>Some cached activity is stale</strong><a href="#repositories">Check repository details</a> for the last successful checks.</div></div>' : health.resuming && !message ? '<div class="banner info" role="status"><div><strong>Catching up after enabling Auto checks</strong>Showing cached activity as checks run.</div></div>' : health.pending.length && !message ? '<div class="banner info"><div><strong>Initial import in progress</strong>Existing history is imported separately from new updates.</div></div>' : ''}`;
}

export function renderFeed(state, ui) {
  const records = state.activity.items;
  const health = healthFor(state, ui);
  const unseen = records.filter(record => record.unseen).sort((a, b) =>
    Number(b.kind === 'branch-created') - Number(a.kind === 'branch-created'));
  const imported = records.filter(record => record.imported);
  const content = ui.route === 'activity' ? `${group('Activity', records.filter(record => !record.imported), state)}${group('Imported history', imported, state, { open: Boolean(ui.search || ui.kind), description: 'Captured before monitoring started' })}` : group('New updates', unseen, state);
  const viewControl = `<h1 class="sr">Activity</h1><div class="activity-view"><nav class="seg" aria-label="Activity view" aria-describedby="activity-view-help"><a href="${activityHref('catchup')}" ${ui.route !== 'activity' ? 'aria-current="page"' : ''}>New updates</a><a href="${activityHref('activity')}" ${ui.route === 'activity' ? 'aria-current="page"' : ''}>All activity</a></nav><p class="help activity-view-help" id="activity-view-help">${ui.route === 'activity' ? 'Browse recorded updates, including seen and imported history.' : 'Updates you haven’t marked seen yet. Opening a page marks nothing.'}</p></div>`;
  return `${viewControl}${renderSummary(records, state, ui, health)}${monitoringNotice(state, health)}${filterControls(ui, state.activity)}
    <section class="card feed" aria-label="Repository activity">${records.length ? content : `<div class="empty"><p class="big">${state.activity?.loading ? 'Loading activity…' : state.activity?.error ? 'Activity could not load' : ui.search || ui.kind || ui.repoIds?.length === 0 ? 'No activity matches these filters' : health.partial ? 'No activity loaded yet' : ui.route === 'activity' ? 'No activity recorded yet' : 'No new updates'}</p><p class="dim">${state.activity?.error ? e(state.activity.error) : state.activity?.loading ? 'Reading your locally stored history.' : health.partial ? 'This does not confirm that nothing changed. Check repository status.' : 'Use All activity to browse history, or adjust your filters.'}</p>${state.activity?.error ? '<button class="btn sm" type="button" data-action="retry-activity">Try again</button>' : ''}</div>`}${state.activity?.nextCursor ? `<div class="foot"><button class="btn" type="button" data-action="load-more-activity">Load more</button><span>Showing ${records.length} of ${state.activity.total} recorded items.</span></div>` : ''}<div class="foot"><button class="btn sm" type="button" data-action="ack-shown" ${unseen.length ? '' : 'disabled'}>Mark shown seen (${unseen.reduce((sum, record) => sum + record.unseenIds.length, 0)})</button><span>Only the shown updates. Opening this page marks nothing.</span></div></section>`;
}
