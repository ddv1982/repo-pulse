import { html } from './format.ts';

export function renderSearchInput(id: string, label: string, placeholder: string, value: string) {
  return html`<input id="${id}" class="search" type="search" aria-label="${label}" aria-describedby="${id}-help" placeholder="${placeholder}" value="${value}">`;
}

export function renderSearchHelp(id: string, peopleScope: string) {
  return html`<p class="help search-help" id="${id}-help">Commas match any term · <code>people:Ali, Jo</code> searches ${peopleScope}</p>`;
}
