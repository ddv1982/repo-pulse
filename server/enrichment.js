import { classifyMergeEvidence, mergeUpdates } from './merge-evidence.js';

const iso = value => new Date(value).toISOString();
const unique = values => [...new Set(values.filter(Boolean))];
const failure = (code, message) => Object.assign(new Error(message), { code });
const EVIDENCE_VERSION = 2;

/** Durable, low-priority semantic work. Each tick performs one page or a tiny hydration batch. */
export function createEnrichment({ store, provider, now = Date.now, negativeTtlMs = 300000, positiveTtlMs = 900000 } = {}) {
  let active, lastJob;
  const available = repoId => store.listRepos().some(repo => repo.id === repoId && !repo.disabled);
  const commit = (repoId, id) => store.getEntity(repoId, 'commit', id);
  const records = job => (job.commitIds || []).map(id => commit(job.repoId, id)).filter(Boolean);
  function cacheEntries(repoId, items) {
    if (items.some(item => !item?.commitId)) throw failure('INVALID_RESPONSE', 'Some commit identities are unavailable.');
    return items.map(item => {
      const previous = commit(repoId, item.commitId);
      return {
        type: 'commit',
        id: item.commitId,
        data: Array.isArray(previous?.parents) && !Array.isArray(item.parents) ? { ...item, ...previous } : { ...previous, ...item },
      };
    });
  }
  function graphRecords(repo, event, introduced) {
    const graph = new Map(introduced.map(item => [item.commitId, item]));
    const pending = mergeUpdates(event).flatMap(ref => [ref.oldObjectId, ref.newObjectId]);
    const visited = new Set();
    while (pending.length) {
      const id = pending.pop();
      if (visited.has(id)) continue;
      visited.add(id);
      const item = graph.get(id) || commit(repo.id, id);
      if (!item) continue;
      graph.set(id, item);
      if (Array.isArray(item.parents)) pending.push(...item.parents);
    }
    return [...graph.values()];
  }
  function partial(repo, event, job) {
    const introduced = records(job);
    const evidence = classifyMergeEvidence(repo, event, introduced, [], {
      checkedAt: iso(now()),
      complete: false,
      graphRecords: graphRecords(repo, event, introduced),
      refRanges: job.refRanges || [],
      limitations: ['Merge enrichment is still in progress.'],
    });
    // The latest page's cache writes share this transaction, so its objects may not
    // yet be readable above. Its IDs are nevertheless known and must be searchable.
    return {
      ...evidence,
      evidenceVersion: EVIDENCE_VERSION,
      candidateCommitIds: job.commitIds || [],
      candidateCommitCount: (job.commitIds || []).length,
      introducedCommitsComplete: Boolean(job.rangesComplete && ['hydrate', 'prs'].includes(job.stage)),
    };
  }
  function saveStep(repo, event, job, entities = []) {
    const previous = event.data?.mergeEvidence;
    const progress = partial(repo, event, job);
    // Previously established positive evidence remains visible while a refresh is incomplete.
    if (!progress.prs.length && previous?.prs?.length) progress.prs = previous.prs;
    if (!progress.commits.length && previous?.commits?.length) progress.commits = previous.commits;
    store.commitEnrichment({
      jobId: job.id,
      eventId: event.id,
      data: { mergeEvidence: { ...progress, status: 'enriching' } },
      entities,
      job: { ...job, status: 'enriching', nextAt: iso(now()), error: null },
    });
  }
  async function runStep() {
    const priority = event => (!event ? -1 : event.imported ? 2 : event.seen ? 1 : 0);
    const ranked = store
      .listJobs({ type: 'merge', dueBefore: iso(now()) })
      .filter(job => available(job.repoId))
      .map(job => ({ job, event: store.getEvent(job.eventId) }))
      .sort(
        (a, b) =>
          priority(a.event) - priority(b.event) ||
          (Date.parse(b.event?.time) || 0) - (Date.parse(a.event?.time) || 0) ||
          a.job.id.localeCompare(b.job.id),
      );
    const due = ranked.filter(item => priority(item.event) === priority(ranked[0]?.event)).map(item => item.job);
    if (!due.length) return false;
    const index = due.findIndex(job => job.id === lastJob);
    const job = due[(index + 1) % due.length];
    lastJob = job.id;
    const event = store.getEvent(job.eventId);
    if (!event) {
      store.removeJob(job.id);
      return true;
    }
    await advance(store.getRepo(job.repoId), event, job);
    return true;
  }
  async function advance(repo, event, job) {
    try {
      if (!mergeUpdates(event).length) {
        store.commitEnrichment({
          jobId: job.id,
          eventId: event.id,
          data: { mergeEvidence: classifyMergeEvidence(repo, event, [], [], { checkedAt: iso(now()) }) },
        });
        return;
      }
      const stage = job.stage || 'commits';
      if (['hydrate', 'prs'].includes(stage) && !job.rangesComplete) {
        saveStep(repo, event, {
          ...job,
          stage: 'ranges',
          refIndex: 0,
          refCursor: null,
          refRanges: [],
          commitIds: unique([...(job.commitIds || []), ...mergeUpdates(event).map(ref => ref.newObjectId)]),
          prSnapshots: undefined,
        });
        return;
      }
      if (stage === 'commits') {
        if (!event.data?.pushId) throw failure('EVIDENCE_UNAVAILABLE', 'The push identity is unavailable for commit enrichment.');
        const page = await provider.pushCommits(repo, event.data.pushId, job.cursor || {});
        if (!available(repo.id) || !store.getEvent(event.id)) return;
        if (!Array.isArray(page?.items)) throw failure('INVALID_RESPONSE', 'Pushed commit data is unavailable.');
        const entities = cacheEntries(repo.id, page.items);
        const next = {
          ...job,
          stage: page.nextCursor ? 'commits' : 'ranges',
          cursor: page.nextCursor || null,
          ...(!page.nextCursor ? { refIndex: 0, refCursor: null, refRanges: [], rangesComplete: false, prSnapshots: undefined } : {}),
          commitIds: unique([
            ...(job.commitIds || []),
            ...page.items.map(item => item.commitId),
            ...mergeUpdates(event).map(ref => ref.newObjectId),
          ]),
        };
        saveStep(repo, event, next, entities);
        return;
      }
      if (stage === 'ranges') {
        const refs = mergeUpdates(event),
          index = job.refIndex || 0,
          ref = refs[index];
        if (!ref) {
          saveStep(repo, event, { ...job, stage: 'hydrate', rangesComplete: true });
          return;
        }
        const page = await provider.refCommits(repo, ref.oldObjectId, ref.newObjectId, job.refCursor || {});
        if (!available(repo.id) || !store.getEvent(event.id)) return;
        if (!Array.isArray(page?.items)) throw failure('INVALID_RESPONSE', 'Branch revision-range data is unavailable.');
        const entities = cacheEntries(repo.id, page.items);
        const ranges = [...(job.refRanges || [])];
        ranges[index] = {
          name: ref.name,
          oldObjectId: ref.oldObjectId,
          newObjectId: ref.newObjectId,
          commitIds: unique([...(ranges[index]?.commitIds || []), ...page.items.map(item => item.commitId)]),
          complete: !page.nextCursor,
        };
        const nextIndex = page.nextCursor ? index : index + 1;
        const complete = nextIndex >= refs.length;
        saveStep(
          repo,
          event,
          {
            ...job,
            stage: complete ? 'hydrate' : 'ranges',
            refIndex: nextIndex,
            refCursor: page.nextCursor || null,
            refRanges: ranges,
            rangesComplete: complete,
            commitIds: unique([...(job.commitIds || []), ...page.items.map(item => item.commitId), ref.newObjectId]),
          },
          entities,
        );
        return;
      }
      if (stage === 'hydrate') {
        const ids = unique([...(job.commitIds || []), ...mergeUpdates(event).flatMap(ref => [ref.oldObjectId, ref.newObjectId])]);
        const missing = ids.filter(id => !Array.isArray(commit(repo.id, id)?.parents)).slice(0, 2);
        if (!missing.length) {
          saveStep(repo, event, { ...job, stage: 'prs' });
          return;
        }
        const hydrated = await provider.commitsByIds(repo, missing);
        if (!available(repo.id) || !store.getEvent(event.id)) return;
        if (!Array.isArray(hydrated) || missing.some(id => !hydrated.some(item => item.commitId === id && Array.isArray(item.parents)))) {
          throw failure('EVIDENCE_UNAVAILABLE', 'Some commit parent objects are unavailable; merge coverage is incomplete.');
        }
        saveStep(
          repo,
          event,
          job,
          hydrated.map(item => ({ type: 'commit', id: item.commitId, data: item })),
        );
        return;
      }
      if (stage !== 'prs') throw failure('INVALID_JOB', 'Merge enrichment could not resume its saved stage.');
      const ids = job.commitIds || [];
      // A bounded job checks each commit once. Earlier batches may expire while the
      // shared request queue is processing later ones; that must not restart this job.
      const snapshots = { ...job.prSnapshots };
      for (const id of ids) {
        if (snapshots[id]) continue;
        const found = store.getEntity(repo.id, 'commit-pr', id);
        if (Array.isArray(found?.associations) && Date.parse(found.expiresAt) > now()) snapshots[id] = found;
      }
      const stale = ids.filter(id => !snapshots[id]).slice(0, 25);
      if (stale.length) {
        const associations = await provider.queryPullRequests(repo, stale);
        if (!available(repo.id) || !store.getEvent(event.id)) return;
        if (!Array.isArray(associations)) throw failure('INVALID_RESPONSE', 'Pull request associations are unavailable.');
        const entities = stale.map(id => {
          const matches = associations.filter(item => item.commitId === id);
          return {
            type: 'commit-pr',
            id,
            data: {
              associations: matches,
              checkedAt: iso(now()),
              expiresAt: iso(now() + (matches.length ? positiveTtlMs : negativeTtlMs)),
            },
          };
        });
        for (const entity of entities) snapshots[entity.id] = entity.data;
        saveStep(repo, event, { ...job, prSnapshots: snapshots }, entities);
        return;
      }
      const caches = ids.map(id => snapshots[id]);
      const introduced = records(job);
      const evidence = classifyMergeEvidence(
        repo,
        event,
        introduced,
        caches.flatMap(item => item.associations || []),
        {
          checkedAt: iso(now()),
          associationExpiresAt: caches.length ? iso(Math.min(...caches.map(item => Date.parse(item.expiresAt)))) : undefined,
          graphRecords: graphRecords(repo, event, introduced),
          refRanges: job.refRanges || [],
        },
      );
      evidence.evidenceVersion = EVIDENCE_VERSION;
      evidence.candidateCommitCount = ids.length;
      evidence.introducedCommitsComplete = true;
      store.commitEnrichment({ jobId: job.id, eventId: event.id, data: { mergeEvidence: evidence } });
    } catch (error) {
      if (!available(repo.id) || !store.getEvent(event.id)) return;
      const attempts = (job.attempts || 0) + 1;
      const safe = {
        code: error.code || 'ENRICHMENT_FAILED',
        message: error.code ? error.message : 'Merge evidence could not be read. Retrying later.',
      };
      const previous = store.getEvent(event.id).data?.mergeEvidence || partial(repo, event, job);
      store.commitEnrichment({
        jobId: job.id,
        eventId: event.id,
        data: {
          mergeEvidence: {
            ...previous,
            status: 'partial',
            error: safe,
            checkedAt: iso(now()),
            limitations: unique([...(previous.limitations || []), safe.message]),
          },
        },
        job: {
          ...job,
          status: 'retrying',
          error: safe,
          attempts,
          nextAt: iso(now() + Math.min(1800000, 60000 * 2 ** Math.min(attempts - 1, 5))),
        },
      });
    }
  }
  return {
    tick() {
      if (!active)
        active = runStep().finally(() => {
          active = null;
        });
      return active;
    },
    status() {
      return { running: Boolean(active), ...store.mergeQueueSummary() };
    },
    reconcilePr(repo, input) {
      const pr = input.data || input;
      if (pr.status !== 'completed') return { scheduled: 0 };
      const ids = unique([pr.mergeCommit, pr.sourceCommit, pr.lastMergeCommit?.commitId, pr.lastMergeSourceCommit?.commitId]);
      const target = pr.targetRefName;
      if (!ids.length || !target) return { scheduled: 0 };
      const pushes = store.findPushEventsForCommits(repo.id, ids, target);
      for (const event of pushes) {
        const metadata = event.data?.mergeEvidence;
        const introduced = metadata?.candidateCommitIds || metadata?.introducedCommitIds || [];
        const existing = store.listJobs({ type: 'merge', repoId: repo.id }).find(job => job.eventId === event.id);
        const known = unique([...introduced, ...(existing?.commitIds || []), ...ids]);
        const entities = known.map(id => ({
          type: 'commit-pr',
          id,
          data: { ...(store.getEntity(repo.id, 'commit-pr', id) || {}), expiresAt: iso(0) },
        }));
        // Completion evidence invalidates PR matches, not unfinished commit paging
        // or parent hydration. Only a fully listed finished operation can jump to PRs.
        const finished = metadata?.introducedCommitsComplete && metadata?.evidenceVersion === EVIDENCE_VERSION;
        const stage = existing ? existing.stage || 'commits' : finished ? 'prs' : 'commits';
        const commitIds = existing ? existing.commitIds : stage === 'prs' ? introduced : undefined;
        store.commitPage({
          repoId: repo.id,
          entities,
          jobs: [
            {
              ...existing,
              id: `merge:${event.id}`,
              type: 'merge',
              repoId: repo.id,
              eventId: event.id,
              stage,
              commitIds,
              ...(!existing && finished ? { rangesComplete: true, refRanges: metadata.refRanges } : {}),
              prSnapshots: undefined,
              status: 'pending',
              error: null,
              nextAt: iso(now()),
            },
          ],
        });
      }
      return { scheduled: pushes.length };
    },
  };
}
