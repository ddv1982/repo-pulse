import { emptyHtml, html, dateTime, isUnseen, activityLabel, activityTone } from './format.ts';

export function renderTrail(record: import('../activity.ts').ActivityItem, { expanded = false } = {}) {
  if (record.events.length < 2) return emptyHtml;
  const entries = html`<ol>${record.events.map(event => html`<li><time datetime="${event.time}">${dateTime(event.time)}</time><span class="status-text ${activityTone(event)}"><span class="status-dot" aria-hidden="true"></span>${activityLabel(event)}</span><span>${isUnseen(event) ? 'new' : event.imported ? 'imported' : 'seen'}</span></li>`)}</ol>`;
  return expanded
    ? html`<section class="activity-history"><h2>Update history</h2><div class="trail">${entries}</div></section>`
    : html`<details class="trail" data-group="activity-${record.groupKey}"><summary>${record.events.length} updates</summary>${entries}</details>`;
}
