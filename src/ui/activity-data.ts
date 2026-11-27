import { splitActivitySearch } from './activity-search.ts';
import type { ActivityEvent, ActivityItem, ActivityPage } from '../activity.ts';

export type ActivityView = {
  route: import('./navigation.ts').Route;
  unreadOnly?: boolean;
  repoIds: string[] | null;
  kind?: string;
  search?: string;
};

const PAGE_SIZE = 50;
const keyFor = (ui: ActivityView) =>
  JSON.stringify({
    view: ui.unreadOnly ? 'new' : 'all',
    repoIds: ui.repoIds === null ? null : [...ui.repoIds].sort(),
    kind: ui.kind || '',
    search: ui.search || '',
  });
const itemKey = (item: ActivityItem) => item.groupKey;

export function activityScopeQuery(ui: Pick<ActivityView, 'repoIds' | 'search' | 'kind'>) {
  const query = new URLSearchParams();
  if (ui.repoIds !== null) query.set('repoIds', ui.repoIds.join(','));
  if (ui.kind) query.set('kind', ui.kind);
  const { search, people } = splitActivitySearch(ui.search || '');
  if (search) query.set('search', search);
  if (people) query.set('people', people);
  return query;
}

function activityQuery(ui: ActivityView, limit: number, cursor?: string | null) {
  const query = activityScopeQuery(ui);
  query.set('view', ui.unreadOnly ? 'new' : 'all');
  query.set('limit', String(limit));
  if (cursor) query.set('cursor', cursor);
  return query;
}

/**
 * Local database paging. The loaded history window survives routine polling.
 */
export function createActivityData(request: typeof import('../api.ts').request) {
  let key: string | undefined;
  let revision: string | undefined;
  let result: ActivityPage | undefined;
  let capacity = PAGE_SIZE,
    generation = 0;

  /** A different view drops the loaded window. */
  function useKey(nextKey: string) {
    if (key !== undefined && key !== nextKey) {
      result = undefined;
      capacity = PAGE_SIZE;
    }
    key = nextKey;
  }

  async function read(
    ui: ActivityView,
    {
      more = false,
      force = false,
      activityRevision,
      restart,
    }: { more?: boolean; force?: boolean; activityRevision?: string | undefined; restart?: boolean } = {},
  ) {
    ui = { ...ui };
    useKey(keyFor(ui));
    const current = ++generation;
    if (ui.repoIds?.length === 0) return (result = { items: [], nextCursor: null, total: 0, newItems: 0, newUpdates: 0 });
    const sameRevision = !restart && revision === activityRevision;
    if (!more && !force && result && activityRevision !== undefined && sameRevision) return result;
    async function fetchPage(limit: number, cursor: string | null) {
      try {
        const value = await request('GET /api/activity', { query: activityQuery(ui, limit, cursor) });
        if (current !== generation) return null;
        if (!Array.isArray(value?.items)) throw new Error('The local activity response is unreadable.');
        return value;
      } catch (error) {
        if (current !== generation) return null;
        throw error;
      }
    }
    if (more && result?.nextCursor && sameRevision) {
      const page = await fetchPage(PAGE_SIZE, result.nextCursor);
      if (!page || current !== generation) return null;
      const merged = new Map(result.items.map(item => [itemKey(item), item]));
      page.items.forEach(item => merged.set(itemKey(item), item));
      result = { ...result, ...page, items: [...merged.values()] };
      capacity = Math.max(PAGE_SIZE, result.items.length);
      return result;
    }
    // Re-read the current window after sync/ack changes instead of snapping back to page one.
    const items: Map<string, ActivityItem> = new Map();
    const cursors = new Set();
    const requested = more && result?.nextCursor ? capacity + PAGE_SIZE : capacity;
    let cursor: string | null = null;
    let first, last;
    do {
      const page = await fetchPage(Math.min(200, requested - items.size), cursor);
      if (!page || current !== generation) return null;
      first ||= page;
      last = page;
      page.items.forEach(item => items.set(itemKey(item), item));
      cursor = page.nextCursor;
      if (cursor && cursors.has(cursor)) throw new Error('The local activity cursor did not advance.');
      if (cursor) cursors.add(cursor);
    } while (cursor && items.size < requested);
    result = { ...first, items: [...items.values()], nextCursor: last.nextCursor };
    revision = activityRevision;
    if (more) capacity = Math.max(PAGE_SIZE, result.items.length);
    return result;
  }

  return {
    reset(size = PAGE_SIZE) {
      key = undefined;
      result = undefined;
      revision = undefined;
      generation++;
      capacity = Number.isSafeInteger(size) && size >= PAGE_SIZE ? size : PAGE_SIZE;
    },
    capacity: () => capacity,
    async read(ui: ActivityView, options: Parameters<typeof read>[1]) {
      try {
        return await read(ui, options);
      } catch (error) {
        if (!(error instanceof Error) || !('code' in error) || error.code !== 'ACTIVITY_CHANGED') throw error;
        return read(ui, { ...options, force: true, restart: true });
      }
    },
    async event(id: string, ciOnly = false) {
      return await request('GET /api/activity/:id', { params: { id }, query: { ci: ciOnly ? '1' : undefined } });
    },
  };
}

/** Every event of the loaded Activity rows, once each. */
export function activityEvents(activity: Pick<ActivityPage, 'items'>): ActivityEvent[] {
  const values = new Map<string, ActivityEvent>();
  for (const item of activity.items) for (const event of item.events) values.set(event.id, event);
  return [...values.values()];
}
