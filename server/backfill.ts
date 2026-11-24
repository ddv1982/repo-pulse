import { addUnreadable, warningOf } from './sync.ts';
import type { ActivityEvent } from '../src/activity.ts';
import type { AzureStreamRecord, HistoryStream, HistoryWindow, HistoryJob, HistoryWarning, UnreadableRecords } from '../src/contract.ts';
import type { AzureRepo, AzurePage as SourcePage } from './azure-client.ts';
import type { Entity } from './normalize.ts';
import type { JobType, JobOf } from './store-records.ts';

export type {
  ActivityEvent,
  AzureStreamRecord,
  HistoryStream,
  HistoryWindow,
  SourcePage,
  HistoryJob,
  HistoryWarning,
  UnreadableRecords,
  Entity,
  JobType,
  JobOf,
};

export type WatchedRepo = AzureRepo & { id: string; disabled?: boolean };

export type HistoryBatch = { events?: ActivityEvent[]; entities?: Entity[] };
export type HistoryStore = {
  listRepos: () => WatchedRepo[];
  listJobs: <T extends JobType>(filter: { type: T }) => JobOf<T>[];
  getSetting: (key: `baseline:${string}`, fallback: string) => string;
  saveJob: (job: HistoryJob) => void;
  commitPage: (page: { repoId: string; events: ActivityEvent[]; entities: Entity[]; jobs: HistoryJob[] }) => void;
};

const DAY = 86400000;
const WINDOW = 30 * DAY;
const EARLIEST = Date.parse('2010-01-01T00:00:00Z');
const STREAMS: [HistoryStream, ...HistoryStream[]] = ['pushes', 'closedPrs', 'builds'];
const iso = (value: number) => new Date(value).toISOString();
const failure = (message: string, status: number) => Object.assign(new Error(message), { status });
/** The job's warnings with the records a page of `stream` skipped added to that stream's. */
function withSkipped(warnings: HistoryWarning[], stream: HistoryStream, skipped: UnreadableRecords): HistoryWarning[] {
  const previous = warnings.find(warning => warning.stream === stream);
  const warning = warningOf(stream, addUnreadable(previous && { count: previous.count, fields: previous.fields }, skipped));
  if (!warning) return warnings;
  const next = { ...warning, stream };
  return previous ? warnings.map(entry => (entry === previous ? next : entry)) : [...warnings, next];
}

export function createBackfill({
  store,
  provider,
  normalize,
  now = Date.now,
}: {
  store: HistoryStore;
  provider: Pick<import('./azure-client.ts').AzureProvider, 'read'>;
  normalize: (
    repo: WatchedRepo,
    stream: HistoryStream,
    records: AzureStreamRecord[],
    state: { initialized: false; historical: true; window: HistoryWindow },
  ) => HistoryBatch;
  now?: () => number;
}) {
  let active: Promise<boolean> | null | undefined;
  let lastId: string | undefined;
  const jobs = () => store.listJobs({ type: 'backfill' });
  function start(repoId: string, days: number | 'all' = 30): HistoryJob {
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
    const baseline = Date.parse(store.getSetting(`baseline:${repoId}`, ''));
    // Never acknowledge a live change merely because historical import reached the present.
    const until = Number.isFinite(baseline) ? Math.min(requestedAt, baseline) : requestedAt;
    const since = period === 'all' ? EARLIEST : requestedAt - period * DAY;
    const complete = since >= until;
    const job: HistoryJob = {
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
  function nextPage(job: HistoryJob, window: HistoryWindow, page: SourcePage): HistoryJob {
    const next: HistoryJob = {
      ...job,
      status: 'pending',
      nextAt: iso(now()),
      lastAttempt: iso(now()),
      lastProgressAt: iso(now()),
      pages: job.pages + 1,
      records: job.records + page.items.length,
      failures: 0,
      error: null,
      // A record Azure returned unreadable is skipped, and the job says so instead of dropping it silently.
      ...(page.unreadable?.count ? { warnings: withSkipped(job.warnings ?? [], job.stream, page.unreadable) } : {}),
    };
    if (page.nextCursor) return { ...next, cursor: page.nextCursor };
    next.cursor = null;
    const following = STREAMS[STREAMS.indexOf(job.stream) + 1];
    if (following) return { ...next, stream: following };
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
          const time = Date.parse(String(event.time));
          return Number.isFinite(time) && time >= since && time <= until;
        })
        .map(event => ({ ...event, imported: true, seen: true }));
      const pushes = new Set(events.filter(event => event.kind === 'push').map(event => String(event.data?.pushId)));
      // Historical snapshots must not regress current PR/build/ref state. Push facts only dedupe IDs.
      const entities = (output.entities || []).filter(entity => entity.type === 'push' && pushes.has(String(entity.id)));
      store.commitPage({ repoId: repo.id, events, entities, jobs: [nextPage(job, window, page)] });
    } catch (error) {
      if (!current()) return true;
      // Shutdown aborted the read, not Azure; the page resumes on the next start.
      if ((error as { code?: unknown })?.code === 'CLOSED') return true;
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
