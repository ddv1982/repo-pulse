import { invalid, notFound } from '../errors.ts';
import type { Handlers } from '../http.ts';
import type { AppContext } from './context.ts';

const isStringList = (value: unknown): value is string[] => Array.isArray(value) && value.every(item => typeof item === 'string');

/** The Activity page, its unread lookup, one item's detail, Seen marks, and the Azure reads a detail asks for. */
export function activityRoutes({ store, provider }: AppContext) {
  function activityScope(query: URLSearchParams) {
    const repoIdList = query.get('repoIds');
    const requested = repoIdList !== null ? repoIdList.split(',').filter(Boolean) : undefined;
    requested?.forEach(store.getRepo);
    const enabled = store.enabledRepoIds();
    return {
      repoIds: (requested || enabled).filter(id => enabled.includes(id)),
      kind: query.get('kind') || '',
      search: query.get('search') || '',
      people: query.get('people') || '',
    };
  }
  return {
    'GET /api/activity': ({ query }) => {
      const cursor = query.get('cursor') || undefined;
      const view = query.get('view') || 'all';
      if (view !== 'new' && view !== 'all') throw invalid('Invalid activity view.');
      const limit = Number(query.get('limit') || 50);
      if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw invalid('Choose a page size from 1 to 200.');
      return store.queryActivity({ ...activityScope(query), view, limit, cursor });
    },
    'GET /api/activity/unseen': ({ query }) => {
      const raw = query.get('through');
      const through = raw === null ? undefined : Number(raw);
      if (through !== undefined && !(Number.isSafeInteger(through) && through >= 0))
        throw invalid('Invalid activity snapshot.', 'BAD_REQUEST');
      return { ids: store.queryActivity.unseenIds({ ...activityScope(query), through }) };
    },
    'GET /api/activity/:id': ({ params: { id }, query }) => {
      const event = store.getEvent(id);
      if (!event || !store.enabledRepoIds().includes(event.repoId)) throw notFound('Activity not found.');
      return {
        event,
        events: store.getEventGroup(id),
        related: store.relatedActivity(event, { ciOnly: query.get('ci') === '1' }),
      };
    },
    'POST /api/ack': ({ body }) => {
      const { ids, seen } = body;
      if (!Array.isArray(ids) || ids.length > 1000 || !isStringList(ids)) throw invalid('Send up to 1000 explicit event IDs.');
      if (seen !== undefined && typeof seen !== 'boolean') throw invalid('seen must be true or false.');
      const changedIds = store.acknowledge(ids, seen !== false);
      return { ok: true, changedIds };
    },
    'GET /api/repos/:id/pushes/:pushId/commits': async ({ params: { id, pushId }, query }) => {
      const repo = store.getEnabledRepo(id);
      if (!/^\d+$/.test(pushId)) throw invalid('Invalid push.');
      const skip = Number(query.get('skip') || 0);
      if (!Number.isSafeInteger(skip) || skip < 0) throw invalid('Invalid page offset.');
      const page = await provider.pushCommits(repo, Number(pushId), { skip });
      // The browser shows only these two fields; raw Azure commit objects stay behind this boundary.
      const items = page.items.map(item => ({
        commitId: typeof item?.commitId === 'string' ? item.commitId : '',
        ...(typeof item?.comment === 'string' ? { comment: item.comment } : {}),
      }));
      return { items, nextCursor: page.nextCursor };
    },
    'GET /api/repos/:id/prs/:prId/review': async ({ params: { id, prId } }) => {
      const repo = store.getEnabledRepo(id);
      if (!/^\d+$/.test(prId)) throw invalid('Invalid pull request.');
      return await provider.prReview(repo, prId);
    },
  } satisfies Partial<Handlers>;
}
