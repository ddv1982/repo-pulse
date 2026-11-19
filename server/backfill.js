// @ts-check

/** @typedef {import('../src/activity.js').ActivityEvent} ActivityEvent */
/** @typedef {'pushes'|'closedPrs'|'builds'} HistoryStream */
/** @typedef {{ since: string, until: string }} HistoryWindow */
/** @typedef {import('./azure-client.js').AzureRepo & { id: string, disabled?: boolean }} WatchedRepo */
/** @typedef {{ code: string, message: string }} JobError */
/** @typedef {import('./azure-client.js').AzurePage} SourcePage */
/**
 * @typedef {{ id: string, type: 'backfill', repoId: string, days: number|'all',
 *   status: 'pending'|'running'|'retrying'|'completed', startedAt: string, nextAt: string,
 *   rangeStart: string, rangeEnd: string, stream: HistoryStream, cursor: SourcePage['nextCursor'],
 *   window: HistoryWindow|null, pages: number, records: number, windowsCompleted: number,
 *   failures: number, error: JobError|null, note: string, lastAttempt?: string,
 *   lastProgressAt?: string, coverageStart?: string, completedAt?: string }} HistoryJob
 */
/** @typedef {{ type: string, id: string, data: unknown }} Entity */
/** @typedef {{ events?: ActivityEvent[], entities?: Entity[] }} HistoryBatch */
/**
 * @typedef {{
 *   listRepos: () => WatchedRepo[],
 *   listJobs: (filter: {type: 'backfill'}) => HistoryJob[],
 *   getSetting: (key: string, fallback: string) => unknown,
 *   saveJob: (job: HistoryJob) => void,
 *   commitPage: (page: {repoId: string, events: ActivityEvent[], entities: Entity[], jobs: HistoryJob[]}) => void
 * }} HistoryStore
 */

const DAY = 86400000;
const WINDOW = 30 * DAY;
const EARLIEST = Date.parse('2010-01-01T00:00:00Z');
/** @type {HistoryStream[]} */
const STREAMS = ['pushes', 'closedPrs', 'builds'];
/** @param {number} value */
const iso = value => new Date(value).toISOString();
/** @param {string} message @param {number} status */
const failure = (message, status) => Object.assign(new Error(message), { status });

/**
 * @param {{
 *   store: HistoryStore,
 *   provider: Pick<import('./azure-client.js').AzureProvider, 'read'>,
 *   normalize: (repo: WatchedRepo, stream: HistoryStream, records: unknown[], state: {initialized: false, historical: true, window: HistoryWindow}) => HistoryBatch,
 *   now?: () => number
 * }} options
 */
export function createBackfill({ store, provider, normalize, now = Date.now }) {
  /** @type {Promise<boolean>|null|undefined} */
  let active;
  /** @type {string|undefined} */
  let lastId;
  const jobs = () => store.listJobs({ type: 'backfill' });
  /** @param {string} repoId @param {number|'all'} [days] */
  function start(repoId, days = 30) {
    const repo = store.listRepos().find(item => item.id === repoId);
    if (!repo) throw failure('Repository is not watched.', 404);
    const period = days === 'all' ? 'all' : Number(days);
    if (![30, 90, 'all'].includes(period)) throw failure('Choose 30 days, 90 days or all available history.', 400);
    const previous = jobs().find(job => job.repoId === repoId);
    if (previous && previous.status !== 'completed') {
      if (previous.days !== period) throw failure('A history import is already running for this repository.', 409);
      return previous;
    }
    const requestedAt = now();
    const baseline = Date.parse(String(store.getSetting(`baseline:${repoId}`, '')));
    // Never acknowledge a live change merely because historical import reached the present.
    const until = Number.isFinite(baseline) ? Math.min(requestedAt, baseline) : requestedAt;
    const since = period === 'all' ? EARLIEST : requestedAt - period * DAY;
    const complete = since >= until;
    /** @type {HistoryJob} */
    const job = {
      id: `backfill:${repoId}`,
      type: 'backfill',
      repoId,
      days: period,
      status: complete ? 'completed' : 'pending',
      startedAt: iso(requestedAt),
      nextAt: iso(requestedAt),
      rangeStart: iso(since),
      rangeEnd: iso(until),
      stream: STREAMS[0],
      cursor: null,
      window: complete ? null : { since: iso(Math.max(since, until - WINDOW)), until: iso(until) },
      pages: 0,
      records: 0,
      windowsCompleted: 0,
      failures: 0,
      error: null,
      note:
        period === 'all'
          ? 'All available history since 2010, bounded by provider retention and permissions.'
          : 'Imports older history before monitoring began; current activity stays in live sync.',
      ...(complete ? { completedAt: iso(requestedAt) } : {}),
    };
    store.saveJob(job);
    return job;
  }
  /** @param {HistoryJob} job @param {HistoryWindow} window @param {SourcePage} page @returns {HistoryJob} */
  function nextPage(job, window, page) {
    /** @type {HistoryJob} */
    const next = {
      ...job,
      status: 'pending',
      nextAt: iso(now()),
      lastAttempt: iso(now()),
      lastProgressAt: iso(now()),
      pages: job.pages + 1,
      records: job.records + page.items.length,
      failures: 0,
      error: null,
    };
    if (page.nextCursor) return { ...next, cursor: page.nextCursor };
    next.cursor = null;
    const index = STREAMS.indexOf(job.stream);
    if (index < STREAMS.length - 1) return { ...next, stream: STREAMS[index + 1] };
    next.windowsCompleted++;
    next.coverageStart = window.since;
    const until = Date.parse(window.since),
      lower = Date.parse(job.rangeStart);
    if (until > lower) return { ...next, stream: STREAMS[0], window: { since: iso(Math.max(lower, until - WINDOW)), until: iso(until) } };
    return { ...next, status: 'completed', completedAt: iso(now()), window: null };
  }
  async function runPage() {
    const repos = new Map(
      store
        .listRepos()
        .filter(repo => !repo.disabled)
        .map(repo => [repo.id, repo]),
    );
    const due = jobs()
      .filter(job => job.status !== 'completed' && repos.has(job.repoId) && Date.parse(job.nextAt) <= now())
      .sort((a, b) => (Date.parse(a.lastAttempt || '') || 0) - (Date.parse(b.lastAttempt || '') || 0));
    const job = due.find(item => item.id !== lastId) || due[0];
    if (!job) return false;
    lastId = job.id;
    const repo = repos.get(job.repoId);
    if (!repo) return false;
    const current = () =>
      store.listRepos().some(item => item.id === repo.id && !item.disabled) &&
      jobs().some(item => item.id === job.id && item.startedAt === job.startedAt);
    store.saveJob({ ...job, status: 'running', lastAttempt: iso(now()) });
    try {
      const window = job.window;
      if (!window) throw new Error('History job has no date window.');
      const page = await provider.read(repo, job.stream, { ...window, cursor: job.cursor });
      if (!page || !Array.isArray(page.items)) throw new Error('Invalid history page.');
      if (!current()) return true;
      const output = normalize(repo, job.stream, page.items, { initialized: false, historical: true, window });
      // Build pages are selected by queue time; their completion may cross a page window.
      // The overall import range still prevents post-baseline work becoming imported.
      const since = Date.parse(job.rangeStart),
        until = Date.parse(job.rangeEnd);
      const events = (output.events || [])
        .filter(event => {
          const time = Date.parse(event.time);
          return Number.isFinite(time) && time >= since && time <= until;
        })
        .map(event => ({ ...event, imported: true, seen: true }));
      const pushes = new Set(events.filter(event => event.kind === 'push').map(event => String(event.data?.pushId)));
      // Historical snapshots must not regress current PR/build/ref state. Push facts only dedupe IDs.
      const entities = (output.entities || []).filter(entity => entity.type === 'push' && pushes.has(String(entity.id)));
      store.commitPage({ repoId: repo.id, events, entities, jobs: [nextPage(job, window, page)] });
    } catch (error) {
      if (!current()) return true;
      const failures = (job.failures || 0) + 1;
      const detail =
        error instanceof Error && 'code' in error && typeof error.code === 'string'
          ? { code: error.code, message: error.message }
          : { code: 'HISTORY_FAILED', message: 'Could not import this history page. Existing activity is kept.' };
      store.saveJob({
        ...job,
        status: 'retrying',
        lastAttempt: iso(now()),
        failures,
        nextAt: iso(now() + Math.min(30 * 60000, 60000 * 2 ** Math.min(failures - 1, 5))),
        error: detail,
      });
    }
    return true;
  }
  return {
    start,
    status: jobs,
    tick() {
      if (active) return active;
      active = runPage().finally(() => {
        active = null;
      });
      return active;
    },
  };
}
