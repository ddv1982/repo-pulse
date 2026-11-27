import { activityKey, lifecycleKey, supportingPushKey } from '../src/activity.ts';
import { activityStatusId, activityEvidenceId, activitySearchText } from '../src/activity-text.ts';
import { readEvent, readOverlay } from './store-records.ts';
import type { ActivityEvent } from '../src/activity.ts';
import type { StoredEvent, HydratedEvent } from '../src/contract.ts';
import type { SqlRow } from './store-records.ts';
import type { StoreDb } from './store-db.ts';
import type { StoreState } from './store-state.ts';
import { invalid, notFound } from './errors.ts';

/** Event rows with the enrichment overlay each hydrated event merges into its data. */
export const SELECT_EVENTS =
  'SELECT e.id,e.data,e.seen,e.imported,n.data AS enrichment FROM events e LEFT JOIN enrichment n ON n.event_id=e.id';

const stamp = (value: string | number) => {
  const time = Date.parse(String(value));
  return Number.isFinite(time) ? time : 0;
};

/**
 * Event rows and their index: inserting, the activity membership and labels each row is listed and searched by, the
 * enrichment overlay, and acknowledgement. None of these writes opens a transaction; the facade owns them.
 */
export function createStoreEvents({ db, q }: StoreDb, state: Pick<StoreState, 'requireRepo' | 'bumpActivity' | 'bumpCiSeen'>) {
  const { requireRepo, bumpActivity } = state;
  /**
   * The boundary for event rows: `enrichment` is the JSON overlay column joined from the enrichment table.
   */
  const hydrate = (row: SqlRow): HydratedEvent => {
    const event = readEvent(row);
    const overlay = row.enrichment == null ? {} : readOverlay(event.id, row.enrichment);
    return { ...event, data: { ...event.data, ...overlay }, seen: Boolean(row.seen), imported: Boolean(row.imported) };
  };
  /** The event a lookup by ID found, or undefined. */
  const hydrateFound = (row: SqlRow | undefined) => (row ? hydrate(row) : undefined);
  const getEvent = (id: string) => hydrateFound(q(`${SELECT_EVENTS} WHERE e.id=?`).get(id));

  function indexLabels(event: ActivityEvent) {
    q(`UPDATE activity_members SET status_id=?, evidence_id=?, search_text=? WHERE event_id=?`).run(
      activityStatusId(event),
      activityEvidenceId(event),
      activitySearchText(event),
      event.id,
    );
  }
  function saveMembership(event: StoredEvent) {
    let key = activityKey(event);
    const candidate = supportingPushKey(event);
    if (candidate && q('SELECT 1 FROM activity_members WHERE group_key=? AND kind=?').get(candidate, 'branch-deleted')) key = candidate;
    q(`INSERT INTO activity_members(event_id,group_key,kind,status_id,evidence_id,search_text,observed,time)
       VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(event_id) DO UPDATE SET group_key=excluded.group_key,kind=excluded.kind,
       status_id=excluded.status_id,evidence_id=excluded.evidence_id,search_text=excluded.search_text,observed=excluded.observed,time=excluded.time`).run(
      event.id,
      key,
      event.kind,
      activityStatusId(event),
      activityEvidenceId(event),
      activitySearchText(event),
      stamp(event.observedAt),
      stamp(event.time),
    );
    if (event.kind === 'branch-deleted' && lifecycleKey(event)) {
      const siblings = q(`SELECT e.id,e.data,e.seen,e.imported FROM events e WHERE e.repo_id=?
        AND json_extract(e.data,'$.kind')='push' AND CAST(json_extract(e.data,'$.data.pushId') AS TEXT)=?`).all(
        event.repoId,
        // lifecycleKey returned a key, so `data` is present; `?.` only satisfies the compiler.
        String(event.data?.pushId),
      );
      for (const row of siblings) {
        const sibling = readEvent(row);
        if (supportingPushKey(sibling) === key) q('UPDATE activity_members SET group_key=? WHERE event_id=?').run(key, sibling.id);
      }
    }
  }
  /** Rebuilds the labels and search text of every stored event. */
  function reindexAll() {
    for (const row of q(SELECT_EVENTS).iterate()) indexLabels(hydrate(row));
  }

  /** Inserts new events and indexes them; `inserted` runs for each event that was not stored yet. */
  function insert(events: ActivityEvent[], inserted: (event: StoredEvent) => void) {
    const statement = q('INSERT OR IGNORE INTO events(id,repo_id,time,observed_at,seen,imported,data) VALUES(?,?,?,?,?,?,?)');
    let any = false;
    for (const event of events) {
      requireRepo(event.repoId);
      if (!event.id || !event.kind) throw invalid('Event ID and kind are required.');
      const imported = Boolean(event.imported);
      const time = event.time || event.observedAt || new Date().toISOString();
      const observedAt = event.observedAt || String(time);
      const value = { ...event, time, observedAt };
      const result = statement.run(
        event.id,
        event.repoId,
        time,
        observedAt,
        Number(Boolean(event.seen || imported)),
        Number(imported),
        JSON.stringify(value),
      );
      if (result.changes) {
        saveMembership(value);
        inserted(value);
        any = true;
      }
    }
    if (any) bumpActivity();
  }

  function enrich(id: string, data: unknown) {
    const event = getEvent(id);
    if (!event) throw notFound('Event is no longer available.', 'NOT_FOUND');
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw invalid('Enrichment must be an object.');
    const stored = q('SELECT data FROM enrichment WHERE event_id=?').get(id);
    const old = stored ? readOverlay(id, stored.data) : {};
    const overlay = { ...old, ...data };
    const serialized = JSON.stringify(overlay);
    if (serialized === JSON.stringify(old)) return event;
    q('INSERT INTO enrichment(event_id,data) VALUES(?,?) ON CONFLICT(event_id) DO UPDATE SET data=excluded.data').run(id, serialized);
    // Enrichment affects search/details only, never alert identity, timing or acknowledgement.
    indexLabels({ ...event, data: { ...event.data, ...overlay } });
    bumpActivity();
    return { ...event, data: { ...event.data, ...overlay } };
  }
  const exists = (id: string) => Boolean(q('SELECT 1 FROM events WHERE id=?').get(id));

  /** Marks these events seen or unseen and returns the IDs that changed. */
  function acknowledge(ids: string[], seen: boolean) {
    const value = Number(Boolean(seen));
    const statement = q('UPDATE events SET seen=? WHERE id=? AND imported=0 AND seen<>?');
    const changedIds = ids.filter(id => statement.run(value, id, value).changes);
    if (changedIds.length) {
      bumpActivity();
      state.bumpCiSeen();
    }
    return changedIds;
  }

  function listEvents({ repoIds, limit = 1000, unseen = false }: { repoIds?: string[]; limit?: number; unseen?: boolean } = {}) {
    const capped = Math.max(1, Math.min(Number(limit) || 1000, 5000));
    if (repoIds?.length === 0) return [];
    const where: string[] = [],
      params: (string | number)[] = [];
    if (repoIds) {
      repoIds.forEach(requireRepo);
      where.push(`e.repo_id IN (${repoIds.map(() => '?').join(',')})`);
      params.push(...repoIds);
    }
    if (unseen) where.push('e.seen=0 AND e.imported=0');
    return db
      .prepare(
        `${SELECT_EVENTS} ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY e.time DESC,e.observed_at DESC,e.rowid DESC LIMIT ?`,
      )
      .all(...params, capped)
      .map(hydrate);
  }
  function getEventGroup(id: string) {
    // The row has the one selected column.
    const member = q('SELECT group_key FROM activity_members WHERE event_id=?').get(id) as { group_key: string } | undefined;
    return member
      ? q(`${SELECT_EVENTS} JOIN activity_members m ON m.event_id=e.id WHERE m.group_key=? ORDER BY m.observed DESC,m.time DESC,e.id DESC`)
          .all(member.group_key)
          .map(hydrate)
      : [];
  }

  return {
    hydrate,
    getEvent,
    exists,
    indexLabels,
    saveMembership,
    reindexAll,
    insert,
    enrich,
    acknowledge,
    listEvents,
    getEventGroup,
  };
}

export type StoreEvents = ReturnType<typeof createStoreEvents>;
