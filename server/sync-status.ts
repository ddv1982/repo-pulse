import { worstStatus } from '../src/sync-worst.ts';
import type { StreamState } from './sync.ts';
import type { SyncStatus, OverallSyncStatus } from '../src/contract.ts';

export type { StreamState, SyncStatus, OverallSyncStatus };
export type { SyncState } from '../src/contract.ts';

export type SyncStatusInput = {
  repos: { id: string; disabled?: boolean }[];
  streams: StreamState[];
  jobs: (Pick<import('./backfill.ts').HistoryJob, 'repoId' | 'status'> &
    Partial<Pick<import('./backfill.ts').HistoryJob, 'failures' | 'error' | 'stream'>>)[];
  inProgress: { repoId: string; stream: string }[];
  settings: { refreshEnabled: boolean; refreshResumedAt: number | null };
  startedAt: number;
  now: number;
  demo?: boolean;
  throttledUntil?: string | null | undefined;
  resetting?: boolean;
  resetFailed?: boolean;
  backgroundProblem?: string | undefined;
};

const MINUTE = 60000;
const HOUR = 60 * MINUTE;
const LATE = 3 * MINUTE;
// A retry cannot fix these, so they count from the first failure.
const LASTING = new Set(['AUTH_REQUIRED', 'FORBIDDEN', 'CLI_MISSING', 'CLI_SETUP']);

/** The name a person reads for each stream, in errors and warnings. */
export const READS: Record<StreamState['stream'] | 'history', string> = {
  pushes: 'pushes',
  refs: 'branches',
  prs: 'pull requests',
  closedPrs: 'pull requests',
  builds: 'builds',
  activeBuilds: 'builds',
  history: 'history',
};
/**
 * What the reader can do about a lasting error; streams keep the technical message for Copy diagnostics.
 */
function plainReason(error: { code: string; message: string }, stream: StreamState['stream'] | 'history') {
  switch (error.code) {
    case 'AUTH_REQUIRED':
      return 'Sign in to Azure again.';
    case 'FORBIDDEN':
      return `Your Azure account has no access to this repository's ${READS[stream]}.`;
    case 'CLI_MISSING':
      return 'Install the Azure CLI.';
    default:
      return error.message;
  }
}
function behindText(ms: number) {
  const [count, unit] =
    ms < 120 * MINUTE
      ? [Math.max(1, Math.round(ms / MINUTE)), 'minute']
      : ms < 48 * HOUR
        ? [Math.round(ms / HOUR), 'hour']
        : [Math.round(ms / (24 * HOUR)), 'day'];
  return `about ${count} ${unit}${count === 1 ? '' : 's'} behind`;
}

const overdueAfter = (stream: StreamState) => (stream.stream === 'refs' ? 20 : 10) * MINUTE;
/** NaN when absent. */
const time = (value: string | undefined) => Date.parse(value ?? '');

/**
 * One status per enabled repository, first matching rule wins; overall is the worst of them.
 */
export function syncStatus({
  repos,
  streams,
  jobs,
  inProgress,
  settings,
  startedAt,
  now,
  demo = false,
  throttledUntil,
  resetting = false,
  resetFailed = false,
  backgroundProblem,
}: SyncStatusInput): import('../src/contract.ts').SyncStatusReport {
  const automatic = settings.refreshEnabled !== false;
  const ranSince = Math.max(startedAt, settings.refreshResumedAt ?? 0);
  const stale = (stream: StreamState) => automatic && now - time(stream.lastSuccess) > overdueAfter(stream);
  const graceOver = (stream: StreamState) => now - ranSince > overdueAfter(stream);
  // Every stream is overdue right after a start or resume; the first minutes are catch-up, after which lateness counts from nextAt.
  const catchingUp = now - ranSince <= LATE;
  /** How far behind a stream is, null when it is not, NaN when throttled before any success. */
  function behindBy(stream: StreamState): number | null {
    const age = now - time(stream.lastSuccess);
    if (stream.error?.code === 'THROTTLED' || (stale(stream) && graceOver(stream))) return age;
    const lateness = now - time(stream.nextAt);
    return (automatic || stream.manual) && !catchingUp && lateness > LATE ? lateness : null;
  }

  function repoStatus(repoId: string): SyncStatus {
    const own = streams.filter(stream => stream.repoId === repoId);
    const successes = own.map(stream => time(stream.lastSuccess)).filter(Number.isFinite);
    const oldest = successes.length ? Math.min(...successes) : NaN;
    const since = own.length && successes.length === own.length ? { since: new Date(oldest).toISOString() } : {};
    // Synced means every stream is within its freshness limit, so the newest read is the honest "last check".
    const fresh = successes.length ? { lastCheck: new Date(Math.max(...successes)).toISOString() } : {};
    if (demo) return { state: 'synced', ...since, ...fresh };
    // Stored activity is being deleted and then imported again, whatever the streams still say.
    if (resetting) return { state: 'syncing' };
    if (resetFailed) return { state: 'problem', reason: 'Starting from scratch failed. Try again.' };
    const importing = jobs.some(job => job.repoId === repoId && job.status !== 'completed');
    // A history import keeps reading with automatic checks off, so it is not paused.
    if (!automatic && !importing && !own.some(stream => stream.manual)) return { state: 'paused', ...since };
    const failing = own.find(
      ({ error, failures = 0 }) => error && error.code !== 'THROTTLED' && (failures >= 2 || LASTING.has(error.code)),
    );
    if (failing?.error) return { state: 'problem', reason: plainReason(failing.error, failing.stream), stream: failing.stream, ...since };
    const failingImport = jobs.find(
      ({ repoId: id, status, error, failures = 0 }) =>
        id === repoId && status !== 'completed' && error && error.code !== 'THROTTLED' && (failures >= 2 || LASTING.has(error.code)),
    );
    if (failingImport?.error)
      return { state: 'problem', reason: plainReason(failingImport.error, failingImport.stream ?? 'history'), stream: 'history', ...since };
    // The read succeeded but left out records Azure returned in a shape this version cannot read, so it is not synced.
    const warned = own.find(stream => stream.warning);
    if (warned?.warning) return { state: 'problem', reason: warned.warning.message, stream: warned.stream, ...since };
    // The shared queue starts no read for any repository until Azure DevOps's requested wait has passed.
    if (time(throttledUntil ?? undefined) > now) return { state: 'delayed', reason: 'Azure DevOps asked us to slow down', ...since };
    const behind = own.find(stream => behindBy(stream) !== null);
    if (behind) {
      const ms = Number(behindBy(behind));
      const reason = Number.isFinite(ms) ? behindText(ms) : 'Checks are behind schedule';
      return { state: 'delayed', reason, stream: behind.stream, ...since };
    }
    // A stale read that got here is still inside the grace period above, so it is catching up.
    const working = own.some(stream => !stream.initialized || stream.pending || stream.cursor || stream.manual || stale(stream));
    const busy = inProgress.some(entry => entry.repoId === repoId);
    if (!own.length || importing || working || busy) return { state: 'syncing', ...since };
    return { state: 'synced', ...since, ...fresh };
  }

  const statuses: Record<string, SyncStatus> = {};
  for (const repo of repos) if (!repo.disabled) statuses[repo.id] = repoStatus(repo.id);
  let overall: OverallSyncStatus =
    worstStatus(Object.entries(statuses).map(([repoId, status]) => ({ ...status, repoId }))) ??
    // With no enabled repository a failed reset has no repository to report it, so the overall status does.
    (resetFailed ? { state: 'problem', reason: 'Starting from scratch failed. Try again.' } : { state: 'empty' });
  if (backgroundProblem && !resetting && !resetFailed) overall = { state: 'problem', reason: backgroundProblem };
  if (overall.state === 'synced') {
    const checks = Object.values(statuses)
      .map(status => time(status.lastCheck))
      .filter(Number.isFinite);
    if (checks.length) overall = { ...overall, lastCheck: new Date(Math.max(...checks)).toISOString() };
  }
  return { overall, repos: statuses };
}
