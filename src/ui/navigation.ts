import { joinActivitySearch } from './activity-search.ts';

export type NavigationState = {
  route: string;
  eventId: string | null;
  repoIds: string[] | null;
  search: string;
  kind: string;
  filtersOpen: boolean | undefined;
  activityRoute: string;
  savedFilterId: string;
};

export type ResultsContext = {
  route: string;
  search: string;
  kind: string;
  repoIds: string[] | null;
  groups: [string, boolean][];
  filtersOpen: boolean | undefined;
  savedFilterId: string;
  scrollY: number;
  eventId: string | null;
  matchingIds?: string[];
  activityCapacity: number;
};

export type WatchedRepo = { id: string; disabled?: boolean };

/**
 * Keep old bookmarks working while exposing one Activity page with two clear views.
 */
export function parseRoute(hash: unknown) {
  const [name, value] = String(hash || '')
    .replace(/^#/, '')
    .split('/');
  if (name === 'rules') return { route: 'settings', eventId: null };
  if (name === 'activity') return { route: value === undefined || value === 'all' ? 'activity' : 'catchup', eventId: null };
  if (name === 'event' || name === 'repositories') {
    let id = null;
    try {
      id = value ? decodeURIComponent(value) : null;
    } catch {
      /* Invalid bookmark gets the not-found view. */
    }
    return name === 'event' ? { route: 'event', eventId: id } : { route: 'repositories', eventId: null, checkoutRepoId: id };
  }
  return { route: name === 'settings' ? 'settings' : 'catchup', eventId: null };
}

export const activityHref = (route: string) => `#activity/${route === 'activity' ? 'all' : 'new'}`;
export const isActivity = (route: unknown) => route === 'catchup' || route === 'activity';
export const repositoryHref = (id: string) => `#repositories/${encodeURIComponent(id)}`;

const RESULTS_KEY = 'repo-pulse-results-context';
const RESULTS_VERSION = 2;

/** Session storage is untrusted JSON, so every field is checked. */
function readResultsContext(): ResultsContext | null {
  try {
    const value = JSON.parse(sessionStorage.getItem(RESULTS_KEY) ?? 'null');
    if (!value || !isActivity(value.route)) return null;
    const search = typeof value.search === 'string' ? value.search : '';
    return {
      route: value.route,
      search: value.version === RESULTS_VERSION ? search : joinActivitySearch(search, typeof value.people === 'string' ? value.people : ''),
      kind: typeof value.kind === 'string' ? value.kind : '',
      repoIds: Array.isArray(value.repoIds) ? value.repoIds.filter((id: unknown) => typeof id === 'string') : null,
      groups: Array.isArray(value.groups)
        ? value.groups.filter((entry: unknown) => Array.isArray(entry) && typeof entry[0] === 'string' && typeof entry[1] === 'boolean')
        : [],
      filtersOpen: typeof value.filtersOpen === 'boolean' ? value.filtersOpen : undefined,
      savedFilterId: typeof value.savedFilterId === 'string' ? value.savedFilterId : '',
      scrollY: Number.isFinite(value.scrollY) ? Math.max(0, value.scrollY) : 0,
      eventId: typeof value.eventId === 'string' ? value.eventId : null,
      matchingIds: Array.isArray(value.matchingIds) ? value.matchingIds.filter((id: unknown) => typeof id === 'string') : undefined,
      activityCapacity: Number.isSafeInteger(value.activityCapacity) && value.activityCapacity >= 50 ? value.activityCapacity : 50,
    };
  } catch {
    return null;
  }
}

function canonicalRoute() {
  const parsed = parseRoute(location.hash);
  if (isActivity(parsed.route) && location.hash !== activityHref(parsed.route)) {
    history.replaceState(history.state, '', activityHref(parsed.route));
  }
  return parsed;
}

export function createNavigation({
  ui,
  captureGroups,
  activityCapacity,
}: {
  ui: NavigationState;
  captureGroups: () => [string, boolean][];
  activityCapacity: () => number;
}) {
  let results = readResultsContext();
  let pending: ResultsContext | null | undefined;
  let checkoutRepoId: string | null | undefined;
  let generation = 0;

  function remember(eventId: string | null, matchingIds?: string[]) {
    if (!isActivity(ui.route)) return;
    results = {
      route: ui.route,
      search: ui.search,
      kind: ui.kind,
      repoIds: ui.repoIds === null ? null : [...ui.repoIds],
      groups: captureGroups(),
      filtersOpen: ui.filtersOpen,
      savedFilterId: ui.savedFilterId,
      scrollY: window.scrollY,
      eventId,
      matchingIds,
      activityCapacity: activityCapacity(),
    };
    try {
      sessionStorage.setItem(RESULTS_KEY, JSON.stringify({ ...results, version: RESULTS_VERSION }));
    } catch {
      /* Navigation still works without storage. */
    }
  }

  function invalidate() {
    generation++;
    pending = null;
  }

  // Disabled repositories keep their place in an explicit scope so enabling one restores it.
  function reconcileRepositories(watched: WatchedRepo[]) {
    if (ui.repoIds !== null) ui.repoIds = ui.repoIds.filter(id => watched.some(repo => repo.id === id));
    if (!watched.some(repo => !repo.disabled) && isActivity(ui.route)) {
      ui.route = 'repositories';
      history.replaceState(history.state, '', '#repositories');
    }
  }

  return {
    initialize() {
      const { checkoutRepoId: id, ...parsed } = canonicalRoute();
      Object.assign(ui, parsed);
      checkoutRepoId = id;
      ui.activityRoute = isActivity(ui.route) ? ui.route : results?.route || 'catchup';
    },
    view() {
      const { route, eventId, search, kind, repoIds } = ui;
      return { route, eventId, search, kind, repoIds, generation };
    },
    get returnRoute() {
      return results?.route || 'catchup';
    },
    get matchingIds() {
      return results && results.eventId === ui.eventId ? results.matchingIds : undefined;
    },
    invalidate,
    reconcileRepositories,
    remember,
    takeCheckoutFocus(repos: WatchedRepo[]) {
      if (ui.route !== 'repositories' || !repos.some(repo => repo.id === checkoutRepoId && !repo.disabled)) return null;
      const id = checkoutRepoId;
      checkoutRepoId = null;
      return id;
    },
    takeRestoration(loading: unknown) {
      if (loading || pending?.route !== ui.route) return null;
      const restored = pending;
      pending = null;
      return restored;
    },
    /** Null repositories mean the watch list has not loaded yet; the first state read reconciles instead. */
    enter(repos: WatchedRepo[] | null) {
      const previous = ui.route;
      const { checkoutRepoId: id, ...parsed } = canonicalRoute();
      checkoutRepoId = id;
      const destination = parsed.route;
      invalidate();
      if (destination === 'event' && results?.eventId !== parsed.eventId) remember(parsed.eventId);
      Object.assign(ui, parsed);

      let capacity;
      if (isActivity(destination)) {
        ui.activityRoute = destination;
        if (previous === 'event' && results?.route === destination) {
          const { search, kind, filtersOpen, savedFilterId, repoIds, activityCapacity } = results;
          Object.assign(ui, { search, kind, filtersOpen, savedFilterId, repoIds });
          pending = results;
          capacity = activityCapacity;
        } else if (previous === destination) {
          capacity = activityCapacity();
        }
      }
      if (repos) reconcileRepositories(repos);
      return { destination: ui.route, capacity, scrollToTop: previous !== 'event' };
    },
  };
}
