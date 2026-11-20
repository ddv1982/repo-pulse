// @ts-check

/** @typedef {import('./azure-client.js').AzureProvider} AzureProvider */
/** @typedef {import('../src/activity.js').ForkOrigin} ForkOrigin */
/**
 * One live branch creation, checked for the commit it started from and the branch that held it. Until `base` is known,
 * `at` is the commit to read next and `reads` counts the commit reads so far. `checks` are the candidate branches
 * still to test with the tip each had before the creating push.
 * @typedef {{ id: string, type: 'fork', repoId: string, eventId: string, ref: string, pushId: number, at: string,
 *   reads: number, attempts: number, nextAt: string, base?: string, checks?: { ref: string, tip: string }[],
 *   on?: string[], notOn?: string[] }} ForkJob
 */
/**
 * @typedef {Pick<ReturnType<typeof import('./store.js').createStore>,
 *   'listRepos'|'listJobs'|'saveJob'|'getEvent'|'saveForkResult'|'branchTipsBefore'|'forkCandidates'|'getStreams'>} ForkStore
 */

const ATTEMPTS = 4;
const RETRY_MS = 60000;
/** Commit reads that may walk back through the commits the creating push brought. */
export const MAX_READS = 8;
/** Candidate branches tested for containing the base, one read each. */
export const MAX_CHECKS = 3;
/** @param {number} ms */
const iso = ms => new Date(ms).toISOString();

/**
 * Each tick runs at most one Azure call for one due job.
 * @param {{ store: ForkStore, provider: Pick<AzureProvider, 'commit'|'droppedCommits'>, now?: () => number }} options
 */
export function createForkOriginCheck({ store, provider, now = Date.now }) {
  /** A finished check whose result could not be stored waits here, like the rewrite check. @type {Map<string, { at: number, result?: ForkOrigin }>} */
  const deferred = new Map();

  /**
   * The base is known: a branch whose latest recorded tip was the base settles it with no call; otherwise the
   * candidates with a recorded tip become checks.
   * @param {ForkJob} job @param {string} base @returns {ForkJob | ForkOrigin}
   */
  function fromBase(job, base) {
    const tips = store.branchTipsBefore(job.repoId, job.pushId);
    tips.delete(job.ref);
    const on = [...tips].filter(([, tip]) => tip === base).map(([ref]) => ref);
    if (on.length) return { status: 'found', base, on: on.sort(), via: 'tip' };
    const checks = store
      .forkCandidates(job.repoId, job.ref)
      .filter(ref => tips.has(ref))
      .slice(0, MAX_CHECKS)
      .map(ref => ({ ref, tip: /** @type {string} */ (tips.get(ref)) }));
    if (!checks.length) return { status: 'none', base, notOn: [] };
    return { ...job, base, checks, on: [], notOn: [] };
  }

  /** @param {ForkJob} job @param {import('./azure-client.js').AzureRepo} repo @returns {Promise<ForkJob | ForkOrigin>} */
  async function step(job, repo) {
    if (!job.base) {
      const commit = await provider.commit(repo, job.at);
      // The first commit an earlier push brought is where the branch started. Without a push order there is no base.
      if (commit.pushId === null || commit.pushId > job.pushId) return { status: 'unknown' };
      if (commit.pushId < job.pushId) return fromBase(job, job.at);
      if (commit.parents.length === 0) return { status: 'orphan' };
      if (commit.parents.length > 1) return { status: 'merge' };
      if (job.reads + 1 >= MAX_READS) return { status: 'unknown' };
      return { ...job, at: commit.parents[0], reads: job.reads + 1 };
    }
    const [check, ...rest] = job.checks ?? [];
    // Nothing the base reaches is missing from the candidate's tip, so the candidate already held the base.
    const page = await provider.droppedCommits(repo, job.base, check.tip);
    const on = [...(job.on ?? [])],
      notOn = [...(job.notOn ?? [])];
    (page.items.length ? notOn : on).push(check.ref);
    if (rest.length) return { ...job, checks: rest, on, notOn };
    return settle({ ...job, on, notOn });
  }

  /** The claim the finished checks support. A failed check keeps the base and the candidates already answered. @param {ForkJob} job @returns {ForkOrigin} */
  function settle(job) {
    const base = /** @type {string} */ (job.base),
      on = job.on ?? [],
      notOn = job.notOn ?? [];
    return on.length ? { status: 'found', base, on, via: 'contained', notOn } : { status: 'none', base, notOn };
  }

  /** @returns {Promise<boolean>} whether a check ran */
  async function tick() {
    // Tips are matched against stored pushes, so a repository whose push stream is still paging through a window waits.
    const reading = new Set(
      store
        .getStreams()
        .filter(state => state.stream === 'pushes' && state.window)
        .map(state => state.repoId),
    );
    const repos = new Map(
      store
        .listRepos()
        .filter(repo => !repo.disabled && !reading.has(repo.id))
        .map(repo => [repo.id, repo]),
    );
    // Rows of type 'fork' are only written by server/normalize.js and this check, as a ForkJob.
    const jobs = /** @type {ForkJob[]} */ (/** @type {unknown} */ (store.listJobs({ type: 'fork', dueBefore: iso(now()) })));
    const job = jobs.find(item => repos.has(item.repoId) && !((deferred.get(item.id)?.at ?? 0) > now()));
    const repo = job && repos.get(job.repoId);
    if (!job || !repo) return false;
    /** @type {ForkJob | ForkOrigin | undefined} */
    let next = deferred.get(job.id)?.result;
    if (!next)
      try {
        next = await step(job, repo);
      } catch (error) {
        const code = /** @type {{ code?: unknown }} */ (error)?.code;
        if (code === 'CLOSED') return true;
        const attempts = job.attempts + 1;
        if (code !== 'NOT_FOUND' && attempts < ATTEMPTS) {
          try {
            if (store.getEvent(job.eventId)) store.saveJob({ ...job, attempts, nextAt: iso(now() + RETRY_MS * 2 ** (attempts - 1)) });
          } catch {
            deferred.set(job.id, { at: now() + RETRY_MS });
          }
          return true;
        }
        next = job.base ? settle(job) : { status: 'unknown' };
      }
    if ('type' in next) {
      // A later step is due at once; a failed write repeats this step on a later tick.
      try {
        store.saveJob({ ...next, attempts: 0, nextAt: iso(now()) });
      } catch {
        deferred.set(job.id, { at: now() + RETRY_MS });
      }
      return true;
    }
    try {
      store.saveForkResult({ eventId: job.eventId, jobId: job.id, forkOrigin: next });
      deferred.delete(job.id);
    } catch {
      deferred.set(job.id, { at: now() + RETRY_MS, result: next });
    }
    return true;
  }
  return { tick, reset: () => deferred.clear() };
}
