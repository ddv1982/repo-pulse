import { createNormalizer } from './normalize.ts';
import { isRecord, recordId, recordsOf, unreadableField } from './azure-records.ts';
import { READS } from './sync-status.ts';
import { isCorruptRow } from './store-records.ts';
import type { AzureStream as StreamName, AzureProvider, PageCursor, AzureStreamRecord, AzurePage } from './azure-client.ts';
import type {
  AzureRef,
  UnreadableRecords,
  UnreadableIds,
  StreamWarning,
  StreamWindow,
  StreamState,
  SyncEngineStatus as SyncStatus,
  RefreshStatus,
} from '../src/contract.d.ts';
import type { WatchedRepo, Entity, EntityData, EntityType, SyncBatch } from './normalize.ts';
import type { Settings, SettingKey } from './store-records.ts';

export type { ActivityKind, NormalizeState, SyncEvent, EventDetail, RewriteJob } from './normalize.ts';
export type {
  StreamName,
  AzureProvider,
  PageCursor,
  AzureStreamRecord,
  AzurePage,
  AzureRef,
  UnreadableRecords,
  UnreadableIds,
  StreamWarning,
  WatchedRepo,
  Entity,
  EntityData,
  EntityType,
  Settings,
  SettingKey,
  SyncBatch,
  StreamState,
  RefreshStatus,
};

/** The time range one read covers. It stays fixed across the pages of that read. */
export type { StreamWindow };

type UnreadableLookups = StreamState['unreadableLookups'];
/** A stream while a read is in flight: the window and the refresh generation it answers are fixed. */
export type StartedStream = StreamState & { window: StreamWindow; windowGeneration: number; lastAttempt: string; pending: true };
export type SyncStore = {
  listRepos: () => WatchedRepo[];
  getSetting: <K extends SettingKey, F>(key: K, fallback: F) => Settings[K] | F;
  setSetting: <K extends SettingKey>(key: K, value: Settings[K]) => void;
  getStreams: () => StreamState[];
  saveStream: (state: StreamState) => void;
  getEntity: <T extends EntityType>(repoId: string, type: T, id: string) => EntityData[T] | undefined;
  listEntities: <T extends EntityType>(repoId: string, type: T) => { id: string; data: EntityData[T] }[];
  commitPage: (page: SyncBatch & { repoId: string; stream: StreamName; state: StreamState }) => void;
};
/** GET /api/state reports this as `diagnostics.sync`. */
export type { SyncStatus };

/** Sync needs `read`; the active-build and PR follow-ups run only when the provider offers them. */
export type SyncProvider = { read: import('./azure-client.ts').StreamRead } & Partial<Pick<AzureProvider, 'buildsById' | 'pullRequest'>>;
export type BackgroundKind = 'rewrite' | 'history';

const STREAMS: StreamName[] = ['pushes', 'refs', 'prs', 'closedPrs', 'builds', 'activeBuilds'];
const DAY = 86400000;
const SNAPSHOT_TTL_MS = 2 * 60000;
const HISTORY_WINDOW_TTL_MS = 10 * 60000;
const BUSY_POLL_MS = 100;
const LIVE_TURNS = 6;
const iso = (ms: number) => new Date(ms).toISOString();

/** Both counts of records left out, with the fields of each. */
export function addUnreadable(sum: UnreadableRecords | undefined, more: UnreadableRecords | undefined): UnreadableRecords | undefined {
  if (!sum || !more) return sum || more;
  return { count: sum.count + more.count, fields: [...new Set([...sum.fields, ...more.fields])] };
}
/** Both lists of the readable IDs of records left out, and both counts of those without one. */
function addIds(sum: UnreadableIds | undefined, more: UnreadableIds | undefined): UnreadableIds | undefined {
  if (!sum || !more) return sum || more;
  return { ids: [...sum.ids, ...more.ids], anonymous: sum.anonymous + more.anonymous };
}
/** The readable IDs of the records a page left out, and how many had none, or undefined when it left none out. */
const idsOf = (page: AzurePage): UnreadableIds | undefined =>
  page.unreadable?.count
    ? {
        ids: (page.unreadableIds || []).map(entry => entry.id),
        anonymous: page.unreadable.count - (page.unreadableIds?.length ?? 0),
      }
    : undefined;
/** The count and fields of records that fail their stream's check, or undefined when there are none. */
function unreadableOf(stream: StreamName, records: readonly unknown[]): UnreadableRecords | undefined {
  if (!records.length) return undefined;
  return { count: records.length, fields: [...new Set(records.map(record => unreadableField(stream, record) ?? 'record'))] };
}
/**
 * The refs a refs snapshot has read up to and including `page`; nothing for another stream. A provider that restarted the snapshot at page one (see
 * azure-client.ts refs) invalidates the pages saved so far. Refs saved by a version that did not check them, or
 * checked them less strictly, are checked again, and those that fail are counted.
 */
function snapshotRefs(
  state: StreamState,
  page: AzurePage,
): { refs?: AzureRef[]; unreadable?: UnreadableRecords | undefined; unreadableIds?: UnreadableIds | undefined } {
  if (state.stream !== 'refs') return {};
  const saved: readonly unknown[] = page.restarted ? [] : state.pendingItems || [];
  const failed = saved.filter(item => unreadableField('refs', item) !== null);
  const names = failed.flatMap(item => recordId('refs', item) ?? []);
  return {
    refs: [...recordsOf('refs', saved), ...recordsOf('refs', page.items)],
    unreadable: unreadableOf('refs', failed),
    unreadableIds: failed.length ? { ids: names, anonymous: failed.length - names.length } : undefined,
  };
}
/** The IDs of the active PRs or builds a page lists. */
const listedIds = (stream: 'prs' | 'activeBuilds', items: readonly AzureStreamRecord[]) =>
  stream === 'prs'
    ? recordsOf('prs', items).map(item => String(item.pullRequestId))
    : recordsOf('activeBuilds', items).map(item => String(item.id));
/**
 * Up to `size` of the missing IDs, those that have waited longest for a lookup first. `order` holds the missing IDs in
 * turn order: an ID joins the end when it goes missing, in numeric order with the others that do, and `lookedUp` moves
 * it to the end, so neither IDs that stay missing nor IDs that keep going missing can hold every turn.
 */
function lookupTurn(order: Set<string>, missing: string[], size: number) {
  const wanted = new Set(missing);
  for (const id of order) if (!wanted.has(id)) order.delete(id);
  for (const id of [...missing].sort((a, b) => Number(a) - Number(b))) order.add(id);
  return [...order].slice(0, size);
}
/** Moves an ID that is being looked up to the end of the turn order. */
function lookedUp(order: Set<string>, id: string) {
  order.delete(id);
  order.add(id);
}
/** The remembered unreadable lookups of IDs that are still missing, by ID. */
const rememberedLookups = (remembered: UnreadableLookups, missing: (id: string) => boolean) =>
  new Map((remembered || []).filter(entry => missing(entry.id)).map(entry => [entry.id, entry.field]));
/** The count and fields of the remembered unreadable lookups, or undefined when there are none. */
const lookupsUnreadable = (lookups: Map<string, string>): UnreadableRecords | undefined =>
  lookups.size ? { count: lookups.size, fields: [...new Set(lookups.values())] } : undefined;
/** The warning for records a read left out, or undefined when it left none out. */
export function warningOf(stream: StreamName, unreadable: UnreadableRecords | undefined): StreamWarning | undefined {
  if (!unreadable?.count) return undefined;
  const { count, fields } = unreadable;
  return {
    code: 'UNREADABLE_RECORDS',
    count,
    fields,
    message: `Skipped ${count} ${count === 1 ? 'record' : 'records'} in ${READS[stream]} that Azure returned without a readable value for ${fields.join(' or ')}.`,
  };
}

/** The streams that traverse a current listing instead of reading a fixed time range. */
function isSnapshot(stream: StreamName) {
  return stream === 'refs' || stream === 'prs' || stream === 'activeBuilds';
}

/** Reuse the fields that belong to a read only while continuing that read. */
function startPage(state: StreamState, at: number, overlapMs: number, liveSince: number): StartedStream {
  const start = { lastAttempt: iso(at), pending: true } as const;
  if (state.window && state.cursor) {
    const snapshot = isSnapshot(state.stream);
    // A healthy snapshot can take longer than the expiry while it shares turns with other streams.
    // The expiry applies to snapshots from before live reads resumed, and to ones that failed.
    const sameRun = snapshot && !state.error && Date.parse(state.lastAttempt ?? '') >= liveSince;
    // Time-windowed reads can keep paging as long as they make progress within the limit.
    const cursorAgeFrom = snapshot || state.error ? state.window.until : (state.lastAttempt ?? state.window.until);
    const maxAge = snapshot ? SNAPSHOT_TTL_MS : HISTORY_WINDOW_TTL_MS;
    if (sameRun || at - Date.parse(cursorAgeFrom) < maxAge) {
      return { ...state, ...start, window: state.window, windowGeneration: state.windowGeneration ?? 0 };
    }
  }

  // Start over at the same lower bound, including for an interrupted first import.
  const since = state.window?.since ?? iso(state.lastSuccess ? Date.parse(state.lastSuccess) - overlapMs : at - 7 * DAY);
  return {
    ...state,
    ...start,
    window: { since, until: start.lastAttempt },
    windowGeneration: state.refreshGeneration ?? 0,
    cursor: undefined,
    pendingItems: undefined,
    activeIds: undefined,
    unreadable: undefined,
    unreadableIds: undefined,
  };
}

/**
 * Stores the cursor for the next page of the same window. `latest` is the stored state,
 * whose refresh request may be newer than the one this page started with. What this read has
 * left out so far goes into `unreadable`; the warning of the last completed read stays as it is.
 */
function nextPage(
  state: StartedStream,
  latest: StreamState,
  {
    at,
    cursor,
    pendingItems,
    activeIds,
    unreadable,
    unreadableIds,
  }: {
    at: number;
    cursor: PageCursor | null;
    pendingItems?: AzureRef[] | undefined;
    activeIds?: string[] | undefined;
    unreadable: UnreadableRecords | undefined;
    unreadableIds: UnreadableIds | undefined;
  },
): StreamState {
  return {
    ...state,
    refreshGeneration: latest.refreshGeneration,
    manual: latest.manual,
    cursor,
    pendingItems,
    activeIds,
    unreadable,
    unreadableIds,
    nextAt: iso(at),
    error: null,
  };
}

/**
 * Ends a read. The window, cursor and per-read fields are dropped. A refresh requested
 * after the window opened schedules another read now and keeps its manual flag. This is the only
 * place the warning changes: it becomes what this read left out, or is cleared when it left none out.
 */
function completePage(
  state: StartedStream,
  latest: StreamState,
  {
    at,
    delayMs,
    catchUp,
    quietCycles,
    warning,
    unreadableLookups,
    initialized,
  }: {
    at: number;
    delayMs: number;
    catchUp: boolean;
    quietCycles: number;
    warning: StreamWarning | undefined;
    unreadableLookups: UnreadableLookups;
    initialized: boolean;
  },
): StreamState {
  const refreshDue = (latest.refreshGeneration || 0) > state.windowGeneration;
  return {
    repoId: state.repoId,
    stream: state.stream,
    initialized,
    lastSuccess: state.window.until,
    lastAttempt: iso(at),
    nextAt: iso(at + (refreshDue || catchUp ? 0 : delayMs)),
    quietCycles,
    error: null,
    pending: false,
    failures: 0,
    refreshGeneration: latest.refreshGeneration,
    ...(refreshDue ? { manual: latest.manual } : {}),
    ...(warning ? { warning } : {}),
    ...(unreadableLookups?.length ? { unreadableLookups } : {}),
  };
}

/**
 * Records a failed read and backs off. A manual request ends with its failure; retrying
 * is left to the user while automatic checks are off. A refresh requested after the window
 * opened stays due as a manual request, and the retry restarts at page one of a window that keeps the
 * old lower bound and ends at this failure, after the request. The warning of the last completed read stays.
 */
function failPage(state: StartedStream, latest: StreamState, at: number, error: unknown, intervalMs: number): StreamState {
  const failures = (state.failures || 0) + 1;
  const delay = Math.min(30 * 60000, intervalMs * 2 ** Math.min(failures - 1, 4));
  // Caught values are untyped; provider errors carry a user-facing message only when they have a code.
  const { code, message } = error as { code?: string; message: string };
  const failed = {
    ...state,
    manual: false,
    failures,
    error: { code: code || 'SYNC_FAILED', message: code ? message : 'Could not refresh this Azure activity stream.' },
    nextAt: iso(at + delay),
  };
  if ((latest.refreshGeneration || 0) <= state.windowGeneration) return failed;
  const restarted = {
    window: { since: state.window.since, until: iso(at) },
    windowGeneration: latest.refreshGeneration || 0,
    cursor: undefined,
    pendingItems: undefined,
    activeIds: undefined,
    unreadable: undefined,
    unreadableIds: undefined,
  };
  // Marked manual so the request still runs if automatic checks were turned off after it was made.
  return { ...failed, ...restarted, refreshGeneration: latest.refreshGeneration, manual: true };
}

/**
 * Asks for a read now. The generation lets a read already in flight tell that it started too early.
 */
function requestRefresh(state: StreamState, at: number, manual: boolean): StreamState {
  return { ...state, nextAt: iso(at), refreshGeneration: (state.refreshGeneration || 0) + 1, manual };
}

/**
 * Every tick does one bounded page, so busy streams cannot monopolize catch-up.
 */
export function createSync({
  store,
  provider,
  now = Date.now,
  intervalMs = 180000,
  isForeground = () => true,
  refsIntervalMs = 600000,
  pollMs = 1000,
  overlapMs = 120000,
  background = {},
}: {
  store: SyncStore;
  provider: SyncProvider;
  now?: () => number;
  intervalMs?: number;
  isForeground?: () => boolean;
  refsIntervalMs?: number;
  pollMs?: number | undefined;
  overlapMs?: number;
  background?: Partial<Record<BackgroundKind, () => unknown>>;
}) {
  const { normalize, reconcileRefs } = createNormalizer({ store, now });
  let timer: ReturnType<typeof setTimeout> | undefined;
  let active: Promise<boolean | undefined> | null | undefined;
  // `stopped` is whether stop() asked the scheduler to end; `resetting` only pauses it, so a stop during a reset still wins.
  let stopped = false;
  let resetting = false;
  const halted = () => stopped || resetting;
  const refreshedAt: Map<string, number> = new Map();
  let reading: { repoId: string; stream: StreamName } | null = null;
  /**
   * User refreshes not yet answered, by `repoId:stream`, with the refresh generation each asked for.
   * Kept here because the persisted manual flag only marks them while automatic checks are off.
   */
  const requested: Map<string, { repoId: string; stream: StreamName; generation: number }> = new Map();
  let lastKey: string | undefined;
  let liveTurns = 0;
  let liveSince = now();
  let nextBackground: BackgroundKind = 'rewrite';
  const lastTurn: Partial<Record<BackgroundKind | 'live', string>> = {};
  const counters = { pages: 0, errors: 0 };
  const backgroundProblems: SyncStatus['backgroundProblems'] = {};
  /** The turn order of the cached active PRs and in-progress builds to look up by ID, per repository (see lookupTurn). */
  const prTurns: Map<string, Set<string>> = new Map();
  const buildTurns: Map<string, Set<string>> = new Map();
  const turnOrder = (turns: Map<string, Set<string>>, repoId: string) => {
    const order = turns.get(repoId) ?? new Set();
    turns.set(repoId, order);
    return order;
  };
  /**
   * How many times each repository stopped being watched. A read keeps the count it started under and commits only
   * while it is unchanged, so a read of a removed repository cannot write into the watch that re-adds it.
   * Kept in memory: no read and no cooldown outlives the process.
   */
  const watches: Map<string, number> = new Map();
  const watchOf = (repoId: string) => watches.get(repoId) ?? 0;

  function ensureStreams() {
    const current = store.getStreams();
    const repos = store.listRepos();
    // A repository removed and added again starts its lookup order afresh.
    const watched = new Set(repos.map(repo => repo.id));
    for (const turns of [prTurns, buildTurns]) for (const repoId of turns.keys()) if (!watched.has(repoId)) turns.delete(repoId);
    for (const repo of repos) {
      if (store.getSetting(`baseline:${repo.id}`, null) === null) store.setSetting(`baseline:${repo.id}`, iso(now()));
      for (const stream of STREAMS) {
        if (!current.some(state => state.repoId === repo.id && state.stream === stream)) {
          store.saveStream({ repoId: repo.id, stream, initialized: false, nextAt: iso(now()), error: null });
        }
      }
    }
  }
  /**
   * Rewrite checks and history import alternate, so neither queue can take every background turn.
   * History import is explicit, so it also runs while automatic checks are off; rewrite checks wait for them.
   */
  async function runBackground(automatic: boolean) {
    const other: BackgroundKind = nextBackground === 'rewrite' ? 'history' : 'rewrite';
    for (const kind of [nextBackground, other]) {
      if (kind === 'rewrite' && !automatic) continue;
      let ran = false;
      try {
        ran = Boolean(await background[kind]?.());
        delete backgroundProblems[kind];
        if (!ran) continue;
      } catch (error) {
        counters.errors++;
        backgroundProblems[kind] = isCorruptRow(error)
          ? error.message
          : kind === 'history'
            ? 'Could not run history import.'
            : 'Could not check branch rewrites and fork origins.';
      }
      nextBackground = kind === 'rewrite' ? 'history' : 'rewrite';
      liveTurns = 0;
      if (ran) lastTurn[kind] = iso(now());
      // A failed worker gives live reads a turn and the other worker first choice next time.
      return ran;
    }
    return false;
  }
  function watching(repo: WatchedRepo, watch: number) {
    return !halted() && watchOf(repo.id) === watch && store.listRepos().some(entry => entry.id === repo.id && !entry.disabled);
  }
  // Least recently attempted first, limited to enabled repositories and, with automatic refresh off, manual requests.
  function dueStreams(automatic: boolean) {
    const repos = new Map(
      store
        .listRepos()
        .filter(repo => !repo.disabled)
        .map(repo => [repo.id, repo]),
    );
    const due = store
      .getStreams()
      .filter(state => repos.has(state.repoId) && (automatic || state.manual) && Date.parse(String(state.nextAt || 0)) <= now());
    due.sort((a, b) => (Date.parse(String(a.lastAttempt || 0)) || 0) - (Date.parse(String(b.lastAttempt || 0)) || 0));
    return { due, repos };
  }
  function takeLiveTurn(first: StreamState, second: StreamState | undefined, repos: Map<string, WatchedRepo>) {
    liveTurns = Math.min(liveTurns + 1, LIVE_TURNS);
    lastTurn.live = iso(now());
    // Rotating equal-priority entries avoids repeatedly selecting a multi-page first stream.
    const state = second && `${first.repoId}:${first.stream}` === lastKey ? second : first;
    // `due` only holds streams of enabled repositories in `repos`.
    const repo = repos.get(state.repoId) as WatchedRepo;
    lastKey = `${state.repoId}:${state.stream}`;
    return { state, repo };
  }
  /**
   * Looks up by ID up to 20 cached in-progress builds that the active list no longer holds. Returns the builds Azure
   * answered with, what it returned unreadable, and the builds it no longer has. A build whose lookup came back
   * unreadable is remembered and counted in every read until it reads, its lookup finds it gone, or it is listed
   * active again, so a read whose turn skips it does not clear the warning.
   */
  async function lookUpBuilds(repo: WatchedRepo, activeIds: string[], remembered: UnreadableLookups, listed: number) {
    if (!provider.buildsById) return { items: [], gone: [] };
    const missing = new Map(
      store
        .listEntities(repo.id, 'build')
        .filter(entry => entry.data.status !== 'completed' && !activeIds.includes(entry.id))
        .map(entry => [entry.id, entry.data]),
    );
    const lookups = rememberedLookups(remembered, id => missing.has(id));
    const order = turnOrder(buildTurns, repo.id);
    const turn = lookupTurn(order, [...missing.keys()], 20);
    if (!turn.length) return { items: [], gone: [] };
    for (const id of turn) lookedUp(order, id);
    const byId = await provider.buildsById(repo, turn);
    // Azure omits a build it no longer has (removed by retention, see docs/probe-results.md), so stop asking for it.
    // The fingerprint stays, so no event is made for it and a later sighting still compares against its last state.
    // With more pages to read, an omitted build may only be on a later one, so none is given up this turn. A build
    // Azure returned unreadable is not omitted, and when one of those has no readable ID it may be any build asked
    // for, so none is given up either.
    const named = byId.unreadableIds || [];
    const answered = new Set([...byId.items.map(item => String(item.id)), ...named.map(entry => entry.id)]);
    const unnamed = (byId.unreadable?.count ?? 0) - named.length;
    const gone: Entity[] =
      byId.nextCursor || unnamed > 0
        ? []
        : turn.flatMap(id => {
            // `turn` holds IDs of `missing` only.
            const data = missing.get(id);
            return answered.has(id) || !data ? [] : [{ type: 'build', id, data: { ...data, status: 'completed' } } satisfies Entity];
          });
    // A remembered build leaves the warning only when this lookup read it or found it gone, not when the answer had
    // more pages or unreadable builds without an ID, either of which may be it.
    for (const id of [...byId.items.map(item => String(item.id)), ...gone.map(entry => entry.id)]) lookups.delete(id);
    // An unreadable build without a readable ID cannot be remembered, so it counts only in this read, and not for a
    // remembered build asked for in this lookup, or for one of the `listed` builds the active list returned without a
    // readable ID, either of which it may be and which are counted already. Its fields are named either way, since they
    // are what this read found.
    const namedIds = new Set(named.map(entry => entry.id));
    const counted = turn.filter(id => lookups.has(id) && !namedIds.has(id)).length;
    const anonymous = Math.max(0, unnamed - counted - listed);
    for (const { id, field } of named) lookups.set(id, field);
    const unreadable = addUnreadable(
      lookupsUnreadable(lookups),
      unnamed > 0 && byId.unreadable ? { count: anonymous, fields: byId.unreadable.fields } : undefined,
    );
    return { items: byId.items, unreadable, gone, unreadableLookups: [...lookups].map(([id, field]) => ({ id, field })) };
  }
  /**
   * Looks up by ID up to 3 cached active PRs that the active list no longer holds. Returns the PRs Azure answered with,
   * what it returned unreadable, and the PRs to remember, or null when the repository stopped being watched. A lookup
   * that came back unreadable counts in every read until that PR reads, its lookup finds it deleted or moved, or it is
   * no longer missing, so a read whose turn skips it does not clear the warning. `listed` counts the records without a
   * readable ID the active list returned in this read.
   */
  async function lookUpPrs(repo: WatchedRepo, activeIds: string[], remembered: UnreadableLookups, listed: number, watch: number) {
    const pullRequest = provider.pullRequest;
    if (!pullRequest) return { items: [], unreadable: undefined, unreadableLookups: undefined };
    const missing = store
      .listEntities(repo.id, 'pr')
      .filter(entry => entry.data.status === 'active' && !activeIds.includes(entry.id))
      .map(entry => entry.id);
    const lookups = rememberedLookups(remembered, id => missing.includes(id));
    const order = turnOrder(prTurns, repo.id);
    const items: AzureStreamRecord[] = [];
    // Answers whose own ID cannot be read count only in this read, and not again for a PR remembered already or for
    // one of the `listed` records, either of which they may be. Their fields are named either way.
    const anonymous: UnreadableRecords = { count: 0, fields: [] };
    for (const id of lookupTurn(order, missing, 3)) {
      if (!watching(repo, watch)) return null;
      lookedUp(order, id);
      try {
        items.push(await pullRequest(repo, id));
        lookups.delete(id);
      } catch (error) {
        // Only "this PR cannot be read" (unreadable, deleted, or now in another repository) is left for a later turn.
        if (!isRecord(error) || !['UNREADABLE_RECORD', 'NOT_FOUND', 'WRONG_REPOSITORY'].includes(String(error.code))) throw error;
        if (error.code !== 'UNREADABLE_RECORD') {
          lookups.delete(id);
          continue;
        }
        // A PR Azure returned in a shape this code cannot read is skipped and counted like an unreadable page record.
        const field = typeof error.field === 'string' ? error.field : 'record';
        if (error.anonymous !== true) {
          lookups.set(id, field);
          continue;
        }
        anonymous.fields = [...new Set([...anonymous.fields, field])];
        if (!lookups.has(id)) anonymous.count++;
      }
    }
    anonymous.count = Math.max(0, anonymous.count - listed);
    const unreadable = addUnreadable(lookupsUnreadable(lookups), anonymous.fields.length ? anonymous : undefined);
    return { items, unreadable, unreadableLookups: [...lookups].map(([id, field]) => ({ id, field })) };
  }
  /**
   * Reads one page plus, on the last page of a snapshot stream, the entities it no longer lists.
   * Returns null when the repository stopped being watched during a read.
   */
  async function readPage(repo: WatchedRepo, state: StartedStream, watch: number) {
    const page = await provider.read(repo, state.stream, { ...state.window, cursor: state.cursor || null });
    if (!page || !Array.isArray(page.items)) throw new Error('Azure returned an invalid page.');
    // Removal while the provider was in flight must not resurrect a local watch or write into the one that re-adds it.
    if (!watching(repo, watch)) return null;
    const complete = !page.nextCursor;
    // A record Azure lists but this code cannot read is still active, so it is neither missing nor looked up again.
    const activeIds: string[] | undefined =
      state.stream === 'prs' || state.stream === 'activeBuilds'
        ? [...(state.activeIds || []), ...listedIds(state.stream, page.items), ...(page.unreadableIds || []).map(entry => entry.id)]
        : undefined;
    let items: AzureStreamRecord[] = page.items;
    // A provider that restarted the snapshot at page one invalidates what the pages read so far left out.
    let unreadable = addUnreadable(page.restarted ? undefined : state.unreadable, page.unreadable);
    let gone: Entity[] = [];
    let unreadableLookups: UnreadableLookups;
    const snapshot = snapshotRefs(state, page);
    unreadable = addUnreadable(unreadable, snapshot.unreadable);
    const unreadableIds = addIds(addIds(page.restarted ? undefined : state.unreadableIds, idsOf(page)), snapshot.unreadableIds);
    if (complete && state.stream === 'activeBuilds') {
      const builds = await lookUpBuilds(repo, activeIds || [], state.unreadableLookups, unreadableIds?.anonymous ?? 0);
      items = [...items, ...builds.items];
      unreadable = addUnreadable(unreadable, builds.unreadable);
      gone = builds.gone;
      unreadableLookups = builds.unreadableLookups;
    }
    if (complete && state.stream === 'prs' && provider.pullRequest) {
      const prs = await lookUpPrs(repo, activeIds || [], state.unreadableLookups, unreadableIds?.anonymous ?? 0, watch);
      if (!prs) return null;
      items = [...items, ...prs.items];
      unreadable = addUnreadable(unreadable, prs.unreadable);
      unreadableLookups = prs.unreadableLookups;
    }
    return { page, complete, activeIds, items, gone, unreadable, unreadableIds, unreadableLookups, pendingItems: snapshot.refs };
  }
  function commitRead(repo: WatchedRepo, state: StreamState, working: StartedStream, read: Awaited<ReturnType<typeof readPage>> & {}) {
    const { page, complete, activeIds, pendingItems } = read;
    // A refs snapshot that left out unreadable records is incomplete (see reconcileRefs).
    const incomplete = state.stream === 'refs' && Boolean(read.unreadable?.count);
    const output: SyncBatch =
      state.stream !== 'refs'
        ? normalize(repo, state.stream, read.items, working)
        : complete
          ? reconcileRefs(repo, pendingItems || [], working, { incomplete, unreadableIds: read.unreadableIds })
          : { events: [], entities: [] };
    output.entities = [...output.entities, ...read.gone];
    // A refresh requested after this window opened must survive the commit of a page read before it.
    const latest = store.getStreams().find(entry => entry.repoId === repo.id && entry.stream === state.stream) || state;
    const quietCycles = output.events.some(event => !event.imported) ? 0 : (state.quietCycles || 0) + 1;
    const cadence = !isForeground() || quietCycles >= 2 ? Math.max(intervalMs, 300000) : intervalMs;
    const at = now();
    const interval = state.stream === 'refs' ? refsIntervalMs : intervalMs;
    const next = complete
      ? completePage(working, latest, {
          at,
          delayMs: state.stream === 'refs' ? refsIntervalMs : cadence,
          catchUp: at - Date.parse(working.window.until) > interval && store.getSetting('refreshEnabled', true) !== false,
          quietCycles,
          warning: warningOf(state.stream, read.unreadable),
          unreadableLookups: read.unreadableLookups,
          // An incomplete refs snapshot is no baseline: until a snapshot reads every ref, the stream stays uninitialized
          // (and reconcileRefs writes no tag baseline and saves no new ref), so the first complete snapshot records the
          // refs, including one that was unreadable, without a "first seen" event. The warning the incomplete snapshot
          // leaves shows this.
          initialized: working.initialized || !incomplete,
        })
      : nextPage(working, latest, {
          at,
          cursor: page.nextCursor,
          pendingItems,
          activeIds,
          unreadable: read.unreadable,
          unreadableIds: read.unreadableIds,
        });
    store.commitPage({ repoId: repo.id, stream: state.stream, state: next, ...output });
    counters.pages++;
    const key = `${repo.id}:${state.stream}`;
    if (complete && (requested.get(key)?.generation ?? 0) <= working.windowGeneration) requested.delete(key);
    return next;
  }
  async function runPage() {
    if (halted()) return;
    ensureStreams();
    const automatic = store.getSetting('refreshEnabled', true) !== false;
    let { due, repos } = dueStreams(automatic);
    if (!due.length) {
      await runBackground(automatic);
      return;
    }
    if (liveTurns >= LIVE_TURNS) {
      if (await runBackground(automatic)) return true;
      if (halted()) return;
      // A background turn can yield while the watch or its streams change.
      ({ due, repos } = dueStreams(store.getSetting('refreshEnabled', true) !== false));
    }
    const [first, second] = due;
    if (!first) return;
    const at = now();
    if (!(at - Date.parse(lastTurn.live ?? '') < SNAPSHOT_TTL_MS)) liveSince = at;
    const { state, repo } = takeLiveTurn(first, second, repos);
    const working = startPage(state, at, overlapMs, liveSince);
    reading = { repoId: state.repoId, stream: state.stream };
    const watch = watchOf(repo.id);
    try {
      const read = await readPage(repo, working, watch);
      // No await separates this check from the synchronous commit, so the watch cannot change in between.
      if (!read || !watching(repo, watch)) return;
      const next = commitRead(repo, state, working, read);
      return due.length > 1 || Date.parse(next.nextAt) <= now();
    } catch (error) {
      if (halted() || (isRecord(error) && error.code === 'CLOSED')) return;
      if (watchOf(repo.id) !== watch || !store.listRepos().some(entry => entry.id === repo.id)) return;
      // A refresh requested while this read was in flight is not answered by its failure.
      const latest = store.getStreams().find(entry => entry.repoId === repo.id && entry.stream === state.stream) || state;
      store.saveStream(failPage(working, latest, now(), error, intervalMs));
      const key = `${repo.id}:${state.stream}`;
      if ((requested.get(key)?.generation ?? 0) <= working.windowGeneration) requested.delete(key);
      counters.errors++;
    } finally {
      reading = null;
    }
  }
  // Due streams normally start within seconds; one full budget minute late means the shared CLI queue is behind.
  function lag() {
    const automatic = store.getSetting('refreshEnabled', true) !== false;
    const enabled = new Set(
      store
        .listRepos()
        .filter(repo => !repo.disabled)
        .map(repo => repo.id),
    );
    const delays = store
      .getStreams()
      .filter(state => enabled.has(state.repoId) && (automatic || state.manual))
      .map(state => now() - Date.parse(String(state.nextAt || 0)))
      .filter(delay => delay > 60000);
    return { overdueStreams: delays.length, maxDelayMs: delays.length ? Math.max(...delays) : 0 };
  }
  function tick() {
    if (active) return active;
    active = runPage().finally(() => {
      active = null;
    });
    return active;
  }
  function schedule(fast = false) {
    if (halted()) return;
    // The turn that a reset waited for can finish after the reset has already scheduled the next one.
    clearTimeout(timer);
    // A failed turn must not reject unobserved (that would end the process) or stop polling.
    timer = setTimeout(
      () => {
        tick()
          .then(schedule)
          .catch(() => {
            counters.errors++;
            schedule();
          });
      },
      fast ? Math.min(BUSY_POLL_MS, pollMs) : pollMs,
    );
    timer.unref?.();
  }
  return {
    start() {
      if (timer) return;
      stopped = false;
      ensureStreams();
      schedule();
    },
    stop() {
      stopped = true;
      clearTimeout(timer);
      timer = undefined;
      return active;
    },
    tick,
    normalize,
    /**
     * Runs `clear` with no turn in flight, then forgets the refreshes and rotation the cleared data asked for.
     */
    async reset(clear: () => void) {
      const scheduled = Boolean(timer);
      resetting = true;
      clearTimeout(timer);
      timer = undefined;
      // A page in flight sees `resetting` and drops its result instead of writing it after `clear`.
      await active?.catch(() => {});
      try {
        clear();
        delete backgroundProblems.rewrite;
        delete backgroundProblems.history;
      } finally {
        requested.clear();
        refreshedAt.clear();
        prTurns.clear();
        buildTurns.clear();
        lastKey = undefined;
        liveTurns = 0;
        resetting = false;
        if (scheduled) schedule();
      }
    },
    /**
     * Ends the watch of a removed repository: a read still in flight for it is dropped when it completes, and none of
     * its in-memory state (cooldown, PR and build lookup order, stream rotation, unanswered refreshes) carries over to a
     * later re-add, even one made before the next turn would see the repository gone.
     */
    forget(repoId: string) {
      watches.set(repoId, watchOf(repoId) + 1);
      if (reading?.repoId === repoId) reading = null;
      refreshedAt.delete(repoId);
      prTurns.delete(repoId);
      buildTurns.delete(repoId);
      for (const [key, entry] of requested) if (entry.repoId === repoId) requested.delete(key);
      if (STREAMS.some(stream => lastKey === `${repoId}:${stream}`)) lastKey = undefined;
    },
    refresh(repoIds?: string[]): RefreshStatus {
      const repos = store.listRepos();
      if (repoIds && repoIds.some(id => !repos.some(repo => repo.id === id)))
        throw Object.assign(new Error('Repository is not watched.'), { code: 'NOT_FOUND' });
      // Batch additions must register every repository even when refresh requests coalesce.
      ensureStreams();
      // Cooldown is per repository so a second added repository still gets its initial import.
      const enabled = repos.filter(repo => !repo.disabled).map(repo => repo.id);
      const targets = (repoIds || enabled).filter(id => enabled.includes(id) && !(now() - (refreshedAt.get(id) ?? NaN) < 30000));
      if (!targets.length && repos.length) return { scheduled: false, cooldown: true };
      for (const id of targets) refreshedAt.set(id, now());
      for (const state of store.getStreams()) {
        const repo = repos.find(entry => entry.id === state.repoId);
        if (!repo || !targets.includes(repo.id)) continue;
        const next = requestRefresh(state, now(), store.getSetting('refreshEnabled', true) === false);
        store.saveStream(next);
        requested.set(`${next.repoId}:${next.stream}`, {
          repoId: next.repoId,
          stream: next.stream,
          generation: next.refreshGeneration || 0,
        });
      }
      return { scheduled: true };
    },
    status(): SyncStatus {
      // The page in flight and unanswered user refreshes are not visible in the persisted streams.
      const inProgress: { repoId: string; stream: StreamName }[] = [];
      const enabled = new Set(
        store
          .listRepos()
          .filter(repo => !repo.disabled)
          .map(repo => repo.id),
      );
      const streams = store.getStreams();
      for (const [key, { repoId, stream, generation }] of requested) {
        const state = streams.find(entry => entry.repoId === repoId && entry.stream === stream);
        // A removed, re-added or disabled repository's streams never answer the generation this refresh asked for.
        if (!enabled.has(repoId) || (state?.refreshGeneration || 0) < generation) requested.delete(key);
        else inProgress.push({ repoId, stream });
      }
      if (reading) inProgress.push({ ...reading });
      return {
        running: Boolean(active),
        stopped,
        ...counters,
        streams: store.getStreams().length,
        lastTurn: { ...lastTurn },
        backgroundProblems: { ...backgroundProblems },
        lag: lag(),
        inProgress: halted() ? [] : inProgress,
      };
    },
  };
}
