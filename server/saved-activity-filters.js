// @ts-check

import { randomUUID } from 'node:crypto';
import { canonicalActivityFilter } from '../src/activity-text.js';
import { parsePeople } from './activity-people.js';

/** @typedef {{ search: string, people: string, kind: string, repoIds: string[] | null, view: 'new' | 'all' }} ActivityFilters */
/** @typedef {{ id: string, name: string, filters: ActivityFilters }} SavedActivityFilter */

const setting = 'savedActivityFilters';
/** @param {string} message @param {number} [status] */
const problem = (message, status = 400) => Object.assign(new Error(message), { status });

/** @param {unknown} value */
function filterName(value) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 80) {
    throw problem('Enter a filter name of 1 to 80 characters.');
  }
  return value.trim();
}

/** @param {unknown} value @returns {ActivityFilters} */
function readFilters(value) {
  if (!value || typeof value !== 'object') throw problem('Choose Activity filters to save.');
  const { search, people, kind, repoIds, view } = /** @type {Record<string, unknown>} */ (value);
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

/** @param {Pick<ReturnType<typeof import('./store.js').createStore>, 'getSetting'|'setSetting'>} store */
export function createSavedActivityFilters(store) {
  // The settings entry is written only here. Read and write synchronously on the server's SQLite connection.
  const list = () => /** @type {SavedActivityFilter[]} */ (store.getSetting(setting, []));
  return {
    list,
    /** @param {Record<string, unknown>} input */
    create(input) {
      const presets = list();
      if (presets.length >= 25) throw problem('You can save up to 25 Activity filters.');
      const preset = { id: randomUUID(), name: filterName(input.name), filters: readFilters(input.filters) };
      store.setSetting(setting, [...presets, preset]);
      return preset;
    },
    /** @param {string} id @param {Record<string, unknown>} input */
    update(id, input) {
      const presets = list();
      const preset = presets.find(item => item.id === id);
      if (!preset) throw problem('Saved filter is no longer available.', 404);
      if (input.name === undefined && input.filters === undefined) throw problem('Choose a name or filters to update.');
      if (input.name !== undefined) preset.name = filterName(input.name);
      if (input.filters !== undefined) preset.filters = readFilters(input.filters);
      store.setSetting(setting, presets);
      return preset;
    },
    /** @param {string} id */
    remove(id) {
      store.setSetting(
        setting,
        list().filter(item => item.id !== id),
      );
    },
  };
}
