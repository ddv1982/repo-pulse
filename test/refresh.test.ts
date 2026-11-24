import test from 'node:test';
import assert from 'node:assert/strict';
import { createRefreshController, type View } from '../src/ui/refresh.ts';
import { fakeRequest } from './fixtures/typed.ts';

const metadata = { repos: [{ id: 'orders' }], activityRevision: '1' };
const page = (id: string) => ({ items: [{ groupKey: id, events: [{ id }] }], total: 1, nextCursor: null });
const initialView: View = { route: 'activity', repoIds: null, eventId: null, search: '', kind: '', generation: 0 };

test('an obsolete filter cannot publish its rows or an error after navigation', async () => {
  for (const fail of [false, true]) {
    const delayed = Promise.withResolvers();
    const requested = Promise.withResolvers<void>();
    let view = initialView;
    const updates: string[][] = [];
    const errors: string[] = [];
    const refresh = createRefreshController({
      request: fakeRequest(path => {
        if (path === '/api/state') return metadata;
        if (path.includes('search=current')) return page('current');
        requested.resolve();
        return delayed.promise;
      }),
      getView: () => view,
      reconcileRepositories: () => {},
      onUpdate: () => updates.push(refresh.state.events.map(event => event.id)),
      onError: error => errors.push(error.message),
    });

    const old = refresh.load();
    await requested.promise;
    view = { ...view, search: 'current', generation: 1 };
    refresh.resetActivity();
    const current = refresh.load({ force: true });
    if (fail) delayed.reject(new Error('obsolete read failed'));
    else delayed.resolve(page('obsolete'));
    await Promise.all([old, current]);
    assert.deepEqual(updates, [['current']]);
    assert.deepEqual(errors, []);
  }
});

test('forced refresh callers complete after their coalesced follow-up read', async () => {
  const firstRead = Promise.withResolvers();
  const secondRead = Promise.withResolvers();
  let requests = 0;
  const updates: (string | undefined)[] = [];
  const refresh = createRefreshController({
    request: fakeRequest(() => (++requests === 1 ? firstRead.promise : secondRead.promise)),
    getView: () => ({ ...initialView, route: 'settings' }),
    reconcileRepositories: () => {},
    onUpdate: () => updates.push(refresh.state.activityRevision),
    onError: assert.fail,
  });
  const inFlight = refresh.load();
  const forced = refresh.load({ force: true });
  const coalesced = refresh.load({ force: true });
  assert.equal(forced, coalesced);
  let complete = false;
  // A rejected forced load fails the test at `await forced` below.
  void forced.then(() => {
    complete = true;
  });
  firstRead.resolve(metadata);
  await inFlight;
  assert.equal(complete, false);
  secondRead.resolve({ ...metadata, activityRevision: '2' });
  await forced;
  assert.equal(complete, true);
  assert.equal(requests, 2);
  assert.deepEqual(updates, ['1', '2']);
});

test('a new non-Activity view gets a refresh while older metadata is in flight', async () => {
  let view = initialView;
  const previousRead = Promise.withResolvers();
  const received = Promise.withResolvers<void>();
  let reads = 0;
  const updates: (string | undefined)[] = [];
  const refresh = createRefreshController({
    request: fakeRequest(path => {
      assert.equal(path, '/api/state');
      if (++reads > 1) return { ...metadata, activityRevision: '2' };
      received.resolve();
      return previousRead.promise;
    }),
    getView: () => view,
    reconcileRepositories: () => {},
    onUpdate: () => updates.push(refresh.state.activityRevision),
    onError: assert.fail,
  });
  const old = refresh.load();
  await received.promise;
  view = { ...view, route: 'settings', generation: 1 };
  const current = refresh.load();
  assert.notEqual(current, old);
  previousRead.resolve(metadata);
  await current;
  assert.deepEqual(updates, ['2']);
});

test('disabled repositories stay watched but leave the shown repositories and their streams', async () => {
  const reconciled: string[][] = [];
  const refresh = createRefreshController({
    request: fakeRequest(path =>
      path === '/api/state'
        ? {
            repos: [{ id: 'orders' }, { id: 'billing', disabled: true }],
            streams: [
              { repoId: 'orders', stream: 'refs' },
              { repoId: 'billing', stream: 'refs' },
            ],
            activityRevision: '1',
          }
        : page('orders'),
    ),
    getView: () => initialView,
    reconcileRepositories: repos => reconciled.push(repos.map(repo => repo.id)),
    onUpdate: () => {},
    onError: error => {
      throw error;
    },
  });
  await refresh.load();
  assert.deepEqual(
    refresh.state.watched.map(repo => repo.id),
    ['orders', 'billing'],
  );
  assert.deepEqual(
    refresh.state.repos.map(repo => repo.id),
    ['orders'],
  );
  assert.deepEqual(
    refresh.state.streams.map(stream => stream.repoId),
    ['orders'],
  );
  assert.deepEqual(reconciled, [['orders', 'billing']]);
});
