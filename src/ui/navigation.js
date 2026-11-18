/** Keep old bookmarks working while exposing one Activity page with two clear views. */
export function parseRoute(hash) {
  const [name, value] = String(hash || '')
    .replace(/^#/, '')
    .split('/');
  if (name === 'rules') return { route: 'settings', eventId: null };
  if (name === 'activity') return { route: value === undefined || value === 'all' ? 'activity' : 'catchup', eventId: null };
  if (name === 'event') {
    let eventId = null;
    try {
      eventId = value ? decodeURIComponent(value) : null;
    } catch {
      /* Invalid bookmark gets the not-found view. */
    }
    return { route: 'event', eventId };
  }
  return { route: ['repositories', 'settings'].includes(name) ? name : 'catchup', eventId: null };
}

export const activityHref = route => `#activity/${route === 'activity' ? 'all' : 'new'}`;
export const isActivity = route => route === 'catchup' || route === 'activity';

const RESULTS_KEY = 'repo-pulse-results-context';

function readResultsContext() {
  try {
    const value = JSON.parse(sessionStorage.getItem(RESULTS_KEY));
    if (!value || !isActivity(value.route)) return null;
    return {
      route: value.route,
      search: typeof value.search === 'string' ? value.search : '',
      kind: typeof value.kind === 'string' ? value.kind : '',
      repoIds: Array.isArray(value.repoIds) ? value.repoIds.filter(id => typeof id === 'string') : null,
      groups: Array.isArray(value.groups)
        ? value.groups.filter(entry => Array.isArray(entry) && typeof entry[0] === 'string' && typeof entry[1] === 'boolean')
        : [],
      filtersOpen: typeof value.filtersOpen === 'boolean' ? value.filtersOpen : undefined,
      scrollY: Number.isFinite(value.scrollY) ? Math.max(0, value.scrollY) : 0,
      eventId: typeof value.eventId === 'string' ? value.eventId : null,
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

export function createNavigation({ ui, captureGroups, activityCapacity }) {
  let results = readResultsContext();
  let pending;
  let generation = 0;

  function remember(eventId) {
    if (!isActivity(ui.route)) return;
    results = {
      route: ui.route,
      search: ui.search,
      kind: ui.kind,
      repoIds: ui.repoIds === null ? null : [...ui.repoIds],
      groups: captureGroups(),
      filtersOpen: ui.filtersOpen,
      scrollY: window.scrollY,
      eventId,
      activityCapacity: activityCapacity(),
    };
    try {
      sessionStorage.setItem(RESULTS_KEY, JSON.stringify(results));
    } catch {
      /* Navigation still works without storage. */
    }
  }

  function invalidate() {
    generation++;
    pending = null;
  }

  // Disabled repositories keep their place in an explicit scope so enabling one restores it.
  function reconcileRepositories(watched) {
    if (ui.repoIds !== null) ui.repoIds = ui.repoIds.filter(id => watched.some(repo => repo.id === id));
    if (!watched.some(repo => !repo.disabled) && isActivity(ui.route)) {
      ui.route = 'repositories';
      history.replaceState(history.state, '', '#repositories');
    }
  }

  return {
    initialize() {
      Object.assign(ui, canonicalRoute());
      ui.activityRoute = isActivity(ui.route) ? ui.route : results?.route || 'catchup';
    },
    view() {
      const { route, eventId, search, kind, repoIds } = ui;
      return { route, eventId, search, kind, repoIds, generation };
    },
    get returnRoute() {
      return results?.route || 'catchup';
    },
    invalidate,
    reconcileRepositories,
    remember,
    takeRestoration(loading) {
      if (loading || pending?.route !== ui.route) return null;
      const restored = pending;
      pending = null;
      return restored;
    },
    enter(repos) {
      const previous = ui.route;
      const parsed = canonicalRoute();
      const destination = parsed.route;
      invalidate();
      if (destination === 'event') remember(parsed.eventId);
      Object.assign(ui, parsed);

      let capacity;
      if (isActivity(destination)) {
        ui.activityRoute = destination;
        if (previous === 'event' && results?.route === destination) {
          const { search, kind, filtersOpen, repoIds, activityCapacity } = results;
          Object.assign(ui, { search, kind, filtersOpen, repoIds });
          pending = results;
          capacity = activityCapacity;
        } else if (previous === destination) {
          capacity = activityCapacity();
        }
      }
      reconcileRepositories(repos);
      return { destination: ui.route, capacity, scrollToTop: previous !== 'event' };
    },
  };
}
