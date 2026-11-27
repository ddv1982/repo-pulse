import { conflict, invalid, notFound } from '../errors.ts';
import { withCommitActivity } from '../git-history.ts';
import type { Handlers } from '../http.ts';
import type { AppContext } from './context.ts';

/** Imports of older Azure activity, and the local Git history the graph shows. */
export function historyRoutes({ store, demo, backfill, checkoutGit, reset }: AppContext) {
  return {
    'POST /api/repos/:id/backfill': ({ params: { id }, body }) => {
      if (demo || !backfill) throw invalid('Historical import is available in live mode.');
      const repo = store.getRepo(id);
      const days = body.days;
      if (days !== 30 && days !== 90 && days !== 'all') throw invalid('Choose 30 days, 90 days or all available history.');
      // Checked after the body arrives: the reset would delete the job this request creates.
      if (reset.running) throw conflict('Starting from scratch is in progress. Try again in a moment.');
      return backfill.start(repo.id, days);
    },
    'GET /api/repos/:id/graph': async ({ params: { id }, query }) => {
      const repo = store.getEnabledRepo(id);
      if (demo) throw notFound('Demo repositories have no local Git history.');
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
      if (demo) throw notFound('Demo repositories have no local Git history.');
      return await checkoutGit.historySnapshot(repo);
    },
  } satisfies Partial<Handlers>;
}
