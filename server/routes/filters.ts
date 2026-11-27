import type { Handlers } from '../http.ts';
import type { AppContext } from './context.ts';

/** Saved Activity filters. */
export function filterRoutes({ savedFilters }: AppContext) {
  return {
    'POST /api/activity-filters': ({ body }) => savedFilters.create(body),
    'PATCH /api/activity-filters/:id': ({ params: { id }, body }) => savedFilters.update(id, body),
    'DELETE /api/activity-filters/:id': ({ params: { id } }) => {
      savedFilters.remove(id);
      return { ok: true };
    },
  } satisfies Partial<Handlers>;
}
