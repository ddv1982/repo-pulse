// @ts-check
import { createNormalizer } from './normalize.js';

/** @typedef {import('./normalize.js').ActivityKind} ActivityKind */
/** @typedef {import('./azure-client.js').AzureStream} StreamName */
/** @typedef {import('./azure-client.js').AzureProvider} AzureProvider */
/** @typedef {import('./azure-client.js').PageCursor} PageCursor */
/** @typedef {import('./azure-client.js').AzureRecord} AzureRecord */
/** @typedef {import('./normalize.js').WatchedRepo} WatchedRepo */
/** @typedef {import('./normalize.js').NormalizeState} NormalizeState */
/** @typedef {import('./normalize.js').SyncEvent} SyncEvent */
/** @typedef {import('./normalize.js').EventDetail} EventDetail */
/** @typedef {import('./normalize.js').Entity} Entity */
/** @typedef {import('./normalize.js').RewriteJob} RewriteJob */
/** @typedef {import('./normalize.js').SyncBatch} SyncBatch */
/** The time range one read covers. It stays fixed across the pages of that read. */
/** @typedef {{ since: string, until: string }} StreamWindow */
/** @typedef {{ code: string, message: string }} StreamError */
/**
 * Persisted per repository and stream. Optional fields are absent before the first read
 * or after a completed read, which keeps only the fields `completePage` writes. Demo seeds
 * leave `error` out entirely.
 * @typedef {{
 *   repoId: string, stream: StreamName, initialized: boolean, nextAt: string, error?: StreamError|null,
 *   lastAttempt?: string, lastSuccess?: string, pending?: boolean, failures?: number, quietCycles?: number,
 *   window?: StreamWindow, windowGeneration?: number, refreshGeneration?: number, manual?: boolean,
 *   cursor?: PageCursor|null, pendingItems?: AzureRecord[], activeIds?: string[]
 * }} StreamState
 */
/** A stream while a read is in flight: the window and the refresh generation it answers are fixed. */
/** @typedef {StreamState & { window: StreamWindow, windowGeneration: number, lastAttempt: string, pending: true }} StartedStream */
/**
 * @typedef {{
 *   listRepos: () => WatchedRepo[],
 *   getSetting: (key: string, fallback: unknown) => unknown,
 *   setSetting: (key: string, value: string) => void,
 *   getStreams: () => StreamState[],
 *   saveStream: (state: StreamState) => void,
 *   getEntity: (repoId: string, type: string, id: string) => any,
 *   listEntities: (repoId: string, type: string) => {id: string, data: any}[],
 *   commitPage: (page: SyncBatch & { repoId: string, stream: StreamName, state: StreamState }) => void
 * }} SyncStore
 */
/** GET /api/state reports this as `diagnostics.sync`. */
/** @typedef {ReturnType<ReturnType<typeof createSync>['status']>} SyncStatus */
/** @typedef {ReturnType<ReturnType<typeof createSync>['refresh']>} RefreshStatus */
/** Sync needs `read`; the active-build and PR follow-ups run only when the provider offers them. */
/** @typedef {Pick<AzureProvider, 'read'> & Partial<Pick<AzureProvider, 'buildsById'|'pullRequest'>>} SyncProvider */
/** @typedef {'rewrite'|'history'} BackgroundKind */

/** @type {StreamName[]} */
const STREAMS = ['pushes', 'refs', 'prs', 'closedPrs', 'builds', 'activeBuilds'];
const DAY = 86400000;
const LIVE_TURNS = 6;
/** @param {number} ms */
const iso = ms => new Date(ms).toISOString();

/**
 * Opens a read. A stream resuming a paged read keeps its window and the generation it
 * opened with; a window persisted before generations existed counts as generation zero.
 * @param {StreamState} state @param {number} at @param {number} overlapMs @returns {StartedStream}
 */
function startPage(state, at, overlapMs) {
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
 * whose refresh request may be newer than the one this page started with.
 * @param {StartedStream} state @param {StreamState} latest
 * @param {{ at: number, cursor: PageCursor|null, pendingItems?: AzureRecord[], activeIds?: string[] }} page
 * @returns {StreamState}
 */
function nextPage(state, latest, { at, cursor, pendingItems, activeIds }) {
  return {
    ...state,
    refreshGeneration: latest.refreshGeneration,
    manual: latest.manual,
    cursor,
    pendingItems,
    activeIds,
    nextAt: iso(at),
    error: null,
  };
}

/**
 * Ends a read. The window, cursor and per-read fields are dropped. A refresh requested
 * after the window opened schedules another read now and keeps its manual flag.
 * @param {StartedStream} state @param {StreamState} latest
 * @param {{ at: number, delayMs: number, quietCycles: number }} result
 * @returns {StreamState}
 */
function completePage(state, latest, { at, delayMs, quietCycles }) {
  const refreshDue = (latest.refreshGeneration || 0) > state.windowGeneration;
  return {
    repoId: state.repoId,
    stream: state.stream,
    initialized: true,
    lastSuccess: state.window.until,
    lastAttempt: iso(at),
    nextAt: iso(at + delayMs),
    quietCycles,
    error: null,
    pending: false,
    failures: 0,
    refreshGeneration: latest.refreshGeneration,
    ...(refreshDue ? { manual: latest.manual, nextAt: iso(at) } : {}),
  };
}

/**
 * Records a failed read and backs off. A manual request ends with its failure; retrying
 * is left to the user while automatic checks are off. A refresh requested after the window
 * opened stays due as a manual request, and the retry restarts at page one of a window that keeps the
 * old lower bound and ends at this failure, after the request.
 * @param {StartedStream} state @param {StreamState} latest @param {number} at @param {unknown} error @param {number} intervalMs
 * @returns {StreamState}
 */
function failPage(state, latest, at, error, intervalMs) {
  const failures = (state.failures || 0) + 1;
  const delay = Math.min(30 * 60000, intervalMs * 2 ** Math.min(failures - 1, 4));
  // Caught values are untyped; provider errors carry a user-facing message only when they have a code.
  const { code, message } = /** @type {{ code?: string, message: string }} */ (error);
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
  };
  // Marked manual so the request still runs if automatic checks were turned off after it was made.
  return { ...failed, ...restarted, refreshGeneration: latest.refreshGeneration, manual: true };
}

/**
 * Asks for a read now. The generation lets a read already in flight tell that it started too early.
 * @param {StreamState} state @param {number} at @param {boolean} manual @returns {StreamState}
 */
function requestRefresh(state, at, manual) {
  return { ...state, nextAt: iso(at), refreshGeneration: (state.refreshGeneration || 0) + 1, manual };
}

/**
 * Every tick does one bounded page, so busy streams cannot monopolize catch-up.
 * @param {{ store: SyncStore, provider: SyncProvider, now?: () => number, intervalMs?: number,
 *   isForeground?: () => boolean, refsIntervalMs?: number, pollMs?: number, overlapMs?: number,
 *   background?: Partial<Record<BackgroundKind, () => unknown>> }} options
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
}) {
  const { normalize, reconcileRefs } = createNormalizer({ store, now });
  /** @type {ReturnType<typeof setTimeout>|undefined} */
  let timer;
  /** @type {Promise<void>|null|undefined} */
  let active;
  // `stopped` is whether stop() asked the scheduler to end; `resetting` only pauses it, so a stop during a reset still wins.
  let stopped = false;
  let resetting = false;
  const halted = () => stopped || resetting;
  /** @type {Map<string, number>} */
  const refreshedAt = new Map();
  /** @type {{ repoId: string, stream: StreamName } | null} */
  let reading = null;
  /**
   * User refreshes not yet answered, by `repoId:stream`, with the refresh generation each asked for.
   * Kept here because the persisted manual flag only marks them while automatic checks are off.
   * @type {Map<string, { repoId: string, stream: StreamName, generation: number }>}
   */
  const requested = new Map();
  /** @type {string|undefined} */
  let lastKey;
  let liveTurns = 0;
  /** @type {BackgroundKind} */
  let nextBackground = 'rewrite';
  /** @type {Partial<Record<BackgroundKind|'live', string>>} */
  const lastTurn = {};
  const counters = { pages: 0, errors: 0 };
  /** The last cached active PR looked up by ID, per repository, so missing PRs take turns. @type {Map<string, string>} */
  const prLookedUp = new Map();

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
   * @param {boolean} automatic
   */
  async function runBackground(automatic) {
    /** @type {BackgroundKind} */
    const other = nextBackground === 'rewrite' ? 'history' : 'rewrite';
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
  /** @param {WatchedRepo} repo */
  function watching(repo) {
    return !halted() && store.listRepos().some(entry => entry.id === repo.id && !entry.disabled);
  }
  // Least recently attempted first, limited to enabled repositories and, with automatic refresh off, manual requests.
  /** @param {boolean} automatic */
  function dueStreams(automatic) {
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
  /** @param {StreamState[]} due @param {Map<string, WatchedRepo>} repos */
  function takeLiveTurn(due, repos) {
    liveTurns = Math.min(liveTurns + 1, LIVE_TURNS);
    lastTurn.live = iso(now());
    // Rotating equal-priority entries avoids repeatedly selecting a multi-page first stream.
    const index = due.findIndex(state => `${state.repoId}:${state.stream}` === lastKey);
    const state = due[index === 0 && due.length > 1 ? 1 : 0];
    // `due` only holds streams of enabled repositories in `repos`.
    const repo = /** @type {WatchedRepo} */ (repos.get(state.repoId));
    lastKey = `${state.repoId}:${state.stream}`;
    return { state, repo };
  }
  /**
   * Reads one page plus, on the last page of a snapshot stream, the entities it no longer lists.
   * Returns null when the repository stopped being watched during a read.
   * @param {WatchedRepo} repo @param {StreamState} state @param {StreamWindow} window
   */
  async function readPage(repo, state, window) {
    const page = await provider.read(repo, state.stream, { since: window.since, until: window.until, cursor: state.cursor || null });
    if (!page || !Array.isArray(page.items)) throw new Error('Azure returned an invalid page.');
    // Removal while the provider was in flight must not resurrect a local watch.
    if (!watching(repo)) return null;
    const complete = !page.nextCursor;
    /** @type {string[]|undefined} */
    const activeIds = ['activeBuilds', 'prs'].includes(state.stream)
      ? [...(state.activeIds || []), ...page.items.map(item => String(item.id || item.pullRequestId))]
      : undefined;
    let items = page.items;
    /** @type {Entity[]} */
    let gone = [];
    if (complete && state.stream === 'activeBuilds' && provider.buildsById) {
      const missing = store
        .listEntities(repo.id, 'build')
        .filter(entry => entry.data.status !== 'completed' && !activeIds?.includes(entry.id))
        .slice(0, 20);
      if (missing.length) {
        const { items: found, nextCursor } = await provider.buildsById(
          repo,
          missing.map(entry => entry.id),
        );
        items = [...items, ...found];
        // Azure omits a build it no longer has (removed by retention, see docs/probe-results.md), so stop asking for it.
        // The fingerprint stays, so no event is made for it and a later sighting still compares against its last state.
        // With more pages to read, an omitted build may only be on a later one, so none is given up this turn.
        if (!nextCursor)
          gone = missing
            .filter(entry => !found.some(item => String(item?.id) === entry.id))
            .map(entry => ({ type: 'build', id: entry.id, data: { ...entry.data, status: 'completed' } }));
      }
    }
    if (complete && state.stream === 'prs' && provider.pullRequest) {
      const missing = store
        .listEntities(repo.id, 'pr')
        .filter(entry => entry.data.status === 'active' && !activeIds?.includes(entry.id))
        .map(entry => entry.id)
        .sort((a, b) => Number(a) - Number(b));
      // Lookups resume after the last ID checked, so PRs that stay unreadable cannot hold every turn.
      const after = missing.findIndex(id => Number(id) > Number(prLookedUp.get(repo.id) ?? -1));
      const turn = [...missing.slice(Math.max(after, 0)), ...missing.slice(0, Math.max(after, 0))].slice(0, 3);
      for (const id of turn) {
        if (!watching(repo)) return null;
        prLookedUp.set(repo.id, id);
        try {
          items = [...items, await provider.pullRequest(repo, id)];
        } catch (error) {
          // Only "this PR cannot be read" (deleted, or now in another repository) is left for a later turn.
          if (!['NOT_FOUND', 'WRONG_REPOSITORY'].includes(/** @type {{ code?: string }} */ (error)?.code || '')) throw error;
        }
      }
    }
    return { page, complete, activeIds, items, gone };
  }
  /**
   * @param {WatchedRepo} repo @param {StreamState} state @param {StartedStream} working
   * @param {{ page: { items: AzureRecord[], restarted?: boolean }, complete: boolean, items: AzureRecord[] }} read
   */
  function pageBatch(repo, state, working, { page, complete, items }) {
    if (state.stream !== 'refs') return { output: normalize(repo, state.stream, items, working), pendingItems: undefined };
    // A provider that restarted the snapshot at page one (see azure-client.js refs) invalidates the pages saved so far.
    const pendingItems = [...(page.restarted ? [] : state.pendingItems || []), ...page.items];
    /** @type {SyncBatch} */
    const output = complete ? reconcileRefs(repo, pendingItems, working) : { events: [], entities: [] };
    return { output, pendingItems };
  }
  /**
   * @param {WatchedRepo} repo @param {StreamState} state @param {StartedStream} working
   * @param {Awaited<ReturnType<typeof readPage>> & {}} read
   */
  function commitRead(repo, state, working, read) {
    const { page, complete, activeIds } = read;
    const { output, pendingItems } = pageBatch(repo, state, working, read);
    output.entities = [...output.entities, ...read.gone];
    // A refresh requested after this window opened must survive the commit of a page read before it.
    const latest = store.getStreams().find(entry => entry.repoId === repo.id && entry.stream === state.stream) || state;
    const quietCycles = output.events.some(event => !event.imported) ? 0 : (state.quietCycles || 0) + 1;
    const cadence = !isForeground() || quietCycles >= 2 ? Math.max(intervalMs, 300000) : intervalMs;
    const next = complete
      ? completePage(working, latest, { at: now(), delayMs: state.stream === 'refs' ? refsIntervalMs : cadence, quietCycles })
      : nextPage(working, latest, { at: now(), cursor: page.nextCursor, pendingItems, activeIds });
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
    if (!due.length) {
      await runBackground(automatic);
      return;
    }
    if (liveTurns >= LIVE_TURNS && (await runBackground(automatic))) return;
    const { state, repo } = takeLiveTurn(due, repos);
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
     * @param {() => void} clear
     */
    async reset(clear) {
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
        prLookedUp.clear();
        lastKey = undefined;
        liveTurns = 0;
        resetting = false;
        if (scheduled) schedule();
      }
    },
    /** @param {string[]} [repoIds] */
    refresh(repoIds) {
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
    status() {
      // The page in flight and unanswered user refreshes are not visible in the persisted streams.
      /** @type {{ repoId: string, stream: StreamName }[]} */
      const inProgress = [];
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
