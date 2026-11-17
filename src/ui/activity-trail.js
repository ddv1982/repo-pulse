import { escape as e, dateTime, isUnseen, activityLabel, activityTone } from './format.js';

export function renderTrail(record, { expanded = false } = {}) {
  if (record.events.length < 2) return '';
  const entries = `<ol>${record.events.map(event => `<li><time datetime="${e(event.time)}">${e(dateTime(event.time))}</time><span class="status-text ${activityTone(event)}"><span class="status-dot" aria-hidden="true"></span>${e(activityLabel(event))}</span><span>${isUnseen(event) ? 'new' : event.imported ? 'imported' : 'seen'}</span></li>`).join('')}</ol>`;
  return expanded ? `<section class="activity-history"><h2>Update history</h2><div class="trail">${entries}</div></section>` : `<details class="trail" data-group="activity-${e(record.groupKey)}"><summary>${record.events.length} updates</summary>${entries}</details>`;
}
