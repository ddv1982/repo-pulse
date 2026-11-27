import { emptyHtml, html, joinHtml } from './format.ts';
import { canonicalActivityFilter } from '../activity-text.ts';
import type { HtmlValue } from './format.ts';
import type { ActivityItem, ActivityPage } from '../activity.ts';
import type { PageState } from './refresh.ts';

export type { PageState };

export function emptyActivityMessage(
  ui: { repoIds: string[] | null; unreadOnly?: boolean; search?: string; kind?: string },
  partial: boolean,
) {
  const scoped = Boolean(ui.search || ui.kind || ui.repoIds !== null);
  if (scoped) return ui.unreadOnly ? 'No unread updates match these filters' : 'No activity matches these filters';
  if (partial) return 'No activity loaded yet';
  return ui.unreadOnly ? 'No new updates' : 'No activity recorded yet';
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

function ciFilterButton(layout: 'cell' | 'chip', kind: 'build' | 'status:failed', content: HtmlValue, label?: string) {
  const failed = kind === 'status:failed';
  return html`<button type="button" id="summary-ci-${layout}-${failed ? 'failed' : 'total'}"
    class="summary-filter ${failed ? 't-crit' : 't-info'}" data-action="filter-activity-type" data-kind="${kind}"
    ${label ? html`aria-label="${label}"` : emptyHtml}>${content}</button>`;
}

function ciBreakdown(layout: 'cell' | 'chip', counts: ActivityPage['newBuildCounts']) {
  if (!counts) return [];
  const { running, queued, failed } = counts;
  return [
    ...(running ? [`${running} running`] : []),
    ...(queued ? [`${queued} queued`] : []),
    ...(failed
      ? [ciFilterButton(layout, 'status:failed', `${failed} failed`, `${failed} failed CI ${failed === 1 ? 'run' : 'runs'}`)]
      : []),
  ];
}

/**
 * @param partial the counts may be incomplete
 */
export function renderSummary(
  records: ActivityItem[],
  state: Pick<PageState, 'activity'>,
  ui: { repoIds: string[] | null; unreadOnly?: boolean; search?: string; kind?: string },
  partial: boolean,
  firstSync: string | undefined,
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
        : firstSync && (records.length || !scoped)
          ? records.length
            ? 'Recent activity available'
            : 'Reading recent activity…'
          : records.length
            ? noUnread
            : emptyActivityMessage(ui, partial);
  // The header names the repository scope. These lines appear only when the list leaves something out.
  const loaded = !state.activity.loading && !state.activity.error;
  const filteredToFailures = canonicalActivityFilter(ui.kind ?? '') === 'status:failed';
  const shown = records.reduce((total, record) => total + 1 + (record.foldedCi ?? 0), 0);
  const legend = loaded
    ? [shown < (state.activity.total ?? 0) ? `Showing ${shown} of ${state.activity.total} items` : ''].filter(Boolean)
    : [];
  return html`<section class="card summary mb" aria-label="Activity summary"><div class="top"><div class="headline"><p><b class="${newItems ? '' : 'zero'}">${headline}</b>${newItems && updates > newItems ? ` · ${updates} updates` : ''}</p>${loaded && firstSync ? html`<span class="summary-sync-progress">${firstSync}</span>` : emptyHtml}${legend.length ? html`<ul class="legend">${legend.map(line => html`<li>${line}</li>`)}</ul>` : emptyHtml}</div><div class="summary-chips" aria-label="Activity counts">${counts
    .filter(cell => cell.count || (cell.build && filteredToFailures && loaded))
    .map(cell => {
      if (cell.build && filteredToFailures) {
        return html`<span class="chip">Failed CI runs <span class="${cell.count ? 't-crit' : 'zero'}">${cell.count}</span>${loaded ? html` · ${ciFilterButton('chip', 'build', 'Show all CI runs')}` : emptyHtml}</span>`;
      }
      const breakdown = cell.build ? ciBreakdown('chip', state.activity.newBuildCounts) : cell.sub ? [cell.sub] : [];
      const title = `${cell.label} ${cell.count}`;
      const value = cell.build
        ? ciFilterButton('chip', 'build', html`<span class="label">${cell.label}</span> ${cell.count}`, `CI runs, ${cell.count} unread`)
        : title;
      return html`<span class="chip">${value}${breakdown.length ? html` · ${joinHtml(breakdown, ' · ')}` : emptyHtml}</span>`;
    })}</div></div><div class="cells c4">${counts.map(cell => {
    const failures = cell.build && filteredToFailures;
    const tone = cell.count ? (failures ? 't-crit' : 't-info') : 'zero';
    const heading = html`<span class="label">${failures ? 'Failed CI runs' : cell.label}</span> <span class="val ${tone}">${cell.count}</span>`;
    const title =
      cell.build && cell.count && !failures ? ciFilterButton('cell', 'build', heading, `CI runs, ${cell.count} unread`) : heading;
    const breakdown = failures
      ? loaded
        ? [ciFilterButton('cell', 'build', 'Show all CI runs')]
        : []
      : cell.build
        ? ciBreakdown('cell', state.activity.newBuildCounts)
        : cell.count && cell.sub
          ? [cell.sub]
          : [];
    return html`<div class="cell" data-summary-kind="${cell.label}">${title}${breakdown.length ? html`<div class="sub">${joinHtml(breakdown, ' · ')}</div>` : emptyHtml}</div>`;
  })}</div></section>`;
}
