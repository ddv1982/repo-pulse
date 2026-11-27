import { joinActivitySearch } from './activity-search.ts';

/** The pages the hash names. Every switch over a route is exhaustive. */
export type Route = 'activity' | 'event' | 'graph' | 'repositories' | 'settings';

export type NavigationState = {
  route: Route;
  eventId: string | null;
  relatedCi?: boolean | undefined;
  repoIds: string[] | null;
  search: string;
  kind: string;
  filtersOpen: boolean | undefined;
  unreadOnly: boolean;
  savedFilterId: string;
};

export type ResultsContext = {
  unreadOnly: boolean;
  search: string;
  kind: string;
  repoIds: string[] | null;
  groups: [string, boolean][];
  filtersOpen: boolean | undefined;
  savedFilterId: string;
  scrollY: number;
  eventId: string | null;
  matchingIds?: string[] | undefined;
  activityCapacity: number;
};

/** The fields of a watched repository that navigation reads. */
type ScopeRepo = Pick<import('../contract.ts').Repository, 'id' | 'disabled'>;

/** What a hash names: the route, plus the unread choice an Activity link carries and the checkout a Repositories link names. */
type ParsedRoute =
  | { route: 'activity'; eventId: null; unreadOnly: boolean; checkoutRepoId?: undefined }
  | { route: 'event'; eventId: string | null; relatedCi?: true; unreadOnly?: undefined; checkoutRepoId?: undefined }
  | { route: 'repositories'; eventId: null; checkoutRepoId: string | null; unreadOnly?: undefined }
  | { route: 'graph' | 'settings'; eventId: null; unreadOnly?: undefined; checkoutRepoId?: undefined };

/**
 * Resolve legacy Activity bookmarks to the corresponding filter.
 */
export function parseRoute(hash: string): ParsedRoute {
  const [name, value, detail] = String(hash || '')
    .replace(/^#/, '')
    .split('/');
  if (name === 'rules') return { route: 'settings', eventId: null };
  if (name === 'activity' || name === 'catchup') {
    return { route: 'activity', eventId: null, unreadOnly: name === 'catchup' || value === 'new' || value === 'unread' };
  }
  if (name === 'event' || name === 'repositories') {
    let id = null;
    try {
      id = value ? decodeURIComponent(value) : null;
    } catch {
      /* Invalid bookmark gets the not-found view. */
    }
    return name === 'event'
      ? { route: 'event', eventId: id, ...(detail === 'ci' ? { relatedCi: true } : {}) }
      : { route: 'repositories', eventId: null, checkoutRepoId: id };
  }
  if (name === 'settings' || name === 'graph') return { route: name, eventId: null };
  return { route: 'activity', eventId: null, unreadOnly: false };
}

export const activityHref = (unreadOnly: boolean) => (unreadOnly ? '#activity/unread' : '#activity');
export const isActivity = (route: Route) => route === 'activity';
export const repositoryHref = (id: string) => `#repositories/${encodeURIComponent(id)}`;

const RESULTS_KEY = 'repo-pulse-results-context';
const RESULTS_VERSION = 2;

/** Session storage is untrusted JSON, so every field is checked. */
function readResultsContext(): ResultsContext | null {
  try {
    const value = JSON.parse(sessionStorage.getItem(RESULTS_KEY) ?? 'null');
    if (!value || (typeof value.unreadOnly !== 'boolean' && value.route !== 'activity' && value.route !== 'catchup')) return null;
    const search = typeof value.search === 'string' ? value.search : '';
    return {
      unreadOnly: typeof value.unreadOnly === 'boolean' ? value.unreadOnly : value.route === 'catchup',
      search: value.version === RESULTS_VERSION ? search : joinActivitySearch(search, typeof value.people === 'string' ? value.people : ''),
      kind: typeof value.kind === 'string' ? value.kind : '',
      repoIds: Array.isArray(value.repoIds) ? value.repoIds.filter((id: unknown) => typeof id === 'string') : null,
      groups: Array.isArray(value.groups)
        ? value.groups
            .filter((entry: unknown) => Array.isArray(entry) && typeof entry[0] === 'string' && typeof entry[1] === 'boolean')
            .map(([group, open]: [string, boolean]) => [group === 'New updates' ? 'Activity' : group, open])
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
  if (parsed.unreadOnly !== undefined) {
    const hash = activityHref(parsed.unreadOnly);
    if (location.hash !== hash) history.replaceState(history.state, '', hash);
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
      unreadOnly: ui.unreadOnly,
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
  function reconcileRepositories(watched: ScopeRepo[]) {
    if (ui.repoIds !== null) ui.repoIds = ui.repoIds.filter(id => watched.some(repo => repo.id === id));
    if (!watched.some(repo => !repo.disabled) && isActivity(ui.route)) {
      ui.route = 'repositories';
      history.replaceState(history.state, '', '#repositories');
    }
  }

  return {
    initialize() {
      const { checkoutRepoId: id, ...parsed } = canonicalRoute();
      Object.assign(ui, { relatedCi: false }, parsed);
      checkoutRepoId = id;
      ui.unreadOnly = parsed.unreadOnly ?? results?.unreadOnly ?? false;
    },
    view(this: void) {
      const { route, eventId, relatedCi, search, kind, repoIds, unreadOnly } = ui;
      return { route, eventId, relatedCi, search, kind, repoIds, unreadOnly, generation };
    },
    get returnUnreadOnly() {
      return results?.unreadOnly ?? false;
    },
    get matchingIds() {
      return results && results.eventId === ui.eventId ? results.matchingIds : undefined;
    },
    invalidate,
    reconcileRepositories,
    remember,
    takeCheckoutFocus(repos: ScopeRepo[]) {
      if (ui.route !== 'repositories' || !repos.some(repo => repo.id === checkoutRepoId && !repo.disabled)) return null;
      const id = checkoutRepoId;
      checkoutRepoId = null;
      return id;
    },
    takeRestoration(loading: unknown) {
      if (loading || !isActivity(ui.route) || !pending) return null;
      const restored = pending;
      pending = null;
      return restored;
    },
    /** Null repositories mean the watch list has not loaded yet; the first state read reconciles instead. */
    enter(repos: ScopeRepo[] | null) {
      const previous = ui.route;
      const previousUnreadOnly = ui.unreadOnly;
      const { checkoutRepoId: id, ...parsed } = canonicalRoute();
      checkoutRepoId = id;
      const destination = parsed.route;
      invalidate();
      if (destination === 'event' && results?.eventId !== parsed.eventId) remember(parsed.eventId);
      Object.assign(ui, { relatedCi: false }, parsed);

      let capacity;
      if (isActivity(destination)) {
        if (previous === 'event' && results?.unreadOnly === ui.unreadOnly) {
          const { search, kind, filtersOpen, savedFilterId, repoIds, activityCapacity } = results;
          Object.assign(ui, { search, kind, filtersOpen, savedFilterId, repoIds });
          pending = results;
          capacity = activityCapacity;
        } else if (previous === destination && previousUnreadOnly === ui.unreadOnly) {
          capacity = activityCapacity();
        }
      }
      if (repos) reconcileRepositories(repos);
      return { destination: ui.route, capacity, scrollToTop: previous !== 'event' };
    },
  };
}
