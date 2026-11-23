import { randomUUID } from 'node:crypto';
import { canonicalActivityFilter } from '../src/activity-text.ts';
import { parsePeople } from './activity-people.ts';

export type ActivityFilters = import('../src/contract.ts').ActivityFilters;
export type SavedActivityFilter = import('../src/contract.ts').SavedActivityFilter;

const setting = 'savedActivityFilters';
const problem = (message: string, status: number = 400) => Object.assign(new Error(message), { status });

function filterName(value: unknown) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 80) {
    throw problem('Enter a filter name of 1 to 80 characters.');
  }
  return value.trim();
}

function readFilters(value: unknown): ActivityFilters {
  if (!value || typeof value !== 'object') throw problem('Choose Activity filters to save.');
  const { search, people, kind, repoIds, view } = value as Record<string, unknown>;
  if (
    typeof search !== 'string' ||
    search.length > 300 ||
    typeof people !== 'string' ||
    typeof kind !== 'string' ||
    kind.length > 80 ||
    (view !== 'new' && view !== 'all')
  ) {
    throw problem('Invalid Activity filters.');
  }
  if (repoIds !== null && (!Array.isArray(repoIds) || repoIds.some(id => typeof id !== 'string' || !id || id.includes(',')))) {
    throw problem('Invalid repository selection.');
  }
  parsePeople(people);
  return { search, people, kind: canonicalActivityFilter(kind), repoIds: repoIds === null ? null : [...new Set(repoIds)], view };
}

export function createSavedActivityFilters(store: Pick<ReturnType<typeof import('./store.js').createStore>, 'getSetting' | 'setSetting'>) {
  // The settings entry is written only here. Read and write synchronously on the server's SQLite connection.
  const list = () => store.getSetting(setting, []) as SavedActivityFilter[];
  return {
    list,
    create(input: Record<string, unknown>) {
      const presets = list();
      if (presets.length >= 25) throw problem('You can save up to 25 Activity filters.');
      const preset = { id: randomUUID(), name: filterName(input.name), filters: readFilters(input.filters) };
      store.setSetting(setting, [...presets, preset]);
      return preset;
    },
    update(id: string, input: Record<string, unknown>) {
      const presets = list();
      const preset = presets.find(item => item.id === id);
      if (!preset) throw problem('Saved filter is no longer available.', 404);
      if (input.name === undefined && input.filters === undefined) throw problem('Choose a name or filters to update.');
      if (input.name !== undefined) preset.name = filterName(input.name);
      if (input.filters !== undefined) preset.filters = readFilters(input.filters);
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
