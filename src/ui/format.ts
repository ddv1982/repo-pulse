export {
  activityActor,
  activityLabel,
  activitySummary,
  activityTitle,
  activityTone,
  buildState,
  labels,
  triggerLabel,
  voteLabel,
} from '../activity-text.ts';
export { isUnseen } from '../activity.ts';
export { branchName } from '../events.ts';
import { safeAzureUrl } from '../events.ts';

const entities: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const escape = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, c => entities[c]);

const SAFE_HTML = Symbol('SafeHtml');

/** Trusted HTML produced only by the `html` tagged template; verified via private-field brand check. */
export class SafeHtml {
  #html;
  constructor(value: string, token: symbol) {
    if (token !== SAFE_HTML) throw new TypeError('Use html`...` to build SafeHtml.');
    this.#html = value;
  }
  static is(value: unknown): value is SafeHtml {
    return typeof value === 'object' && value !== null && #html in value;
  }
  static unwrap(value: unknown): string {
    if (!SafeHtml.is(value)) throw new TypeError('Repo Pulse: expected SafeHtml.');
    return value.#html;
  }
  toString() {
    return this.#html;
  }
}

export type HtmlValue = SafeHtml | string | number | boolean | null | undefined | HtmlValue[];

function renderValue(value: HtmlValue): string {
  if (value === null || value === undefined) return '';
  if (SafeHtml.is(value)) return SafeHtml.unwrap(value);
  if (Array.isArray(value)) {
    let out = '';
    for (let i = 0; i < value.length; i++) out += renderValue(value[i]);
    return out;
  }
  return escape(value);
}

/**
 * Tagged template that auto-escapes interpolated values unless they are already SafeHtml.
 */
export function html(strings: TemplateStringsArray, ...values: HtmlValue[]): SafeHtml {
  let out = strings[0];
  for (let i = 0; i < values.length; i++) out += renderValue(values[i]) + strings[i + 1];
  return new SafeHtml(out, SAFE_HTML);
}

export const emptyHtml = html``;

export function joinHtml(items: HtmlValue[], separator: HtmlValue = emptyHtml): SafeHtml {
  const sep = renderValue(separator);
  let out = '';
  for (let i = 0; i < items.length; i++) out += (i ? sep : '') + renderValue(items[i]);
  return new SafeHtml(out, SAFE_HTML);
}
const streamLabels: Record<string, string | undefined> = {
  refs: 'Branches',
  pushes: 'Pushes',
  prs: 'Open pull requests',
  pullRequests: 'Pull requests',
  closedPrs: 'Closed pull requests',
  builds: 'Recent CI runs',
  activeBuilds: 'Active CI runs',
};
export function streamLabel(value: string) {
  return streamLabels[value] || 'Activity';
}

export function dateTime(value: string | number | undefined) {
  // new Date(undefined) is an invalid date too; the explicit NaN only spells that out for the type checker.
  const date = new Date(value === undefined ? NaN : value);
  return Number.isNaN(date.valueOf())
    ? 'Not checked yet'
    : date.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/** The full date with year and weekday, for hover text beside the short dateTime. */
export function fullDateTime(value: string | number | undefined) {
  const date = new Date(value === undefined ? NaN : value);
  return Number.isNaN(date.valueOf()) ? '' : date.toLocaleString([], { dateStyle: 'full', timeStyle: 'short' });
}

export function azureLink(value: unknown, label = 'Azure ↗', className = 'ghost sm'): SafeHtml {
  try {
    const safe = safeAzureUrl(value);
    if (!safe) return emptyHtml;
    const url = new URL(safe);
    return html`<a class="${className}" href="${url.href}" target="_blank" rel="noopener noreferrer">${label}</a>`;
  } catch {
    return emptyHtml;
  }
}

export function streamError(stream: { error?: string | { message?: string } | null }) {
  return typeof stream.error === 'string' ? stream.error : stream.error?.message;
}
