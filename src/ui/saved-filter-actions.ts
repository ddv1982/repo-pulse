import { activityFilterLabel } from '../activity-text.ts';
import { required } from './dom.ts';
import { isActivity } from './navigation.ts';
import { scopeName } from './repository-scope.ts';
import { createFilterNameDialog, currentActivityFilters, isSavedFilterModified } from './saved-filters.ts';
import type { Actions } from './actions.ts';
import type { SavedActivityFilter } from '../contract.ts';
import type { Shell } from './shell.ts';

const busy = 'A saved filter change is still being saved. Try again when it finishes.';

/** Saving, applying, renaming, updating and deleting saved Activity filters, and the dialog that names one. */
export function createSavedFilterActions(
  { ui, state, request, load, renderPage, feedback, commands, confirm }: Shell,
  applySavedFilter: (filter: SavedActivityFilter) => void,
) {
  const filterName = createFilterNameDialog(required('#filter-name-dialog', HTMLDialogElement));
  const selected = () => state().savedFilters.find(filter => filter.id === ui.savedFilterId);
  return {
    'apply-saved-filter': element => {
      const preset = state().savedFilters.find(filter => filter.id === element.dataset.preset);
      if (preset) applySavedFilter(preset);
      else renderPage();
    },
    'save-filter': () => {
      const filters = currentActivityFilters(ui);
      const summary = `Includes ${filters.view === 'all' ? 'All activity' : 'Unread only'} · ${scopeName(state(), filters)} · ${activityFilterLabel(filters.kind)}`;
      filterName.show(
        selected() ? 'Save as new filter' : 'Save Activity filter',
        '',
        commands.holding('saved-filters', busy, async name => {
          const preset = await request('POST /api/activity-filters', { body: { name, filters } });
          await load({ force: true });
          if (isActivity(ui.route) && state().savedFilters.some(filter => filter.id === preset.id)) {
            ui.savedFilterId = preset.id;
            renderPage();
          }
          feedback.toast(`Filter “${preset.name}” saved.`);
        }),
        `${summary}${ui.search ? ` · Search “${ui.search}”` : ''}`,
      );
    },
    'restore-filter': () => {
      const preset = selected();
      if (preset) applySavedFilter(preset);
    },
    'detach-filter': () => {
      ui.savedFilterId = '';
      renderPage();
      document.getElementById('saved-filter-toggle')?.focus({ preventScroll: true });
    },
    'rename-filter': () => {
      const preset = selected();
      if (!preset) return;
      filterName.show(
        'Rename Activity filter',
        preset.name,
        commands.holding('saved-filters', busy, async name => {
          await request('PATCH /api/activity-filters/:id', { params: { id: preset.id }, body: { name } });
          await load({ force: true });
          feedback.toast('Filter renamed.');
        }),
      );
    },
    'update-filter': async () => {
      const preset = selected();
      if (!preset) return;
      const filters = currentActivityFilters(ui);
      if (!isSavedFilterModified(preset.filters, filters, state().watched)) return;
      await request('PATCH /api/activity-filters/:id', { params: { id: preset.id }, body: { filters } });
      await load({ force: true });
      feedback.toast('Saved filter updated.');
    },
    'delete-filter': () => {
      const preset = selected();
      if (!preset) return;
      confirm(
        'Delete saved filter?',
        'Your current Activity filters will stay applied.',
        async () => {
          await request('DELETE /api/activity-filters/:id', { params: { id: preset.id } });
          if (ui.savedFilterId === preset.id) ui.savedFilterId = '';
          await load({ force: true });
          feedback.toast('Saved filter deleted.');
        },
        'Delete filter',
        { subject: preset.name, destructive: true, resource: 'saved-filters' },
      );
    },
  } satisfies Actions<
    'apply-saved-filter' | 'save-filter' | 'restore-filter' | 'detach-filter' | 'rename-filter' | 'update-filter' | 'delete-filter'
  >;
}
