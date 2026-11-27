import { randomUUID } from 'node:crypto';
import { canonicalActivityFilter } from '../src/activity-text.ts';
import { PEOPLE_LIMIT_MESSAGE, peopleNames } from '../src/search-terms.ts';
import type { ActivityFilters, SavedActivityFilter } from '../src/contract.ts';
import { invalid, notFound } from './errors.ts';

const setting = 'savedActivityFilters';

function filterName(value: unknown) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 80) {
    throw invalid('Enter a filter name of 1 to 80 characters.');
  }
  return value.trim();
}

function readFilters(value: unknown): ActivityFilters {
  if (!value || typeof value !== 'object') throw invalid('Choose Activity filters to save.');
  const { search, people, kind, repoIds, view } = value as Record<string, unknown>;
  if (
    typeof search !== 'string' ||
    search.length > 300 ||
    typeof people !== 'string' ||
    typeof kind !== 'string' ||
    kind.length > 80 ||
    (view !== 'new' && view !== 'all')
  ) {
    throw invalid('Invalid Activity filters.');
  }
  if (repoIds !== null && (!Array.isArray(repoIds) || repoIds.some(id => typeof id !== 'string' || !id || id.includes(',')))) {
    throw invalid('Invalid repository selection.');
  }
  if (!peopleNames(people)) throw invalid(PEOPLE_LIMIT_MESSAGE, 'BAD_REQUEST');
  return { search, people, kind: canonicalActivityFilter(kind), repoIds: repoIds === null ? null : [...new Set(repoIds)], view };
}

/** A new saved filter as a request sends it, read once at the route. */
export function readNewFilter(input: Record<string, unknown>) {
  return { name: filterName(input.name), filters: readFilters(input.filters) };
}

/** A change to a saved filter: a new name, new filters, or both. */
export type FilterChange = { name?: string; filters?: ActivityFilters };

export function readFilterChange(input: Record<string, unknown>): FilterChange {
  if (input.name === undefined && input.filters === undefined) throw invalid('Choose a name or filters to update.');
  return {
    ...(input.name === undefined ? {} : { name: filterName(input.name) }),
    ...(input.filters === undefined ? {} : { filters: readFilters(input.filters) }),
  };
}

export function createSavedActivityFilters(store: Pick<ReturnType<typeof import('./store.ts').createStore>, 'getSetting' | 'setSetting'>) {
  // The settings entry is written only here. Read and write synchronously on the server's SQLite connection.
  const list = (): SavedActivityFilter[] => store.getSetting(setting, []);
  return {
    list,
    create({ name, filters }: { name: string; filters: ActivityFilters }) {
      const presets = list();
      if (presets.length >= 25) throw invalid('You can save up to 25 Activity filters.');
      const preset = { id: randomUUID(), name, filters };
      store.setSetting(setting, [...presets, preset]);
      return preset;
    },
    update(id: string, { name, filters }: FilterChange) {
      const presets = list();
      const preset = presets.find(item => item.id === id);
      if (!preset) throw notFound('Saved filter is no longer available.');
      if (name !== undefined) preset.name = name;
      if (filters !== undefined) preset.filters = filters;
      store.setSetting(setting, presets);
      return preset;
    },
    remove(id: string) {
      store.setSetting(
        setting,
        list().filter(item => item.id !== id),
      );
    },
  };
}
