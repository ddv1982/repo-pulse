import { createNormalizer } from './normalize.ts';
import { isAzureRef, isRecord, recordsOf, unreadableField } from './azure-records.ts';

export type ActivityKind = import('./normalize.ts').ActivityKind;
export type StreamName = import('./azure-client.ts').AzureStream;
export type AzureProvider = import('./azure-client.ts').AzureProvider;
export type PageCursor = import('./azure-client.ts').PageCursor;
export type AzureStreamRecord = import('./azure-client.ts').AzureStreamRecord;
export type AzurePage = import('./azure-client.ts').AzurePage;
export type AzureRef = import('../src/contract.ts').AzureRef;
export type UnreadableRecords = import('../src/contract.ts').UnreadableRecords;
export type StreamWarning = import('../src/contract.ts').StreamWarning;
export type WatchedRepo = import('./normalize.ts').WatchedRepo;
export type NormalizeState = import('./normalize.ts').NormalizeState;
export type SyncEvent = import('./normalize.ts').SyncEvent;
export type EventDetail = import('./normalize.ts').EventDetail;
export type Entity = import('./normalize.ts').Entity;
export type RewriteJob = import('./normalize.ts').RewriteJob;
export type SyncBatch = import('./normalize.ts').SyncBatch;
/** The time range one read covers. It stays fixed across the pages of that read. */
export type StreamWindow = import('../src/contract.ts').StreamWindow;
export type StreamState = import('../src/contract.ts').StreamState;
type UnreadableLookups = StreamState['unreadableLookups'];
/** A stream while a read is in flight: the window and the refresh generation it answers are fixed. */
export type StartedStream = StreamState & { window: StreamWindow; windowGeneration: number; lastAttempt: string; pending: true };
export type SyncStore = {
  listRepos: () => WatchedRepo[];
  getSetting: (key: string, fallback: unknown) => unknown;
  setSetting: (key: string, value: string) => void;
  getStreams: () => StreamState[];
  saveStream: (state: StreamState) => void;
  getEntity: (repoId: string, type: string, id: string) => any;
  listEntities: (repoId: string, type: string) => { id: string; data: any }[];
  commitPage: (page: SyncBatch & { repoId: string; stream: StreamName; state: StreamState }) => void;
};
/** GET /api/state reports this as `diagnostics.sync`. */
export type SyncStatus = import('../src/contract.ts').SyncEngineStatus;
export type RefreshStatus = import('../src/contract.ts').RefreshStatus;
/** Sync needs `read`; the active-build and PR follow-ups run only when the provider offers them. */
export type SyncProvider = { read: import('./azure-client.ts').StreamRead } & Partial<Pick<AzureProvider, 'buildsById' | 'pullRequest'>>;
export type BackgroundKind = 'rewrite' | 'history';

const STREAMS: StreamName[] = ['pushes', 'refs', 'prs', 'closedPrs', 'builds', 'activeBuilds'];
const DAY = 86400000;
const LIVE_TURNS = 6;
const iso = (ms: number) => new Date(ms).toISOString();

/** Both counts of records left out, with the fields of each. */
export function addUnreadable(sum: UnreadableRecords | undefined, more: UnreadableRecords | undefined): UnreadableRecords | undefined {
  if (!sum || !more) return sum || more;
  return { count: sum.count + more.count, fields: [...new Set([...sum.fields, ...more.fields])] };
}
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
function snapshotRefs(state: StreamState, page: AzurePage): { refs?: AzureRef[]; unreadable?: UnreadableRecords | undefined } {
  if (state.stream !== 'refs') return {};
  const saved: readonly unknown[] = page.restarted ? [] : state.pendingItems || [];
  return {
    refs: [...recordsOf('refs', saved), ...recordsOf('refs', page.items)],
    unreadable: unreadableOf(
      'refs',
      saved.filter(item => !isAzureRef(item)),
    ),
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
    message: `Skipped ${count} ${count === 1 ? 'record' : 'records'} in ${stream} that Azure returned without a readable value for ${fields.join(' or ')}.`,
  };
}

/**
 * Opens a read. A stream resuming a paged read keeps its window and the generation it
 * opened with; a window persisted before generations existed counts as generation zero.
 */
function startPage(state: StreamState, at: number, overlapMs: number): StartedStream {
  const window = state.window || {
    since: iso(state.lastSuccess ? Date.parse(state.lastSuccess) - overlapMs : at - 7 * DAY),
    until: iso(at),
  };
  // The refresh generation at the time this window opened; later refreshes need another read.
  const windowGeneration = state.window ? (state.windowGeneration ?? 0) : state.refreshGeneration || 0;
  return { ...state, window, windowGeneration, lastAttempt: iso(at), pending: true };
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
  }: {
    at: number;
    cursor: PageCursor | null;
    pendingItems?: AzureRef[] | undefined;
    activeIds?: string[] | undefined;
    unreadable: UnreadableRecords | undefined;
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
    quietCycles,
    warning,
    unreadableLookups,
    initialized,
  }: {
    at: number;
    delayMs: number;
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
    nextAt: iso(at + delayMs),
    quietCycles,
    error: null,
    pending: false,
    failures: 0,
    refreshGeneration: latest.refreshGeneration,
    ...(refreshDue ? { manual: latest.manual, nextAt: iso(at) } : {}),
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
  let active: Promise<void> | null | undefined;
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
  let nextBackground: BackgroundKind = 'rewrite';
  const lastTurn: Partial<Record<BackgroundKind | 'live', string>> = {};
  const counters = { pages: 0, errors: 0 };
  /** The turn order of the cached active PRs and in-progress builds to look up by ID, per repository (see lookupTurn). */
  const prTurns: Map<string, Set<string>> = new Map();
  const buildTurns: Map<string, Set<string>> = new Map();
  const turnOrder = (turns: Map<string, Set<string>>, repoId: string) => {
    const order = turns.get(repoId) ?? new Set();
    turns.set(repoId, order);
    return order;
  };

  function ensureStreams() {
    const current = store.getStreams();
    for (const repo of store.listRepos()) {
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
      if (!(await background[kind]?.())) continue;
      lastTurn[kind] = iso(now());
      nextBackground = kind === 'rewrite' ? 'history' : 'rewrite';
      liveTurns = 0;
      return true;
    }
    return false;
  }
  function watching(repo: WatchedRepo) {
    return !halted() && store.listRepos().some(entry => entry.id === repo.id && !entry.disabled);
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
  async function lookUpBuilds(repo: WatchedRepo, activeIds: string[], remembered: UnreadableLookups) {
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
        : turn.filter(id => !answered.has(id)).map(id => ({ type: 'build', id, data: { ...missing.get(id), status: 'completed' } }));
    // A remembered build leaves the warning only when this lookup read it or found it gone, not when the answer had
    // more pages or unreadable builds without an ID, either of which may be it.
    for (const id of [...byId.items.map(item => String(item.id)), ...gone.map(entry => entry.id)]) lookups.delete(id);
    for (const { id, field } of named) lookups.set(id, field);
    // An unreadable build without a readable ID cannot be remembered, so it counts only in this read.
    const unreadable = addUnreadable(
      lookupsUnreadable(lookups),
      unnamed > 0 && byId.unreadable ? { count: unnamed, fields: byId.unreadable.fields } : undefined,
    );
    return { items: byId.items, unreadable, gone, unreadableLookups: [...lookups].map(([id, field]) => ({ id, field })) };
  }
  /**
   * Reads one page plus, on the last page of a snapshot stream, the entities it no longer lists.
   * Returns null when the repository stopped being watched during a read.
   */
  async function readPage(repo: WatchedRepo, state: StreamState, window: StreamWindow) {
    const page = await provider.read(repo, state.stream, { since: window.since, until: window.until, cursor: state.cursor || null });
    if (!page || !Array.isArray(page.items)) throw new Error('Azure returned an invalid page.');
    // Removal while the provider was in flight must not resurrect a local watch.
    if (!watching(repo)) return null;
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
    if (complete && state.stream === 'activeBuilds') {
      const builds = await lookUpBuilds(repo, activeIds || [], state.unreadableLookups);
      items = [...items, ...builds.items];
      unreadable = addUnreadable(unreadable, builds.unreadable);
      gone = builds.gone;
      unreadableLookups = builds.unreadableLookups;
    }
    if (complete && state.stream === 'prs' && provider.pullRequest) {
      const missing = store
        .listEntities(repo.id, 'pr')
        .filter(entry => entry.data.status === 'active' && !activeIds?.includes(entry.id))
        .map(entry => entry.id);
      // A lookup that came back unreadable counts in every read until that PR reads, its lookup finds it deleted or
      // moved, or it is no longer missing, so a read whose turn skips it does not clear the warning.
      const lookups = rememberedLookups(state.unreadableLookups, id => missing.includes(id));
      const order = turnOrder(prTurns, repo.id);
      for (const id of lookupTurn(order, missing, 3)) {
        if (!watching(repo)) return null;
        lookedUp(order, id);
        try {
          items = [...items, await provider.pullRequest(repo, id)];
          lookups.delete(id);
        } catch (error) {
          // Only "this PR cannot be read" (unreadable, deleted, or now in another repository) is left for a later turn.
          if (!isRecord(error) || !['UNREADABLE_RECORD', 'NOT_FOUND', 'WRONG_REPOSITORY'].includes(String(error.code))) throw error;
          // A PR Azure returned in a shape this code cannot read is skipped and counted like an unreadable page record.
          if (error.code === 'UNREADABLE_RECORD') lookups.set(id, typeof error.field === 'string' ? error.field : 'record');
          else lookups.delete(id);
        }
      }
      unreadableLookups = [...lookups].map(([id, field]) => ({ id, field }));
      unreadable = addUnreadable(unreadable, lookupsUnreadable(lookups));
    }
    return { page, complete, activeIds, items, gone, unreadable, unreadableLookups, pendingItems: snapshot.refs };
  }
  function commitRead(repo: WatchedRepo, state: StreamState, working: StartedStream, read: Awaited<ReturnType<typeof readPage>> & {}) {
    const { page, complete, activeIds, pendingItems } = read;
    // A refs snapshot that left out unreadable records is incomplete (see reconcileRefs).
    const incomplete = state.stream === 'refs' && Boolean(read.unreadable?.count);
    const output: SyncBatch =
      state.stream !== 'refs'
        ? normalize(repo, state.stream, read.items, working)
        : complete
          ? reconcileRefs(repo, pendingItems || [], working, { incomplete })
          : { events: [], entities: [] };
    output.entities = [...output.entities, ...read.gone];
    // A refresh requested after this window opened must survive the commit of a page read before it.
    const latest = store.getStreams().find(entry => entry.repoId === repo.id && entry.stream === state.stream) || state;
    const quietCycles = output.events.some(event => !event.imported) ? 0 : (state.quietCycles || 0) + 1;
    const cadence = !isForeground() || quietCycles >= 2 ? Math.max(intervalMs, 300000) : intervalMs;
    const next = complete
      ? completePage(working, latest, {
          at: now(),
          delayMs: state.stream === 'refs' ? refsIntervalMs : cadence,
          quietCycles,
          warning: warningOf(state.stream, read.unreadable),
          unreadableLookups: read.unreadableLookups,
          // An incomplete refs snapshot is no baseline: until a snapshot reads every ref, the stream stays uninitialized
          // (and reconcileRefs writes no tag baseline), so refs that appear meanwhile, including one that stayed
          // unreadable, are recorded without a "first seen" event. The warning the incomplete snapshot leaves shows this.
          initialized: working.initialized || !incomplete,
        })
      : nextPage(working, latest, { at: now(), cursor: page.nextCursor, pendingItems, activeIds, unreadable: read.unreadable });
    store.commitPage({ repoId: repo.id, stream: state.stream, state: next, ...output });
    counters.pages++;
    const key = `${repo.id}:${state.stream}`;
    if (complete && (requested.get(key)?.generation ?? 0) <= working.windowGeneration) requested.delete(key);
  }
  async function runPage() {
    if (halted()) return;
    ensureStreams();
    const automatic = store.getSetting('refreshEnabled', true) !== false;
    const { due, repos } = dueStreams(automatic);
    const [first, second] = due;
    if (!first) {
      await runBackground(automatic);
      return;
    }
    if (liveTurns >= LIVE_TURNS && (await runBackground(automatic))) return;
    const { state, repo } = takeLiveTurn(first, second, repos);
    const working = startPage(state, now(), overlapMs);
    reading = { repoId: state.repoId, stream: state.stream };
    try {
      const read = await readPage(repo, state, working.window);
      if (!read || !watching(repo)) return;
      commitRead(repo, state, working, read);
    } catch (error) {
      if (!store.listRepos().some(entry => entry.id === repo.id)) return;
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
  function schedule() {
    if (halted()) return;
    // The turn that a reset waited for can finish after the reset has already scheduled the next one.
    clearTimeout(timer);
    // A failed turn must not reject unobserved (that would end the process) or stop polling.
    timer = setTimeout(() => {
      tick()
        .catch(() => {
          counters.errors++;
        })
        .finally(schedule);
    }, pollMs);
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
        lag: lag(),
        inProgress: halted() ? [] : inProgress,
      };
    },
  };
}
