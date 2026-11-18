// @ts-check
import { createHash } from 'node:crypto';
import { actorName, branchName, safeAzureUrl } from '../src/events.js';

/** @typedef {import('../src/activity.js').ActivityKind} ActivityKind */
/** @typedef {import('./azure-client.js').AzureStream} StreamName */
/** @typedef {import('./azure-client.js').AzureProvider} AzureProvider */
/** @typedef {import('./azure-client.js').PageCursor} PageCursor */
/** The time range one read covers. It stays fixed across the pages of that read. */
/** @typedef {{ since: string, until: string }} StreamWindow */
/** @typedef {{ code: string, message: string }} StreamError */
/**
 * Persisted per repository and stream. Optional fields are absent before the first read
 * or after a completed read, which keeps only the fields `completePage` writes.
 * @typedef {{
 *   repoId: string, stream: StreamName, initialized: boolean, nextAt: string, error: StreamError|null,
 *   lastAttempt?: string, lastSuccess?: string, pending?: boolean, failures?: number, quietCycles?: number,
 *   window?: StreamWindow, windowGeneration?: number, refreshGeneration?: number, manual?: boolean,
 *   cursor?: PageCursor|null, pendingItems?: AzureRecord[], activeIds?: string[]
 * }} StreamState
 */
/** A stream while a read is in flight: the window and the refresh generation it answers are fixed. */
/** @typedef {StreamState & { window: StreamWindow, windowGeneration: number, lastAttempt: string, pending: true }} StartedStream */
/** What `normalize` reads from a stream state; backfill passes `historical: true`. */
/** @typedef {{ initialized: boolean, historical?: boolean }} NormalizeState */
/** @typedef {import('./azure-client.js').AzureRecord} AzureRecord */
/** @typedef {import('./azure-client.js').AzureRepo & { id: string, disabled?: boolean }} WatchedRepo */
/**
 * @typedef {{ id: string, repoId: string, kind: ActivityKind, observedAt: string, time: string, actor: string,
 *   branch: string, summary: string, url: string, title?: string, data?: Record<string, unknown>,
 *   imported: boolean, seen: boolean }} SyncEvent
 */
/** @typedef {Partial<Omit<SyncEvent, 'id'|'repoId'|'kind'|'observedAt'|'imported'|'seen'>>} EventDetail */
/** Entity data is stored JSON, so its shape depends on the entity type. */
/** @typedef {{ type: string, id: string, data: any }} Entity */
/** @typedef {{ id: string, type: 'merge', repoId: string, eventId: string, status: 'pending', nextAt: string }} MergeJob */
/** @typedef {{ events: SyncEvent[], entities: Entity[], jobs?: MergeJob[] }} SyncBatch */
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
/** Sync needs `read`; the active-build and PR follow-ups run only when the provider offers them. */
/** @typedef {Pick<AzureProvider, 'read'> & Partial<Pick<AzureProvider, 'buildsById'|'pullRequest'>>} SyncProvider */
/** @typedef {'merge'|'history'} BackgroundKind */

/** @type {StreamName[]} */
const STREAMS = ['pushes', 'refs', 'prs', 'closedPrs', 'builds', 'activeBuilds'];
const ZERO = /^0+$/;
const DAY = 86400000;
const LIVE_TURNS = 6;
/** @param {unknown} value */
const fingerprint = value => createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 24);
/** @param {number} ms */
const iso = ms => new Date(ms).toISOString();
/** @param {AzureRecord} pr */
const prState = pr => ({
  status: pr.status,
  isDraft: Boolean(pr.isDraft),
  title: pr.title,
  source: pr.lastMergeSourceCommit?.commitId,
  target: pr.targetRefName,
});
// Active PRs can expose a successful preview merge. Only completion establishes
// the actual merge result; retain its metadata from this existing response.
/** @param {AzureRecord} item */
const prCompletion = item =>
  item.status === 'completed'
    ? {
        mergeCommit: item.lastMergeCommit?.commitId,
        targetCommit: item.lastMergeTargetCommit?.commitId,
        mergeStatus: item.mergeStatus,
        mergeStrategy: item.completionOptions?.mergeStrategy,
        closedBy: actorName(item.closedBy),
        sourceRepositoryId: item.forkSource ? item.forkSource.repository?.id : item.repository?.id,
        targetRepositoryId: item.repository?.id,
      }
    : {};
/** @param {AzureRecord} build */
const buildState = build => ({
  status: build.status,
  result: build.result,
  finishTime: build.finishTime,
  sourceVersion: build.sourceVersion,
  sourceBranch: build.sourceBranch,
});

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
 * is left to the user while automatic checks are off.
 * @param {StartedStream} state @param {number} at @param {unknown} error @param {number} intervalMs
 * @returns {StreamState}
 */
function failPage(state, at, error, intervalMs) {
  const failures = (state.failures || 0) + 1;
  const delay = Math.min(30 * 60000, intervalMs * 2 ** Math.min(failures - 1, 4));
  // Caught values are untyped; provider errors carry a user-facing message only when they have a code.
  const { code, message } = /** @type {{ code?: string, message: string }} */ (error);
  return {
    ...state,
    manual: false,
    failures,
    error: { code: code || 'SYNC_FAILED', message: code ? message : 'Could not refresh this Azure activity stream.' },
    nextAt: iso(at + delay),
  };
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
 *   background?: Partial<Record<BackgroundKind, () => unknown>>,
 *   onPrCompleted?: (repo: WatchedRepo, data: Record<string, unknown>) => void }} options
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
  onPrCompleted,
}) {
  /** @type {ReturnType<typeof setTimeout>|undefined} */
  let timer;
  /** @type {Promise<void>|null|undefined} */
  let active;
  let stopped = false;
  /** @type {Map<string, number>} */
  const refreshedAt = new Map();
  /** @type {string|undefined} */
  let lastKey;
  let liveTurns = 0;
  /** @type {BackgroundKind} */
  let nextBackground = 'merge';
  /** @type {Partial<Record<BackgroundKind|'live', string>>} */
  const lastTurn = {};
  const counters = { pages: 0, errors: 0 };

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
   * @param {WatchedRepo} repo @param {ActivityKind} kind @param {string} sourceId
   * @param {EventDetail & { time: string }} detail @param {boolean} imported @returns {SyncEvent}
   */
  function makeEvent(repo, kind, sourceId, detail, imported) {
    const observedAt = iso(now());
    return {
      id: `${repo.id}:${kind}:${sourceId}`,
      repoId: repo.id,
      kind,
      observedAt,
      actor: 'Unknown',
      branch: '',
      summary: '',
      url: repo.webUrl,
      ...detail,
      imported,
      seen: imported,
    };
  }
  // PRs and builds are snapshots: an event is emitted only when their fingerprint changes.
  /** @param {WatchedRepo} repo @param {string} type @param {string} key @param {{ status: string }} value @param {boolean} historical */
  function snapshot(repo, type, key, value, historical) {
    const previous = store.getEntity(repo.id, type, key);
    const changed = !previous || JSON.stringify(previous.fingerprint) !== JSON.stringify(value);
    const revision = (previous?.revision || 0) + Number(changed);
    return {
      previous,
      changed,
      sourceId: historical ? `history:${key}:${fingerprint(value)}` : `${key}:${(previous?.revision || 0) + 1}:${fingerprint(value)}`,
      entity: historical ? null : { type, id: key, data: { fingerprint: value, status: value.status, revision } },
    };
  }
  /**
   * A non-status change to a live PR is dated when observed; otherwise the event takes the
   * closure time Azure reports, or the creation time for a PR seen for the first time.
   * @param {AzureRecord} item @param {any} previous @param {boolean} historical
   */
  function prEventTime(item, previous, historical) {
    const unchangedStatus = previous?.fingerprint?.status === item.status;
    if (previous && !historical && unchangedStatus) return iso(now());
    return (item.status !== 'active' ? item.closedDate : null) || (!previous ? item.creationDate : null) || iso(now());
  }
  /**
   * @typedef {{ repo: WatchedRepo, add: (kind: ActivityKind, sourceId: string, detail: EventDetail) => void,
   *   entities: Entity[], jobs: MergeJob[], refs: Map<string, any>|null, historical: boolean }} NormalizeContext
   * @typedef {(item: AzureRecord, context: NormalizeContext) => void} Normalizer
   */
  /** @type {Record<'pushes'|'prs'|'builds', Normalizer> & Partial<Record<StreamName, Normalizer>>} */
  const normalizers = {
    pushes(item, { repo, add, entities, jobs, refs, historical }) {
      const source = String(item.pushId);
      if (!item.pushId || store.getEntity(repo.id, 'push', source)) return;
      const updates = item.refUpdates || [];
      /** @type {AzureRecord[]} */
      const branches = updates.filter((/** @type {AzureRecord} */ ref) => ref.name?.startsWith('refs/heads/'));
      const time = item.date || iso(now());
      const actor = actorName(item.pushedBy);
      const data = { pushId: item.pushId, refUpdates: branches, commits: item.commits || [] };
      const url = safeAzureUrl(item._links?.web?.href, `${repo.webUrl}/pushes?pushId=${encodeURIComponent(source)}`);
      add('push', source, {
        title: `${actor} pushed${branches.length ? ` to ${branches.map(r => branchName(r.name)).join(', ')}` : ''}`,
        branch: branchName(branches[0]?.name),
        actor,
        time,
        url,
        summary: branches.length
          ? branches.map(ref => `${ref.oldObjectId?.slice(0, 7) || '?'} → ${ref.newObjectId?.slice(0, 7) || '?'}`).join(' · ')
          : 'Repository push',
        data,
      });
      entities.push({ type: 'push', id: source, data: { date: time } });
      jobs.push({
        id: `merge:${repo.id}:push:${source}`,
        type: 'merge',
        repoId: repo.id,
        eventId: `${repo.id}:push:${source}`,
        status: 'pending',
        nextAt: iso(now()),
      });
      for (const ref of branches) {
        const created = ref.oldObjectId && ZERO.test(ref.oldObjectId);
        const deleted = ref.newObjectId && ZERO.test(ref.newObjectId);
        if (created || deleted)
          add(created ? 'branch-created' : 'branch-deleted', `${source}:${ref.name}`, {
            title: `${created ? 'New branch' : 'Branch deleted'} · ${branchName(ref.name)}`,
            branch: branchName(ref.name),
            actor,
            time,
            url,
            summary: `${created ? 'Created' : 'Deleted'} in push ${source}`,
            data: { ...data, evidence: 'push', ...ref },
          });
        // Azure lists pushes newest first. Keep a source watermark across pages/snapshots,
        // while retaining every historical event independently of the current ref state.
        const previous = refs?.get(ref.name);
        if (!historical && (!previous?.lastPushId || Number(item.pushId) > previous.lastPushId)) {
          const current = {
            name: ref.name,
            objectId: ref.newObjectId,
            active: !deleted,
            evidence: 'push',
            lastPushId: Number(item.pushId),
          };
          refs?.set(ref.name, current);
          entities.push({ type: 'ref', id: ref.name, data: current });
        }
      }
    },
    prs(item, { repo, add, entities, historical }) {
      if (!item.pullRequestId || (item.repository?.id && item.repository.id.toLowerCase() !== repo.azureId?.toLowerCase())) return;
      const key = String(item.pullRequestId);
      const { previous, changed, sourceId, entity } = snapshot(repo, 'pr', key, prState(item), historical);
      if (changed) {
        add('pr', sourceId, {
          title: `PR ${key} · ${item.title || 'Untitled'}`,
          branch: branchName(item.sourceRefName),
          actor: actorName(item.createdBy),
          time: prEventTime(item, previous, historical),
          summary: `${item.isDraft ? 'Draft · ' : ''}${item.status || 'unknown'} → ${branchName(item.targetRefName)}`,
          url: safeAzureUrl(item._links?.web?.href, `${repo.webUrl}/pullrequest/${encodeURIComponent(key)}`),
          data: {
            pullRequestId: item.pullRequestId,
            status: item.status,
            isDraft: item.isDraft,
            sourceRefName: item.sourceRefName,
            targetRefName: item.targetRefName,
            sourceCommit: item.lastMergeSourceCommit?.commitId,
            ...prCompletion(item),
          },
        });
      }
      if (entity) entities.push(entity);
    },
    builds(item, { repo, add, entities, historical }) {
      if (!item.id || item.repository?.id?.toLowerCase() !== repo.azureId?.toLowerCase()) return;
      const key = String(item.id);
      const { changed, sourceId, entity } = snapshot(repo, 'build', key, buildState(item), historical);
      if (changed) {
        add('build', sourceId, {
          title: `${item.definition?.name || 'Pipeline'} · ${item.buildNumber || key}`,
          branch: branchName(item.sourceBranch),
          actor: actorName(item.requestedFor || item.requestedBy),
          time: item.finishTime || item.startTime || item.queueTime || iso(now()),
          summary: `${item.status || 'unknown'}${item.result ? ` · ${item.result}` : ''} · ${(item.sourceVersion || '').slice(0, 7)}`,
          url: safeAzureUrl(
            item._links?.web?.href,
            `${repo.organization}/${encodeURIComponent(repo.project)}/_build/results?buildId=${encodeURIComponent(key)}`,
          ),
          data: {
            id: item.id,
            buildId: item.id,
            status: item.status,
            result: item.result,
            sourceVersion: item.sourceVersion,
            sourceBranch: item.sourceBranch,
            definition: item.definition,
            reason: item.reason,
          },
        });
      }
      if (entity) entities.push(entity);
    },
  };
  normalizers.closedPrs = normalizers.prs;
  normalizers.activeBuilds = normalizers.builds;
  /**
   * @param {WatchedRepo} repo @param {StreamName} stream @param {AzureRecord[]} records @param {NormalizeState} state
   * @returns {SyncBatch & { jobs: MergeJob[] }}
   */
  function normalize(repo, stream, records, state) {
    /** @type {SyncEvent[]} */
    const events = [];
    /** @type {Entity[]} */
    const entities = [];
    /** @type {MergeJob[]} */
    const jobs = [];
    const historical = Boolean(state.historical);
    const refs = stream === 'pushes' ? new Map(store.listEntities(repo.id, 'ref').map(entry => [entry.id, entry.data])) : null;
    const baseline = /** @type {string} */ (store.getSetting(`baseline:${repo.id}`, iso(now())));
    /** @type {NormalizeContext['add']} */
    const add = (kind, sourceId, detail) => {
      const time = detail.time || iso(now());
      const imported = !state.initialized && Date.parse(time) <= Date.parse(baseline);
      events.push(makeEvent(repo, kind, sourceId, { ...detail, time }, historical || imported));
    };
    const normalizeItem = normalizers[stream];
    if (normalizeItem) for (const item of records) normalizeItem(item, { repo, add, entities, jobs, refs, historical });
    return { events, entities, jobs };
  }
  /**
   * @param {WatchedRepo} repo @param {AzureRecord[]} records @param {StartedStream} state
   * @returns {SyncBatch}
   */
  function reconcileRefs(repo, records, state) {
    const before = new Map(store.listEntities(repo.id, 'ref').map(entry => [entry.id, entry.data]));
    /** @type {Map<string, AzureRecord>} */
    const current = new Map(records.filter(item => item.name?.startsWith('refs/heads/')).map(item => [item.name, item]));
    /** @type {SyncEvent[]} */
    const events = [];
    /** @type {Entity[]} */
    const entities = [];
    for (const [name, item] of current) {
      const previous = before.get(name);
      if (state.initialized && (!previous || previous.active === false)) {
        events.push(
          makeEvent(
            repo,
            'branch-created',
            `ref:${name}:${fingerprint([item.objectId, state.window.until])}`,
            {
              title: `Branch first seen · ${branchName(name)}`,
              branch: branchName(name),
              time: iso(now()),
              summary: 'Discovered in remote refs; creation time and actor unknown',
              data: { name, objectId: item.objectId, evidence: 'snapshot' },
              actor: 'Unknown',
            },
            false,
          ),
        );
      }
      entities.push({ type: 'ref', id: name, data: { name, objectId: item.objectId, active: true, lastPushId: previous?.lastPushId } });
    }
    if (state.initialized)
      for (const [name, old] of before) {
        if (old.active !== false && !current.has(name)) {
          events.push(
            makeEvent(
              repo,
              'branch-deleted',
              `ref:${name}:${fingerprint([old.objectId, state.window.until])}`,
              {
                title: `Branch no longer listed · ${branchName(name)}`,
                branch: branchName(name),
                time: iso(now()),
                summary: 'Missing from complete refs snapshot; deletion time and actor unknown',
                data: { name, objectId: old.objectId, evidence: 'snapshot' },
              },
              false,
            ),
          );
          entities.push({ type: 'ref', id: name, data: { ...old, active: false } });
        }
      }
    return { events, entities };
  }
  /** @param {boolean} automatic */
  async function runBackground(automatic) {
    /** @type {BackgroundKind} */
    const other = nextBackground === 'merge' ? 'history' : 'merge';
    for (const kind of [nextBackground, other]) {
      if (kind === 'merge' && !automatic) continue;
      if (!(await background[kind]?.())) continue;
      lastTurn[kind] = iso(now());
      nextBackground = kind === 'merge' ? 'history' : 'merge';
      liveTurns = 0;
      return true;
    }
    return false;
  }
  /** @param {WatchedRepo} repo */
  function watching(repo) {
    return !stopped && store.listRepos().some(entry => entry.id === repo.id && !entry.disabled);
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
    if (complete && state.stream === 'activeBuilds' && provider.buildsById) {
      const missing = store
        .listEntities(repo.id, 'build')
        .filter(entry => entry.data.status !== 'completed' && !activeIds?.includes(entry.id))
        .slice(0, 20)
        .map(entry => entry.id);
      if (missing.length) items = [...items, ...(await provider.buildsById(repo, missing))];
    }
    if (complete && state.stream === 'prs' && provider.pullRequest) {
      const missing = store
        .listEntities(repo.id, 'pr')
        .filter(entry => entry.data.status === 'active' && !activeIds?.includes(entry.id))
        .slice(0, 3);
      for (const entry of missing) {
        if (!watching(repo)) return null;
        items = [...items, await provider.pullRequest(repo, entry.id)];
      }
    }
    return { page, complete, activeIds, items };
  }
  /**
   * @param {WatchedRepo} repo @param {StreamState} state @param {StartedStream} working
   * @param {{ page: { items: AzureRecord[] }, complete: boolean, items: AzureRecord[] }} read
   */
  function pageBatch(repo, state, working, { page, complete, items }) {
    if (state.stream !== 'refs') return { output: normalize(repo, state.stream, items, working), pendingItems: undefined };
    const pendingItems = [...(state.pendingItems || []), ...page.items];
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
    // A refresh requested after this window opened must survive the commit of a page read before it.
    const latest = store.getStreams().find(entry => entry.repoId === repo.id && entry.stream === state.stream) || state;
    const quietCycles = output.events.some(event => !event.imported) ? 0 : (state.quietCycles || 0) + 1;
    const cadence = !isForeground() || quietCycles >= 2 ? Math.max(intervalMs, 300000) : intervalMs;
    const next = complete
      ? completePage(working, latest, { at: now(), delayMs: state.stream === 'refs' ? refsIntervalMs : cadence, quietCycles })
      : nextPage(working, latest, { at: now(), cursor: page.nextCursor, pendingItems, activeIds });
    store.commitPage({ repoId: repo.id, stream: state.stream, state: next, ...output });
    for (const event of output.events) if (event.kind === 'pr' && event.data?.status === 'completed') onPrCompleted?.(repo, event.data);
    counters.pages++;
  }
  async function runPage() {
    if (stopped) return;
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
    try {
      const read = await readPage(repo, state, working.window);
      if (!read || !watching(repo)) return;
      commitRead(repo, state, working, read);
    } catch (error) {
      if (!store.listRepos().some(entry => entry.id === repo.id)) return;
      store.saveStream(failPage(working, now(), error, intervalMs));
      counters.errors++;
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
    if (stopped) return;
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
        if (repo && targets.includes(repo.id))
          store.saveStream(requestRefresh(state, now(), store.getSetting('refreshEnabled', true) === false));
      }
      return { scheduled: true };
    },
    status() {
      return { running: Boolean(active), stopped, ...counters, streams: store.getStreams().length, lastTurn: { ...lastTurn }, lag: lag() };
    },
  };
}
