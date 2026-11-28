import { emptyHtml, html, dateTime, isUnseen, activityLabel, activityTone, timeInRow } from './format.ts';
import { disclosure, type Groups } from './groups.ts';
import { action } from './actions.ts';

/**
 * A row's updates: a disclosure on Activity, whose state `groups` holds, and an open list on the detail. On Activity an
 * update on the row's day shows only its clock, as the row does; the detail keeps full dates.
 */
export function renderTrail(
  record: import('../activity.ts').ActivityItem,
  { expanded = false, groups = new Map() }: { expanded?: boolean; groups?: Groups } = {},
) {
  if (record.events.length < 2) return emptyHtml;
  const entries = html`<ol>${record.events.map(event => {
    const label = activityLabel(event);
    return html`<li><time datetime="${event.time}">${expanded ? dateTime(event.time) : timeInRow(event.time, record.time)}</time><span class="status-text ${activityTone(event)}${label === 'Merged' ? ' merged' : ''}"><span class="status-dot" aria-hidden="true"></span>${label}</span><span>${isUnseen(event) ? 'new' : event.imported ? 'imported' : 'seen'}</span></li>`;
  })}</ol>`;
  return expanded
    ? html`<section class="activity-history"><h2>Update history</h2><div class="trail">${entries}</div></section>`
    : html`<details class="trail" ${disclosure(groups, `activity-${record.groupKey}`)}><summary ${action('toggle-group')}>${record.events.length} updates</summary>${entries}</details>`;
}
