// @ts-check

import { emptyHtml, html, buildState } from './format.js';

/** @typedef {import('./refresh.js').PageState} PageState */

/** @param {{repoIds: string[] | null, route?: string, search?: string, kind?: string}} ui @param {boolean} partial */
export function emptyActivityMessage(ui, partial) {
  const scoped = Boolean(ui.search || ui.kind || ui.repoIds !== null);
  if (scoped) return ui.route === 'activity' ? 'No activity matches these filters' : 'No unread updates match these filters';
  if (partial) return 'No activity loaded yet';
  return ui.route === 'activity' ? 'No activity recorded yet' : 'No new updates';
}
/**
 * @param {import('../activity.js').ActivityItem[]} records @param {Pick<PageState, 'activity' | 'repos'>} state
 * @param {{ repoIds: string[] | null, route?: string, search?: string, kind?: string }} ui @param {boolean} partial the counts may be incomplete
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
  const scoped = Boolean(ui.search || ui.kind || ui.repoIds !== null);
  const noUnread = scoped ? 'No unread updates match these filters' : 'No new updates';
  const headline = state.activity?.loading
    ? 'Loading activity…'
    : !records.length && state.activity.error
      ? 'Activity could not load'
      : unseen.length
        ? `${partial ? 'At least ' : ''}${unseen.length} new item${unseen.length === 1 ? '' : 's'} shown`
        : state.activity.newItems
          ? '0 new items shown'
          : records.length
            ? noUnread
            : emptyActivityMessage(ui, partial);
  // The header names the repository scope. These lines appear only when the list leaves something out.
  const loaded = !state.activity.loading && !state.activity.error;
  const legend = loaded
    ? [
        records.length < (state.activity.total ?? 0) ? `Showing ${records.length} of ${state.activity.total} items` : '',
        (state.activity.newItems ?? 0) > unseen.length
          ? `${state.activity.newItems} total new items · ${state.activity.newUpdates} new updates`
          : '',
      ].filter(Boolean)
    : [];
  return html`<section class="card summary mb" aria-label="Activity summary"><div class="top"><div class="headline"><p><b class="${unseen.length ? '' : 'zero'}">${headline}</b>${updates > unseen.length ? ` · ${updates} updates` : ''}</p>${legend.length ? html`<ul class="legend">${legend.map(line => html`<li>${line}</li>`)}</ul>` : emptyHtml}</div><div class="summary-chips" aria-label="Activity counts">${counts
    .filter(cell => cell.count)
    .map(
      cell => html`<span class="chip ${cell.tone || ''}">${cell.label} ${cell.count}${cell.sub ? ` · ${cell.sub}` : ''}</span>`,
    )}</div></div><div class="cells c4">${counts.map(cell => html`<div class="cell" data-summary-kind="${cell.label}"><div class="label">${cell.label}</div><div class="val ${cell.count ? cell.tone || 't-info' : 'zero'}">${cell.count}</div>${cell.count && cell.sub ? html`<div class="sub">${cell.sub}</div>` : emptyHtml}</div>`)}</div></section>`;
}
