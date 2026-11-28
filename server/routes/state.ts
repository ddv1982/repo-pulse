import { invalid, notFound } from '../errors.ts';
import { isCorruptRow, refreshEnabled } from '../store-records.ts';
import { syncStatus } from '../sync-status.ts';
import { addDemoEvent } from '../demo.ts';
import type { Handlers } from '../http.ts';
import type { AppContext } from './context.ts';
import type { StateResponse } from '../../src/contract.ts';

const isStringList = (value: unknown): value is string[] => Array.isArray(value) && value.every(item => typeof item === 'string');

/** The page state, refresh, Start from scratch, the refresh setting, and demo mode's incoming event. */
export function stateRoutes({ store, sync, cli, historyImporter, demo, savedFilters, onStateRead, startedAt, reset }: AppContext) {
  return {
    'GET /api/state': () => {
      onStateRead();
      const status = sync.status();
      const repos = store.listRepos();
      const streams = store.getStreams();
      let backgroundProblem = status.backgroundProblems.history ?? status.backgroundProblems.rewrite;
      let jobs: StateResponse['jobs'] = [];
      try {
        jobs = store.listJobs({ type: 'backfill' });
      } catch (error) {
        if (!isCorruptRow(error)) throw error;
        // Keep state readable so the Activity banner can explain why history progress is unavailable.
        backgroundProblem = error.message;
      }
      const settings = {
        refreshEnabled: refreshEnabled(store),
        refreshResumedAt: store.getSetting('refreshResumedAt', null),
      };
      const diagnostics = { ...(cli?.diagnostics() || {}), sync: status };
      return {
        repos,
        streams: streams.map(({ repoId, stream, initialized, lastSuccess, error, warning }) => ({
          repoId,
          stream,
          initialized,
          lastSuccess,
          ...(error === undefined ? {} : { error }),
          warning,
        })),
        diagnostics,
        jobs,
        activityRevision: store.activityRevision(),
        savedFilters: savedFilters.list(),
        settings,
        syncStatus: syncStatus({
          repos,
          streams,
          jobs,
          inProgress: status.inProgress,
          settings,
          startedAt,
          now: Date.now(),
          demo,
          throttledUntil: diagnostics.throttledUntil,
          resetting: reset.running,
          resetFailed: reset.failed,
          backgroundProblem,
        }),
        demo,
      };
    },
    'POST /api/refresh': ({ body }) => {
      const { repoIds, retrySignIn } = body;
      if (repoIds !== undefined && !isStringList(repoIds)) throw invalid('repoIds must be a list.');
      if (retrySignIn !== undefined && typeof retrySignIn !== 'boolean') throw invalid('retrySignIn must be a boolean.');
      repoIds?.forEach(store.getRepo);
      const status = retrySignIn ? sync.refresh(repoIds, true) : sync.refresh(repoIds);
      const history = retrySignIn
        ? historyImporter?.retrySignIn?.(
            store
              .listRepos()
              .filter(repo => !repo.disabled && (!repoIds || repoIds.includes(repo.id)))
              .map(repo => repo.id),
          )
        : undefined;
      const combined = history?.scheduled
        ? { scheduled: true }
        : history?.cooldown && !status.scheduled
          ? { scheduled: false, cooldown: true }
          : status;
      return { ok: true, status: combined };
    },
    'POST /api/reset': () => {
      reset.start();
      return { started: true };
    },
    'PATCH /api/settings': ({ body }) => {
      if (typeof body.refreshEnabled !== 'boolean') throw invalid('refreshEnabled must be true or false.');
      if (body.refreshEnabled && !refreshEnabled(store)) {
        store.setSetting('refreshResumedAt', Date.now());
      }
      store.setSetting('refreshEnabled', body.refreshEnabled);
      return { ok: true };
    },
    'POST /api/demo/event': () => {
      // Live mode answers 404, as for a path no route matches.
      if (!demo) throw notFound('Demo activity can be added only in demo mode.');
      return addDemoEvent(store);
    },
  } satisfies Partial<Handlers>;
}
