// Live polling: the scheduler, cadence, refreshes and their generations, read windows and cursors, pausing, and
// background turns.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../server/store.ts';
import { createNormalizer } from '../server/normalize.ts';
import { createSync } from '../server/sync.ts';
import { createHistoryImporter } from '../server/history-import.ts';
import type { SyncProvider } from '../server/sync.ts';
import type { AzureProvider, AzurePage, ReadOptions } from '../server/azure-client.ts';
import type { Repository } from '../src/contract.ts';
import { present, stub, watchedIdOf } from './fixtures/typed.ts';
import { repo } from './fixtures/repository.ts';
import { BASE, DAY, setup, push, pushesState } from './fixtures/sync.ts';
test('returning to the app advances one quiet stream and respects the cooldown, backoff, and pause', async () => {
  let calls = 0;
  let signedIn = true;
  const { sync, store, advance } = setup({
    async read() {
      calls++;
      if (!signedIn) throw Object.assign(new Error('Sign in again'), { code: 'AUTH_REQUIRED' });
      return { items: [], nextCursor: null };
    },
  });
  const pushes = () => present(store.getStreams().find(state => state.stream === 'pushes'));
  await sync.tick();
  store.saveStream({ ...pushes(), nextAt: new Date(BASE + 300000).toISOString() });
  signedIn = false;
  advance(46000);
  await sync.tick();
  assert.equal(calls, 1, 'the normal read would still be five minutes from the last check');
  sync.checkOnForeground();
  await sync.tick();
  assert.equal(calls, 2);
  assert.equal(pushes().error?.code, 'AUTH_REQUIRED');
  const backoff = pushes().nextAt;
  sync.checkOnForeground();
  assert.equal(pushes().nextAt, backoff, 'a second heartbeat does not advance the backoff');
  advance(100);
  const nextAt = new Date(BASE + 300000).toISOString();
  store.saveStream({ ...pushes(), error: null, pending: false, nextAt });
  sync.checkOnForeground();
  assert.equal(pushes().nextAt, nextAt, 'even a healthy stream waits out the foreground cooldown');
  advance(60000);
  store.saveStream({ ...pushes(), error: { code: 'AUTH_REQUIRED', message: 'Sign in again' }, pending: true });
  sync.checkOnForeground();
  assert.equal(pushes().nextAt, nextAt, 'a backed-off stream is never accelerated on focus');
  store.saveStream({ ...pushes(), error: null, pending: false });
  store.setSetting('refreshEnabled', false);
  sync.checkOnForeground();
  await sync.tick();
  assert.equal(pushes().nextAt, nextAt);
  assert.equal(calls, 2);
  store.close();
});

test('sign-in retry bypasses normal refresh cooldown and only schedules auth failures while paused', async () => {
  const calls: string[] = [];
  const { store, sync } = setup({
    async read(_repo, stream) {
      calls.push(stream);
      return { items: [], nextCursor: null };
    },
  });
  assert.deepEqual(sync.refresh([], true), { scheduled: false });
  assert.deepEqual(sync.refresh([]), { scheduled: false });
  assert.deepEqual(sync.refresh([repo.id], true), { scheduled: false });
  store.setSetting('refreshEnabled', false);
  const streams = store.getStreams();
  const pushes = present(streams.find(state => state.stream === 'pushes'));
  const refs = present(streams.find(state => state.stream === 'refs'));
  store.saveStream({ ...pushes, error: { code: 'AUTH_REQUIRED', message: 'Sign in again' } });
  store.saveStream({ ...refs, error: { code: 'UNAVAILABLE', message: 'Offline' } });
  assert.deepEqual(sync.refresh([repo.id]), { scheduled: false, cooldown: true });
  assert.deepEqual(sync.refresh([repo.id], true), { scheduled: true });
  assert.deepEqual(sync.refresh([repo.id], true), { scheduled: false, cooldown: true });
  await sync.tick();
  await sync.tick();
  assert.deepEqual(calls, ['pushes']);
  assert.equal(store.getStreams().find(state => state.stream === 'refs')?.nextAt, refs.nextAt);
  assert.deepEqual(sync.refresh([repo.id], true), { scheduled: false });
  store.close();
});

test('manual refresh drains its paginated work once while automatic checks stay off', async () => {
  const store = createStore();
  store.saveRepo(repo);
  store.saveRepo({ ...repo, id: 'two', name: 'Disabled', disabled: true });
  store.setSetting('refreshEnabled', false);
  let calls = 0,
    time = BASE;
  const sync = createSync({
    store,
    now: () => time,
    provider: {
      async read(current, stream, given) {
        const { cursor } = present(given);
        calls++;
        assert.equal(watchedIdOf(current), repo.id);
        return { items: [], nextCursor: stream === 'pushes' && !cursor ? { skip: 1 } : null };
      },
    },
  });
  await sync.tick();
  assert.equal(calls, 0);
  assert.equal(sync.refresh([repo.id]).scheduled, true);
  assert.equal(sync.refresh([repo.id]).cooldown, true);
  for (let i = 0; i < 7; i++) await sync.tick();
  assert.equal(calls, 7);
  assert.ok(
    store
      .getStreams()
      .filter(state => state.repoId === repo.id)
      .every(state => state.initialized),
  );
  time += 600001;
  await sync.tick();
  assert.equal(calls, 7, 'manual work must not turn automatic polling back on');
  store.close();
});

test('quiet streams and a background server reduce cadence without per-branch reads', async () => {
  const store = createStore();
  store.saveRepo(repo);
  let time = BASE,
    foreground = true,
    reads = 0;
  const sync = createSync({
    store,
    now: () => time,
    isForeground: () => foreground,
    provider: {
      async read() {
        reads++;
        return { items: [], nextCursor: null };
      },
    },
  });
  sync.refresh();
  for (const stream of store.getStreams()) if (stream.stream !== 'pushes') store.saveStream({ ...stream, nextAt: '2099-01-01T00:00:00Z' });
  await sync.tick();
  assert.equal(Date.parse(present(store.getStreams().find(s => s.stream === 'pushes')).nextAt) - time, 180000);
  time += 180000;
  await sync.tick();
  assert.equal(Date.parse(present(store.getStreams().find(s => s.stream === 'pushes')).nextAt) - time, 300000);
  time += 300000;
  foreground = false;
  await sync.tick();
  assert.equal(Date.parse(present(store.getStreams().find(s => s.stream === 'pushes')).nextAt) - time, 300000);
  assert.equal(reads, 3);
  store.close();
});

test('failed page preserves cursor across sync restart, completed window deduplicates overlap', async () => {
  let calls = 0;
  const provider: SyncProvider = {
    async read(_repo, _stream, given) {
      const options = present(given);
      calls++;
      if (!options.cursor) return { items: [push(1, '2026-11-16T10:00:00Z')], nextCursor: { skip: 1 } };
      if (calls === 2) throw Object.assign(new Error('Network unavailable'), { code: 'NETWORK' });
      return { items: [push(2)], nextCursor: null };
    },
  };
  const { store, sync, advance } = setup(provider);
  await sync.tick();
  assert.equal(present(store.getStreams().find(s => s.stream === 'pushes'))?.cursor?.skip, 1);
  await sync.tick();
  assert.equal(present(store.getStreams().find(s => s.stream === 'pushes')).lastSuccess, undefined);
  assert.equal(store.listEvents().length, 1);
  advance();
  const resumed = createSync({ store, provider, now: () => BASE + 2000, intervalMs: 1000 });
  await resumed.tick();
  assert.equal(present(store.getStreams().find(s => s.stream === 'pushes')).pending, false);
  assert.equal(store.listEvents().length, 2);
  assert.equal(present(store.listEvents().find(e => e.data?.pushId === 1)).imported, true);
  assert.equal(present(store.listEvents().find(e => e.data?.pushId === 2)).seen, false);
  store.close();
});

for (const stream of ['pushes', 'builds'] as const) {
  test(`a stale ${stream} cursor restarts from the same lower bound and catches up to now`, async () => {
    const calls: ReadOptions[] = [];
    const cursor = stream === 'pushes' ? { skip: 100 } : { token: 'old' };
    const provider: SyncProvider = {
      async read(_repo, _stream, options) {
        calls.push(present(options));
        return { items: stream === 'pushes' ? [push(1)] : [], nextCursor: calls.length === 2 ? cursor : null };
      },
    };
    const { store, sync, advance } = setup(provider, [stream]);
    const state = () => present(store.getStreams().find(entry => entry.stream === stream));
    await sync.tick();
    advance();
    await sync.tick();
    const saved = state();
    assert.deepEqual(saved.cursor, cursor);
    advance(11 * 60000);

    const at = BASE + 2000 + 11 * 60000;
    const resumed = createSync({ store, provider, now: () => at });
    await resumed.tick();

    assert.deepEqual(calls[2], { since: present(saved.window).since, until: new Date(at).toISOString(), cursor: null });
    assert.equal(state().lastSuccess, new Date(at).toISOString());
    assert.equal(state().cursor, undefined);
    if (stream === 'pushes') assert.equal(store.listEvents().filter(event => event.kind === 'push').length, 1);
    store.close();
  });
}

test('a large healthy history window can keep paging beyond ten minutes', async () => {
  const calls: ReadOptions[] = [];
  const { store, sync, advance } = setup({
    async read(_repo, _stream, options) {
      calls.push(present(options));
      return { items: [], nextCursor: calls.length < 3 ? { skip: calls.length * 100 } : null };
    },
  });
  for (let page = 0; page < 3; page++) {
    await sync.tick();
    advance(6 * 60000);
  }
  assert.deepEqual(calls[2], { ...calls[0], cursor: { skip: 200 } });
  assert.equal(pushesState(store).lastSuccess, new Date(BASE).toISOString());
  store.close();
});

test('retrying the first page of an initial import keeps its original lower bound', async () => {
  const calls: ReadOptions[] = [];
  const { store, sync, advance } = setup({
    async read(_repo, _stream, options) {
      calls.push(present(options));
      if (calls.length === 1) throw Object.assign(new Error('Network unavailable'), { code: 'NETWORK' });
      return { items: [], nextCursor: null };
    },
  });
  await sync.tick();
  advance(DAY);
  await sync.tick();
  assert.deepEqual(calls[1], {
    since: new Date(BASE - 7 * DAY).toISOString(),
    until: new Date(BASE + DAY).toISOString(),
    cursor: null,
  });
  store.close();
});

for (const automatic of [true, false]) {
  test(`a slow paged read catches up immediately only with automatic refresh on (automatic: ${automatic})`, async () => {
    const calls: ReadOptions[] = [];
    const { store, sync, advance } = setup({
      async read(_repo, _stream, options) {
        calls.push(present(options));
        if (calls.length === 2) advance(4 * 60000);
        return { items: [], nextCursor: calls.length === 1 ? { skip: 1 } : null };
      },
    });
    store.setSetting('refreshEnabled', automatic);
    const initial = pushesState(store);
    store.saveStream({ ...initial, manual: !automatic });
    await sync.tick();
    await sync.tick();
    const settled = pushesState(store);
    const completedAt = BASE + 4 * 60000;
    assert.equal(settled.lastSuccess, new Date(BASE).toISOString(), 'the first window retains its own watermark');
    await sync.tick();
    if (automatic) {
      assert.equal(settled.nextAt, new Date(completedAt).toISOString());
      assert.equal(present(calls[2]).until, new Date(completedAt).toISOString());
    } else {
      assert.ok(Date.parse(settled.nextAt) > completedAt);
      assert.equal(calls.length, 2);
    }
    store.close();
  });
}

test('closing the queue during shutdown leaves the read checkpoint and errors untouched', async () => {
  const { promise, reject } = Promise.withResolvers<AzurePage>();
  const { store, sync } = setup({ read: () => promise });
  const before = store.getStreams();
  const turn = sync.tick();
  const stopped = sync.stop();
  reject(Object.assign(new Error('Queue closed'), { code: 'CLOSED' }));
  await Promise.all([turn, stopped]);
  assert.deepEqual(store.getStreams(), before);
  assert.equal(sync.status().errors, 0);
  store.close();
});

test('disabled repositories and disabled refresh never call Azure; concurrent ticks coalesce', async () => {
  let release: (() => void) | undefined;
  let calls = 0;
  const provider: SyncProvider = {
    read() {
      calls++;
      return new Promise(resolve => {
        release = () => resolve({ items: [], nextCursor: null });
      });
    },
  };
  const { store, sync } = setup(provider);
  store.saveRepo({ ...repo, disabled: true });
  await sync.tick();
  assert.equal(calls, 0);
  store.saveRepo({ ...repo, disabled: false });
  store.setSetting('refreshEnabled', false);
  await sync.tick();
  assert.equal(calls, 0);
  store.setSetting('refreshEnabled', true);
  const a = sync.tick();
  const b = sync.tick();
  assert.equal(a, b);
  assert.equal(calls, 1);
  present(release)();
  await a;
  assert.deepEqual(sync.refresh(), { scheduled: false, cooldown: true });
  store.close();
});

test('a refresh while a repository is disabled does not start its cooldown', () => {
  const { store, sync, advance } = setup({
    async read() {
      return { items: [], nextCursor: null };
    },
  });
  advance(31000);
  store.saveRepo({ ...repo, disabled: true });
  sync.refresh();
  store.saveRepo({ ...repo, disabled: false });
  assert.deepEqual(sync.refresh([repo.id]), { scheduled: true });
  store.close();
});

test('pagination receives a fixed window and yields between pages to another repository', async () => {
  const calls: ({ id: string | undefined; stream: string } & ReadOptions)[] = [];
  const provider: SyncProvider = {
    async read(repo, stream, given) {
      const options = present(given);
      calls.push({ id: watchedIdOf(repo), stream, ...options });
      return { items: [], nextCursor: options.cursor ? null : { skip: 1 } };
    },
  };
  const { store, sync, advance } = setup(provider);
  store.saveRepo({ ...repo, id: 'two', name: 'Two' });
  // Ensure both repositories have just the pushes stream due.
  sync.refresh(['two']);
  await sync.tick();
  for (const state of store.getStreams()) if (state.stream !== 'pushes') store.saveStream({ ...state, nextAt: '2099-01-01T00:00:00Z' });
  advance(500);
  await sync.tick();
  await sync.tick();
  assert.equal(present(calls[0]).id, 'one');
  assert.equal(present(calls[1]).id, 'two');
  assert.equal(present(calls[2]).id, 'one');
  assert.equal(present(calls[0]).since, present(calls[2]).since);
  assert.equal(present(calls[0]).until, present(calls[2]).until);
  assert.deepEqual(present(calls[2]).cursor, { skip: 1 });
  store.close();
});

test('pausing during a read prevents follow-up reconciliation and never acknowledges existing events', async () => {
  let release: (() => void) | undefined;
  let reconciled = 0;
  const provider: SyncProvider = {
    read() {
      return new Promise(resolve => {
        release = () => resolve({ items: [], nextCursor: null });
      });
    },
    async buildsById() {
      reconciled++;
      return { items: [], nextCursor: null };
    },
  };
  const { store, sync } = setup(provider, ['activeBuilds']);
  store.insertEvents([{ id: 'existing', repoId: 'one', kind: 'push', title: 'Existing', time: '2026-11-17T10:00:00Z' }]);
  store.commitPage({ repoId: 'one', stream: 'activeBuilds', entities: [{ type: 'build', id: '42', data: { status: 'inProgress' } }] });
  const pending = sync.tick();
  store.saveRepo({ ...repo, disabled: true });
  present(release)();
  await pending;
  assert.equal(reconciled, 0);
  assert.equal(present(store.listEvents()[0]).seen, false);
  assert.equal(present(store.getStreams().find(s => s.stream === 'activeBuilds')).lastSuccess, undefined);
  store.close();
});

test('real-time due pages precede the background history import', async () => {
  const store = createStore();
  store.saveRepo(repo);
  let live = 0,
    background = 0;
  const sync = createSync({
    store,
    now: () => BASE,
    provider: {
      read: async () => {
        live++;
        return { items: [], nextCursor: null };
      },
    },
    background: {
      history: async () => {
        background++;
        return true;
      },
    },
  });
  for (let i = 0; i < 6; i++) await sync.tick();
  assert.equal(live, 6);
  assert.equal(background, 0);
  await sync.tick();
  assert.equal(background, 1);
  store.close();
});

test('a background turn that declines work reads the replacement watch from its first page', async t => {
  const store = createStore();
  t.after(() => store.close());
  store.saveRepo(repo);
  const started = Promise.withResolvers<void>();
  const background = Promise.withResolvers<boolean>();
  const cursors: ReadOptions['cursor'][] = [];
  const sync = createSync({
    store,
    now: () => BASE,
    provider: {
      async read(_repo, stream, options) {
        if (stream === 'pushes') cursors.push(options?.cursor);
        return { items: [], nextCursor: cursors.length < 2 && stream === 'pushes' ? { skip: 100 } : null };
      },
    },
    background: {
      history: () => {
        started.resolve();
        return background.promise;
      },
    },
  });
  const pushes = () => present(store.getStreams().find(state => state.stream === 'pushes'));
  for (let i = 0; i < 6; i++) await sync.tick();
  assert.deepEqual(pushes().cursor, { skip: 100 });
  const turn = sync.tick();
  await started.promise;
  store.removeRepo(repo.id);
  sync.forget(repo.id);
  store.saveRepo(repo);
  sync.refresh([repo.id]);
  assert.equal(pushes().initialized, false);
  background.resolve(false);
  await turn;
  assert.deepEqual(cursors, [null, null], 'the replacement watch must start without the removed watch cursor');
  assert.equal(pushes().initialized, true);
});

test('busy live queues leave turns for background work', async () => {
  const store = createStore();
  try {
    for (let id = 0; id < 12; id++) store.saveRepo(stub<Repository>({ id: String(id), name: String(id) }));
    let time = BASE;
    const turns: string[] = [];
    const sync = createSync({
      store,
      now: () => time,
      isForeground: () => false,
      provider: {
        read: async () => {
          turns.push('live');
          return stub<AzurePage>({ items: [] });
        },
      },
      background: {
        history: async () => {
          turns.push('history');
          return true;
        },
      },
    });
    for (let i = 0; i < 360; i++) {
      await sync.tick();
      time += 5000;
    }
    const live = turns.filter(turn => turn === 'live').length;
    assert.ok(live > 180, 'live checks retain most turns');
    assert.deepEqual(turns.slice(0, 14), [
      'live',
      'live',
      'live',
      'live',
      'live',
      'live',
      'history',
      'live',
      'live',
      'live',
      'live',
      'live',
      'live',
      'history',
    ]);
    assert.ok(turns.filter(turn => turn === 'history').length > 40);
    assert.ok(sync.status().lastTurn.history);
  } finally {
    store.close();
  }
});

test('automatic checks can be disabled while an explicit history import still gets turns', async () => {
  const store = createStore();
  try {
    store.saveRepo(repo);
    store.setSetting('refreshEnabled', false);
    const sync = createSync({
      store,
      now: () => BASE,
      provider: { read: async () => assert.fail('live was not requested') },
      background: { history: async () => true },
    });
    await sync.tick();
    assert.equal(sync.status().lastTurn.history, new Date(BASE).toISOString());
  } finally {
    store.close();
  }
});

test('repositories added during the refresh cooldown still get their initial import with automatic checks off', async () => {
  const store = createStore();
  store.setSetting('refreshEnabled', false);
  const reads: string[] = [];
  const sync = createSync({
    store,
    now: () => BASE,
    provider: {
      async read(current, stream) {
        reads.push(`${watchedIdOf(current)}:${stream}`);
        return { items: [], nextCursor: null };
      },
    },
  });
  store.saveRepo(repo);
  assert.equal(sync.refresh([repo.id]).scheduled, true);
  store.saveRepo({ ...repo, id: 'two', name: 'Two' });
  assert.equal(sync.refresh(['two']).scheduled, true, 'a different repository is not on cooldown');
  assert.equal(sync.refresh(['two']).cooldown, true);
  for (let i = 0; i < 20; i++) await sync.tick();
  assert.ok(
    store.getStreams().every(state => state.initialized),
    'every stream of both repositories imported',
  );
  assert.ok(reads.some(entry => entry.startsWith('two:')));
  store.close();
});

test('the scheduler drains due live work quickly, then returns to the idle interval', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const reads: string[] = [];
  const { store, sync } = setup(
    {
      async read(_repo, stream) {
        reads.push(stream);
        return { items: [], nextCursor: null };
      },
    },
    ['pushes', 'refs'],
  );
  t.after(async () => {
    await sync.stop();
    store.close();
  });
  async function advanceTimer(ms: number) {
    t.mock.timers.tick(ms);
    await new Promise(resolve => setImmediate(resolve));
  }

  sync.start();
  await advanceTimer(1000);
  assert.deepEqual(reads, ['pushes']);
  await advanceTimer(100);
  assert.deepEqual(reads, ['pushes', 'refs']);

  sync.refresh([repo.id]);
  const state = pushesState(store);
  store.saveStream({ ...state, nextAt: new Date(BASE).toISOString() });
  await advanceTimer(100);
  assert.deepEqual(reads, ['pushes', 'refs'], 'the scheduler stayed idle between checks');
  await advanceTimer(900);
  assert.deepEqual(reads, ['pushes', 'refs', 'pushes']);
});

test('a failing scheduled tick is contained and polling continues', async () => {
  const store = createStore();
  store.saveRepo(repo);
  let turns = 0;
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);
  const sync = createSync({
    store,
    pollMs: 5,
    provider: {
      async read() {
        return { items: [], nextCursor: null };
      },
    },
    background: {
      history: async () => {
        turns++;
        throw new Error('database is locked');
      },
    },
  });
  for (const state of store.getStreams()) store.saveStream({ ...state, nextAt: '2099-01-01T00:00:00Z' });
  sync.start();
  // Windows timers fire in coarser steps, so wait for the turns rather than a fixed time.
  for (const deadline = Date.now() + 5000; turns < 2 && Date.now() < deadline;) await new Promise(resolve => setTimeout(resolve, 10));
  await sync.stop();
  process.off('unhandledRejection', onUnhandled);
  assert.deepEqual(unhandled, []);
  assert.ok(turns >= 2, `polling continued after a failure (turns: ${turns})`);
  assert.ok(sync.status().errors >= 1);
  store.close();
});

test('a failed manual refresh is not retried while automatic checks are off', async () => {
  const store = createStore();
  store.saveRepo(repo);
  store.setSetting('refreshEnabled', false);
  let time = BASE,
    calls = 0;
  const sync = createSync({
    store,
    now: () => time,
    intervalMs: 1000,
    provider: {
      async read() {
        calls++;
        throw Object.assign(new Error('offline'), { code: 'UNAVAILABLE' });
      },
    },
  });
  sync.refresh([repo.id]);
  for (const state of store.getStreams()) if (state.stream !== 'pushes') store.saveStream({ ...state, manual: false });
  await sync.tick();
  assert.equal(calls, 1);
  assert.equal(
    present(store.getStreams().find(state => state.stream === 'pushes')).error?.code,
    'UNAVAILABLE',
    'the failure stays visible',
  );
  time += 31 * 60000;
  await sync.tick();
  assert.equal(calls, 1, 'no Azure call without another refresh request');
  store.close();
});

test('a refresh requested during a read that then fails is still answered while automatic checks are off', async () => {
  const store = createStore();
  store.saveRepo(repo);
  store.setSetting('refreshEnabled', false);
  let time = BASE,
    fail: (() => void) | undefined,
    calls = 0;
  const sync = createSync({
    store,
    now: () => time,
    intervalMs: 1000,
    provider: {
      read() {
        if (++calls > 1) return Promise.reject(Object.assign(new Error('offline'), { code: 'UNAVAILABLE' }));
        return new Promise((_done, reject) => {
          fail = () => reject(Object.assign(new Error('offline'), { code: 'UNAVAILABLE' }));
        });
      },
    },
  });
  sync.refresh([repo.id]);
  for (const state of store.getStreams()) if (state.stream !== 'pushes') store.saveStream({ ...state, manual: false });
  const reading = sync.tick();
  await new Promise(setImmediate);
  time += 40000;
  assert.equal(sync.refresh([repo.id]).scheduled, true);
  for (const state of store.getStreams()) if (state.stream !== 'pushes') store.saveStream({ ...state, manual: false });
  present(fail)();
  await reading;
  const pending = () => sync.status().inProgress.some(entry => entry.stream === 'pushes');
  assert.equal(
    present(store.getStreams().find(state => state.stream === 'pushes')).error?.code,
    'UNAVAILABLE',
    'the failure stays visible',
  );
  assert.equal(pending(), true, 'the newer request is still pending');
  time += 31 * 60000;
  await sync.tick();
  assert.equal(calls, 2, 'the newer request gets its own read');
  assert.equal(pending(), false, 'its failure answers it');
  time += 31 * 60000;
  await sync.tick();
  assert.equal(calls, 2, 'no further read without another request');
  store.close();
});

test('a refresh made with automatic checks on still runs if checks are turned off before the older read fails', async () => {
  const store = createStore();
  store.saveRepo(repo);
  let time = BASE,
    fail: (() => void) | undefined,
    calls = 0;
  const sync = createSync({
    store,
    now: () => time,
    intervalMs: 1000,
    provider: {
      read() {
        if (++calls > 1) return Promise.resolve({ items: [], nextCursor: null });
        return new Promise((_done, reject) => {
          fail = () => reject(Object.assign(new Error('offline'), { code: 'UNAVAILABLE' }));
        });
      },
    },
  });
  sync.refresh([repo.id]);
  for (const state of store.getStreams()) if (state.stream !== 'pushes') store.saveStream({ ...state, nextAt: '2099-01-01T00:00:00Z' });
  const reading = sync.tick();
  await new Promise(setImmediate);
  time += 40000;
  assert.equal(sync.refresh([repo.id]).scheduled, true);
  for (const state of store.getStreams()) if (state.stream !== 'pushes') store.saveStream({ ...state, nextAt: '2099-01-01T00:00:00Z' });
  store.setSetting('refreshEnabled', false);
  present(fail)();
  await reading;
  time += 31 * 60000;
  await sync.tick();
  assert.equal(calls, 2, 'the request still gets its read');
  assert.equal(
    sync.status().inProgress.some(entry => entry.stream === 'pushes'),
    false,
    'and is no longer in progress',
  );
  store.close();
});

test('a first sync whose read fails after a newer refresh keeps its lower bound', async () => {
  const store = createStore();
  store.saveRepo(repo);
  store.setSetting('refreshEnabled', false);
  let time = BASE,
    fail: (() => void) | undefined;
  const sinces: (string | undefined)[] = [];
  const sync = createSync({
    store,
    now: () => time,
    intervalMs: 1000,
    provider: {
      read(_repo, _stream, given) {
        const { since } = present(given);
        sinces.push(since);
        if (sinces.length === 1) return Promise.resolve({ items: [], nextCursor: { skip: 1 } });
        if (sinces.length > 2) return Promise.resolve({ items: [], nextCursor: null });
        return new Promise((_done, reject) => {
          fail = () => reject(Object.assign(new Error('offline'), { code: 'UNAVAILABLE' }));
        });
      },
    },
  });
  const onlyPushes = () => {
    for (const state of store.getStreams()) if (state.stream !== 'pushes') store.saveStream({ ...state, manual: false });
  };
  sync.refresh([repo.id]);
  onlyPushes();
  await sync.tick();
  time += DAY;
  const reading = sync.tick();
  await new Promise(setImmediate);
  sync.refresh([repo.id]);
  onlyPushes();
  present(fail)();
  await reading;
  time += 31 * 60000;
  await sync.tick();
  assert.equal(sinces.length, 3);
  assert.equal(sinces[2], sinces[0], 'the retry starts where the first sync started');
  store.close();
});

for (const automatic of [true, false]) {
  test(`a refresh requested during a read stays due after that page commits (automatic checks ${automatic ? 'on' : 'off'})`, async () => {
    const store = createStore();
    store.saveRepo(repo);
    store.setSetting('refreshEnabled', automatic);
    let time = BASE,
      release: (() => void) | undefined,
      calls = 0;
    const sync = createSync({
      store,
      now: () => time,
      intervalMs: 180000,
      provider: {
        read() {
          if (++calls > 1) return Promise.resolve({ items: [], nextCursor: null });
          return new Promise(done => {
            release = () => done({ items: [], nextCursor: null });
          });
        },
      },
    });
    sync.refresh([repo.id]);
    for (const state of store.getStreams())
      if (state.stream !== 'pushes') store.saveStream({ ...state, nextAt: '2099-01-01T00:00:00Z', manual: false });
    const reading = sync.tick();
    await new Promise(setImmediate);
    time += 40000;
    assert.equal(sync.refresh([repo.id]).scheduled, true);
    present(release)();
    await reading;
    const pushes = present(store.getStreams().find(state => state.stream === 'pushes'));
    assert.equal(pushes.nextAt, new Date(time).toISOString(), 'the refresh is still due');
    await sync.tick();
    assert.equal(calls, 2, 'the requested refresh reads again');
    store.close();
  });
}

test('first-sync history at the baseline instant is imported whatever its fractional-second format', async () => {
  const { store, sync } = setup({
    async read() {
      return { items: [push(7, '2026-11-17T10:00:00Z')], nextCursor: null };
    },
  });
  assert.equal(store.getBaseline(repo.id), '2026-11-17T10:00:00.000Z');
  await sync.tick();
  const event = present(store.listEvents().find(item => item.kind === 'push'));
  assert.equal(event.imported, true, 'an event at the baseline instant is history, not a new update');
  store.close();
});

test('a refresh in the same millisecond its stream starts reading still stays due', async () => {
  const store = createStore();
  store.saveRepo(repo);
  let release: (() => void) | undefined,
    calls = 0;
  const sync = createSync({
    store,
    now: () => BASE,
    intervalMs: 180000,
    provider: {
      read() {
        if (++calls > 1) return Promise.resolve({ items: [], nextCursor: null });
        return new Promise(done => {
          release = () => done({ items: [], nextCursor: null });
        });
      },
    },
  });
  const reading = sync.tick();
  await new Promise(setImmediate);
  assert.equal(calls, 1);
  store.setSetting('refreshEnabled', false);
  assert.equal(sync.refresh([repo.id]).scheduled, true);
  present(release)();
  await reading;
  const read = present(store.getStreams().find(state => state.initialized));
  assert.equal(read.nextAt, new Date(BASE).toISOString(), 'the refresh is still due');
  assert.equal(read.manual, true, 'a manual refresh keeps its manual flag with automatic checks off');
  store.close();
});

test('a read window saved before refresh generations existed still keeps a refresh made during its read', async () => {
  const store = createStore();
  store.saveRepo(repo);
  let release: (() => void) | undefined,
    calls = 0,
    time = BASE;
  const sync = createSync({
    store,
    now: () => time,
    intervalMs: 180000,
    provider: {
      read() {
        if (++calls > 1) return Promise.resolve({ items: [], nextCursor: null });
        return new Promise(done => {
          release = () => done({ items: [], nextCursor: null });
        });
      },
    },
  });
  sync.refresh([repo.id]);
  for (const state of store.getStreams()) {
    const { refreshGeneration, ...upgraded } = state;
    store.saveStream(
      state.stream === 'pushes'
        ? { ...upgraded, window: { since: '2026-11-17T09:00:00.000Z', until: '2026-11-17T09:59:00.000Z' }, cursor: { skip: 100 } }
        : { ...upgraded, nextAt: '2099-01-01T00:00:00Z' },
    );
    assert.ok(refreshGeneration !== undefined && refreshGeneration >= 0);
  }
  const reading = sync.tick();
  await new Promise(setImmediate);
  time += 40000;
  store.setSetting('refreshEnabled', false);
  assert.equal(sync.refresh([repo.id]).scheduled, true);
  present(release)();
  await reading;
  const pushes = present(store.getStreams().find(state => state.stream === 'pushes'));
  assert.equal(pushes.nextAt, new Date(time).toISOString(), 'the refresh is still due');
  assert.equal(pushes.manual, true);
  store.close();
});

test('status reports streams that are overdue because the budget is behind', async () => {
  const { store, sync, advance } = setup(
    {
      async read() {
        return { items: [], nextCursor: null };
      },
    },
    ['pushes', 'refs'],
  );
  store.saveRepo({ ...repo, id: 'off', name: 'Off', disabled: true });
  sync.refresh();
  assert.deepEqual(sync.status().lag, { overdueStreams: 0, maxDelayMs: 0 });
  advance(5 * 60000);
  assert.deepEqual(sync.status().lag, { overdueStreams: 2, maxDelayMs: 5 * 60000 }, 'disabled repositories do not count');
  store.setSetting('refreshEnabled', false);
  assert.deepEqual(sync.status().lag, { overdueStreams: 0, maxDelayMs: 0 }, 'paused automatic checks are not lag');
  store.close();
});

/**
 * Records every provider method a run calls. Pushes come in pages; every other call answers empty.
 * @param pages pages per stream, chained by a `skip` cursor
 */
function recordingProvider(pages: Record<string, object[][]>) {
  const calls: string[] = [];
  const provider = new Proxy(stub<AzureProvider>({}), {
    get(_target, name) {
      if (typeof name !== 'string' || name === 'then') return undefined;
      return async (_repo: unknown, stream: string, options?: ReadOptions) => {
        calls.push(name === 'read' ? `read:${stream}` : name);
        const list = (name === 'read' && pages[stream]) || [];
        const index = options?.cursor?.skip || 0;
        return { items: list[index] || [], nextCursor: index + 1 < list.length ? { skip: index + 1 } : null };
      };
    },
  });
  return { provider, calls };
}

test('a sync run over several push pages makes only stream reads and queues no merge work', async () => {
  const store = createStore();
  store.saveRepo(repo);
  let time = BASE;
  const { provider, calls } = recordingProvider({ pushes: [[push(1), push(2)], [push(3)], [push(4)]] });
  const sync = createSync({ store, provider, now: () => time, intervalMs: 1000 });
  for (let i = 0; i < 40; i++) {
    await sync.tick();
    time += 500;
  }
  assert.equal(store.listEvents().filter(event => event.kind === 'push').length, 4);
  assert.deepEqual(
    calls.filter(call => !call.startsWith('read:')),
    [],
  );
  // Merge jobs are no job type any more: listJobs reports a stored one as a corrupt row, so reading every job finds none.
  assert.doesNotThrow(() => store.listJobs());
  store.close();
});

test('a history import page makes only stream reads and queues no merge work', async () => {
  const store = createStore();
  store.saveRepo(repo);
  let time = BASE;
  const day = 86400000;
  const { provider, calls } = recordingProvider({
    pushes: [[push(5, new Date(BASE - day).toISOString()), push(6, new Date(BASE - 2 * day).toISOString())]],
  });
  let historyImporter: ReturnType<typeof createHistoryImporter>;
  const normalizer = createNormalizer({ store, now: () => time });
  const sync = createSync({
    store,
    provider,
    now: () => time,
    normalizer,
    background: { history: () => historyImporter.tick() },
  });
  historyImporter = createHistoryImporter({ store, provider, normalize: normalizer.normalize, now: () => time });
  store.setBaseline(repo.id, new Date(BASE).toISOString());
  historyImporter.start(repo.id, 30);
  // Automatic checks stay on, but no live stream is due.
  sync.refresh();
  for (const state of store.getStreams()) store.saveStream({ ...state, nextAt: '2099-01-01T00:00:00Z' });
  for (let i = 0; i < 10; i++) {
    await sync.tick();
    time += 1000;
  }
  assert.equal(store.listEvents().filter(event => event.kind === 'push' && event.imported).length, 2);
  assert.deepEqual(
    calls.filter(call => !call.startsWith('read:')),
    [],
  );
  // Merge jobs are no job type any more: listJobs reports a stored one as a corrupt row, so reading every job finds none.
  assert.doesNotThrow(() => store.listJobs());
  store.close();
});
