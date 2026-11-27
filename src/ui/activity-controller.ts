import { joinActivitySearch } from './activity-search.ts';
import { activityHref } from './navigation.ts';
import { savedRepositoryScope } from './saved-filters.ts';
import type { Actions } from './actions.ts';
import type { SavedActivityFilter } from '../contract.ts';
import type { Shell } from './shell.ts';
import { createSeenActions } from './seen-actions.ts';

/**
 * The Activity page: its filters, search, repository scope and type, and applying a saved filter. A change of filter
 * starts the feed again from its first page.
 */
export function createActivityController(
  { ui, page, state, request, load, renderPage, navigation, feedback, confirm }: Shell,
  resetActivity: () => void,
) {
  let searchTimer: ReturnType<typeof setTimeout> | undefined;
  const seen = createSeenActions({
    page,
    request,
    toast: feedback.seenToast,
    async reload() {
      const outcome = await load({ force: true });
      if (outcome.type === 'failed') throw new Error(`Could not refresh seen status. ${outcome.error.message}`);
    },
  });

  function activityChanged({ debounce = false } = {}) {
    navigation.invalidate();
    resetActivity();
    renderPage();
    clearTimeout(searchTimer);
    if (debounce)
      searchTimer = setTimeout(() => {
        void load({ force: true });
      }, 250);
    else void load({ force: true });
  }

  function setActivityType(kind: string | undefined) {
    ui.kind = kind ?? '';
    activityChanged();
  }

  function applySavedFilter({ id, name, filters }: SavedActivityFilter) {
    const { search, people, kind, repoIds, view } = filters;
    const available = new Set(state().repos.map(repo => repo.id));
    const unavailable = (repoIds ?? []).filter(id => !available.has(id)).length;
    Object.assign(ui, {
      savedFilterId: id,
      search: joinActivitySearch(search, people),
      kind,
      repoIds: savedRepositoryScope(repoIds, state().watched),
    });
    const unseenOnly = view === 'new';
    if (unseenOnly === ui.unseenOnly) activityChanged();
    else location.hash = activityHref(unseenOnly);
    const scopeMessage = unavailable
      ? unavailable === repoIds?.length
        ? ' All saved repositories are unavailable.'
        : ' Some saved repositories are unavailable.'
      : '';
    feedback.toast(`Applied “${name}”.${scopeMessage}`);
  }

  return {
    seen,
    activityChanged,
    applySavedFilter,
    /** A pending search load belongs to the page it was typed on. */
    leave() {
      clearTimeout(searchTimer);
    },
    /** `/` focuses the search box, opening the collapsed Filters disclosure first. */
    focusSearch() {
      if (document.getElementById('activity-filters')?.hidden) {
        ui.filtersOpen = true;
        renderPage();
      }
      const search = document.querySelector('#feed-search');
      if (!(search instanceof HTMLElement)) return false;
      search.focus();
      return true;
    },
    actions: {
      'load-more-activity': async () => {
        await load({ force: true, more: true });
      },
      'retry-activity': async () => {
        await load({ force: true });
      },
      'ack-matching': async element => {
        const { query, scope } = element.dataset;
        if (!query || !scope) return;
        const { generation } = navigation.view();
        const { ids } = await request('GET /api/activity/unseen', { query: new URLSearchParams(query) });
        if (navigation.view().generation !== generation) return;
        if (!ids.length) {
          await load({ force: true });
          return feedback.toast('No unread updates match the current filters.');
        }
        const shown = new Set(seen.shownUnseenIds());
        const below = ids.filter(id => !shown.has(id)).length;
        // Everything it would mark is on screen, so there is nothing to preview; Undo covers a slip.
        if (!below) return seen.acknowledge(ids, true);
        confirm(
          `Mark ${ids.length} update${ids.length === 1 ? '' : 's'} as seen?`,
          `${below} ${below === 1 ? 'is' : 'are'} below the rows shown. Updates recorded after this page loaded stay unread.`,
          () => seen.acknowledge(ids, true),
          'Mark as seen',
          { subject: scope, resource: 'activity' },
        );
      },
      'clear-filters': () => {
        ui.search = '';
        ui.kind = '';
        ui.savedFilterId = '';
        if (ui.unseenOnly) location.hash = activityHref(false);
        else activityChanged();
      },
      'toggle-unseen-only': () => {
        location.hash = activityHref(!ui.unseenOnly);
      },
      'filter-activity-type': element => {
        ui.filtersOpen = true;
        setActivityType(element.dataset.kind);
      },
      'choose-activity-type': element => setActivityType(element.dataset.kind),
      'toggle-activity-filters': () => {
        ui.filtersOpen = !ui.filtersOpen;
        renderPage();
      },
      'all-repos': () => {
        ui.repoIds = null;
        activityChanged();
      },
      'no-repos': () => {
        ui.repoIds = [];
        activityChanged();
      },
      'scope-repo': () => {
        // Disabled repositories have no checkbox; keep their place in the scope for when they are enabled.
        const disabled = state().watched.filter(repo => repo.disabled && (ui.repoIds === null || ui.repoIds.includes(repo.id)));
        ui.repoIds = [...document.querySelectorAll('[data-scope-repo]:checked')]
          .filter(input => input instanceof HTMLInputElement)
          // The selector guarantees data-scope-repo, so the fallback never applies.
          .map(input => input.dataset.scopeRepo ?? '')
          .concat(disabled.map(repo => repo.id));
        activityChanged();
      },
      'search-activity': element => {
        if (!(element instanceof HTMLInputElement)) return;
        ui.search = element.value;
        activityChanged({ debounce: true });
      },
      ...seen.actions,
    } satisfies Actions<
      | 'load-more-activity'
      | 'retry-activity'
      | 'ack-matching'
      | 'clear-filters'
      | 'toggle-unseen-only'
      | 'filter-activity-type'
      | 'choose-activity-type'
      | 'toggle-activity-filters'
      | 'all-repos'
      | 'no-repos'
      | 'scope-repo'
      | 'search-activity'
      | 'ack-item'
      | 'undo-ack'
    >,
  };
}
