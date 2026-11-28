import { emptyHtml, html } from './format.ts';
import { activityFilterLabel, canonicalActivityFilter } from '../activity-text.ts';
import { createToolbarMenu } from './toolbar-menu.ts';
import type { MenuManager } from './menus.ts';
import { action } from './actions.ts';

export function renderTypeFilter(value: string = '', options: string[] = [], loading: boolean = false, open: boolean = false) {
  value = canonicalActivityFilter(value);
  const choices = [...new Set(['', ...options, value])];
  return html`<div class="menu type-menu"><button class="control" id="kind-toggle" type="button" data-active="${Boolean(value)}" aria-label="Activity type: ${activityFilterLabel(value)}" aria-haspopup="listbox" aria-disabled="${Boolean(loading)}" aria-expanded="${open}" aria-controls="kind-panel">${activityFilterLabel(value)} ▾</button><div class="menu-panel type-panel" id="kind-panel" role="listbox" aria-label="Activity type" ${open ? emptyHtml : html`hidden`}>${choices.map(key => html`<button class="type-option" type="button" role="option" id="kind-option-${key || 'all'}" aria-selected="${value === key}" ${action('choose-activity-type')} data-activity-filter="${key}" tabindex="-1"><span class="type-check" aria-hidden="true">${value === key ? '✓' : ''}</span>${activityFilterLabel(key)}</button>`)}</div></div>`;
}

export function createTypeFilter(menus: MenuManager) {
  return createToolbarMenu({
    menus,
    toggleId: 'kind-toggle',
    panelId: 'kind-panel',
    itemSelector: '[data-activity-filter]',
    choosing: 'one',
  });
}
