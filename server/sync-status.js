// @ts-check

import { worstStatus } from '../src/sync-worst.js';

/** @typedef {import('./sync.js').StreamState} StreamState */
/** @typedef {'paused'|'problem'|'delayed'|'syncing'|'synced'} SyncState */
/**
 * `since` is the oldest last success across the repository's streams, absent until every stream has read once.
 * @typedef {{ state: SyncState, reason?: string, since?: string, lastCheck?: string, stream?: StreamState['stream'] | 'history' }} SyncStatus
 */
/** @typedef {(SyncStatus & { repoId: string }) | { state: 'empty' }} OverallSyncStatus */
/**
 * @typedef {{
 *   repos: { id: string, disabled?: boolean }[],
 *   streams: StreamState[],
 *   jobs: (Pick<import('./backfill.js').HistoryJob, 'repoId'|'status'> & Partial<Pick<import('./backfill.js').HistoryJob, 'failures'|'error'|'stream'>>)[],
 *   inProgress: { repoId: string, stream: string }[],
 *   settings: { refreshEnabled: boolean, refreshResumedAt: number | null },
 *   startedAt: number,
 *   now: number,
 *   demo?: boolean,
 *   throttledUntil?: string | null,
 *   resetting?: boolean,
 *   resetFailed?: boolean,
 * }} SyncStatusInput
 */

const MINUTE = 60000;
const HOUR = 60 * MINUTE;
const LATE = 3 * MINUTE;
// A retry cannot fix these, so they count from the first failure.
const LASTING = new Set(['AUTH_REQUIRED', 'FORBIDDEN', 'CLI_MISSING', 'CLI_SETUP']);

/** @type {Record<StreamState['stream'] | 'history', string>} */
const READS = {
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
 * @param {{ code: string, message: string }} error @param {StreamState['stream'] | 'history'} stream
 */
function plainReason(error, stream) {
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
/** @param {number} ms */
function behindText(ms) {
  const [count, unit] =
    ms < 120 * MINUTE
      ? [Math.max(1, Math.round(ms / MINUTE)), 'minute']
      : ms < 48 * HOUR
        ? [Math.round(ms / HOUR), 'hour']
        : [Math.round(ms / (24 * HOUR)), 'day'];
  return `about ${count} ${unit}${count === 1 ? '' : 's'} behind`;
}

/** @param {StreamState} stream */
const overdueAfter = stream => (stream.stream === 'refs' ? 20 : 10) * MINUTE;
/** NaN when absent. @param {string | undefined} value */
const time = value => Date.parse(value ?? '');

/**
 * One status per enabled repository, first matching rule wins; overall is the worst of them.
 * @param {SyncStatusInput} input
 * @returns {{ overall: OverallSyncStatus, repos: Record<string, SyncStatus> }}
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
}) {
  const automatic = settings.refreshEnabled !== false;
  const ranSince = Math.max(startedAt, settings.refreshResumedAt ?? 0);
  /** @param {StreamState} stream */
  const stale = stream => automatic && now - time(stream.lastSuccess) > overdueAfter(stream);
  /** @param {StreamState} stream */
  const graceOver = stream => now - ranSince > overdueAfter(stream);
  // Every stream is overdue right after a start or resume; the first minutes are catch-up, after which lateness counts from nextAt.
  const catchingUp = now - ranSince <= LATE;
  /** How far behind a stream is, null when it is not, NaN when throttled before any success. @param {StreamState} stream @returns {number | null} */
  function behindBy(stream) {
    const age = now - time(stream.lastSuccess);
    if (stream.error?.code === 'THROTTLED' || (stale(stream) && graceOver(stream))) return age;
    const lateness = now - time(stream.nextAt);
    return (automatic || stream.manual) && !catchingUp && lateness > LATE ? lateness : null;
  }

  /** @param {string} repoId @returns {SyncStatus} */
  function repoStatus(repoId) {
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

  /** @type {Record<string, SyncStatus>} */
  const statuses = {};
  for (const repo of repos) if (!repo.disabled) statuses[repo.id] = repoStatus(repo.id);
  /** @type {OverallSyncStatus} */
  let overall = worstStatus(Object.entries(statuses).map(([repoId, status]) => ({ ...status, repoId }))) ?? { state: 'empty' };
  if (overall.state === 'synced') {
    const checks = Object.values(statuses)
      .map(status => time(status.lastCheck))
      .filter(Number.isFinite);
    if (checks.length) overall = { ...overall, lastCheck: new Date(Math.max(...checks)).toISOString() };
  }
  return { overall, repos: statuses };
}
