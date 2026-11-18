// @ts-check

export {
  activityLabel,
  activitySummary,
  activityTitle,
  activityTone,
  buildState,
  labels,
  triggerLabel,
  voteLabel,
} from '../activity-text.js';
export { isUnseen } from '../activity.js';
export { branchName } from '../events.js';
import { safeAzureUrl } from '../events.js';

/** @type {Record<string, string>} */
const entities = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
/** @param {unknown} value */
export const escape = value => String(value ?? '').replace(/[&<>"']/g, c => entities[c]);
/** @type {Record<string, string | undefined>} */
const streamLabels = {
  refs: 'Branches',
  pushes: 'Pushes',
  prs: 'Open pull requests',
  pullRequests: 'Pull requests',
  closedPrs: 'Closed pull requests',
  builds: 'Recent CI runs',
  activeBuilds: 'Active CI runs',
};
/** @param {string} value */
export function streamLabel(value) {
  return streamLabels[value] || 'Activity';
}

/** @param {string | number | undefined} value */
export function dateTime(value) {
  // new Date(undefined) is an invalid date too; the explicit NaN only spells that out for the type checker.
  const date = new Date(value === undefined ? NaN : value);
  return Number.isNaN(date.valueOf())
    ? 'Not checked yet'
    : date.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/** @param {unknown} value */
export function azureLink(value, label = 'Azure ↗', className = 'ghost sm') {
  try {
    const safe = safeAzureUrl(value);
    if (!safe) return '';
    const url = new URL(safe);
    return `<a class="${className}" href="${escape(url.href)}" target="_blank" rel="noopener noreferrer">${escape(label)}</a>`;
  } catch {
    return '';
  }
}

/** @param {{ error?: string | { message?: string } | null }} stream */
export function streamError(stream) {
  return typeof stream.error === 'string' ? stream.error : stream.error?.message;
}
