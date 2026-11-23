export type AzureProvider = import('./azure-client.ts').AzureProvider;
/** One moved branch of a live push, checked once for commits the new tip no longer reaches. */
export type RewriteJob = {
  id: string;
  type: 'rewrite';
  repoId: string;
  eventId: string;
  ref: string;
  oldObjectId: string;
  newObjectId: string;
  attempts: number;
  nextAt: string;
};
export type RewriteResult = import('../src/activity.ts').RewriteResult;
export type RewriteStore = Pick<
  ReturnType<typeof import('./store.ts').createStore>,
  'listRepos' | 'listJobs' | 'saveJob' | 'getEvent' | 'saveRewriteResult'
>;

const ATTEMPTS = 4;
const RETRY_MS = 60000;
const iso = (ms: number) => new Date(ms).toISOString();

/**
 * Each tick runs at most one due check, so it is one Azure call.
 */
export function createRewriteCheck({
  store,
  provider,
  now = Date.now,
}: {
  store: RewriteStore;
  provider: Pick<AzureProvider, 'droppedCommits'>;
  now?: () => number;
}) {
  // A check whose result could not be stored waits here, since a database that refuses writes cannot reschedule it.
  const deferred: Map<string, { at: number; result?: RewriteResult }> = new Map();
  /** @returns whether a check ran */
  async function tick(): Promise<boolean> {
    const repos = new Map(
      store
        .listRepos()
        .filter(repo => !repo.disabled)
        .map(repo => [repo.id, repo]),
    );
    // Rows of type 'rewrite' are only written by server/normalize.ts, as a RewriteJob.
    const jobs = store.listJobs({ type: 'rewrite', dueBefore: iso(now()) }) as unknown as RewriteJob[];
    const job = jobs.find(item => repos.has(item.repoId) && !((deferred.get(item.id)?.at ?? 0) > now()));
    const repo = job && repos.get(job.repoId);
    if (!job || !repo) return false;
    // A result Azure already gave is only written again, never asked for again.
    let result = deferred.get(job.id)?.result;
    if (!result)
      try {
        const page = await provider.droppedCommits(repo, job.oldObjectId, job.newObjectId);
        result = page.items.length
          ? { ref: job.ref, status: 'rewrite', dropped: page.items.length, ...(page.nextCursor ? { more: true } : {}) }
          : { ref: job.ref, status: 'fast-forward' };
      } catch (error) {
        const code = (error as { code?: unknown })?.code;
        // Shutdown aborted the call, not Azure; the unchanged job resumes on the next start.
        if (code === 'CLOSED') return true;
        const attempts = job.attempts + 1;
        // A missing old tip cannot be read on a later attempt either.
        if (code !== 'NOT_FOUND' && attempts < ATTEMPTS) {
          try {
            // A repository removed during the call took its job and event with it.
            if (store.getEvent(job.eventId)) store.saveJob({ ...job, attempts, nextAt: iso(now() + RETRY_MS * 2 ** (attempts - 1)) });
          } catch {
            deferred.set(job.id, { at: now() + RETRY_MS });
          }
          return true;
        }
        result = { ref: job.ref, status: 'unknown' };
      }
    try {
      store.saveRewriteResult({ eventId: job.eventId, jobId: job.id, rewrite: result });
      deferred.delete(job.id);
    } catch {
      // Only Azure errors count as attempts, so a failed write never turns a proven result into unknown.
      deferred.set(job.id, { at: now() + RETRY_MS, result });
    }
    return true;
  }
  return {
    tick,
    // A reset deletes the jobs these waiting results belong to.
    reset: () => deferred.clear(),
  };
}
