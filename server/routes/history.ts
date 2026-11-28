import { conflict, invalid, notInDemo } from '../errors.ts';
import { NOT_IN_DEMO } from '../demo.ts';
import { withCommitActivity } from '../git-history.ts';
import type { Handlers } from '../http.ts';
import type { AppContext } from './context.ts';

/** Imports of older Azure activity, and the local Git history the graph shows. */
export function historyRoutes({ store, historyImporter, checkoutGit, reset }: AppContext) {
  return {
    'POST /api/repos/:id/backfill': ({ params: { id }, body }) => {
      if (!historyImporter) throw notInDemo(NOT_IN_DEMO['POST /api/repos/:id/backfill']);
      const repo = store.getRepo(id);
      const days = body.days;
      if (days !== 30 && days !== 90 && days !== 'all') throw invalid('Choose 30 days, 90 days or all available history.');
      // Checked after the body arrives: the reset would delete the job this request creates.
      if (reset.running) throw conflict('Starting from scratch is in progress. Try again in a moment.');
      return historyImporter.start(repo.id, days);
    },
    'GET /api/repos/:id/graph': async ({ params: { id }, query }) => {
      const repo = store.getEnabledRepo(id);
      const page = await checkoutGit.history(repo, query.get('cursor'));
      return withCommitActivity(
        page,
        store.commitActivity(
          repo.id,
          page.commits.map(commit => commit.id),
        ),
      );
    },
    'GET /api/repos/:id/graph/snapshot': async ({ params: { id } }) => {
      const repo = store.getEnabledRepo(id);
      return await checkoutGit.historySnapshot(repo);
    },
  } satisfies Partial<Handlers>;
}
