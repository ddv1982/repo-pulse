import { html } from './format.ts';
import { action } from './actions.ts';

const svg = (content: import('./format.ts').SafeHtml) =>
  html`<svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">${content}</svg>`;
export const tagGlyph = html`<path d="M3 4h8l10 10-7 7L3 10zM7 8h.1"/>`;
export const icons = {
  system: svg(html`<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M12 16v4m-4 0h8"/>`),
  light: svg(
    html`<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M4.93 4.93l1.42 1.42m11.3 11.3 1.42 1.42M4.93 19.07l1.42-1.42m11.3-11.3 1.42-1.42"/>`,
  ),
  dark: svg(html`<path d="M20.9 13.1A9 9 0 0 1 10.9 3.1 9 9 0 1 0 20.9 13.1Z"/>`),
  refresh: svg(html`<path d="M21 12a9 9 0 1 1-2.64-6.36L21 8"/><path d="M21 3v5h-5"/>`),
  copy: svg(html`<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 4H6a2 2 0 0 0-2 2v10"/>`),
  pulse: svg(html`<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>`),
  seenBox: html`<svg class="seen-box" aria-hidden="true" width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="1.25" y="1.25" width="11.5" height="11.5" rx="3"/><path class="seen-check" d="M4 7.2 6.1 9.3 10 5"/></svg>`,
  tag: svg(tagGlyph),
  branch: svg(
    html`<circle cx="6" cy="5" r="2"/><circle cx="6" cy="19" r="2"/><circle cx="18" cy="7" r="2"/><path d="M6 7v10M18 9c0 5-6 4-11 8"/>`,
  ),
};

export function themeSwitch() {
  // web/theme.ts defines repoPulseTheme on window before the modules load; the optional call covers its absence.
  const selected = window.repoPulseTheme?.get() || 'system';
  return html`<div class="seg theme" role="group" aria-label="Theme">${(['system', 'light', 'dark'] as const).map(value => html`<button type="button" ${action('set-theme')} data-theme="${value}" aria-label="${value.charAt(0).toUpperCase() + value.slice(1)}" title="${value.charAt(0).toUpperCase() + value.slice(1)}" aria-pressed="${value === selected}">${icons[value]}</button>`)}</div>`;
}
