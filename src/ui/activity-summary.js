// @ts-check

import { escape as e, buildState } from './format.js';

/** @typedef {import('./refresh.js').PageState} PageState */

/**
 * @param {import('../activity.js').ActivityItem[]} records @param {Pick<PageState, 'activity' | 'repos'>} state
 * @param {{ repoIds: string[] | null }} ui @param {boolean} partial the counts may be incomplete
 */
export function renderSummary(records, state, ui, partial) {
  const unseen = records.filter(record => record.unseen);
  const updates = unseen.reduce((sum, record) => sum + record.unseenIds.length, 0);
  const builds = unseen.filter(record => record.kind === 'build');
  const running = builds.filter(record => buildState(record).label === 'Running').length;
  const queued = builds.filter(record => buildState(record).label === 'Queued').length;
  const failed = builds.filter(record => buildState(record).tone === 'crit').length;
  const created = unseen.filter(record => record.kind === 'branch-created').length;
  const missing = unseen.filter(record => record.kind === 'branch-deleted').length;
  const counts = [
    { label: 'Pull requests', count: unseen.filter(record => record.kind === 'pr').length },
    { label: 'Pushes', count: unseen.filter(record => record.kind === 'push').length },
    {
      label: 'Branches',
      count: created + missing,
      sub: [created && `${created} new`, missing && `${missing} deleted or unlisted`].filter(Boolean).join(' · '),
    },
    {
      label: 'CI runs',
      count: builds.length,
      sub: [running && `${running} running`, queued && `${queued} queued`, failed && `${failed} failed`].filter(Boolean).join(' · '),
      tone: failed ? 't-crit' : running || queued ? 't-info' : '',
    },
  ];
  const headline = state.activity?.loading
    ? 'Loading activity…'
    : unseen.length
      ? `${partial ? 'At least ' : ''}${unseen.length} new item${unseen.length === 1 ? '' : 's'} shown`
      : state.activity.newItems
        ? '0 new items shown'
        : records.length || !partial
          ? 'No new updates'
          : 'No activity loaded yet';
  const repos = state.repos.filter(repo => ui.repoIds === null || ui.repoIds.includes(repo.id)).length;
  return `<section class="card summary mb" aria-label="Activity summary"><div class="top"><div class="headline"><p><b class="${unseen.length ? '' : 'zero'}">${e(headline)}</b>${updates > unseen.length ? ` · ${updates} updates` : ''}</p><ul class="legend"><li>${repos} repositor${repos === 1 ? 'y' : 'ies'}</li>${!state.activity.loading && !state.activity.error ? `<li>Showing ${records.length} of ${state.activity.total} items</li><li>${state.activity.newItems} total new items · ${state.activity.newUpdates} new updates</li>` : ''}</ul></div><div class="summary-chips" aria-label="Activity counts">${counts
    .filter(cell => cell.count)
    .map(cell => `<span class="chip ${cell.tone || ''}">${e(cell.label)} ${cell.count}${cell.sub ? ` · ${e(cell.sub)}` : ''}</span>`)
    .join(
      '',
    )}</div></div><div class="cells c4">${counts.map(cell => `<div class="cell" data-summary-kind="${e(cell.label)}"><div class="label">${e(cell.label)}</div><div class="val ${cell.count ? cell.tone || 't-info' : 'zero'}">${cell.count}</div>${cell.count && cell.sub ? `<div class="sub">${e(cell.sub)}</div>` : ''}</div>`).join('')}</div></section>`;
}
