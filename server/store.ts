import { createActivityQuery } from './activity-query.ts';
import { openStoreDb } from './store-db.ts';
import { createStoreState } from './store-state.ts';
import { createStoreEvents } from './store-events.ts';
import { createStoreLinks } from './store-links.ts';
import { createStoreQueries } from './store-queries.ts';
import { migrate } from './store-migrations.ts';
import type { ActivityEvent, ForkOrigin, MergeEvidenceData, RewriteResult } from '../src/activity.ts';
import type { Repository, StreamState, AzureStream as StreamName } from '../src/contract.ts';
import type { Entity, Job } from './store-records.ts';
import { conflict, invalid } from './errors.ts';

export type Store = ReturnType<typeof createStore>;

/**
 * SQLite owns durable events, cursor transactions and indexed view-only activity membership. The store composes its
 * modules over one connection: state (repositories, streams, entities, jobs, settings), events, links between pushes
 * and pull requests, read-model queries, and the migration runner. Every write below is one transaction.
 */
export function createStore(path = ':memory:', { highlights = false } = {}) {
  const conn = openStoreDb(path);
  const { db, transaction } = conn;
  const state = createStoreState(conn);
  const events = createStoreEvents(conn, state);
  const links = createStoreLinks(conn, events);
  const queries = createStoreQueries(conn, events, state);
  migrate(conn, { events, links, state });
  const { requireRepo, listRepos, bumpActivity } = state;
  const insertEvents = (list: ActivityEvent[]) => events.insert(list, links.linkInserted);

  // Returns the space deleted data held to the file system. VACUUM cannot run inside a transaction, and a failure
  // (for example a full disk) must not stop the app, so the pending flag keeps it for the next start.
  const compact = () => {
    if (!state.compactPending()) return;
    try {
      db.exec('VACUUM');
      // In WAL mode the space returns only once the checkpoint copies the vacuumed pages back; a reader can block it.
      if (path !== ':memory:' && db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get()?.busy) return;
      state.clearCompact();
    } catch {
      /* Retried on the next start. */
    }
  };
  compact();
  const queryActivity = createActivityQuery(db, events.hydrate, requireRepo, state.activityRevision, state.ciSeenRevision, highlights);

  return {
    activityRevision: state.activityRevision,
    listRepos,
    getRepo: requireRepo,
    /** The watched repository, refused while it is disabled: reads and actions on it wait until it is enabled. */
    getEnabledRepo(id: string) {
      const repo = requireRepo(id);
      if (repo.disabled) throw conflict('Repository is disabled. Enable it on Repositories first.');
      return repo;
    },
    enabledRepoIds: () =>
      listRepos()
        .filter(repo => !repo.disabled)
        .map(repo => repo.id),
    listBranches: queries.listBranches,
    saveRepo(repo: Repository) {
      if (!repo.id || !repo.name) throw invalid('Repository ID and name are required.');
      const old = state.findRepo(repo.id);
      const value = { disabled: false, ...old, ...repo };
      transaction(() => {
        state.writeRepo(value);
        if (old?.name !== value.name || old?.defaultBranch !== value.defaultBranch || Boolean(old?.disabled) !== Boolean(value.disabled))
          bumpActivity();
      });
      return value;
    },
    removeRepo(id: string) {
      requireRepo(id);
      transaction(() => {
        state.deleteRepo(id);
        bumpActivity();
        state.deleteRepoSettings(id);
      });
    },
    /**
     * Deletes everything sync and history import wrote, so the next sync is a first import from a new baseline.
     * Repositories, linked checkouts and app settings stay.
     */
    resetActivity() {
      transaction(() => {
        db.exec(`DELETE FROM push_tips; DELETE FROM enrichment; DELETE FROM activity_members; DELETE FROM events;
          DELETE FROM entities; DELETE FROM streams; DELETE FROM jobs;`);
        state.clearBaselines();
        bumpActivity();
        state.requestCompact();
      });
      compact();
    },
    listEvents: events.listEvents,
    queryActivity,
    commitActivity: queries.commitActivity,
    getEvent: events.getEvent,
    getEventGroup: events.getEventGroup,
    relatedActivity: queries.relatedActivity,
    completedCheckoutPulls: queries.completedCheckoutPulls,
    enrichEvent(id: string, data: unknown) {
      return transaction(() => events.enrich(id, data));
    },
    /** Marks these events seen or unseen; the route limits how many one request may name. */
    acknowledge(ids: string[], seen: boolean = true) {
      return transaction(() => events.acknowledge(ids, seen));
    },
    insertEvents(list: ActivityEvent[]) {
      return transaction(() => insertEvents(list));
    },
    getStreams: state.getStreams,
    saveStream: state.saveStream,
    getEntity: state.getEntity,
    listEntities: state.listEntities,
    /**
     * Sync pages carry their stream state; backfill pages carry none.
     */
    commitPage(
      this: void,
      {
        repoId,
        stream,
        state: streamState,
        events: pageEvents = [],
        entities = [],
        jobs = [],
      }: { repoId: string; events?: ActivityEvent[]; entities?: Entity[]; jobs?: Job[] } & (
        { stream: StreamName; state: StreamState } | { stream?: StreamName; state?: undefined }
      ),
    ) {
      return transaction(() => {
        requireRepo(repoId);
        insertEvents(pageEvents);
        state.saveEntities(repoId, entities);
        jobs.forEach(state.saveJob);
        if (streamState) state.saveStream({ ...streamState, repoId, stream });
      });
    },
    listJobs: state.listJobs,
    saveJob: state.saveJob,
    /**
     * Replaces the result for this ref and removes the job in one write, so a finished check is never run again.
     * A missing event (its repository was removed) only removes the job.
     */
    saveRewriteResult({ eventId, jobId, rewrite }: { eventId: string; jobId: string; rewrite: RewriteResult }) {
      transaction(() => {
        const event = events.getEvent(eventId);
        if (event) {
          const evidence = (event.data?.mergeEvidence || {}) as MergeEvidenceData;
          const results = [...(evidence.rewrite || []).filter(item => item.ref !== rewrite.ref), rewrite];
          events.enrich(eventId, { mergeEvidence: { ...evidence, rewrite: results } });
        }
        state.deleteJob(jobId);
      });
    },
    /**
     * Replaces the fork origin of a branch creation and removes its job in one write. A missing event (its repository
     * was removed) only removes the job.
     */
    saveForkResult({ eventId, jobId, forkOrigin }: { eventId: string; jobId: string; forkOrigin: ForkOrigin }) {
      transaction(() => {
        if (events.exists(eventId)) events.enrich(eventId, { forkOrigin });
        state.deleteJob(jobId);
      });
    },
    branchTipsBefore: queries.branchTipsBefore,
    forkCandidates: queries.forkCandidates,
    getSetting: state.getSetting,
    setSetting: state.setSetting,
    getBaseline: state.getBaseline,
    setBaseline: state.setBaseline,
    getCheckoutObservation: state.getCheckoutObservation,
    saveCheckoutObservation: state.saveCheckoutObservation,
    getCheckoutFollowup: state.getCheckoutFollowup,
    saveCheckoutFollowup: state.saveCheckoutFollowup,
    close: conn.close,
  };
}
