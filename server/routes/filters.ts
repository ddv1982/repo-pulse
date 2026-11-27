import { readFilterChange, readNewFilter } from '../saved-activity-filters.ts';
import type { Handlers } from '../http.ts';
import type { AppContext } from './context.ts';

/** Saved Activity filters. */
export function filterRoutes({ savedFilters }: AppContext) {
  return {
    'POST /api/activity-filters': ({ body }) => savedFilters.create(readNewFilter(body)),
    'PATCH /api/activity-filters/:id': ({ params: { id }, body }) => savedFilters.update(id, readFilterChange(body)),
    'DELETE /api/activity-filters/:id': ({ params: { id } }) => {
      savedFilters.remove(id);
      return { ok: true };
    },
  } satisfies Partial<Handlers>;
}
