// @ts-check

/** @typedef {import('./azure-client.js').AzureProvider} AzureProvider */
/** @typedef {import('../src/activity.ts').ForkOrigin} ForkOrigin */
/**
 * One live branch creation, checked for the commit it started from and the branch that held it. Until `base` is known,
 * `at` is the commit to read next and `reads` counts the commit reads so far. `checks` are the candidate branches
 * still to test with the tip each had before the creating push.
 * @typedef {{ id: string, type: 'fork', repoId: string, eventId: string, ref: string, pushId: number, at: string,
 *   reads: number, attempts: number, nextAt: string, base?: string, checks?: { ref: string, tip: string }[],
 *   on?: string[], notOn?: string[], unanswered?: string[] }} ForkJob
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
 * The check for one push branch creation, or null when the row cannot be checked (no full ref or created tip).
 * @param {{ id: string, repoId: string, kind: string, observedAt: string, data?: { evidence?: string, name?: string,
 *   newObjectId?: string, pushId?: number | string } }} event
 * @returns {ForkJob | null}
 */
export function forkJob(event) {
  const { evidence, name, newObjectId, pushId } = event.data ?? {};
  if (event.kind !== 'branch-created' || evidence !== 'push' || typeof name !== 'string') return null;
  if (typeof newObjectId !== 'string' || !/^[0-9a-f]{40}$/i.test(newObjectId) || /^0+$/.test(newObjectId)) return null;
  if (!Number.isSafeInteger(Number(pushId)) || Number(pushId) <= 0) return null;
  return {
    id: `fork:${event.id}`,
    type: 'fork',
    repoId: event.repoId,
    eventId: event.id,
    ref: name,
    pushId: Number(pushId),
    at: newObjectId.toLowerCase(),
    reads: 0,
    attempts: 0,
    nextAt: event.observedAt,
  };
}

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
    // Nothing the base reaches is missing from the candidate's tip, so the candidate already held the base.
    const page = await provider.droppedCommits(repo, job.base, (job.checks ?? [])[0].tip);
    return answer(job, page.items.length ? 'notOn' : 'on');
  }

  /**
   * Files the current candidate under its answer and moves to the next one, or settles once none is left. A candidate
   * whose read failed is `unanswered`, so a single match next to it is not called the only one.
   * @param {ForkJob} job @param {'on' | 'notOn' | 'unanswered'} list @returns {ForkJob | ForkOrigin}
   */
  function answer(job, list) {
    const [check, ...rest] = job.checks ?? [];
    const next = { ...job, checks: rest, [list]: [...(job[list] ?? []), check.ref] };
    if (rest.length) return next;
    const base = /** @type {string} */ (job.base),
      { on = [], notOn = [], unanswered = [] } = next;
    const extra = unanswered.length ? { unanswered } : {};
    return on.length ? { status: 'found', base, on, via: 'contained', notOn, ...extra } : { status: 'none', base, notOn, ...extra };
  }

  /** @returns {Promise<boolean>} whether a check ran */
  async function tick() {
    // Tips are matched against stored pushes. While a push window is still paging, a creation inside it may have older
    // pushes still to come, so a check that has not matched tips yet waits.
    /** @type {Map<string, number>} */
    const reading = new Map(
      store
        .getStreams()
        .flatMap(state => (state.stream === 'pushes' && state.window ? [[state.repoId, Date.parse(state.window.since)]] : [])),
    );
    /** @param {ForkJob} job */
    const waits = job => {
      if (job.base || !reading.has(job.repoId)) return false;
      const time = Date.parse(store.getEvent(job.eventId)?.time ?? '');
      return !(time < /** @type {number} */ (reading.get(job.repoId)));
    };
    const repos = new Map(
      store
        .listRepos()
        .filter(repo => !repo.disabled)
        .map(repo => [repo.id, repo]),
    );
    // Rows of type 'fork' are only written by server/normalize.js and this check, as a ForkJob.
    const jobs = /** @type {ForkJob[]} */ (/** @type {unknown} */ (store.listJobs({ type: 'fork', dueBefore: iso(now()) })));
    const job = jobs.find(item => repos.has(item.repoId) && !((deferred.get(item.id)?.at ?? 0) > now()) && !waits(item));
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
        next = job.base ? answer(job, 'unanswered') : { status: 'unknown' };
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
