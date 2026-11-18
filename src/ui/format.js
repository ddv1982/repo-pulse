export { activityLabel, activitySummary, activityTitle, activityTone, buildState, labels, triggerLabel } from '../activity-text.js';
export { isUnseen } from '../activity.js';
export { branchName } from '../events.js';
import { safeAzureUrl } from '../events.js';

export const escape = value =>
  String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
export function streamLabel(value) {
  return (
    {
      refs: 'Branches',
      pushes: 'Pushes',
      prs: 'Open pull requests',
      pullRequests: 'Pull requests',
      closedPrs: 'Closed pull requests',
      builds: 'Recent CI runs',
      activeBuilds: 'Active CI runs',
    }[value] || 'Activity'
  );
}

export function dateTime(value) {
  const date = new Date(value);
  return Number.isNaN(date.valueOf())
    ? 'Not checked yet'
    : date.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

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

export function streamError(stream) {
  return typeof stream.error === 'string' ? stream.error : stream.error?.message;
}
