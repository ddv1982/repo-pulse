import { required } from './dom.ts';
import { canonicalActivityFilter } from '../activity-text.ts';
import { splitActivitySearch } from './activity-search.ts';
import { emptyHtml, html } from './format.ts';
import type { SavedActivityFilter } from '../contract.d.ts';

export type { SavedActivityFilter };

export type ActivityFilters = SavedActivityFilter['filters'];

export function savedRepositoryScope(ids: string[] | null, watched: { id: string }[]) {
  return ids?.filter(id => watched.some(repo => repo.id === id)) ?? null;
}

export function currentActivityFilters({
  search,
  kind,
  repoIds,
  unreadOnly,
}: {
  search: string;
  kind: string;
  repoIds: string[] | null;
  unreadOnly: boolean;
}): ActivityFilters {
  return { ...splitActivitySearch(search), kind, repoIds, view: unreadOnly ? 'new' : 'all' };
}

export function isSavedFilterModified(saved: ActivityFilters, current: ActivityFilters, watched: { id: string }[]) {
  const normalized = ({ search, people, kind, repoIds, view }: ActivityFilters) => {
    const scope = savedRepositoryScope(repoIds, watched);
    return [search.trim(), people.trim(), canonicalActivityFilter(kind), scope === null ? null : [...new Set(scope)].sort(), view];
  };
  return JSON.stringify(normalized(saved)) !== JSON.stringify(normalized(current));
}

export function renderSavedFilters(filters: SavedActivityFilter[], selectedId: string, modified: boolean, openMenu: string = '') {
  const panel = (id: string) => (openMenu === id ? emptyHtml : html`hidden`);
  const selected = filters.find(filter => filter.id === selectedId);
  const title = selected?.name ?? 'Saved filters';
  const label = selected ? `Saved filter: ${title}${modified ? ', modified' : ''}` : title;
  return html`<div class="saved-filters">
    ${
      filters.length
        ? html`<div class="menu saved-filter-menu">
      <button class="control saved-filter-toggle" id="saved-filter-toggle" type="button" aria-haspopup="listbox"
        aria-expanded="${openMenu === 'saved-filter-panel'}" aria-controls="saved-filter-panel" aria-describedby="saved-filter-help" aria-label="${label}" title="${title}"><span>${title}</span>${modified ? html`<small>Modified</small>` : emptyHtml} ▾</button>
      <span class="sr" id="saved-filter-help">Choosing a saved filter also restores its unread setting and repository scope.</span>
      <div class="menu-panel type-panel saved-filter-panel" id="saved-filter-panel" role="listbox" aria-label="Saved filters" ${panel('saved-filter-panel')}>
        ${filters.map(
          filter => html`<button class="type-option" type="button" role="option" id="saved-filter-option-${filter.id}" aria-selected="${filter.id === selected?.id}"
          data-preset="${filter.id}" tabindex="-1"><span class="type-check" aria-hidden="true">${filter.id === selected?.id ? '✓' : ''}</span><span>${filter.name}<small class="help">${filter.filters.view === 'all' ? 'All activity' : 'Unread only'}</small></span></button>`,
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
            aria-haspopup="menu" aria-expanded="${openMenu === 'saved-filter-actions-panel'}" aria-controls="saved-filter-actions-panel">More ▾</button>
          <div class="menu-panel type-panel saved-filter-actions-panel" id="saved-filter-actions-panel" role="menu" aria-label="Saved filter actions" ${panel('saved-filter-actions-panel')}>
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

function filterAction(action: string, label: string) {
  return html`<button class="type-option" role="menuitem" type="button" data-filter-action="${action}" tabindex="-1">${label}</button>`;
}

export function createFilterNameDialog(dialog: HTMLDialogElement) {
  const form = required('form', HTMLFormElement, dialog);
  const title = required('#filter-name-title', HTMLElement, dialog);
  const input = required('#filter-name', HTMLInputElement, dialog);
  const scope = required('#filter-name-scope', HTMLElement, dialog);
  const error = required('[role="alert"]', HTMLElement, dialog);
  const submit = required('button[type="submit"]', HTMLButtonElement, dialog);
  let save: ((name: string) => Promise<void>) | undefined;
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
  const submitName = async (event: SubmitEvent) => {
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
  };
  // A failed save is caught above and shown in the dialog's alert, so this promise does not reject.
  form.addEventListener('submit', event => void submitName(event));

  return {
    get open() {
      return dialog.open;
    },
    show(heading: string, name: string, callback: (name: string) => Promise<void>, summary: string = '') {
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
