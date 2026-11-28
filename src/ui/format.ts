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
function escape(value: string | number | boolean) {
  const text = String(value);
  // Older provider data can carry a plain object despite the display type.
  if (typeof value !== 'string' && text === '[object Object]') return '';
  return text.replace(/[&<>"']/g, c => entities[c] ?? `&#${c.charCodeAt(0)};`);
}

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
  let out = '';
  for (const [i, chunk] of strings.entries()) out += (i ? renderValue(values[i - 1]) : '') + chunk;
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

/** The local calendar day of a time as `YYYY-MM-DD`, or '' for an invalid time. */
export function localDay(value: string | number | Date) {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return '';
  return [date.getFullYear(), date.getMonth() + 1, date.getDate()].map(part => String(part).padStart(2, '0')).join('-');
}

const headerDay = new Intl.DateTimeFormat([], { weekday: 'short', day: 'numeric', month: 'short' });
const headerYear = new Intl.DateTimeFormat([], { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });

/**
 * The label of an Activity day header: "Today", "Yesterday · Fri 27 Nov", otherwise "Thu 26 Nov", with the year when it
 * is not the current year. The parts keep one order in every locale, as ciTime's do. '' for an invalid time.
 */
export function dayLabel(value: string | number, now: number | Date = Date.now()) {
  const date = new Date(value);
  const today = new Date(now);
  const day = localDay(date);
  if (!day) return '';
  if (day === localDay(today)) return 'Today';
  const format = date.getFullYear() === today.getFullYear() ? headerDay : headerYear;
  const parts = Object.fromEntries(format.formatToParts(date).map(part => [part.type, part.value]));
  const label = [parts.weekday, parts.day, parts.month, parts.year].filter(Boolean).join(' ');
  const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
  return day === localDay(yesterday) ? `Yesterday · ${label}` : label;
}

const runDay = new Intl.DateTimeFormat([], { day: 'numeric', month: 'short' });
const runClock = new Intl.DateTimeFormat([], { hour: '2-digit', minute: '2-digit' });

/**
 * A time shown inside an Activity row: only the clock when it falls on the row's local day, which its day header
 * names, otherwise the short date and time.
 */
export function timeInRow(value: string | number, rowTime: string | number) {
  const day = localDay(value);
  return day && day === localDay(rowTime) ? runClock.format(new Date(value)) : dateTime(value);
}

/** @param rowTime the time of the Activity row that shows the run: on that row's local day only the clock is shown. */
export function ciTime(value: string | number, showClock = false, rowTime?: string | number) {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return emptyHtml;
  const parts = runDay.formatToParts(date);
  const day = parts.find(part => part.type === 'day')?.value;
  const month = parts.find(part => part.type === 'month')?.value;
  const sameDay = rowTime !== undefined && localDay(date) === localDay(rowTime);
  const label = sameDay ? runClock.format(date) : `${day} ${month}${showClock ? `, ${runClock.format(date)}` : ''}`;
  return html`<time class="ci-time" datetime="${date.toISOString()}" title="${fullDateTime(value)}">${label}</time>`;
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

/** The problems of a stream's last check: its error, then the warning about records it skipped. */
export function streamProblems(stream: { error?: string | { message?: string } | null; warning?: { message: string } | null | undefined }) {
  return [streamError(stream), stream.warning?.message].filter(message => message !== undefined && message !== '');
}
