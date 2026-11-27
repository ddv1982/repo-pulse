import { html } from './format.ts';
import { action, type ActionName } from './actions.ts';

export function renderSearchInput(id: string, label: string, placeholder: string, value: string, name: ActionName) {
  return html`<input id="${id}" class="search" type="search" ${action(name)} aria-label="${label}" aria-describedby="${id}-help" placeholder="${placeholder}" value="${value}">`;
}

/** `/` moves focus to the page's search box, unless `blocked` says otherwise or a form control has focus. */
export function listenForSearchKey({ blocked, focus }: { blocked: () => boolean; focus: () => boolean }) {
  document.addEventListener('keydown', event => {
    if (event.key !== '/' || blocked() || ['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement?.tagName ?? '')) return;
    if (focus()) event.preventDefault();
  });
}

export function renderSearchHelp(id: string, peopleScope: string) {
  return html`<p class="help search-help" id="${id}-help">Commas match any term · <code>people:Ali, Jo</code> searches ${peopleScope}</p>`;
}
