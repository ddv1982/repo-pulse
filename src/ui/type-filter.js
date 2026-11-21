// @ts-check

import { emptyHtml, html } from './format.js';
import { activityFilterLabel, canonicalActivityFilter } from '../activity-text.js';
import { createToolbarMenu } from './toolbar-menu.js';

/** @param {string} [value] @param {string[]} [options] @param {boolean} [loading] @param {boolean} [open] */
export function renderTypeFilter(value = '', options = [], loading = false, open = false) {
  value = canonicalActivityFilter(value);
  const choices = [...new Set(['', ...options, value])];
  return html`<div class="menu type-menu"><button class="control" id="kind-toggle" type="button" aria-label="Activity type: ${activityFilterLabel(value)}" aria-haspopup="listbox" aria-disabled="${Boolean(loading)}" aria-expanded="${open}" aria-controls="kind-panel">${activityFilterLabel(value)} ▾</button><div class="menu-panel type-panel" id="kind-panel" role="listbox" aria-label="Activity type" ${open ? emptyHtml : html`hidden`}>${choices.map(key => html`<button class="type-option" type="button" role="option" id="kind-option-${key || 'all'}" aria-selected="${value === key}" data-kind="${key}" tabindex="-1"><span class="type-check" aria-hidden="true">${value === key ? '✓' : ''}</span>${activityFilterLabel(key)}</button>`)}</div></div>`;
}

/** @param {{ state: { openMenu?: string }, onChange: (kind: string | undefined) => void }} options */
export function createTypeFilter({ state, onChange }) {
  return createToolbarMenu({
    toggleId: 'kind-toggle',
    panelId: 'kind-panel',
    itemSelector: '[data-kind]',
    state,
    onSelect: option => onChange(option.dataset.kind),
  });
}
