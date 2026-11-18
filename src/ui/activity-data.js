// @ts-check

/** @typedef {import('../activity.js').ActivityEvent} ActivityEvent */
/** @typedef {import('../activity.js').ActivityItem} ActivityItem */
/** @typedef {import('../activity.js').ActivityPage} ActivityPage */
/** @typedef {{ event: ActivityEvent, events: ActivityEvent[] }} EventDetail */
/** @typedef {{ route: string, repoIds: string[]|null, kind?: string, search?: string }} ActivityView */

const PAGE_SIZE = 50;
/** @param {ActivityView} ui */
const keyFor = ui => JSON.stringify({ view: ui.route === 'activity' ? 'all' : 'new', repoIds: ui.repoIds === null ? null : [...ui.repoIds].sort(), kind: ui.kind || '', search: ui.search || '' });
/** @param {ActivityItem} item */
const itemKey = item => item.groupKey;

/** @param {ActivityView} ui @param {number} limit @param {string|null} [cursor] */
function activityUrl(ui, limit, cursor) {
  const query = new URLSearchParams({ view: ui.route === 'activity' ? 'all' : 'new', limit: String(limit) });
  if (ui.repoIds !== null) query.set('repoIds', ui.repoIds.join(','));
  if (ui.kind) query.set('kind', ui.kind);
  if (ui.search) query.set('search', ui.search);
  if (cursor) query.set('cursor', cursor);
  return `/api/activity?${query}`;
}

/**
 * Local database paging. The loaded history window survives routine polling.
 * @param {(path: string) => Promise<unknown>} request
 */
export function createActivityData(request) {
  /** @type {string|undefined} */
  let key;
  /** @type {string|undefined} */
  let revision;
  /** @type {ActivityPage|undefined} */
  let result;
  let capacity = PAGE_SIZE, generation = 0;

  return {
    reset(size = PAGE_SIZE) {
      key = undefined; result = undefined; revision = undefined; generation++;
      capacity = Number.isSafeInteger(size) && size >= PAGE_SIZE ? size : PAGE_SIZE;
    },
    capacity: () => capacity,
    /** @param {ActivityView} ui @param {{more?: boolean, force?: boolean, activityRevision?: string}} [options] */
    async read(ui, { more = false, force = false, activityRevision } = {}) {
      ui = { ...ui };
      const nextKey = keyFor(ui);
      if (key !== undefined && key !== nextKey) { result = undefined; capacity = PAGE_SIZE; }
      key = nextKey;
      const current = ++generation;
      if (ui.repoIds?.length === 0) return (result = { items: [], nextCursor: null, total: 0, newItems: 0, newUpdates: 0 });
      const sameRevision = revision === activityRevision;
      if (!more && !force && result && activityRevision !== undefined && sameRevision) return result;
      /** @param {number} limit @param {string|null} cursor */
      async function fetchPage(limit, cursor) {
        try {
          const value = /** @type {ActivityPage} */ (await request(activityUrl(ui, limit, cursor)));
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
      /** @type {Map<string, ActivityItem>} */
      const items = new Map();
      const cursors = new Set();
      const requested = more && result?.nextCursor ? capacity + PAGE_SIZE : capacity;
      /** @type {string|null} */
      let cursor = null;
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
    },
    /** @param {string} id */
    async event(id) {
      return /** @type {EventDetail} */ (await request(`/api/events/${encodeURIComponent(id)}`));
    },
  };
}

/** @param {Pick<ActivityPage, 'items'>|undefined} activity @param {EventDetail} [detail] */
export function activityEvents(activity, detail) {
  const values = new Map();
  for (const item of activity?.items || []) for (const event of item.events) values.set(event.id, event);
  for (const event of detail?.events || []) values.set(event.id, event);
  if (detail?.event && !values.has(detail.event.id)) values.set(detail.event.id, detail.event);
  return [...values.values()];
}
