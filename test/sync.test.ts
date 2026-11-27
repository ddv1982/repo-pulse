import test from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../server/store.ts';
import { createHash } from 'node:crypto';
import { createSync } from '../server/sync.ts';
import { createBackfill } from '../server/backfill.ts';
import { activityMergeBadge } from '../src/activity-text.ts';
import type { SyncProvider } from '../server/sync.ts';
import { createAzureClient } from '../server/azure-client.ts';
import type { AzureProvider, AzurePage, ReadOptions } from '../server/azure-client.ts';
import type { AzureStreamRecord, Repository } from '../src/contract.ts';
import { dataOf, fieldsOf, present, stub, watchedIdOf } from './fixtures/typed.ts';
const repo = {
  id: 'one',
  name: 'One',
  azureId: 'a',
  organization: 'https://dev.azure.com/org',
  project: 'P',
  webUrl: 'https://dev.azure.com/org/P/_git/One',
};
const BASE = Date.parse('2026-11-17T10:00:00Z');
const DAY = 86400000;
function setup(provider: SyncProvider, streams: string[] = ['pushes']) {
  const store = createStore();
  store.saveRepo(repo);
  let time = BASE;
  const sync = createSync({ store, provider, now: () => time, intervalMs: 1000 });
  sync.refresh();
  for (const state of store.getStreams())
    if (!streams.includes(state.stream)) store.saveStream({ ...state, nextAt: '2099-01-01T00:00:00Z' });
  return {
    store,
    sync,
    advance(this: void, ms = 2000) {
      time += ms;
    },
  };
}
const push = (id: number, date = '2026-11-17T10:00:01Z') => ({
  pushId: id,
  date,
  pushedBy: { displayName: 'A' },
  refUpdates: [{ name: 'refs/heads/hotfix/example', oldObjectId: 'a'.repeat(40), newObjectId: 'b'.repeat(40) }],
});

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

test('newest-first push history cannot resurrect a deleted ref across pages or snapshots', async () => {
  const name = 'refs/heads/hotfix/example';
  const deletion = {
    ...push(20, '2026-11-17T10:00:02Z'),
    refUpdates: [{ name, oldObjectId: 'b'.repeat(40), newObjectId: '0'.repeat(40) }],
  };
  const creation = { ...push(10), refUpdates: [{ name, oldObjectId: '0'.repeat(40), newObjectId: 'b'.repeat(40) }] };
  let acrossPages = false;
  const provider: SyncProvider = {
    async read(_repo, stream, given) {
      const { cursor } = present(given);
      if (stream === 'refs') return { items: [], nextCursor: null };
      if (!acrossPages) return { items: [deletion, creation], nextCursor: null };
      return { items: cursor ? [{ ...creation, pushId: 30 }] : [{ ...deletion, pushId: 40 }], nextCursor: cursor ? null : { skip: 1 } };
    },
  };
  const { store, sync, advance } = setup(provider, ['pushes']);
  // Baseline ref stream already exists; an empty reconciliation should add no duplicate deletion.
  const refs = present(store.getStreams().find(state => state.stream === 'refs'));
  store.saveStream({ ...refs, initialized: true });
  await sync.tick();
  assert.equal(fieldsOf(store.getEntity(repo.id, 'ref', name)).active, false);
  acrossPages = true;
  advance();
  await sync.tick();
  await sync.tick();
  assert.equal(fieldsOf(store.getEntity(repo.id, 'ref', name)).active, false);
  const before = store.listEvents().filter(event => event.kind === 'branch-deleted').length;
  store.saveStream({ ...refs, initialized: true, nextAt: new Date(BASE).toISOString() });
  await sync.tick();
  assert.equal(store.listEvents().filter(event => event.kind === 'branch-deleted').length, before);
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

test('an old incomplete refs snapshot is discarded before its cursor or warning is used', async () => {
  const calls: ReadOptions[] = [];
  const provider: SyncProvider = {
    async read(_repo, _stream, options) {
      calls.push(present(options));
      if (calls.length === 1) return { items: [{ name: 'refs/heads/main', objectId: 'a' }], nextCursor: null };
      if (calls.length === 2)
        return {
          items: [{ name: 'refs/heads/obsolete', objectId: 'b' }],
          nextCursor: { token: 'stale', allRefs: true },
          unreadable: { count: 1, fields: ['objectId'] },
          unreadableIds: [{ id: 'refs/heads/main', field: 'objectId' }],
        };
      return { items: [{ name: 'refs/heads/main', objectId: 'a' }], nextCursor: null };
    },
  };
  const { store, sync, advance } = setup(provider, ['refs']);
  await sync.tick();
  advance(600000);
  await sync.tick();

  const at = BASE + 10 * 60000 + 5.5 * 3600000;
  const resumed = createSync({ store, provider, now: () => at });
  await resumed.tick();

  assert.equal(present(calls[2]).cursor, null);
  assert.equal(present(calls[2]).until, new Date(at).toISOString());
  assert.equal(store.getEntity(repo.id, 'ref', 'refs/heads/obsolete'), undefined);
  assert.equal(present(store.getStreams().find(entry => entry.stream === 'refs')).warning, undefined);
  assert.deepEqual(store.listEvents(), []);
  store.close();
});

test('a refs continuation survives busy turns beyond the snapshot expiry', async () => {
  const cursors: ReadOptions['cursor'][] = [];
  const { store, sync, advance } = setup(
    {
      async read(_repo, stream, options) {
        if (stream === 'pushes') return { items: [], nextCursor: null };
        const { cursor } = present(options);
        cursors.push(cursor);
        return {
          items: [{ name: cursor ? 'refs/heads/second' : 'refs/heads/first', objectId: 'a' }],
          nextCursor: cursor ? null : { token: 'next', allRefs: true },
        };
      },
    },
    ['refs'],
  );
  await sync.tick();
  advance(90000);
  store.saveStream({ ...pushesState(store), nextAt: new Date(BASE + 90000).toISOString() });
  await sync.tick();
  advance(90000);
  await sync.tick();
  assert.deepEqual(cursors, [null, { token: 'next', allRefs: true }]);
  assert.equal(store.getEntity(repo.id, 'ref', 'refs/heads/first')?.active, true);
  assert.equal(store.getEntity(repo.id, 'ref', 'refs/heads/second')?.active, true);
  store.close();
});

for (const interruption of ['disabled repository', 'paused checks']) {
  test(`an old refs snapshot starts over after ${interruption} while another repo stays active`, async () => {
    const cursors: ReadOptions['cursor'][] = [];
    const { store, sync, advance } = setup(
      {
        async read(current, stream, options) {
          if (watchedIdOf(current) !== repo.id || stream !== 'refs') return { items: [], nextCursor: null };
          cursors.push(present(options).cursor);
          const first = cursors.length === 1;
          return {
            items: [{ name: first ? 'refs/heads/obsolete' : 'refs/heads/current', objectId: 'a' }],
            nextCursor: first ? { token: 'old', allRefs: true } : null,
          };
        },
      },
      ['refs'],
    );
    const other = { ...repo, id: 'two', name: 'Two' };
    await sync.tick();
    if (interruption === 'disabled repository') store.saveRepo({ ...repo, disabled: true });
    else store.setSetting('refreshEnabled', false);
    store.saveRepo(other);
    for (let minute = 1; minute <= 3; minute++) {
      advance(60000);
      assert.equal(sync.refresh([other.id]).scheduled, true);
      await sync.tick();
    }
    if (interruption === 'disabled repository') {
      store.saveRepo({ ...repo, disabled: false });
      sync.refresh([repo.id]);
      for (const state of store.getStreams())
        if (state.repoId === repo.id && state.stream !== 'refs') store.saveStream({ ...state, nextAt: '2099-01-01T00:00:00Z' });
    } else {
      store.setSetting('refreshEnabled', true);
    }
    for (const state of store.getStreams()) if (state.repoId === other.id) store.saveStream({ ...state, nextAt: '2099-01-01T00:00:00Z' });
    await sync.tick();

    assert.deepEqual(cursors, [null, null]);
    assert.equal(store.getEntity(repo.id, 'ref', 'refs/heads/obsolete'), undefined);
    assert.equal(store.getEntity(repo.id, 'ref', 'refs/heads/current')?.active, true);
    store.close();
  });
}

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

test('a refs scan leaves branch updates from pushes observed between its pages intact', async () => {
  const name = 'refs/heads/hotfix/example';
  const old = 'refs/heads/gone';
  const main = 'refs/heads/main';
  let scan = 0;
  const { store, sync, advance } = setup(
    {
      async read(_repo, stream, options) {
        if (stream === 'pushes')
          return {
            items:
              scan > 0
                ? [
                    {
                      ...push(1),
                      refUpdates: [
                        { name, oldObjectId: '0'.repeat(40), newObjectId: 'b'.repeat(40) },
                        { name: main, oldObjectId: 'b'.repeat(40), newObjectId: '0'.repeat(40) },
                      ],
                    },
                  ]
                : [],
            nextCursor: null,
          };
        if (scan === 0)
          return {
            items: [
              { name: old, objectId: 'a' },
              { name: main, objectId: 'b' },
            ],
            nextCursor: null,
          };
        return {
          items: present(options).cursor || scan > 1 ? [] : [{ name: main, objectId: 'b' }],
          nextCursor: present(options).cursor ? null : { token: 'next', allRefs: true },
        };
      },
    },
    ['refs'],
  );
  const state = (stream: 'refs' | 'pushes') => present(store.getStreams().find(entry => entry.stream === stream));
  await sync.tick();
  scan = 1;
  advance(600000);
  await sync.tick();
  advance(1);
  store.saveStream({ ...state('pushes'), nextAt: new Date(BASE + 600001).toISOString() });
  await sync.tick();
  await sync.tick();

  assert.equal(store.getEntity(repo.id, 'ref', name)?.active, true);
  assert.equal(store.getEntity(repo.id, 'ref', old)?.active, false);
  assert.equal(store.getEntity(repo.id, 'ref', main)?.active, false, 'an older page cannot re-list a deleted branch');
  assert.deepEqual(
    store
      .listEvents()
      .filter(event => event.kind === 'branch-deleted' && event.data?.evidence === 'snapshot')
      .map(event => event.branch),
    ['gone'],
  );
  store.saveStream({ ...state('pushes'), nextAt: '2099-01-01T00:00:00Z' });
  scan = 2;
  advance(600000);
  await sync.tick();
  await sync.tick();
  assert.equal(store.getEntity(repo.id, 'ref', name)?.active, false, 'a later scan can retire the branch');
  store.close();
});

test('ref baseline emits nothing and only full snapshots expose newly discovered branches', async () => {
  let stage = 0;
  const provider: SyncProvider = {
    async read(_r, _s, given) {
      const { cursor } = present(given);
      if (!stage) return { items: [{ name: 'refs/heads/main', objectId: 'a' }], nextCursor: null };
      return cursor
        ? { items: [{ name: 'refs/heads/hotfix/new', objectId: 'b' }], nextCursor: null }
        : { items: [{ name: 'refs/heads/main', objectId: 'a' }], nextCursor: { skip: 1 } };
    },
  };
  const { store, sync, advance } = setup(provider, ['refs']);
  await sync.tick();
  assert.equal(store.listEvents().length, 0);
  stage = 1;
  advance(600001);
  await sync.tick();
  assert.equal(store.listEvents().length, 0);
  await sync.tick();
  const event = present(store.listEvents()[0]);
  assert.equal(event.kind, 'branch-created');
  assert.equal(event.actor, 'Unknown');
  assert.equal(dataOf(event).evidence, 'snapshot');
  assert.match(present(event.summary), /creation time and actor unknown/);
  store.close();
});

test('new remote branch from push is visible before a PR and duplicate polls do not reset seen', async () => {
  const record = push(3);
  present(record.refUpdates[0]).oldObjectId = '0'.repeat(40);
  const { store, sync, advance } = setup({
    async read() {
      return { items: [record], nextCursor: null };
    },
  });
  await sync.tick();
  const branch = present(store.listEvents().find(e => e.kind === 'branch-created'));
  assert.equal(branch.branch, 'hotfix/example');
  store.acknowledge([branch.id]);
  advance();
  await sync.tick();
  assert.equal(store.listEvents().length, 2);
  assert.equal(present(store.listEvents().find(e => e.id === branch.id)).seen, true);
  store.close();
});

test('old active build is refreshed by ID after disappearing from active results', async () => {
  const build = {
    id: 42,
    repository: { id: 'a' },
    status: 'inProgress',
    queueTime: '2026-11-01T00:00:00Z',
    sourceBranch: 'refs/heads/main',
    sourceVersion: 'a',
  };
  let active = true;
  const provider: SyncProvider = {
    async read() {
      return { items: active ? [build] : [], nextCursor: null };
    },
    async buildsById(_r, ids) {
      assert.deepEqual(ids, ['42']);
      return { items: [{ ...build, status: 'completed', result: 'failed', finishTime: '2026-11-17T10:01:00Z' }], nextCursor: null };
    },
  };
  const { store, sync, advance } = setup(provider, ['activeBuilds']);
  await sync.tick();
  active = false;
  advance();
  await sync.tick();
  assert.equal(store.listEvents().length, 2);
  assert.equal(present(store.listEvents().find(e => e.data?.result === 'failed')).seen, false);
  store.close();
});

for (const nextCursor of [null, { token: 'more' }]) {
  test(`an active build that Azure omits when asked for by ID is asked again only if the answer had more pages (${nextCursor ? 'more' : 'none'})`, async () => {
    const build = {
      id: 42,
      repository: { id: 'a' },
      status: 'inProgress',
      queueTime: '2026-11-01T00:00:00Z',
      sourceBranch: 'refs/heads/main',
      sourceVersion: 'a',
    };
    let active = true;
    const asked: string[][] = [];
    const provider: SyncProvider = {
      async read() {
        return { items: active ? [build] : [], nextCursor: null };
      },
      // Azure answers a build removed by retention with an empty list (docs/probe-results.md).
      async buildsById(_r, ids) {
        asked.push(ids);
        return { items: [], nextCursor };
      },
    };
    const { store, sync, advance } = setup(provider, ['activeBuilds']);
    await sync.tick();
    active = false;
    advance();
    await sync.tick();
    const stream = () => present(store.getStreams().find(state => state.stream === 'activeBuilds'));
    assert.equal(stream().error, null);
    store.saveStream({ ...stream(), nextAt: new Date(BASE + 2000).toISOString() });
    await sync.tick();
    assert.deepEqual(asked, nextCursor ? [['42'], ['42']] : [['42']], 'an omission on the only page ends the lookups');
    assert.equal(store.listEvents().length, 1, 'no event is invented for it');
    store.close();
  });
}

test('PR reactivation creates a fresh event even when its state matches an earlier snapshot', async () => {
  let status = 'active';
  const provider: SyncProvider = {
    async read() {
      return {
        items: [{ pullRequestId: 1, title: 'Fix', status, creationDate: '2026-11-16T10:00:00Z', sourceRefName: 'refs/heads/feature/x' }],
        nextCursor: null,
      };
    },
  };
  const { store, sync, advance } = setup(provider, ['prs']);
  await sync.tick();
  status = 'abandoned';
  advance();
  await sync.tick();
  status = 'active';
  advance();
  await sync.tick();
  assert.equal(store.listEvents().length, 3);
  assert.equal(store.listEvents({ unseen: true }).length, 2);
  store.close();
});

const cachedPr = (id: number, status = 'active') => ({
  pullRequestId: id,
  title: `PR ${id}`,
  status,
  creationDate: '2026-11-16T10:00:00Z',
  sourceRefName: `refs/heads/feature/${id}`,
});

test('a repository removed and added again starts its PR lookup order afresh', async () => {
  let listed: ReturnType<typeof cachedPr>[] = [];
  const lookups: string[] = [];
  const provider: SyncProvider = {
    async read(_r, stream) {
      return { items: stream === 'prs' ? listed : [], nextCursor: null };
    },
    async pullRequest(_repo, id) {
      lookups.push(String(id));
      return cachedPr(Number(id));
    },
  };
  const { store, sync, advance } = setup(provider, ['prs']);
  const onlyPrs = () => {
    for (const state of store.getStreams()) if (state.stream !== 'prs') store.saveStream({ ...state, nextAt: '2099-01-01T00:00:00Z' });
  };
  // PRs 1 to 4 leave the active list, and one read looks up three of them.
  const lookUpOnce = async () => {
    listed = [1, 2, 3, 4].map(id => cachedPr(id));
    advance(600000);
    await sync.tick();
    listed = [];
    advance(600000);
    await sync.tick();
  };
  await lookUpOnce();
  assert.deepEqual(lookups, ['1', '2', '3']);
  store.removeRepo(repo.id);
  advance(600000);
  await sync.tick();
  store.saveRepo(repo);
  sync.refresh();
  onlyPrs();
  // Removal deleted the PRs, and a read that misses none empties the order, so the old order could only resume for
  // active PRs saved before the re-added watch's first lookup.
  store.commitPage({
    repoId: repo.id,
    stream: 'prs',
    entities: [1, 2, 3, 4].map(id => ({ type: 'pr', id: String(id), data: { status: 'active', revision: 1 } })),
  });
  lookups.length = 0;
  advance(600000);
  await sync.tick();
  assert.deepEqual(lookups, ['1', '2', '3'], 'the order the removed watch left is not resumed');
  store.close();
});

test('a cached active PR that Azure can no longer read does not stall the prs stream or its later siblings', async () => {
  let listed = [1, 2, 3, 4, 5].map(id => cachedPr(id));
  const lookups: (number | string)[] = [];
  const unreadable: Record<string, string> = { 1: 'NOT_FOUND', 2: 'WRONG_REPOSITORY' };
  const provider: SyncProvider = {
    async read() {
      return { items: listed, nextCursor: null };
    },
    async pullRequest(_repo, id) {
      lookups.push(id);
      if (unreadable[id]) throw Object.assign(new Error('unreadable'), { code: unreadable[id] });
      return cachedPr(Number(id), 'completed');
    },
  };
  const { store, sync, advance } = setup(provider, ['prs']);
  await sync.tick();
  listed = [];
  advance();
  await sync.tick();
  const prs = () => present(store.getStreams().find(state => state.stream === 'prs'));
  assert.equal(prs().error, null, 'one unreadable PR does not fail the page');
  assert.equal(prs().lastSuccess, new Date(BASE + 2000).toISOString(), 'the listing commits');
  assert.equal(fieldsOf(store.getEntity(repo.id, 'pr', '3')).status, 'completed', 'a readable sibling commits');
  assert.equal(fieldsOf(store.getEntity(repo.id, 'pr', '1')).status, 'active', 'an unreadable PR is left as it was');
  store.saveStream({ ...prs(), nextAt: new Date(BASE + 2000).toISOString() });
  await sync.tick();
  assert.deepEqual(lookups, ['1', '2', '3', '4', '5', '1'], 'later PRs get a turn instead of the same first three');
  assert.equal(fieldsOf(store.getEntity(repo.id, 'pr', '5')).status, 'completed');
  store.close();
});

test('a removed and re-added repository starts its PR lookups and stream rotation afresh', async () => {
  let listed = [1, 2, 3, 4, 5].map(id => cachedPr(id));
  const reads: string[] = [];
  const lookups: string[] = [];
  const provider: SyncProvider = {
    async read(_repo, stream) {
      reads.push(stream);
      return { items: stream === 'prs' ? listed : [], nextCursor: null };
    },
    async pullRequest(_repo, id) {
      lookups.push(String(id));
      throw Object.assign(new Error('gone'), { code: 'NOT_FOUND' });
    },
  };
  const { store, sync, advance } = setup(provider, ['prs']);
  await sync.tick();
  listed = [];
  advance();
  await sync.tick();
  assert.deepEqual(lookups, ['1', '2', '3']);
  const onlyPrsDue = () => {
    for (const state of store.getStreams())
      if (!['prs', 'closedPrs'].includes(state.stream)) store.saveStream({ ...state, nextAt: '2099-01-01T00:00:00Z' });
  };

  store.removeRepo(repo.id);
  sync.forget(repo.id);
  store.saveRepo(repo);
  assert.equal(sync.refresh([repo.id]).scheduled, true);
  onlyPrsDue();
  store.commitPage({
    repoId: repo.id,
    stream: 'prs',
    entities: [1, 2, 3, 4, 5].map(id => ({ type: 'pr', id: String(id), data: { status: 'active' } })),
  });
  reads.length = 0;
  lookups.length = 0;
  await sync.tick();
  assert.deepEqual(reads, ['prs'], 'the old watch having read prs last does not pass the new prs stream over');
  assert.deepEqual(lookups, ['1', '2', '3'], 'lookups start at the first PR, not after the last one the old watch checked');
  store.close();
});

for (const code of ['AUTH_REQUIRED', 'INVALID_RESPONSE']) {
  test(`a ${code} error during a per-PR lookup still fails the prs page`, async () => {
    let listed = [cachedPr(1), cachedPr(2)];
    const provider: SyncProvider = {
      async read() {
        return { items: listed, nextCursor: null };
      },
      async pullRequest(_repo, id) {
        if (id === '2') throw Object.assign(new Error('failed'), { code });
        return cachedPr(Number(id), 'completed');
      },
    };
    const { store, sync, advance } = setup(provider, ['prs']);
    await sync.tick();
    const before = present(store.getStreams().find(state => state.stream === 'prs')).lastSuccess;
    listed = [];
    advance();
    await sync.tick();
    const prs = present(store.getStreams().find(state => state.stream === 'prs'));
    assert.equal(prs.error?.code, code);
    assert.equal(prs.lastSuccess, before, 'the page does not commit');
    assert.equal(fieldsOf(store.getEntity(repo.id, 'pr', '1')).status, 'active', 'no sibling commits from a failed page');
    store.close();
  });
}

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

test('editing an old active PR after baseline is unseen using observation time', async () => {
  let title = 'Original title';
  const provider: SyncProvider = {
    async read() {
      return { items: [{ pullRequestId: 1, title, status: 'active', creationDate: '2026-10-01T00:00:00Z' }], nextCursor: null };
    },
  };
  const { store, sync, advance } = setup(provider, ['prs']);
  await sync.tick();
  assert.equal(present(store.listEvents()[0]).imported, true);
  title = 'New title';
  advance();
  await sync.tick();
  const changed = present(store.listEvents({ unseen: true })[0]);
  assert.match(present(changed.title), /New title/);
  assert.equal(changed.time, '2026-11-17T10:00:02.000Z');
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

test('project-wide PR results cannot leak another repository into the watched repo', async () => {
  const provider: SyncProvider = {
    async read() {
      return {
        items: [
          { pullRequestId: 1, repository: { id: 'other' }, title: 'Other repo', status: 'active', creationDate: '2026-11-17T10:00:01Z' },
          { pullRequestId: 2, repository: { id: 'A' }, title: 'Watched repo', status: 'active', creationDate: '2026-11-17T10:00:01Z' },
        ],
        nextCursor: null,
      };
    },
  };
  const { store, sync } = setup(provider, ['prs']);
  await sync.tick();
  assert.equal(store.listEvents().length, 1);
  assert.match(present(present(store.listEvents()[0]).title), /Watched repo/);
  assert.equal(store.getEntity('one', 'pr', '1'), undefined);
  assert.equal(store.listEntities('one', 'pr').length, 1);
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

test('completed PR snapshots retain source, target and merge result without extra reads or repeat notifications', async () => {
  let reads = 0;
  const item = {
    pullRequestId: 90,
    repository: { id: 'a' },
    title: 'Fix validation',
    status: 'completed',
    sourceRefName: 'refs/heads/hotfix/validation',
    targetRefName: 'refs/heads/main',
    creationDate: '2026-11-16T09:00:00Z',
    closedDate: '2026-11-17T10:00:01Z',
    createdBy: { displayName: 'PR creator' },
    mergeStatus: 'succeeded',
    lastMergeSourceCommit: { commitId: 'source-sha' },
    lastMergeTargetCommit: { commitId: 'target-before-sha' },
    lastMergeCommit: { commitId: 'merged-result-sha' },
    completionOptions: { mergeStrategy: 'squash' },
  };
  const { store, sync, advance } = setup(
    {
      async read() {
        reads++;
        return { items: [item], nextCursor: null };
      },
    },
    ['closedPrs'],
  );
  await sync.tick();
  const event = present(store.listEvents()[0]);
  assert.equal(dataOf(event).sourceRefName, item.sourceRefName);
  assert.equal(dataOf(event).targetRefName, item.targetRefName);
  assert.equal(dataOf(event).sourceCommit, 'source-sha');
  assert.equal(dataOf(event).targetCommit, 'target-before-sha');
  assert.equal(dataOf(event).mergeCommit, 'merged-result-sha');
  assert.equal(dataOf(event).mergeStatus, 'succeeded');
  assert.equal(dataOf(event).mergeStrategy, 'squash');
  assert.equal(event.actor, 'PR creator', 'the recorded actor is the creator, not an inferred merger');
  assert.equal(event.seen, false);
  advance();
  await sync.tick();
  assert.equal(reads, 2);
  assert.equal(store.listEvents().length, 1, 'unchanged snapshots do not produce metadata-only notifications');
  store.close();
});

test('active preview and abandoned PRs never acquire actual merge-result fields', async () => {
  const items = ['active', 'abandoned'].map((status, index) => ({
    pullRequestId: 100 + index,
    status,
    repository: { id: 'a' },
    title: status,
    creationDate: '2026-11-16T09:00:00Z',
    sourceRefName: 'refs/heads/feature/work',
    targetRefName: 'refs/heads/main',
    mergeStatus: 'succeeded',
    lastMergeCommit: { commitId: 'preview-only' },
    lastMergeTargetCommit: { commitId: 'target-before' },
    completionOptions: { mergeStrategy: 'noFastForward' },
  }));
  const { store, sync } = setup(
    {
      async read() {
        return { items, nextCursor: null };
      },
    },
    ['prs'],
  );
  await sync.tick();
  assert.equal(store.listEvents().length, 2);
  for (const event of store.listEvents()) {
    assert.equal(dataOf(event).mergeCommit, undefined);
    assert.equal(dataOf(event).targetCommit, undefined);
    assert.equal(dataOf(event).mergeStatus, undefined);
    assert.equal(dataOf(event).mergeStrategy, undefined);
  }
  store.close();
});

test('ingestion stores pushes and leaves historical imports out of live ref state', async () => {
  const { store, sync } = setup({ read: async () => ({ items: [push(333)], nextCursor: null }) });
  await sync.tick();
  assert.ok(store.getEvent('one:push:333'));
  const before = store.getEntity('one', 'ref', 'refs/heads/hotfix/example');
  const historical = sync.normalize(repo, 'pushes', [push(1, '2020-01-01T00:00:00Z')], { historical: true, initialized: false });
  assert.ok(historical.events.every(event => event.imported && event.seen));
  assert.equal(
    historical.entities.some(entity => entity.type === 'ref'),
    false,
  );
  store.commitPage({ repoId: repo.id, ...historical });
  assert.deepEqual(store.getEntity('one', 'ref', 'refs/heads/hotfix/example'), before);
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
  assert.equal(store.getSetting(`baseline:${repo.id}`), '2026-11-17T10:00:00.000Z');
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

test('tag pushes become tag rows with their own change, and a tag-only push makes no push row', async () => {
  const zero = '0'.repeat(40);
  const tagPush = (pushId: number, refUpdates: object[]) => ({
    pushId,
    date: '2026-11-17T10:00:01Z',
    pushedBy: { displayName: 'A' },
    refUpdates,
  });
  const records = [
    tagPush(4, [{ name: 'refs/tags/v2', oldObjectId: 'c'.repeat(40), newObjectId: zero }]),
    tagPush(3, [{ name: 'refs/tags/v1', oldObjectId: 'a'.repeat(40), newObjectId: 'd'.repeat(40) }]),
    tagPush(2, [
      { name: 'refs/heads/main', oldObjectId: 'a'.repeat(40), newObjectId: 'b'.repeat(40) },
      { name: 'refs/tags/annotated', oldObjectId: zero, newObjectId: 'e'.repeat(40) },
    ]),
    tagPush(1, [{ name: 'refs/tags/v1', oldObjectId: zero, newObjectId: 'a'.repeat(40) }]),
  ];
  const { store, sync } = setup({
    async read() {
      return { items: records, nextCursor: null };
    },
  });
  await sync.tick();
  const tags = store.listEvents().filter(event => event.kind === 'tag');
  assert.deepEqual(
    tags.map(event => [dataOf(event).pushId, event.branch, dataOf(event).change]).sort(([a], [b]) => Number(a) - Number(b)),
    [
      [1, 'v1', 'created'],
      [2, 'annotated', 'created'],
      [3, 'v1', 'moved'],
      [4, 'v2', 'deleted'],
    ],
  );
  const pushes = store.listEvents().filter(event => event.kind === 'push');
  assert.deepEqual(
    pushes.map(event => dataOf(event).pushId),
    [2],
    'only the push that moved a branch is a push row',
  );
  assert.deepEqual(
    present(dataOf(pushes[0]).refUpdates).map(ref => ref.name),
    ['refs/heads/main'],
  );
  assert.equal(fieldsOf(store.getEntity('one', 'ref', 'refs/tags/v1')).objectId, 'd'.repeat(40));
  assert.equal(fieldsOf(store.getEntity('one', 'ref', 'refs/tags/v2')).active, false);
  store.close();
});

test('tags join the refs snapshot without announcing the tags that already existed', async () => {
  let items: AzureStreamRecord[] = [{ name: 'refs/heads/main', objectId: 'a' }];
  const { store, sync, advance } = setup(
    {
      async read() {
        return { items, nextCursor: null };
      },
    },
    ['refs'],
  );
  // An install from before tags: the refs stream is initialized and knows main, but has never recorded a tag.
  const refs = present(store.getStreams().find(state => state.stream === 'refs'));
  store.commitPage({
    repoId: 'one',
    stream: 'refs',
    state: { ...refs, initialized: true, nextAt: new Date(BASE).toISOString() },
    entities: [{ type: 'ref', id: 'refs/heads/main', data: { name: 'refs/heads/main', objectId: 'a', active: true } }],
  });
  items = [present(items[0]), { name: 'refs/tags/old', objectId: 'b' }];
  await sync.tick();
  assert.equal(store.listEvents().length, 0, 'existing tags are a baseline, not news');
  items = [present(items[0]), { name: 'refs/tags/v2', objectId: 't', peeledObjectId: 'c' }];
  advance(600001);
  await sync.tick();
  const tags = store.listEvents().filter(event => event.kind === 'tag');
  assert.deepEqual(
    tags.map(event => [event.branch, dataOf(event).change, dataOf(event).evidence]).sort(([a], [b]) => String(a).localeCompare(String(b))),
    [
      ['old', 'deleted', 'snapshot'],
      ['v2', 'created', 'snapshot'],
    ],
  );
  assert.equal(dataOf(tags.find(event => event.branch === 'v2')).peeledObjectId, 'c');
  assert.equal(
    store.listEvents().some(event => event.kind.startsWith('branch-')),
    false,
  );
  store.close();
});

test('a fork PR keeps where it came from without changing the fingerprint of PRs seen before', async () => {
  const pr = {
    pullRequestId: 5,
    title: 'Fix',
    status: 'active',
    creationDate: '2026-11-16T10:00:00Z',
    sourceRefName: 'refs/heads/fix',
    targetRefName: 'refs/heads/main',
    repository: { id: 'a' },
  };
  let items: AzureStreamRecord[] = [pr];
  const { store, sync, advance } = setup(
    {
      async read() {
        return { items, nextCursor: null };
      },
    },
    ['prs'],
  );
  await sync.tick();
  assert.equal(store.listEvents().length, 1);
  assert.equal(dataOf(store.listEvents()[0]).fork, undefined);
  assert.equal(dataOf(store.listEvents()[0]).sourceRepositoryId, 'a', 'an active PR records where its source branch lives');
  assert.equal(dataOf(store.listEvents()[0]).targetRepositoryId, 'a');
  const forkSource = { name: 'refs/heads/fix', repository: { id: 'f', name: 'One-fork', project: { name: 'Q' } } };
  const forked = { ...pr, forkSource };
  items = [forked];
  advance(600001);
  await sync.tick();
  assert.equal(store.listEvents().length, 1, 'learning the fork source is not a PR update');
  items = [{ ...forked, title: 'Fix, retitled' }];
  advance(600001);
  await sync.tick();
  const latest = present(store.listEvents().find(event => dataOf(event).fork));
  assert.deepEqual(dataOf(latest).fork, { repository: 'One-fork', project: 'Q' });
  assert.equal(dataOf(latest).sourceRepositoryId, 'f');
  store.close();
});

test('a reviewer vote is PR activity, and PRs saved before votes were recorded adopt them quietly', async () => {
  const reviewer = (id: string, vote: number, displayName = id) => ({ id, displayName, vote });
  const pr = {
    pullRequestId: 6,
    title: 'Fix',
    status: 'active',
    creationDate: '2026-11-16T10:00:00Z',
    sourceRefName: 'refs/heads/fix',
    targetRefName: 'refs/heads/main',
    repository: { id: 'a' },
    reviewers: [reviewer('ana', 0, 'Ana'), reviewer('sam', -5, 'Sam')],
  };
  let items: AzureStreamRecord[] = [pr];
  const { store, sync, advance } = setup(
    {
      async read() {
        return { items, nextCursor: null };
      },
    },
    ['prs'],
  );
  // A snapshot from before votes were part of the fingerprint.
  const prs = present(store.getStreams().find(state => state.stream === 'prs'));
  const old = { status: 'active', isDraft: false, title: 'Fix', target: 'refs/heads/main' };
  store.commitPage({
    repoId: 'one',
    stream: 'prs',
    state: { ...prs, initialized: true },
    entities: [{ type: 'pr', id: '6', data: { fingerprint: old, status: 'active', revision: 1 } }],
  });
  await sync.tick();
  assert.equal(store.listEvents().length, 0, 'existing votes are not news after an upgrade');
  items = [{ ...pr, reviewers: [reviewer('ana', 10, 'Ana'), reviewer('sam', -5, 'Sam')] }];
  advance(600001);
  await sync.tick();
  items = [{ ...pr, reviewers: [reviewer('ana', 0, 'Ana'), reviewer('sam', -5, 'Sam')] }];
  advance(600001);
  await sync.tick();
  const changes = store
    .listEvents()
    .sort((a, b) => a.observedAt.localeCompare(b.observedAt))
    .map(event => dataOf(event).voteChanges);
  assert.deepEqual(changes, [[{ name: 'Ana', vote: 10 }], [{ name: 'Ana', vote: 0 }]]);
  assert.deepEqual(
    present(dataOf(store.listEvents()[0]).reviewers)
      .map(item => [item.name, item.vote])
      .sort(([a], [b]) => String(a).localeCompare(String(b))),
    [
      ['Ana', 0],
      ['Sam', -5],
    ],
  );
  store.close();
});

test('a historical PR import keeps the event ID it had before votes were recorded', () => {
  const store = createStore();
  store.saveRepo(repo);
  const sync = createSync({ store, provider: stub<SyncProvider>({}) });
  const closed = {
    pullRequestId: 8,
    title: 'Fix',
    status: 'completed',
    closedDate: '2026-11-10T10:00:00Z',
    targetRefName: 'refs/heads/main',
    lastMergeSourceCommit: { commitId: 'c'.repeat(40) },
    repository: { id: 'a' },
    reviewers: [{ id: 'ana', displayName: 'Ana', vote: 10 }],
  };
  const { events } = sync.normalize(repo, 'closedPrs', [closed], { historical: true, initialized: false });
  const before = { status: 'completed', isDraft: false, title: 'Fix', source: 'c'.repeat(40), target: 'refs/heads/main' };
  const hash = createHash('sha256').update(JSON.stringify(before)).digest('hex').slice(0, 24);
  assert.equal(present(events[0]).id, `one:pr:history:8:${hash}`);
  store.close();
});

test('adding a reviewer who has not voted is not PR activity', async () => {
  const pr = {
    pullRequestId: 9,
    title: 'Fix',
    status: 'active',
    creationDate: '2026-11-16T10:00:00Z',
    targetRefName: 'refs/heads/main',
    repository: { id: 'a' },
    reviewers: [{ id: 'ana', displayName: 'Ana', vote: 10 }],
  };
  let items: AzureStreamRecord[] = [pr];
  const { store, sync, advance } = setup(
    {
      async read() {
        return { items, nextCursor: null };
      },
    },
    ['prs'],
  );
  await sync.tick();
  items = [{ ...pr, reviewers: [...pr.reviewers, { id: 'team', displayName: 'Team', vote: 0, isRequired: true }] }];
  advance(600001);
  await sync.tick();
  assert.equal(store.listEvents().length, 1);
  store.close();
});

test('a refs snapshot saved before tags restarts and still notices a branch deleted meanwhile', async () => {
  let cursorSeen;
  const { store, sync } = setup(
    {
      async read(_repo, _stream, given) {
        const { cursor } = present(given);
        cursorSeen = cursor;
        return { items: [{ name: 'refs/heads/main', objectId: 'a' }], nextCursor: null, restarted: true };
      },
    },
    ['refs'],
  );
  const refs = present(store.getStreams().find(state => state.stream === 'refs'));
  store.commitPage({
    repoId: 'one',
    stream: 'refs',
    state: {
      ...refs,
      initialized: true,
      cursor: { token: 'heads-only' },
      window: { since: new Date(BASE - DAY).toISOString(), until: new Date(BASE).toISOString() },
      pendingItems: [{ name: 'refs/heads/old', objectId: 'b' }],
      nextAt: new Date(BASE).toISOString(),
    },
    entities: [
      { type: 'ref', id: 'refs/heads/main', data: { name: 'refs/heads/main', objectId: 'a', active: true } },
      { type: 'ref', id: 'refs/heads/old', data: { name: 'refs/heads/old', objectId: 'b', active: true } },
    ],
  });
  await sync.tick();
  assert.deepEqual(cursorSeen, { token: 'heads-only' });
  assert.equal(fieldsOf(store.getEntity('one', 'ref', 'refs/heads/old')).active, false);
  store.close();
});

for (const [order, first, second] of [
  ['push stored first', 'pushes', 'closedPrs'],
  ['PR stored first', 'closedPrs', 'pushes'],
] satisfies [string, string, string][]) {
  test(`a completed PR links to the push that is its result with no merge call, ${order}`, async () => {
    const result = 'c'.repeat(40);
    const items: Record<string, AzureStreamRecord[]> = {
      pushes: [{ ...push(30), refUpdates: [{ name: 'refs/heads/main', oldObjectId: 'a'.repeat(40), newObjectId: result }] }],
      closedPrs: [
        {
          pullRequestId: 91,
          repository: { id: 'a' },
          title: 'Ship it',
          status: 'completed',
          sourceRefName: 'refs/heads/feature/ship',
          targetRefName: 'refs/heads/main',
          closedDate: '2026-11-17T10:00:01Z',
          lastMergeCommit: { commitId: result.toUpperCase() },
          completionOptions: { mergeStrategy: 'squash' },
        },
      ],
    };
    const offered: Record<string, AzureStreamRecord[]> = { pushes: [], closedPrs: [] };
    const store = createStore();
    store.saveRepo(repo);
    let time = BASE;
    const sync = createSync({
      store,
      provider: { read: async (_repo, stream) => ({ items: offered[stream] || [], nextCursor: null }) },
      now: () => time,
      intervalMs: 1000,
    });
    sync.refresh();
    for (const state of store.getStreams())
      if (!['pushes', 'closedPrs'].includes(state.stream)) store.saveStream({ ...state, nextAt: '2099-01-01T00:00:00Z' });
    for (const stream of [first, second]) {
      offered[stream] = present(items[stream]);
      for (let i = 0; i < 2; i++) {
        time += 2000;
        await sync.tick();
      }
    }
    const pushed = store.getEvent('one:push:30');
    assert.ok(pushed, 'push stored');
    assert.ok(
      store.listEvents().some(event => event.kind === 'pr'),
      'PR stored',
    );
    assert.equal(activityMergeBadge(pushed), 'PR evidence');
    assert.deepEqual(
      dataOf(pushed).mergeEvidence?.prs?.map(pr => [pr.pullRequestId, pr.targetRefName, pr.mergeCommit, pr.relationship]),
      [[91, 'refs/heads/main', result.toUpperCase(), 'result-introduced']],
    );
    store.close();
  });
}

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
  let backfill: ReturnType<typeof createBackfill>;
  const sync = createSync({
    store,
    provider,
    now: () => time,
    background: { history: () => backfill.tick() },
  });
  backfill = createBackfill({ store, provider, normalize: sync.normalize, now: () => time });
  store.setSetting(`baseline:${repo.id}`, new Date(BASE).toISOString());
  backfill.start(repo.id, 30);
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

/** The live client over a CLI that answers every read with these pushes, so the record guards run as in the app. */
const clientReturning = (pushes: unknown[]) => createAzureClient({ cli: { run: async () => ({ value: pushes }) } });
const pushesState = (store: ReturnType<typeof createStore>) => present(store.getStreams().find(state => state.stream === 'pushes'));

test('a push Azure returns without a pushId is skipped with a warning instead of a clean success', async () => {
  const { date, pushedBy, refUpdates } = push(1);
  const withoutId = { date, pushedBy, refUpdates };
  const { store, sync } = setup(clientReturning([push(2), withoutId]), ['pushes']);
  await sync.tick();
  const state = pushesState(store);
  assert.equal(state.error, null);
  assert.equal(state.lastSuccess, new Date(BASE).toISOString(), 'the readable push still advances the checkpoint');
  assert.ok(store.listEvents().some(event => event.id === 'one:push:2'));
  assert.deepEqual(state.warning, {
    code: 'UNREADABLE_RECORDS',
    fields: ['pushId'],
    count: 1,
    message: 'Skipped 1 record in pushes that Azure returned without a readable value for pushId.',
  });
  store.close();
});

test('a push whose refUpdates is not a list is skipped with a warning instead of failing the page', async () => {
  const { store, sync } = setup(clientReturning([push(2), { ...push(1), refUpdates: { name: 'refs/heads/main' } }]), ['pushes']);
  await sync.tick();
  const state = pushesState(store);
  assert.equal(state.error, null);
  assert.equal(state.lastSuccess, new Date(BASE).toISOString());
  assert.ok(store.listEvents().some(event => event.id === 'one:push:2'));
  assert.equal(store.getEntity(repo.id, 'push', '1'), undefined, 'the unreadable push is not stored');
  assert.deepEqual(state.warning && { fields: state.warning.fields, count: state.warning.count }, { fields: ['refUpdates'], count: 1 });
  store.close();
});

test('a push with a malformed web link still reports its tag deletion, without a warning, as on main', async () => {
  const deletion = {
    ...push(1),
    refUpdates: [{ name: 'refs/tags/v1', oldObjectId: 'c'.repeat(40), newObjectId: '0'.repeat(40) }],
    _links: { web: 'https://dev.azure.com/org/P/_git/One/pushes?pushId=1' },
  };
  const { store, sync } = setup(clientReturning([deletion]), ['pushes']);
  await sync.tick();
  const state = pushesState(store);
  assert.equal(state.error, null);
  assert.equal(state.warning ?? null, null);
  const row = present(store.listEvents().find(event => event.title === 'Tag deleted · v1'));
  assert.equal(row.url, `${repo.webUrl}/pushes?pushId=1`, 'the link falls back to the push page');
  assert.ok(store.getEntity(repo.id, 'push', '1'));
  store.close();
});

test('a stream warning stands until a later read of that stream completes with no unreadable records', async () => {
  let pushes: unknown[] = [push(2), { ...push(1), pushId: 'one' }, { ...push(3), pushId: null }];
  const client = createAzureClient({ cli: { run: async () => ({ value: pushes }) } });
  const { store, sync, advance } = setup(client, ['pushes']);
  await sync.tick();
  assert.equal(pushesState(store).warning?.count, 2);
  assert.equal(pushesState(store).warning?.message, 'Skipped 2 records in pushes that Azure returned without a readable value for pushId.');
  pushes = [push(4)];
  advance();
  await sync.tick();
  assert.equal(pushesState(store).warning ?? null, null);
  assert.ok(store.listEvents().some(event => event.id === 'one:push:4'));
  store.close();
});

test('a cached active PR that Azure returns unreadable when asked by ID is skipped with a warning, not a failed page', async () => {
  let listed = [cachedPr(1), cachedPr(2)];
  const client = createAzureClient({
    cli: {
      run: async args =>
        args[0] === 'repos'
          ? args.includes('1')
            ? { ...cachedPr(1, 'completed'), repository: { id: 'a' }, reviewers: { id: 'r' } }
            : { ...cachedPr(2, 'completed'), repository: { id: 'a' } }
          : { value: listed },
    },
  });
  const { store, sync, advance } = setup(client, ['prs']);
  await sync.tick();
  listed = [];
  advance();
  await sync.tick();
  const prs = present(store.getStreams().find(state => state.stream === 'prs'));
  assert.equal(prs.error, null, 'the unreadable PR does not fail the page');
  assert.equal(prs.lastSuccess, new Date(BASE + 2000).toISOString());
  assert.deepEqual(prs.warning && { fields: prs.warning.fields, count: prs.warning.count }, { fields: ['reviewers'], count: 1 });
  assert.equal(
    prs.warning?.message,
    'Skipped 1 record in pull requests that Azure returned without a readable value for reviewers.',
    'the message reads naturally for a plural field name',
  );
  assert.equal(fieldsOf(store.getEntity(repo.id, 'pr', '1')).status, 'active', 'the unreadable PR is left as it was');
  assert.equal(fieldsOf(store.getEntity(repo.id, 'pr', '2')).status, 'completed', 'its readable sibling commits');
  store.close();
});

test('an active build Azure returns unreadable when asked by ID is reported and asked again, not given up as gone', async () => {
  const build = { id: 42, repository: { id: 'a' }, status: 'inProgress', queueTime: '2026-11-01T00:00:00Z', sourceVersion: 'a' };
  let active = true;
  const asked: string[] = [];
  // Build reads are cached for 45 seconds of the client's clock, so each turn below starts a minute later.
  let clientTime = 0;
  const client = createAzureClient({
    now: () => clientTime,
    cli: {
      run: async args => {
        if (args.some(arg => arg.startsWith('buildIds='))) {
          asked.push('42');
          return { value: [{ ...build, status: 7 }] };
        }
        return { value: active ? [build] : [] };
      },
    },
  });
  const { store, sync, advance } = setup(client, ['activeBuilds']);
  await sync.tick();
  active = false;
  advance();
  clientTime += 60000;
  await sync.tick();
  const stream = () => present(store.getStreams().find(state => state.stream === 'activeBuilds'));
  assert.equal(stream().error, null);
  assert.deepEqual(stream().warning?.fields, ['status']);
  assert.equal(fieldsOf(store.getEntity(repo.id, 'build', '42')).status, 'inProgress', 'an unreadable answer is not a removal');
  advance(600000);
  clientTime += 60000;
  await sync.tick();
  assert.deepEqual(asked, ['42', '42'], 'it is asked for again');
  store.close();
});

test('a warning found on any page of a read stands when the read completes, and only a later clean read clears it', async () => {
  let pages: AzurePage[] = [
    { items: [push(2)], nextCursor: { skip: 1 }, unreadable: { count: 1, fields: ['pushId'] } },
    { items: [push(3)], nextCursor: null },
  ];
  const provider: SyncProvider = {
    async read(_repo, _stream, given) {
      return present(pages[present(given).cursor ? 1 : 0]);
    },
  };
  const { store, sync, advance } = setup(provider, ['pushes']);
  await sync.tick();
  await sync.tick();
  assert.equal(pushesState(store).pending, false, 'the two-page read completed');
  assert.equal(
    pushesState(store).warning?.message,
    'Skipped 1 record in pushes that Azure returned without a readable value for pushId.',
    'a clean last page does not clear what an earlier page of the same read found',
  );
  pages = [
    { items: [push(4)], nextCursor: { skip: 1 }, unreadable: { count: 1, fields: ['pushId'] } },
    { items: [push(5)], nextCursor: null, unreadable: { count: 2, fields: ['refUpdates'] } },
  ];
  advance();
  await sync.tick();
  await sync.tick();
  assert.equal(pushesState(store).pending, false);
  assert.equal(
    pushesState(store).warning?.message,
    'Skipped 3 records in pushes that Azure returned without a readable value for pushId or refUpdates.',
    'counts and fields of every page of the read add up',
  );
  pages = [
    { items: [push(6)], nextCursor: { skip: 1 } },
    { items: [push(7)], nextCursor: null },
  ];
  advance();
  await sync.tick();
  assert.equal(pushesState(store).warning?.count, 3, 'the last completed read stays visible while the next is in progress');
  await sync.tick();
  assert.equal(pushesState(store).pending, false);
  assert.equal(pushesState(store).warning ?? null, null, 'a fully clean read clears it');
  store.close();
});

test('a ref Azure returns unreadable is not reported as no longer listed, and neither is any ref until a complete snapshot', async () => {
  let refs: unknown[] = [
    { name: 'refs/heads/a', objectId: 'a' },
    { name: 'refs/heads/b', objectId: 'b' },
    { name: 'refs/heads/c', objectId: 'c' },
  ];
  const { store, sync, advance } = setup(createAzureClient({ cli: { run: async () => ({ value: refs }) } }), ['refs']);
  await sync.tick();
  refs = [
    { name: 'refs/heads/a', objectId: 'a2' },
    { name: 'refs/heads/b', objectId: 7 },
  ];
  advance(600001);
  await sync.tick();
  const state = () => present(store.getStreams().find(entry => entry.stream === 'refs'));
  const deleted = () => store.listEvents().filter(event => event.kind === 'branch-deleted');
  assert.equal(state().error, null);
  assert.deepEqual(state().warning && { fields: state().warning?.fields, count: state().warning?.count }, {
    fields: ['objectId'],
    count: 1,
  });
  assert.deepEqual(deleted(), [], 'an incomplete snapshot does not delete');
  assert.deepEqual(
    fieldsOf(store.getEntity(repo.id, 'ref', 'refs/heads/b')),
    { name: 'refs/heads/b', objectId: 'b', active: true },
    'the unreadable ref keeps its old tip',
  );
  assert.equal(
    fieldsOf(store.getEntity(repo.id, 'ref', 'refs/heads/c')).active,
    true,
    'a ref the incomplete snapshot did not list is kept too',
  );
  assert.equal(fieldsOf(store.getEntity(repo.id, 'ref', 'refs/heads/a')).objectId, 'a2', 'a readable ref still updates');
  refs = [
    { name: 'refs/heads/a', objectId: 'a2' },
    { name: 'refs/heads/b', objectId: 'b' },
  ];
  advance(600001);
  await sync.tick();
  assert.equal(state().warning ?? null, null);
  assert.deepEqual(
    deleted().map(event => event.title),
    ['Branch no longer listed · c'],
    'the next complete snapshot reports the ref it does not list',
  );
  store.close();
});

/** A provider that answers page one, or the page after it once a cursor is saved; an Error entry fails that read. */
const pagedProvider = (pages: () => (AzurePage | Error)[]): SyncProvider => ({
  async read(_repo, _stream, given) {
    const page = present(pages()[present(given).cursor ? 1 : 0]);
    if (page instanceof Error) throw page;
    return page;
  },
});

test('a read that finds other unreadable records and then fails keeps the warning of the last completed read', async () => {
  let pages: (AzurePage | Error)[] = [{ items: [push(2)], nextCursor: null, unreadable: { count: 1, fields: ['pushId'] } }];
  const { store, sync, advance } = setup(
    pagedProvider(() => pages),
    ['pushes'],
  );
  await sync.tick();
  const completed = pushesState(store).warning;
  assert.deepEqual(completed && { fields: completed.fields, count: completed.count }, { fields: ['pushId'], count: 1 });
  pages = [
    { items: [push(3)], nextCursor: { skip: 1 }, unreadable: { count: 1, fields: ['refUpdates'] } },
    Object.assign(new Error('Azure is down'), { code: 'CLI_ERROR' }),
  ];
  advance();
  await sync.tick();
  assert.equal(pushesState(store).pending, true, 'the second read is between pages');
  assert.deepEqual(pushesState(store).warning, completed, 'a page in progress does not replace the warning');
  await sync.tick();
  assert.equal(pushesState(store).error?.code, 'CLI_ERROR');
  assert.deepEqual(pushesState(store).warning, completed, 'the failed read does not replace it either');
  store.close();
});

test('a refresh that restarts a read after a page with unreadable records does not leave that page as the warning', async () => {
  const pages: (AzurePage | Error)[] = [
    { items: [push(2)], nextCursor: { skip: 1 }, unreadable: { count: 1, fields: ['pushId'] } },
    Object.assign(new Error('Azure is down'), { code: 'CLI_ERROR' }),
  ];
  const { store, sync, advance } = setup(
    pagedProvider(() => pages),
    ['pushes'],
  );
  await sync.tick();
  advance(30001);
  assert.equal(sync.refresh().scheduled, true);
  for (const state of store.getStreams()) if (state.stream !== 'pushes') store.saveStream({ ...state, nextAt: '2099-01-01T00:00:00Z' });
  await sync.tick();
  const state = pushesState(store);
  assert.equal(state.error?.code, 'CLI_ERROR');
  assert.equal(state.cursor, undefined, 'the read restarts at page one');
  assert.equal(state.warning ?? null, null, 'no read has completed with unreadable records');
  store.close();
});

test('a refs snapshot that restarts after a page with unreadable records does not leave that page as the warning', async () => {
  let calls = 0;
  const provider: SyncProvider = {
    async read() {
      calls++;
      if (calls === 1)
        return {
          items: [{ name: 'refs/heads/a', objectId: 'a' }],
          nextCursor: { token: 'old' },
          unreadable: { count: 1, fields: ['objectId'] },
        };
      return calls === 2
        ? { items: [{ name: 'refs/heads/a', objectId: 'a' }], nextCursor: { token: 'next', allRefs: true }, restarted: true }
        : { items: [{ name: 'refs/heads/b', objectId: 'b' }], nextCursor: null };
    },
  };
  const { store, sync } = setup(provider, ['refs']);
  const refs = () => present(store.getStreams().find(state => state.stream === 'refs'));
  await sync.tick();
  await sync.tick();
  assert.equal(refs().pending, true, 'the restarted snapshot is between pages');
  assert.equal(refs().unreadable, undefined, 'the restart drops what the discarded page left out');
  assert.equal(refs().warning ?? null, null, 'and does not show it as the warning');
  await sync.tick();
  assert.equal(refs().pending, false);
  assert.equal(refs().warning ?? null, null);
  store.close();
});

test('a read that fails keeps the warning of the last completed read', async () => {
  let pages: (AzurePage | Error)[] = [{ items: [push(2)], nextCursor: null, unreadable: { count: 1, fields: ['pushId'] } }];
  const { store, sync, advance } = setup(
    pagedProvider(() => pages),
    ['pushes'],
  );
  await sync.tick();
  const completed = pushesState(store).warning;
  assert.ok(completed);
  pages = [Object.assign(new Error('Azure is down'), { code: 'CLI_ERROR' })];
  advance();
  await sync.tick();
  assert.equal(pushesState(store).error?.code, 'CLI_ERROR');
  assert.deepEqual(pushesState(store).warning, completed);
  store.close();
});

test('an active PR that the active list returns unreadable is counted once and not looked up by ID', async () => {
  let listed: unknown[] = [{ ...cachedPr(1), repository: { id: 'a' } }];
  const lookups: string[] = [];
  const client = createAzureClient({
    cli: {
      run: async args => {
        if (args[0] === 'repos') {
          lookups.push(String(args[args.indexOf('--id') + 1]));
          return { ...cachedPr(1), repository: { id: 'a' }, reviewers: { id: 'r' } };
        }
        return { value: listed };
      },
    },
  });
  const { store, sync, advance } = setup(client, ['prs']);
  await sync.tick();
  listed = [{ ...cachedPr(1), repository: { id: 'a' }, reviewers: { id: 'r' } }];
  advance();
  await sync.tick();
  const prs = present(store.getStreams().find(state => state.stream === 'prs'));
  assert.deepEqual(prs.warning && { fields: prs.warning.fields, count: prs.warning.count }, { fields: ['reviewers'], count: 1 });
  assert.deepEqual(lookups, [], 'a PR the list still holds is not missing');
  assert.equal(fieldsOf(store.getEntity(repo.id, 'pr', '1')).status, 'active');
  store.close();
});

test('an active build that the active list returns unreadable is counted once and not looked up by ID', async () => {
  const build = { id: 42, repository: { id: 'a' }, status: 'inProgress', queueTime: '2026-11-01T00:00:00Z', sourceVersion: 'a' };
  let listed: unknown[] = [build];
  const lookups: string[] = [];
  let clientTime = 0;
  const client = createAzureClient({
    now: () => clientTime,
    cli: {
      run: async args => {
        const ids = args.find(arg => arg.startsWith('buildIds='));
        if (ids) {
          lookups.push(ids);
          return { value: [{ ...build, status: 7 }] };
        }
        return { value: listed };
      },
    },
  });
  const { store, sync, advance } = setup(client, ['activeBuilds']);
  await sync.tick();
  listed = [{ ...build, status: 7 }];
  advance();
  clientTime += 60000;
  await sync.tick();
  const stream = present(store.getStreams().find(state => state.stream === 'activeBuilds'));
  assert.deepEqual(stream.warning && { fields: stream.warning.fields, count: stream.warning.count }, { fields: ['status'], count: 1 });
  assert.deepEqual(lookups, [], 'a build the list still holds is not missing');
  assert.equal(fieldsOf(store.getEntity(repo.id, 'build', '42')).status, 'inProgress');
  store.close();
});

const inProgressBuild = (id: number) => ({
  id,
  repository: { id: 'a' },
  status: 'inProgress',
  queueTime: '2026-11-01T00:00:00Z',
  sourceVersion: 'a',
});
/**
 * Sync over the live client after cached in-progress builds left the active list. `answer` gives what a lookup by ID
 * returns for each build, undefined when Azure omits it.
 */
async function leftActiveBuilds(ids: number[], answer: (id: number) => unknown) {
  let listed = true;
  const asked: number[][] = [];
  // Build reads are cached for 45 seconds of the client's clock, so each turn starts a minute later.
  let clientTime = 0;
  const client = createAzureClient({
    now: () => clientTime,
    cli: {
      run: async args => {
        const query = args.find(arg => arg.startsWith('buildIds='));
        if (!query) return { value: listed ? ids.map(inProgressBuild) : [] };
        const wanted = query.slice('buildIds='.length).split(',').map(Number);
        asked.push(wanted);
        const value: unknown[] = [];
        for (const id of wanted) {
          const found = answer(id);
          if (found !== undefined) value.push(found);
        }
        return { value };
      },
    },
  });
  const { store, sync, advance } = setup(client, ['activeBuilds']);
  await sync.tick();
  listed = false;
  return {
    asked,
    store,
    async turn() {
      advance(600000);
      clientTime += 60000;
      await sync.tick();
    },
    status: (id: number) => fieldsOf(store.getEntity(repo.id, 'build', String(id))).status,
  };
}
const finishedBuild = (id: number) => ({
  ...inProgressBuild(id),
  status: 'completed',
  result: 'succeeded',
  finishTime: '2026-11-17T10:01:00Z',
});

test('a build omitted from a lookup is given up even when another build in that lookup is unreadable', async () => {
  const builds = await leftActiveBuilds([42, 43], id => (id === 42 ? { ...inProgressBuild(42), status: 7 } : undefined));
  await builds.turn();
  assert.equal(builds.status(43), 'completed', 'Azure omitted 43, so it is gone');
  assert.equal(builds.status(42), 'inProgress', 'Azure returned 42 unreadable, so it is not');
  await builds.turn();
  assert.deepEqual(builds.asked, [[42, 43], [42]]);
  builds.store.close();
});

test('no build is given up in a lookup that returns a build whose ID cannot be read', async () => {
  const builds = await leftActiveBuilds([42], () => ({ ...inProgressBuild(42), id: '42' }));
  await builds.turn();
  assert.equal(builds.status(42), 'inProgress', 'the unreadable answer may be build 42, so it is not a removal');
  await builds.turn();
  assert.deepEqual(builds.asked, [[42], [42]], 'it is looked up again');
  builds.store.close();
});

test('builds beyond the first lookup batch get a turn when one build stays unreadable and the rest were removed', async () => {
  const ids = Array.from({ length: 21 }, (_, index) => 101 + index);
  const builds = await leftActiveBuilds(ids, id =>
    id === 101 ? { ...inProgressBuild(101), status: 7 } : id === 121 ? finishedBuild(121) : undefined,
  );
  for (let turn = 0; turn < 3; turn++) await builds.turn();
  assert.ok(
    builds.asked.some(batch => batch.includes(121)),
    'build 121 is looked up',
  );
  assert.equal(builds.status(121), 'completed');
  builds.store.close();
});

test('builds beyond the first lookup batch get a turn when every build in it stays unreadable', async () => {
  const ids = Array.from({ length: 21 }, (_, index) => 101 + index);
  const builds = await leftActiveBuilds(ids, id => (id === 121 ? finishedBuild(121) : { ...inProgressBuild(id), status: 7 }));
  await builds.turn();
  await builds.turn();
  assert.equal(present(builds.asked[0]).length, 20, 'one lookup asks for at most 20 builds');
  assert.ok(
    builds.asked.some(batch => batch.includes(121)),
    'the next lookup starts after the last build asked for',
  );
  assert.equal(builds.status(121), 'completed');
  builds.store.close();
});

test('an older build is still looked up while 20 newer builds leave the active list every read (lookup unreadable once)', async () => {
  const batch = (cycle: number) => Array.from({ length: 20 }, (_, index) => String(100 + 20 * cycle + index + 1));
  let cycle = 0;
  let failed = false;
  const asked: string[][] = [];
  const provider: SyncProvider = {
    async read() {
      return { items: (cycle === 0 ? ['1'] : batch(cycle)).map(id => inProgressBuild(Number(id))), nextCursor: null };
    },
    async buildsById(_repo, ids) {
      asked.push(ids);
      if (!failed) {
        failed = true;
        const unreadableIds = ids.map(id => ({ id, field: 'status' }));
        return { items: [], nextCursor: null, unreadable: { count: ids.length, fields: ['status'] }, unreadableIds };
      }
      return { items: ids.map(id => finishedBuild(Number(id))), nextCursor: null };
    },
  };
  const { store, sync, advance } = setup(provider, ['activeBuilds']);
  await sync.tick();
  for (cycle = 1; cycle <= 6; cycle++) {
    advance(600000);
    await sync.tick();
  }
  assert.equal(fieldsOf(store.getEntity(repo.id, 'build', '1')).status, 'completed', `build 1 was looked up in ${JSON.stringify(asked)}`);
  store.close();
});

test('a repository removed and added again with no read in between starts its build lookup order afresh', async () => {
  const ids = Array.from({ length: 21 }, (_, index) => String(index + 1));
  let listed = ids;
  const asked: string[][] = [];
  const provider: SyncProvider = {
    async read(_repo, stream) {
      return { items: stream === 'activeBuilds' ? listed.map(id => inProgressBuild(Number(id))) : [], nextCursor: null };
    },
    // Every build stays unreadable, so none is given up and the turn order alone decides which builds a lookup asks for.
    async buildsById(_repo, wanted) {
      asked.push(wanted);
      const unreadableIds = wanted.map(id => ({ id, field: 'status' }));
      return { items: [], nextCursor: null, unreadable: { count: wanted.length, fields: ['status'] }, unreadableIds };
    },
  };
  const { store, sync, advance } = setup(provider, ['activeBuilds']);
  await sync.tick();
  listed = [];
  advance(600000);
  await sync.tick();
  assert.deepEqual(asked, [ids.slice(0, 20)]);

  // The remove route forgets the watch, and the repository is added again before any turn sees it gone.
  store.removeRepo(repo.id);
  sync.forget(repo.id);
  store.saveRepo(repo);
  sync.refresh();
  for (const state of store.getStreams())
    if (state.stream !== 'activeBuilds') store.saveStream({ ...state, nextAt: '2099-01-01T00:00:00Z' });
  // Removal deleted the builds, and a read that misses none empties the order, so the old order could only resume for
  // in-progress builds saved before the re-added watch's first lookup.
  store.commitPage({
    repoId: repo.id,
    stream: 'activeBuilds',
    entities: ids.map(id => ({ type: 'build', id, data: { status: 'inProgress' } })),
  });
  asked.length = 0;
  advance(600000);
  await sync.tick();
  assert.deepEqual(asked, [ids.slice(0, 20)], 'the order the removed watch left is not resumed');
  store.close();
});

test('an older build that sorts after the newer ones is still looked up while 20 of them leave the active list every read', async () => {
  // Numeric order alone would always pick the 20 newcomers below 1000; only the turn order gives build 1000 its turn.
  const batch = (cycle: number) => Array.from({ length: 20 }, (_, index) => String(20 * (cycle - 1) + index + 1));
  let cycle = 0;
  let failed = false;
  const asked: string[][] = [];
  const provider: SyncProvider = {
    async read() {
      return { items: (cycle === 0 ? ['1000'] : batch(cycle)).map(id => inProgressBuild(Number(id))), nextCursor: null };
    },
    async buildsById(_repo, ids) {
      asked.push(ids);
      if (!failed) {
        failed = true;
        const unreadableIds = ids.map(id => ({ id, field: 'status' }));
        return { items: [], nextCursor: null, unreadable: { count: ids.length, fields: ['status'] }, unreadableIds };
      }
      return { items: ids.map(id => finishedBuild(Number(id))), nextCursor: null };
    },
  };
  const { store, sync, advance } = setup(provider, ['activeBuilds']);
  await sync.tick();
  for (cycle = 1; cycle <= 6; cycle++) {
    advance(600000);
    await sync.tick();
  }
  assert.equal(
    fieldsOf(store.getEntity(repo.id, 'build', '1000')).status,
    'completed',
    `build 1000 was looked up in ${JSON.stringify(asked)}`,
  );
  store.close();
});

test('a build whose lookup came back unreadable stays in the warning on reads whose lookups skip it', async () => {
  const ids = Array.from({ length: 21 }, (_, index) => 101 + index);
  const builds = await leftActiveBuilds(ids, id =>
    id === 101 ? { ...inProgressBuild(101), status: 7 } : { ...inProgressBuild(id), status: 'none' },
  );
  const counts: (number | null)[] = [];
  for (let turn = 0; turn < 23; turn++) {
    await builds.turn();
    counts.push(present(builds.store.getStreams().find(state => state.stream === 'activeBuilds')).warning?.count ?? null);
  }
  assert.ok(
    builds.asked.some(batch => !batch.includes(101)),
    'some lookup skips build 101',
  );
  assert.deepEqual(counts, Array(23).fill(1));
  builds.store.close();
});

test('a build whose lookup came back unreadable leaves the warning once it reads, is gone, or is listed again', async () => {
  for (const outcome of ['reads', 'gone', 'listed']) {
    let answer: unknown = { ...inProgressBuild(42), status: 7 };
    let listed = true;
    let clientTime = 0;
    const client = createAzureClient({
      now: () => clientTime,
      cli: {
        run: async args =>
          args.some(arg => arg.startsWith('buildIds='))
            ? { value: answer === undefined ? [] : [answer] }
            : { value: listed ? [inProgressBuild(42)] : [] },
      },
    });
    const { store, sync, advance } = setup(client, ['activeBuilds']);
    const turn = async () => {
      advance(600000);
      clientTime += 60000;
      await sync.tick();
    };
    await sync.tick();
    listed = false;
    await turn();
    const warning = () => present(store.getStreams().find(state => state.stream === 'activeBuilds')).warning ?? null;
    assert.equal(warning()?.count, 1, outcome);
    if (outcome === 'reads') answer = finishedBuild(42);
    if (outcome === 'gone') answer = undefined;
    if (outcome === 'listed') listed = true;
    await turn();
    assert.equal(warning(), null, outcome);
    store.close();
  }
});

for (const inconclusive of ['more pages', 'unreadable builds without an ID']) {
  test(`a build whose lookup came back unreadable stays in the warning when a later lookup of it is inconclusive (${inconclusive})`, async () => {
    let listed = true;
    const asked: string[][] = [];
    const provider: SyncProvider = {
      async read() {
        return { items: listed ? [inProgressBuild(42), inProgressBuild(43)] : [], nextCursor: null };
      },
      async buildsById(_repo, ids) {
        asked.push(ids);
        if (asked.length === 1)
          return {
            items: [inProgressBuild(43)],
            nextCursor: null,
            unreadable: { count: 1, fields: ['status'] },
            unreadableIds: [{ id: '42', field: 'status' }],
          };
        return inconclusive === 'more pages'
          ? { items: [inProgressBuild(43)], nextCursor: { skip: 1 } }
          : { items: [inProgressBuild(43)], nextCursor: null, unreadable: { count: 1, fields: ['status'] } };
      },
    };
    const { store, sync, advance } = setup(provider, ['activeBuilds']);
    const state = () => present(store.getStreams().find(entry => entry.stream === 'activeBuilds'));
    await sync.tick();
    listed = false;
    advance(600000);
    await sync.tick();
    assert.deepEqual(state().unreadableLookups, [{ id: '42', field: 'status' }]);
    advance(600000);
    await sync.tick();
    assert.deepEqual(
      asked.map(ids => [...ids].sort()),
      [
        ['42', '43'],
        ['42', '43'],
      ],
    );
    assert.equal(state().error, null, 'the second lookup is a successful read');
    assert.equal(fieldsOf(store.getEntity(repo.id, 'build', '42')).status, 'inProgress');
    assert.deepEqual(state().unreadableLookups, [{ id: '42', field: 'status' }], 'build 42 is still remembered');
    assert.ok(state().warning, 'and still counted in the warning');
    store.close();
  });
}

test('an in-progress build without a readable ID in both the active list and its lookup counts once', async () => {
  // Opus's probe: the list's record of build 42 has no ID, so build 42 is missing and looked up, and that answer has none either.
  let listed: unknown[] = [inProgressBuild(42)];
  const withoutId: Record<string, unknown> = { ...inProgressBuild(42) };
  delete withoutId.id;
  // Build reads are cached for 45 seconds of the client's clock, so the second read starts a minute later.
  let clientTime = 0;
  const client = createAzureClient({
    now: () => clientTime,
    cli: { run: async args => (args.some(arg => arg.startsWith('buildIds=')) ? { value: [withoutId] } : { value: listed }) },
  });
  const { store, sync, advance } = setup(client, ['activeBuilds']);
  await sync.tick();
  listed = [withoutId];
  clientTime += 60000;
  advance(600000);
  await sync.tick();
  const warning = present(store.getStreams().find(entry => entry.stream === 'activeBuilds')).warning;
  assert.deepEqual(warning && { fields: warning.fields, count: warning.count }, { fields: ['id'], count: 1 });
  assert.equal(
    warning?.message,
    'Skipped 1 record in builds that Azure returned without a readable value for id.',
    'named as errors name it',
  );
  store.close();
});

test('an unreadable build without an ID is not counted again for a remembered build asked in the same lookup', async () => {
  let listed = true;
  let lookups = 0;
  const provider: SyncProvider = {
    async read() {
      return { items: listed ? [inProgressBuild(42)] : [], nextCursor: null };
    },
    async buildsById() {
      lookups++;
      return lookups === 1
        ? { items: [], nextCursor: null, unreadable: { count: 1, fields: ['status'] }, unreadableIds: [{ id: '42', field: 'status' }] }
        : { items: [], nextCursor: null, unreadable: { count: 1, fields: ['status'] } };
    },
  };
  const { store, sync, advance } = setup(provider, ['activeBuilds']);
  const state = () => present(store.getStreams().find(entry => entry.stream === 'activeBuilds'));
  await sync.tick();
  listed = false;
  advance(600000);
  await sync.tick();
  assert.equal(state().warning?.count, 1);
  advance(600000);
  await sync.tick();
  assert.equal(lookups, 2);
  assert.deepEqual(state().unreadableLookups, [{ id: '42', field: 'status' }]);
  assert.equal(state().warning?.count, 1, 'only build 42 was asked for, so the record without an ID may be it');
  store.close();
});

test('an unreadable build without an ID that may be a remembered build adds its fields to the warning without counting again', async () => {
  let listed = true;
  let lookups = 0;
  const provider: SyncProvider = {
    async read() {
      return { items: listed ? [inProgressBuild(42)] : [], nextCursor: null };
    },
    async buildsById() {
      lookups++;
      return lookups === 1
        ? { items: [], nextCursor: null, unreadable: { count: 1, fields: ['status'] }, unreadableIds: [{ id: '42', field: 'status' }] }
        : { items: [], nextCursor: null, unreadable: { count: 1, fields: ['id'] } };
    },
  };
  const { store, sync, advance } = setup(provider, ['activeBuilds']);
  const state = () => present(store.getStreams().find(entry => entry.stream === 'activeBuilds'));
  await sync.tick();
  listed = false;
  advance(600000);
  await sync.tick();
  advance(600000);
  await sync.tick();
  assert.equal(lookups, 2);
  assert.equal(state().warning?.count, 1);
  assert.deepEqual([...(state().warning?.fields ?? [])].sort(), ['id', 'status'], 'the warning names what this read found too');
  store.close();
});

test('a PR lookup that comes back without a pullRequestId is counted and does not stop a readable sibling', async () => {
  let listed: unknown[] = [cachedPr(1), cachedPr(2)];
  const client = createAzureClient({
    cli: {
      run: async args => {
        if (args[0] !== 'repos') return { value: listed };
        if (args.includes('1')) {
          const withoutId: Record<string, unknown> = { ...cachedPr(1, 'completed'), repository: { id: 'a' } };
          delete withoutId.pullRequestId;
          return withoutId;
        }
        return { ...cachedPr(2, 'completed'), repository: { id: 'a' } };
      },
    },
  });
  const { store, sync, advance } = setup(client, ['prs']);
  await sync.tick();
  listed = [];
  advance();
  await sync.tick();
  const prs = present(store.getStreams().find(state => state.stream === 'prs'));
  assert.equal(prs.error, null, 'the unreadable answer does not fail the page');
  assert.deepEqual(prs.warning && { fields: prs.warning.fields, count: prs.warning.count }, { fields: ['pullRequestId'], count: 1 });
  assert.equal(fieldsOf(store.getEntity(repo.id, 'pr', '1')).status, 'active', 'the unreadable PR is left as it was');
  assert.equal(fieldsOf(store.getEntity(repo.id, 'pr', '2')).status, 'completed', 'its readable sibling is looked up and commits');
  store.close();
});

test('a PR lookup answer without a readable ID counts only in its own read and is not remembered', async () => {
  // Sol's probe: six cached PRs leave the active list; the first batch's answer for PR 1 has no pullRequestId.
  let listed: unknown[] = [1, 2, 3, 4, 5, 6].map(id => cachedPr(id));
  const asked: string[] = [];
  const client = createAzureClient({
    cli: {
      run: async args => {
        if (args[0] !== 'repos') return { value: listed };
        const id = String(args[args.indexOf('--id') + 1]);
        asked.push(id);
        const answer: Record<string, unknown> = { ...cachedPr(Number(id), 'completed'), repository: { id: 'a' } };
        if (id === '1') delete answer.pullRequestId;
        return answer;
      },
    },
  });
  const { store, sync, advance } = setup(client, ['prs']);
  const prs = () => present(store.getStreams().find(state => state.stream === 'prs'));
  await sync.tick();
  listed = [];
  advance();
  await sync.tick();
  assert.deepEqual(prs().warning && { fields: prs().warning?.fields, count: prs().warning?.count }, {
    fields: ['pullRequestId'],
    count: 1,
  });
  advance(600000);
  await sync.tick();
  assert.deepEqual(asked, ['1', '2', '3', '4', '5', '6']);
  assert.equal(prs().warning ?? null, null, 'the second read looked up only readable PRs');
  assert.equal(prs().unreadableLookups, undefined, 'nothing is remembered');
  store.close();
});

test('an active PR without a readable ID in both the list and its lookup counts once', async () => {
  // Opus's probe: the list's record of PR 1 has no ID, so PR 1 is missing and looked up, and that answer has none either.
  let listed: unknown[] = [cachedPr(1)];
  const withoutId = (status: string) => {
    const record: Record<string, unknown> = { ...cachedPr(1, status), repository: { id: 'a' } };
    delete record.pullRequestId;
    return record;
  };
  const client = createAzureClient({ cli: { run: async args => (args[0] !== 'repos' ? { value: listed } : withoutId('active')) } });
  const { store, sync, advance } = setup(client, ['prs']);
  await sync.tick();
  listed = [withoutId('active')];
  advance();
  await sync.tick();
  const warning = present(store.getStreams().find(state => state.stream === 'prs')).warning;
  assert.deepEqual(warning && { fields: warning.fields, count: warning.count }, { fields: ['pullRequestId'], count: 1 });
  store.close();
});

test('a PR whose lookup came back unreadable stays in the warning on reads whose lookups skip it, until it reads', async () => {
  let listed = [1, 2, 3, 4, 5].map(id => cachedPr(id));
  let readable = false;
  const lookups: string[] = [];
  const provider: SyncProvider = {
    async read() {
      return { items: listed, nextCursor: null };
    },
    async pullRequest(_repo, id) {
      lookups.push(String(id));
      if (String(id) === '1' && readable) return cachedPr(1, 'completed');
      if (String(id) === '1') throw Object.assign(new Error('unreadable'), { code: 'UNREADABLE_RECORD', field: 'reviewers' });
      throw Object.assign(new Error('gone'), { code: 'NOT_FOUND' });
    },
  };
  const { store, sync, advance } = setup(provider, ['prs']);
  await sync.tick();
  listed = [];
  const warning = () => {
    const found = present(store.getStreams().find(state => state.stream === 'prs')).warning;
    return found ? { fields: found.fields, count: found.count } : null;
  };
  for (let turn = 0; turn < 3; turn++) {
    advance(600000);
    await sync.tick();
    assert.deepEqual(warning(), { fields: ['reviewers'], count: 1 }, `read ${turn + 1}`);
  }
  assert.deepEqual(lookups, ['1', '2', '3', '4', '5', '1', '2', '3', '4'], 'the third read did not look up PR 1');
  readable = true;
  advance(600000);
  await sync.tick();
  assert.equal(lookups.at(-2), '1');
  assert.equal(warning(), null, 'a lookup that reads it clears it');
  store.close();
});

test('a PR whose lookup came back unreadable leaves the warning once the active list holds it again', async () => {
  let listed = [1, 2, 3, 4].map(id => cachedPr(id));
  const provider: SyncProvider = {
    async read() {
      return { items: listed, nextCursor: null };
    },
    async pullRequest(_repo, id) {
      if (String(id) === '1') throw Object.assign(new Error('unreadable'), { code: 'UNREADABLE_RECORD', field: 'reviewers' });
      throw Object.assign(new Error('gone'), { code: 'NOT_FOUND' });
    },
  };
  const { store, sync, advance } = setup(provider, ['prs']);
  await sync.tick();
  listed = [];
  advance(600000);
  await sync.tick();
  assert.equal(present(store.getStreams().find(state => state.stream === 'prs')).warning?.count, 1);
  listed = [cachedPr(1)];
  advance(600000);
  await sync.tick();
  assert.equal(present(store.getStreams().find(state => state.stream === 'prs')).warning ?? null, null);
  store.close();
});

test("a build Azure returns without a repository.id is skipped with a warning, and another repository's build is still left out", async () => {
  const build = (id: number) => ({ ...inProgressBuild(id), status: 'completed', result: 'succeeded', finishTime: '2026-11-17T10:00:01Z' });
  const withoutRepository: Record<string, unknown> = build(2);
  delete withoutRepository.repository;
  const client = createAzureClient({
    cli: {
      run: async () => ({
        value: [
          { ...build(1), repository: null },
          withoutRepository,
          { ...build(3), repository: {} },
          { ...build(4), repository: { id: 'other' } },
          build(5),
        ],
      }),
    },
  });
  const { store, sync } = setup(client, ['builds']);
  await sync.tick();
  const state = present(store.getStreams().find(entry => entry.stream === 'builds'));
  assert.equal(state.error, null);
  assert.deepEqual(state.warning && { fields: state.warning.fields, count: state.warning.count }, { fields: ['repository.id'], count: 3 });
  assert.deepEqual(
    store.listEntities(repo.id, 'build').map(entry => entry.id),
    ['5'],
    'only the readable build of this repository is stored',
  );
  store.close();
});

test('a branch unreadable in the first refs snapshot is not announced as first seen once it reads', async () => {
  let refs: unknown[] = [
    { name: 'refs/heads/main', objectId: 'a' },
    { name: 'refs/heads/b', objectId: 7 },
  ];
  const { store, sync, advance } = setup(createAzureClient({ cli: { run: async () => ({ value: refs }) } }), ['refs']);
  const state = () => present(store.getStreams().find(entry => entry.stream === 'refs'));
  await sync.tick();
  assert.equal(state().initialized, false, 'an incomplete snapshot is no baseline');
  assert.equal(store.getEntity(repo.id, 'ref-baseline', 'tags'), undefined);
  refs = [
    { name: 'refs/heads/main', objectId: 'a' },
    { name: 'refs/heads/b', objectId: 'b' },
  ];
  advance(600001);
  await sync.tick();
  assert.equal(state().initialized, true);
  assert.deepEqual(
    store.listEvents().map(event => event.title),
    [],
    'no branch is announced as first seen',
  );
  store.close();
});

test('a branch listed only by an incomplete first snapshot is not saved, and no event follows when complete snapshots omit it', async () => {
  let refs: unknown[] = [
    { name: 'refs/heads/main', objectId: 'a' },
    { name: 'refs/heads/gone', objectId: 'b' },
    { name: 'refs/heads/bad', objectId: 7 },
  ];
  const { store, sync, advance } = setup(createAzureClient({ cli: { run: async () => ({ value: refs }) } }), ['refs']);
  await sync.tick();
  assert.equal(
    store.getEntity(repo.id, 'ref', 'refs/heads/gone'),
    undefined,
    'an incomplete snapshot before the baseline saves no new ref',
  );
  refs = [{ name: 'refs/heads/main', objectId: 'a' }];
  advance(600001);
  await sync.tick();
  assert.equal(present(store.getStreams().find(entry => entry.stream === 'refs')).initialized, true);
  assert.equal(store.getEntity(repo.id, 'ref', 'refs/heads/gone'), undefined);
  advance(600001);
  await sync.tick();
  assert.deepEqual(
    store.listEvents().map(event => event.title),
    [],
    'it is not reported as no longer listed one snapshot later',
  );
  store.close();
});

test('a branch a push recorded before the first complete refs snapshot is reported once a later snapshot still does not list it', async () => {
  const created = push(3);
  present(created.refUpdates[0]).oldObjectId = '0'.repeat(40);
  present(created.refUpdates[0]).name = 'refs/heads/feature';
  const { store, sync, advance } = setup(
    {
      async read(_r, stream) {
        return { items: stream === 'pushes' ? [created] : [{ name: 'refs/heads/main', objectId: 'a' }], nextCursor: null };
      },
    },
    ['pushes'],
  );
  await sync.tick();
  assert.equal(fieldsOf(store.getEntity(repo.id, 'ref', 'refs/heads/feature')).evidence, 'push');
  const stream = (name: string) => present(store.getStreams().find(entry => entry.stream === name));
  const refs = () => stream('refs');
  store.saveStream({ ...stream('pushes'), nextAt: '2099-01-01T00:00:00Z' });
  store.saveStream({ ...refs(), nextAt: new Date(BASE).toISOString() });
  const titles = () =>
    store
      .listEvents()
      .map(event => event.title)
      .filter(title => title?.startsWith('Branch no longer'));
  advance(600001);
  await sync.tick();
  assert.equal(refs().initialized, true);
  assert.deepEqual(titles(), [], 'the baseline reports nothing');
  advance(600001);
  await sync.tick();
  assert.deepEqual(titles(), ['Branch no longer listed · feature'], 'as on main, a branch a push recorded is reported');
  store.close();
});

test('a branch and tag a push recorded and an incomplete snapshot listed are reported once complete snapshots omit them', async () => {
  const created = push(3);
  created.refUpdates = [
    { name: 'refs/heads/feature', oldObjectId: '0'.repeat(40), newObjectId: 'b'.repeat(40) },
    { name: 'refs/tags/v1', oldObjectId: '0'.repeat(40), newObjectId: 'c'.repeat(40) },
  ];
  let snapshot: AzurePage = {
    items: [
      { name: 'refs/heads/main', objectId: 'a' },
      { name: 'refs/heads/feature', objectId: 'b'.repeat(40) },
      { name: 'refs/tags/v1', objectId: 'c'.repeat(40) },
    ],
    nextCursor: null,
    unreadable: { count: 1, fields: ['objectId'] },
  };
  const { store, sync, advance } = setup(
    {
      async read(_r, stream) {
        return stream === 'pushes' ? { items: [created], nextCursor: null } : snapshot;
      },
    },
    ['pushes'],
  );
  await sync.tick();
  const stream = (name: string) => present(store.getStreams().find(entry => entry.stream === name));
  const refs = () => stream('refs');
  store.saveStream({ ...stream('pushes'), nextAt: '2099-01-01T00:00:00Z' });
  store.saveStream({ ...refs(), nextAt: new Date(BASE).toISOString() });
  advance(600001);
  await sync.tick();
  assert.equal(refs().initialized, false, 'the incomplete snapshot is no baseline');
  const titles = () =>
    store
      .listEvents()
      .map(event => event.title)
      .filter(title => /no longer listed/.test(title ?? ''));
  snapshot = { items: [{ name: 'refs/heads/main', objectId: 'a' }], nextCursor: null };
  advance(600001);
  await sync.tick();
  assert.equal(refs().initialized, true);
  assert.deepEqual(titles(), [], 'the baseline reports nothing');
  advance(600001);
  await sync.tick();
  assert.deepEqual(
    titles().sort((a, b) => (a ?? '').localeCompare(b ?? '')),
    ['Branch no longer listed · feature', 'Tag no longer listed · v1'],
    'as on main, the next complete snapshot reports both',
  );
  store.close();
});

/** A refs stream initialized before tags joined the snapshot: no tag baseline, and tag v1 recorded by a push. */
async function legacyRefsWithPushedTag(snapshot: () => AzurePage | Promise<AzurePage>) {
  const created = push(3);
  created.refUpdates = [{ name: 'refs/tags/v1', oldObjectId: '0'.repeat(40), newObjectId: 'c'.repeat(40) }];
  let pushes = [created];
  let time = BASE;
  const fixture = setup(
    {
      async read(_r, stream) {
        return stream === 'pushes' ? { items: pushes, nextCursor: null } : snapshot();
      },
    },
    ['pushes'],
  );
  const { store, sync } = fixture;
  await sync.tick();
  const stream = (name: string) => present(store.getStreams().find(entry => entry.stream === name));
  const due = (name: string, at: number | null) =>
    store.saveStream({ ...stream(name), nextAt: at === null ? '2099-01-01T00:00:00Z' : new Date(at).toISOString() });
  due('pushes', null);
  store.saveStream({ ...stream('refs'), initialized: true, nextAt: new Date(BASE).toISOString() });
  assert.equal(fieldsOf(store.getEntity(repo.id, 'ref', 'refs/tags/v1')).evidence, 'push');
  assert.equal(store.getEntity(repo.id, 'ref-baseline', 'tags'), undefined);
  const titles = () =>
    store
      .listEvents()
      .map(event => event.title)
      .filter(title => /^Tag (no longer listed|first seen)/.test(title ?? ''));
  /** Reads one more push, which creates `name`, while the refs stream waits. */
  const pushTag = async (id: number, name: string) => {
    const next = push(id);
    next.refUpdates = [{ name, oldObjectId: '0'.repeat(40), newObjectId: 'e'.repeat(40) }];
    pushes = [next];
    const refsAt = Date.parse(String(stream('refs').nextAt));
    due('refs', null);
    due('pushes', time);
    await sync.tick();
    due('pushes', null);
    due('refs', refsAt);
  };
  const advance = (ms: number) => {
    time += ms;
    fixture.advance(ms);
  };
  return { ...fixture, advance, titles, pushTag };
}

test('before the tag baseline, a tag a push recorded and an incomplete snapshot listed is reported once a complete snapshot omits it', async () => {
  let snapshot: AzurePage = {
    items: [
      { name: 'refs/heads/main', objectId: 'a' },
      { name: 'refs/tags/v1', objectId: 'c'.repeat(40) },
      { name: 'refs/tags/v2', objectId: 'd'.repeat(40) },
    ],
    nextCursor: null,
    unreadable: { count: 1, fields: ['objectId'] },
  };
  const { store, sync, advance, titles } = await legacyRefsWithPushedTag(() => snapshot);
  advance(600001);
  await sync.tick();
  assert.ok(store.getEntity(repo.id, 'ref-baseline', 'tags'), 'as on main, the incomplete snapshot is the tag baseline');
  assert.equal(
    store.getEntity(repo.id, 'ref', 'refs/tags/v2'),
    undefined,
    'its unreadable ref has no readable name, so every tag is uncertain and v2 is not created',
  );
  snapshot = { items: [{ name: 'refs/heads/main', objectId: 'a' }], nextCursor: null };
  advance(600001);
  await sync.tick();
  assert.equal(fieldsOf(store.getEntity(repo.id, 'ref', 'refs/tags/v1')).active, false);
  assert.deepEqual(titles(), ['Tag no longer listed · v1'], 'as on main');
  snapshot = {
    items: [
      { name: 'refs/heads/main', objectId: 'a' },
      { name: 'refs/tags/v2', objectId: 'd'.repeat(40) },
    ],
    nextCursor: null,
  };
  advance(600001);
  await sync.tick();
  assert.deepEqual(
    titles(),
    ['Tag first seen · v2', 'Tag no longer listed · v1'],
    'v1 is reported only once, and the complete snapshot cleared the uncertain tags, so v2 is announced as on main',
  );
  store.close();
});

test('before the tag baseline, a tag a push records after an incomplete snapshot is reported once a complete snapshot omits it', async () => {
  let snapshot: AzurePage = {
    items: [{ name: 'refs/heads/main', objectId: 'a' }],
    nextCursor: null,
    unreadable: { count: 1, fields: ['objectId'] },
  };
  const { store, sync, advance, titles, pushTag } = await legacyRefsWithPushedTag(() => snapshot);
  advance(600001);
  await sync.tick();
  assert.equal(fieldsOf(store.getEntity(repo.id, 'ref', 'refs/tags/v1')).active, true, 'v1 is uncertain, so it is not put away');
  await pushTag(4, 'refs/tags/v3');
  assert.equal(fieldsOf(store.getEntity(repo.id, 'ref', 'refs/tags/v3')).evidence, 'push');
  snapshot = { items: [{ name: 'refs/heads/main', objectId: 'a' }], nextCursor: null };
  advance(600001);
  await sync.tick();
  assert.ok(store.getEntity(repo.id, 'ref-baseline', 'tags'));
  assert.deepEqual(
    titles().sort((a, b) => (a ?? '').localeCompare(b ?? '')),
    ['Tag no longer listed · v1', 'Tag no longer listed · v3'],
    'main took the incomplete snapshot for the tag baseline and reports v3; v1 is reported too, since the unreadable record may have been it',
  );
  store.close();
});

test('before the tag baseline, a tag a push recorded that the first complete snapshot omits is put away without an event, as on main', async () => {
  const { store, sync, advance, titles } = await legacyRefsWithPushedTag(() => ({
    items: [{ name: 'refs/heads/main', objectId: 'a' }],
    nextCursor: null,
  }));
  advance(600001);
  await sync.tick();
  assert.ok(store.getEntity(repo.id, 'ref-baseline', 'tags'));
  assert.equal(fieldsOf(store.getEntity(repo.id, 'ref', 'refs/tags/v1')).active, false);
  advance(600001);
  await sync.tick();
  assert.deepEqual(titles(), []);
  store.close();
});

test('before the tag baseline, a tag that no unreadable ref of an incomplete snapshot could be is put away without an event, as on main', async () => {
  // Sol's probe: the incomplete snapshot's only unreadable ref is a named branch, so it cannot be tag v1.
  let refs: unknown[] = [
    { name: 'refs/heads/main', objectId: 'a' },
    { name: 'refs/heads/feature', objectId: 7 },
  ];
  const client = createAzureClient({ cli: { run: async () => ({ value: refs }) } });
  const { store, sync, advance, titles } = await legacyRefsWithPushedTag(() => client.read(repo, 'refs'));
  advance(600001);
  await sync.tick();
  assert.ok(store.getEntity(repo.id, 'ref-baseline', 'tags'), 'as on main, the incomplete snapshot is the tag baseline');
  assert.equal(fieldsOf(store.getEntity(repo.id, 'ref', 'refs/tags/v1')).active, false, 'and puts v1 away there');
  refs = [{ name: 'refs/heads/main', objectId: 'a' }];
  advance(600001);
  await sync.tick();
  assert.deepEqual(titles(), [], 'as on main, no event follows');
  store.close();
});

for (const pushedBetween of [false, true])
  test(`before the tag baseline, an incomplete snapshot is the tag baseline for its readable tags, so a tag it listed${pushedBetween ? ' and a push then recorded' : ''} is reported once a complete snapshot omits it, as on main`, async () => {
    // Sol's probes: the incomplete snapshot lists v1 and its only unreadable ref is a named branch.
    let refs: unknown[] = [
      { name: 'refs/heads/main', objectId: 'a' },
      { name: 'refs/tags/v1', objectId: 'c'.repeat(40) },
      { name: 'refs/heads/feature', objectId: 7 },
    ];
    const client = createAzureClient({ cli: { run: async () => ({ value: refs }) } });
    const { store, sync, advance, titles, pushTag } = await legacyRefsWithPushedTag(() => client.read(repo, 'refs'));
    advance(600001);
    await sync.tick();
    assert.ok(store.getEntity(repo.id, 'ref-baseline', 'tags'), 'as on main, the incomplete snapshot is the tag baseline');
    if (pushedBetween) await pushTag(4, 'refs/tags/v1');
    refs = [
      { name: 'refs/heads/main', objectId: 'a' },
      { name: 'refs/heads/feature', objectId: 'f' },
    ];
    advance(600001);
    await sync.tick();
    assert.deepEqual(titles(), ['Tag no longer listed · v1'], 'main reports v1');
    advance(600001);
    await sync.tick();
    assert.deepEqual(titles(), ['Tag no longer listed · v1'], 'and only once');
    store.close();
  });

test('before the tag baseline, a tag that an unreadable ref of any incomplete snapshot may be is reported once a complete snapshot omits it', async () => {
  let refs: unknown[] = [
    { name: 'refs/heads/main', objectId: 'a' },
    { name: 'refs/tags/v1', objectId: 7 },
  ];
  const client = createAzureClient({ cli: { run: async () => ({ value: refs }) } });
  const { store, sync, advance, titles } = await legacyRefsWithPushedTag(() => client.read(repo, 'refs'));
  advance(600001);
  await sync.tick();
  // A later incomplete snapshot whose unreadable ref is another one does not make v1 certain.
  refs = [
    { name: 'refs/heads/main', objectId: 'a' },
    { name: 'refs/heads/feature', objectId: 7 },
  ];
  advance(600001);
  await sync.tick();
  assert.equal(fieldsOf(store.getEntity(repo.id, 'ref', 'refs/tags/v1')).active, true, 'neither incomplete snapshot puts v1 away');
  refs = [{ name: 'refs/heads/main', objectId: 'a' }];
  advance(600001);
  await sync.tick();
  assert.deepEqual(titles(), ['Tag no longer listed · v1'], 'as on main, which read v1 with its malformed objectId and then missed it');
  store.close();
});

test('a tag unreadable in the first refs snapshot with tags is not announced as first seen once it reads', async () => {
  let refs: unknown[] = [
    { name: 'refs/heads/main', objectId: 'a' },
    { name: 'refs/tags/v0', objectId: 'b' },
    { name: 'refs/tags/v1', objectId: 7 },
  ];
  const { store, sync, advance } = setup(createAzureClient({ cli: { run: async () => ({ value: refs }) } }), ['refs']);
  const state = () => present(store.getStreams().find(entry => entry.stream === 'refs'));
  // A stream initialized by a branch-only snapshot, before tags joined it, has no tag baseline yet.
  store.commitPage({
    repoId: repo.id,
    stream: 'refs',
    entities: [{ type: 'ref', id: 'refs/heads/main', data: { name: 'refs/heads/main', objectId: 'a', active: true } }],
  });
  store.saveStream({ ...state(), initialized: true, lastSuccess: new Date(BASE - 600000).toISOString() });
  await sync.tick();
  assert.ok(store.getEntity(repo.id, 'ref-baseline', 'tags'), 'as on main, the incomplete snapshot is the tag baseline');
  assert.equal(fieldsOf(store.getEntity(repo.id, 'ref', 'refs/tags/v0')).active, true, 'it records its readable tags');
  assert.equal(store.getEntity(repo.id, 'ref', 'refs/tags/v1'), undefined, 'but not v1, which its unreadable ref names');
  refs = [
    { name: 'refs/heads/main', objectId: 'a' },
    { name: 'refs/tags/v0', objectId: 'b' },
    { name: 'refs/tags/v1', objectId: 'c' },
  ];
  advance(600001);
  await sync.tick();
  assert.equal(fieldsOf(store.getEntity(repo.id, 'ref', 'refs/tags/v1')).active, true);
  assert.deepEqual(
    store.listEvents().map(event => event.title),
    [],
    'no tag is announced as first seen',
  );
  store.close();
});

test('refs saved from a snapshot in progress are checked again when the snapshot resumes', async () => {
  let resumed = false;
  const provider: SyncProvider = {
    async read() {
      return resumed
        ? { items: [], nextCursor: null }
        : {
            items: [
              { name: 'refs/heads/a', objectId: 'a' },
              { name: 'refs/heads/b', objectId: 'b' },
            ],
            nextCursor: null,
          };
    },
  };
  const { store, sync, advance } = setup(provider, ['refs']);
  const state = () => present(store.getStreams().find(entry => entry.stream === 'refs'));
  await sync.tick();
  advance(600001);
  // Saved by a version that did not check refs as it read them.
  store.saveStream({
    ...state(),
    window: { since: new Date(BASE).toISOString(), until: new Date(BASE + 600001).toISOString() },
    windowGeneration: state().refreshGeneration ?? 0,
    pending: true,
    cursor: { token: 'next', allRefs: true },
    pendingItems: [
      { name: 'refs/heads/a', objectId: 'a' },
      { name: 'refs/heads/b', objectId: '' },
    ],
    nextAt: new Date(BASE).toISOString(),
  });
  resumed = true;
  await sync.tick();
  assert.equal(state().pending, false);
  assert.deepEqual(state().warning && { fields: state().warning?.fields, count: state().warning?.count }, {
    fields: ['objectId'],
    count: 1,
  });
  assert.equal(
    fieldsOf(store.getEntity(repo.id, 'ref', 'refs/heads/b')).objectId,
    'b',
    'the saved ref that fails the check is not applied',
  );
  assert.deepEqual(
    store.listEvents().filter(event => event.kind === 'branch-deleted'),
    [],
  );
  store.close();
});
