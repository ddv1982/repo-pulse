// @ts-check

import { required } from './dom.js';
import { emptyHtml, html } from './format.js';

/** @typedef {import('../../server/saved-activity-filters.js').SavedActivityFilter} SavedActivityFilter */

/** @param {SavedActivityFilter[]} filters @param {string} selectedId */
export function renderSavedFilters(filters, selectedId) {
  const disabled = filters.some(filter => filter.id === selectedId) ? emptyHtml : html`disabled`;
  return html`<div class="toolbar saved-filters">
    <button id="save-filter" class="btn sm" type="button" data-action="save-filter">Save filter</button>
    ${
      filters.length
        ? html`<select id="saved-filter" class="control sm" aria-label="Saved filters"><option value="">Saved filters</option>
      ${filters.map(filter => html`<option value="${filter.id}" ${filter.id === selectedId ? html`selected` : emptyHtml}>${filter.name}</option>`)}
    </select>
    <button id="apply-filter" class="btn sm" type="button" data-action="apply-filter" ${disabled}>Apply</button>
    <button id="update-filter" class="btn sm" type="button" data-action="update-filter" ${disabled}>Update from current</button>
    <button id="rename-filter" class="btn sm" type="button" data-action="rename-filter" ${disabled}>Rename</button>
    <button id="delete-filter" class="btn sm" type="button" data-action="delete-filter" ${disabled}>Delete</button>`
        : emptyHtml
    }
  </div>`;
}

/** @param {HTMLDialogElement} dialog */
export function createFilterNameDialog(dialog) {
  const form = required('form', HTMLFormElement, dialog);
  const title = required('#filter-name-title', HTMLElement, dialog);
  const input = required('#filter-name', HTMLInputElement, dialog);
  const error = required('[role="alert"]', HTMLElement, dialog);
  const submit = required('button[type="submit"]', HTMLButtonElement, dialog);
  /** @type {((name: string) => Promise<void>) | undefined} */
  let save;
  let openerId = '';
  dialog.addEventListener('close', () => {
    save = undefined;
    document.getElementById(openerId)?.focus({ preventScroll: true });
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
    /** @param {string} heading @param {string} name @param {(name: string) => Promise<void>} callback */
    show(heading, name, callback) {
      openerId = document.activeElement?.id || '';
      title.textContent = heading;
      input.value = name;
      error.hidden = true;
      save = callback;
      dialog.showModal();
      input.select();
    },
  };
}
