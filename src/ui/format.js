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

const SAFE_HTML = Symbol('SafeHtml');

/** Trusted HTML produced only by the `html` tagged template; plain strings cannot impersonate it. */
export class SafeHtml {
  #html;
  /** @param {string} value @param {symbol} token */
  constructor(value, token) {
    if (token !== SAFE_HTML) throw new TypeError('Use html`...` to build SafeHtml.');
    this.#html = value;
  }
  toString() {
    return this.#html;
  }
}

/** @typedef {SafeHtml | string | number | boolean | null | undefined | HtmlValue[]} HtmlValue */

/** @param {HtmlValue} value @returns {string} */
function renderValue(value) {
  if (value === null || value === undefined) return '';
  if (value instanceof SafeHtml) return value.toString();
  if (Array.isArray(value)) return value.map(renderValue).join('');
  return escape(value);
}

/**
 * Tagged template that auto-escapes interpolated values unless they are already SafeHtml.
 * @param {TemplateStringsArray} strings
 * @param {...HtmlValue} values
 * @returns {SafeHtml}
 */
export function html(strings, ...values) {
  let out = strings[0];
  for (let i = 0; i < values.length; i++) out += renderValue(values[i]) + strings[i + 1];
  return new SafeHtml(out, SAFE_HTML);
}

export const emptyHtml = html``;

/** @param {HtmlValue[]} items @param {HtmlValue} [separator] @returns {SafeHtml} */
export function joinHtml(items, separator = emptyHtml) {
  return new SafeHtml(items.map(renderValue).join(renderValue(separator)), SAFE_HTML);
}
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

/** @param {unknown} value @returns {SafeHtml} */
export function azureLink(value, label = 'Azure ↗', className = 'ghost sm') {
  try {
    const safe = safeAzureUrl(value);
    if (!safe) return emptyHtml;
    const url = new URL(safe);
    return html`<a class="${className}" href="${url.href}" target="_blank" rel="noopener noreferrer">${label}</a>`;
  } catch {
    return emptyHtml;
  }
}

/** @param {{ error?: string | { message?: string } | null }} stream */
export function streamError(stream) {
  return typeof stream.error === 'string' ? stream.error : stream.error?.message;
}
