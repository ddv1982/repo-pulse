// Shared setup for the sync suites: a store and sync over one repository on a fixed clock, and the pages and
// providers more than one suite reads.
import { createStore } from '../../server/store.ts';
import { createNormalizer } from '../../server/normalize.ts';
import { createSync } from '../../server/sync.ts';
import type { SyncProvider } from '../../server/sync.ts';
import { present } from './typed.ts';
import { repo } from './repository.ts';
export const BASE = Date.parse('2026-11-17T10:00:00Z');
export const DAY = 86400000;
export function setup(provider: SyncProvider, streams: string[] = ['pushes']) {
  const store = createStore();
  store.saveRepo(repo);
  let time = BASE;
  const normalizer = createNormalizer({ store, now: () => time });
  const sync = createSync({ store, provider, now: () => time, intervalMs: 1000, normalizer });
  sync.refresh();
  for (const state of store.getStreams())
    if (!streams.includes(state.stream)) store.saveStream({ ...state, nextAt: '2099-01-01T00:00:00Z' });
  return {
    store,
    sync,
    normalizer,
    advance(this: void, ms = 2000) {
      time += ms;
    },
  };
}
export const push = (id: number, date = '2026-11-17T10:00:01Z') => ({
  pushId: id,
  date,
  pushedBy: { displayName: 'A' },
  refUpdates: [{ name: 'refs/heads/hotfix/example', oldObjectId: 'a'.repeat(40), newObjectId: 'b'.repeat(40) }],
});

export const cachedPr = (id: number, status = 'active') => ({
  pullRequestId: id,
  title: `PR ${id}`,
  status,
  creationDate: '2026-11-16T10:00:00Z',
  sourceRefName: `refs/heads/feature/${id}`,
});

export const pushesState = (store: ReturnType<typeof createStore>) => present(store.getStreams().find(state => state.stream === 'pushes'));
