import { emptyHtml, html, joinHtml } from './format.ts';
import type { ActivityItem, ActivityPage } from '../activity.ts';
import type { PageState } from './refresh.ts';

export type { PageState };

export function emptyActivityMessage(ui: { repoIds: string[] | null; route?: string; search?: string; kind?: string }, partial: boolean) {
  const scoped = Boolean(ui.search || ui.kind || ui.repoIds !== null);
  if (scoped) return ui.route === 'activity' ? 'No activity matches these filters' : 'No unread updates match these filters';
  if (partial) return 'No activity loaded yet';
  return ui.route === 'activity' ? 'No activity recorded yet' : 'No new updates';
}
/**
 * Unread totals come from the server so they cover every page, not only the loaded rows.
 * @param unseen the loaded unread rows */
function unreadCounts(unseen: ActivityItem[], state: Pick<PageState, 'activity'>) {
  const newCounts = state.activity.newCounts;
  const unreadOf = (kind: string) => newCounts?.[kind] ?? unseen.filter(record => record.kind === kind).length;
  const created = unreadOf('branch-created');
  const missing = unreadOf('branch-deleted');
  return {
    newItems: state.activity.newItems ?? unseen.length,
    updates: state.activity.newUpdates ?? unseen.reduce((sum, record) => sum + record.unseenIds.length, 0),
    counts: [
      { label: 'Pull requests', count: unreadOf('pr') },
      { label: 'Pushes', count: unreadOf('push') },
      {
        label: 'Branches',
        count: created + missing,
        sub: [created && `${created} new`, missing && `${missing} deleted or unlisted`].filter(Boolean).join(' · '),
      },
      {
        label: 'CI runs',
        count: unreadOf('build'),
        build: true,
      },
    ],
  };
}

function ciFilterButton(layout: 'cell' | 'chip', kind: 'build' | 'status:failed', count: number) {
  const failed = kind === 'status:failed';
  const label = failed ? `${count} failed CI ${count === 1 ? 'run' : 'runs'}` : `${count} unread CI ${count === 1 ? 'run' : 'runs'}`;
  return html`<button type="button" id="summary-ci-${layout}-${failed ? 'failed' : 'total'}"
    class="summary-filter ${failed ? 't-crit' : 't-info'}" data-action="filter-activity-type" data-kind="${kind}"
    aria-label="${label}">${failed ? `${count} failed` : count}</button>`;
}

function ciBreakdown(layout: 'cell' | 'chip', counts: ActivityPage['newBuildCounts']) {
  if (!counts) return [];
  const { running, queued, failed } = counts;
  return [
    ...(running ? [`${running} running`] : []),
    ...(queued ? [`${queued} queued`] : []),
    ...(failed ? [ciFilterButton(layout, 'status:failed', failed)] : []),
  ];
}

/**
 * @param partial the counts may be incomplete
 */
export function renderSummary(
  records: ActivityItem[],
  state: Pick<PageState, 'activity'>,
  ui: { repoIds: string[] | null; route?: string; search?: string; kind?: string },
  partial: boolean,
) {
  const { newItems, updates, counts } = unreadCounts(
    records.filter(record => record.unseen),
    state,
  );
  const scoped = Boolean(ui.search || ui.kind || ui.repoIds !== null);
  const noUnread = scoped ? 'No unread updates match these filters' : 'No new updates';
  const headline = state.activity?.loading
    ? 'Loading activity…'
    : !records.length && state.activity.error
      ? 'Activity could not load'
      : newItems
        ? `${partial ? 'At least ' : ''}${newItems} new item${newItems === 1 ? '' : 's'}`
        : records.length
          ? noUnread
          : emptyActivityMessage(ui, partial);
  // The header names the repository scope. These lines appear only when the list leaves something out.
  const loaded = !state.activity.loading && !state.activity.error;
  const legend = loaded
    ? [records.length < (state.activity.total ?? 0) ? `Showing ${records.length} of ${state.activity.total} items` : ''].filter(Boolean)
    : [];
  return html`<section class="card summary mb" aria-label="Activity summary"><div class="top"><div class="headline"><p><b class="${newItems ? '' : 'zero'}">${headline}</b>${newItems && updates > newItems ? ` · ${updates} updates` : ''}</p>${legend.length ? html`<ul class="legend">${legend.map(line => html`<li>${line}</li>`)}</ul>` : emptyHtml}</div><div class="summary-chips" aria-label="Activity counts">${counts
    .filter(cell => cell.count)
    .map(cell => {
      const breakdown = cell.build ? ciBreakdown('chip', state.activity.newBuildCounts) : cell.sub ? [cell.sub] : [];
      const value = cell.build ? ciFilterButton('chip', 'build', cell.count) : cell.count;
      return html`<span class="chip">${cell.label} ${value}${breakdown.length ? html` · ${joinHtml(breakdown, ' · ')}` : emptyHtml}</span>`;
    })}</div></div><div class="cells c4">${counts.map(cell => {
    const breakdown = cell.build ? ciBreakdown('cell', state.activity.newBuildCounts) : cell.sub ? [cell.sub] : [];
    const value = cell.build && cell.count ? ciFilterButton('cell', 'build', cell.count) : cell.count;
    return html`<div class="cell" data-summary-kind="${cell.label}"><div class="label">${cell.label}</div><div class="val ${cell.count ? 't-info' : 'zero'}">${value}</div>${cell.count && breakdown.length ? html`<div class="sub">${joinHtml(breakdown, ' · ')}</div>` : emptyHtml}</div>`;
  })}</div></section>`;
}
