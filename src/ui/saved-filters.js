// @ts-check

import { required } from './dom.js';
import { canonicalActivityFilter } from '../activity-text.js';
import { splitActivitySearch } from './activity-search.js';
import { emptyHtml, html } from './format.js';

/** @typedef {import('../../server/saved-activity-filters.js').SavedActivityFilter} SavedActivityFilter */

/** @typedef {SavedActivityFilter['filters']} ActivityFilters */

/** @param {string[]|null} ids @param {{id: string}[]} watched */
export function savedRepositoryScope(ids, watched) {
  return ids?.filter(id => watched.some(repo => repo.id === id)) ?? null;
}

/** @param {{search: string, kind: string, repoIds: string[]|null, route: string}} view */
export function currentActivityFilters({ search, kind, repoIds, route }) {
  /** @type {ActivityFilters} */
  return { ...splitActivitySearch(search), kind, repoIds, view: route === 'activity' ? 'all' : 'new' };
}

/** @param {ActivityFilters} saved @param {ActivityFilters} current @param {{id: string}[]} watched */
export function isSavedFilterModified(saved, current, watched) {
  /** @param {ActivityFilters} filters */
  const normalized = ({ search, people, kind, repoIds, view }) => {
    const scope = savedRepositoryScope(repoIds, watched);
    return [search.trim(), people.trim(), canonicalActivityFilter(kind), scope === null ? null : [...new Set(scope)].sort(), view];
  };
  return JSON.stringify(normalized(saved)) !== JSON.stringify(normalized(current));
}

/** @param {SavedActivityFilter[]} filters @param {string} selectedId @param {boolean} modified */
export function renderSavedFilters(filters, selectedId, modified) {
  const selected = filters.find(filter => filter.id === selectedId);
  const title = selected?.name ?? 'Saved filters';
  const label = selected ? `Saved filter: ${title}${modified ? ', modified' : ''}` : title;
  return html`<div class="saved-filters">
    ${
      filters.length
        ? html`<div class="menu saved-filter-menu">
      <button class="control saved-filter-toggle" id="saved-filter-toggle" type="button" aria-haspopup="listbox"
        aria-expanded="false" aria-controls="saved-filter-panel" aria-describedby="saved-filter-help" aria-label="${label}" title="${title}"><span>${title}</span>${modified ? html`<small>Modified</small>` : emptyHtml} ▾</button>
      <span class="sr" id="saved-filter-help">Choosing a saved filter also restores its Activity tab and repository scope.</span>
      <div class="menu-panel type-panel saved-filter-panel" id="saved-filter-panel" role="listbox" aria-label="Saved filters" hidden>
        ${filters.map(
          filter => html`<button class="type-option" type="button" role="option" aria-selected="${filter.id === selected?.id}"
          data-preset="${filter.id}" tabindex="-1"><span class="type-check" aria-hidden="true">${filter.id === selected?.id ? '✓' : ''}</span><span>${filter.name}<small class="help">${filter.filters.view === 'all' ? 'All activity' : 'New updates'}</small></span></button>`,
        )}
      </div>
    </div>`
        : emptyHtml
    }
    ${
      !selected
        ? html`<button id="save-filter" class="btn" type="button" data-action="save-filter">Save filter…</button>`
        : html`${modified ? html`<button id="update-filter" class="btn saved-filter-update" type="button" data-action="update-filter" title="Update “${title}”">Update “${title}”</button>` : emptyHtml}
        <div class="menu saved-filter-actions">
          <button id="saved-filter-actions-toggle" class="btn" type="button" aria-label="More saved filter actions"
            aria-haspopup="menu" aria-expanded="false" aria-controls="saved-filter-actions-panel">More ▾</button>
          <div class="menu-panel type-panel saved-filter-actions-panel" id="saved-filter-actions-panel" role="menu" aria-label="Saved filter actions" hidden>
            ${modified ? filterAction('restore-filter', 'Restore saved version') : emptyHtml}
            ${filterAction('save-filter', 'Save as new…')}
            ${filterAction('rename-filter', 'Rename…')}
            ${filterAction('detach-filter', 'Stop using filter')}
            ${filterAction('delete-filter', 'Delete…')}
          </div>
        </div>`
    }
  </div>`;
}

/** @param {string} action @param {string} label */
function filterAction(action, label) {
  return html`<button class="type-option" role="menuitem" type="button" data-filter-action="${action}" tabindex="-1">${label}</button>`;
}

/** @param {HTMLDialogElement} dialog */
export function createFilterNameDialog(dialog) {
  const form = required('form', HTMLFormElement, dialog);
  const title = required('#filter-name-title', HTMLElement, dialog);
  const input = required('#filter-name', HTMLInputElement, dialog);
  const scope = required('#filter-name-scope', HTMLElement, dialog);
  const error = required('[role="alert"]', HTMLElement, dialog);
  const submit = required('button[type="submit"]', HTMLButtonElement, dialog);
  /** @type {((name: string) => Promise<void>) | undefined} */
  let save;
  let openerId = '';
  dialog.addEventListener('close', () => {
    save = undefined;
    (document.getElementById(openerId) ?? document.getElementById('saved-filter-toggle'))?.focus({ preventScroll: true });
  });
  required('[data-cancel]', HTMLButtonElement, dialog).addEventListener('click', () => {
    if (!submit.disabled) dialog.close();
  });
  dialog.addEventListener('cancel', event => {
    if (submit.disabled) event.preventDefault();
  });
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (submit.disabled || !save) return;
    submit.disabled = true;
    error.hidden = true;
    try {
      await save(input.value);
      dialog.close();
    } catch (failure) {
      error.textContent = failure instanceof Error ? failure.message : String(failure);
      error.hidden = false;
    } finally {
      submit.disabled = false;
    }
  });

  return {
    get open() {
      return dialog.open;
    },
    /** @param {string} heading @param {string} name @param {(name: string) => Promise<void>} callback @param {string} [summary] */
    show(heading, name, callback, summary = '') {
      openerId = document.activeElement?.id || '';
      title.textContent = heading;
      scope.hidden = !summary;
      scope.textContent = summary;
      input.value = name;
      error.hidden = true;
      save = callback;
      dialog.showModal();
      input.select();
    },
  };
}
