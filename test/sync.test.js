import test from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../server/store.js';
import { createSync } from '../server/sync.js';
const repo = { id: 'one', name: 'One', azureId: 'a', organization: 'https://dev.azure.com/org', project: 'P', webUrl: 'https://dev.azure.com/org/P/_git/One' };
const BASE = Date.parse('2026-11-17T10:00:00Z');
function setup(provider, streams = ['pushes']) {
  const store = createStore();
  store.saveRepo(repo);
  let time = BASE;
  const sync = createSync({ store, provider, now: () => time, intervalMs: 1000 });
  sync.refresh();
  for (const state of store.getStreams()) if (!streams.includes(state.stream)) store.saveStream({ ...state, nextAt: '2099-01-01T00:00:00Z' });
  return { store, sync, advance(ms = 2000) { time += ms; } };
}
const push = (id, date = '2026-11-17T10:00:01Z') => ({ pushId: id, date, pushedBy: { displayName: 'A' }, refUpdates: [{ name: 'refs/heads/hotfix/example', oldObjectId: 'a'.repeat(40), newObjectId: 'b'.repeat(40) }] });

test('manual refresh drains its paginated work once while automatic checks stay off', async () => {
  const store = createStore();
  store.saveRepo(repo);
  store.saveRepo({ ...repo, id: 'two', name: 'Disabled', disabled: true });
  store.setSetting('refreshEnabled', false);
  let calls = 0, time = BASE;
  const sync = createSync({ store, now: () => time, provider: { async read(current, stream, { cursor }) {
    calls++; assert.equal(current.id, repo.id);
    return { items: [], nextCursor: stream === 'pushes' && !cursor ? { skip: 1 } : null };
  } } });
  await sync.tick(); assert.equal(calls, 0);
  assert.equal(sync.refresh([repo.id]).scheduled, true);
  assert.equal(sync.refresh([repo.id]).cooldown, true);
  for (let i = 0; i < 7; i++) await sync.tick();
  assert.equal(calls, 7);
  assert.ok(store.getStreams().filter(state => state.repoId === repo.id).every(state => state.initialized));
  time += 600001; await sync.tick();
  assert.equal(calls, 7, 'manual work must not turn automatic polling back on');
  store.close();
});

test('newest-first push history cannot resurrect a deleted ref across pages or snapshots', async () => {
  const name = 'refs/heads/hotfix/example';
  const deletion = { ...push(20, '2026-11-17T10:00:02Z'), refUpdates: [{ name, oldObjectId: 'b'.repeat(40), newObjectId: '0'.repeat(40) }] };
  const creation = { ...push(10), refUpdates: [{ name, oldObjectId: '0'.repeat(40), newObjectId: 'b'.repeat(40) }] };
  let acrossPages = false;
  const provider = { async read(_repo, stream, { cursor }) {
    if (stream === 'refs') return { items: [], nextCursor: null };
    if (!acrossPages) return { items: [deletion, creation], nextCursor: null };
    return { items: cursor ? [{ ...creation, pushId: 30 }] : [{ ...deletion, pushId: 40 }], nextCursor: cursor ? null : { skip: 1 } };
  } };
  const { store, sync, advance } = setup(provider, ['pushes']);
  // Baseline ref stream already exists; an empty reconciliation should add no duplicate deletion.
  const refs = store.getStreams().find(state => state.stream === 'refs');
  store.saveStream({ ...refs, initialized: true });
  await sync.tick();
  assert.equal(store.getEntity(repo.id, 'ref', name).active, false);
  acrossPages = true; advance(); await sync.tick(); await sync.tick();
  assert.equal(store.getEntity(repo.id, 'ref', name).active, false);
  const before = store.listEvents().filter(event => event.kind === 'branch-deleted').length;
  store.saveStream({ ...refs, initialized: true, nextAt: new Date(BASE).toISOString() });
  await sync.tick();
  assert.equal(store.listEvents().filter(event => event.kind === 'branch-deleted').length, before);
  store.close();
});

test('quiet streams and a background server reduce cadence without per-branch reads', async () => {
  const store = createStore();
  store.saveRepo(repo);
  let time = BASE, foreground = true, reads = 0;
  const sync = createSync({ store, now: () => time, isForeground: () => foreground, provider: { async read() { reads++; return { items: [], nextCursor: null }; } } });
  sync.refresh();
  for (const stream of store.getStreams()) if (stream.stream !== 'pushes') store.saveStream({ ...stream, nextAt: '2099-01-01T00:00:00Z' });
  await sync.tick();
  assert.equal(Date.parse(store.getStreams().find(s => s.stream === 'pushes').nextAt) - time, 180000);
  time += 180000;
  await sync.tick();
  assert.equal(Date.parse(store.getStreams().find(s => s.stream === 'pushes').nextAt) - time, 300000);
  time += 300000; foreground = false;
  await sync.tick();
  assert.equal(Date.parse(store.getStreams().find(s => s.stream === 'pushes').nextAt) - time, 300000);
  assert.equal(reads, 3);
  store.close();
});

test('failed page preserves cursor across sync restart, completed window deduplicates overlap', async () => {
  let calls = 0;
  const provider = { async read(_repo, _stream, options) {
    calls++;
    if (!options.cursor) return { items: [push(1, '2026-11-16T10:00:00Z')], nextCursor: { skip: 1 } };
    if (calls === 2) throw Object.assign(new Error('Network unavailable'), { code: 'NETWORK' });
    return { items: [push(2)], nextCursor: null };
  } };
  const { store, sync, advance } = setup(provider);
  await sync.tick();
  assert.equal(store.getStreams().find((s) => s.stream === 'pushes').cursor.skip, 1);
  await sync.tick();
  assert.equal(store.getStreams().find((s) => s.stream === 'pushes').lastSuccess, undefined);
  assert.equal(store.listEvents().length, 1);
  advance();
  const resumed = createSync({ store, provider, now: () => BASE + 2000, intervalMs: 1000 });
  await resumed.tick();
  assert.equal(store.getStreams().find((s) => s.stream === 'pushes').pending, false);
  assert.equal(store.listEvents().length, 2);
  assert.equal(store.listEvents().find((e) => e.data.pushId === 1).imported, true);
  assert.equal(store.listEvents().find((e) => e.data.pushId === 2).seen, false);
  store.close();
});

test('ref baseline emits nothing and only full snapshots expose newly discovered branches', async () => {
  let stage = 0;
  const provider = { async read(_r, _s, { cursor }) {
    if (!stage) return { items: [{ name: 'refs/heads/main', objectId: 'a' }], nextCursor: null };
    return cursor ? { items: [{ name: 'refs/heads/hotfix/new', objectId: 'b' }], nextCursor: null }
      : { items: [{ name: 'refs/heads/main', objectId: 'a' }], nextCursor: { next: 1 } };
  } };
  const { store, sync, advance } = setup(provider, ['refs']);
  await sync.tick();
  assert.equal(store.listEvents().length, 0);
  stage = 1; advance(600001);
  await sync.tick();
  assert.equal(store.listEvents().length, 0);
  await sync.tick();
  const event = store.listEvents()[0];
  assert.equal(event.kind, 'branch-created');
  assert.equal(event.actor, 'Unknown');
  assert.equal(event.data.evidence, 'snapshot');
  assert.match(event.summary, /creation time and actor unknown/);
  store.close();
});

test('new remote branch from push is visible before a PR and duplicate polls do not reset seen', async () => {
  const record = push(3);
  record.refUpdates[0].oldObjectId = '0'.repeat(40);
  const { store, sync, advance } = setup({ async read() { return { items: [record], nextCursor: null }; } });
  await sync.tick();
  const branch = store.listEvents().find((e) => e.kind === 'branch-created');
  assert.equal(branch.branch, 'hotfix/example');
  store.acknowledge([branch.id]);
  advance(); await sync.tick();
  assert.equal(store.listEvents().length, 2);
  assert.equal(store.listEvents().find((e) => e.id === branch.id).seen, true);
  store.close();
});

test('old active build is refreshed by ID after disappearing from active results', async () => {
  const build = { id: 42, repository: { id: 'a' }, status: 'inProgress', queueTime: '2026-11-01T00:00:00Z', sourceBranch: 'refs/heads/main', sourceVersion: 'a' };
  let active = true;
  const provider = { async read() { return { items: active ? [build] : [], nextCursor: null }; },
    async buildsById(_r, ids) { assert.deepEqual(ids, ['42']); return [{ ...build, status: 'completed', result: 'failed', finishTime: '2026-11-17T10:01:00Z' }]; } };
  const { store, sync, advance } = setup(provider, ['activeBuilds']);
  await sync.tick();
  active = false; advance(); await sync.tick();
  assert.equal(store.listEvents().length, 2);
  assert.equal(store.listEvents().find((e) => e.data.result === 'failed').seen, false);
  store.close();
});

test('PR reactivation creates a fresh event even when its state matches an earlier snapshot', async () => {
  let status = 'active';
  const provider = { async read() { return { items: [{ pullRequestId: 1, title: 'Fix', status, creationDate: '2026-11-16T10:00:00Z', sourceRefName: 'refs/heads/feature/x' }], nextCursor: null }; } };
  const { store, sync, advance } = setup(provider, ['prs']);
  await sync.tick();
  status = 'abandoned'; advance(); await sync.tick();
  status = 'active'; advance(); await sync.tick();
  assert.equal(store.listEvents().length, 3);
  assert.equal(store.listEvents({ unseen: true }).length, 2);
  store.close();
});

test('disabled repositories and disabled refresh never call Azure; concurrent ticks coalesce', async () => {
  let release;
  let calls = 0;
  const provider = { read() { calls++; return new Promise((resolve) => { release = () => resolve({ items: [], nextCursor: null }); }); } };
  const { store, sync } = setup(provider);
  store.saveRepo({ ...repo, disabled: true });
  await sync.tick(); assert.equal(calls, 0);
  store.saveRepo({ ...repo, disabled: false });
  store.setSetting('refreshEnabled', false); await sync.tick(); assert.equal(calls, 0);
  store.setSetting('refreshEnabled', true);
  const a = sync.tick(); const b = sync.tick();
  assert.equal(a, b); assert.equal(calls, 1);
  release(); await a;
  assert.deepEqual(sync.refresh(), { scheduled: false, cooldown: true });
  store.close();
});

test('a refresh while a repository is disabled does not start its cooldown', () => {
  const { store, sync, advance } = setup({ async read() { return { items: [], nextCursor: null }; } });
  advance(31000);
  store.saveRepo({ ...repo, disabled: true });
  sync.refresh();
  store.saveRepo({ ...repo, disabled: false });
  assert.deepEqual(sync.refresh([repo.id]), { scheduled: true });
  store.close();
});

test('editing an old active PR after baseline is unseen using observation time', async () => {
  let title = 'Original title';
  const provider = { async read() { return { items: [{ pullRequestId: 1, title, status: 'active', creationDate: '2026-10-01T00:00:00Z' }], nextCursor: null }; } };
  const { store, sync, advance } = setup(provider, ['prs']);
  await sync.tick();
  assert.equal(store.listEvents()[0].imported, true);
  title = 'New title'; advance(); await sync.tick();
  const [changed] = store.listEvents({ unseen: true });
  assert.match(changed.title, /New title/);
  assert.equal(changed.time, '2026-11-17T10:00:02.000Z');
  store.close();
});

test('pagination receives a fixed window and yields between pages to another repository', async () => {
  const calls = [];
  const provider = { async read(repo, stream, options) { calls.push({ id: repo.id, stream, ...options }); return { items: [], nextCursor: options.cursor ? null : { skip: 1 } }; } };
  const { store, sync, advance } = setup(provider);
  store.saveRepo({ ...repo, id: 'two', name: 'Two' });
  // Ensure both repositories have just the pushes stream due.
  sync.refresh(['two']);
  await sync.tick();
  for (const state of store.getStreams()) if (state.stream !== 'pushes') store.saveStream({ ...state, nextAt: '2099-01-01T00:00:00Z' });
  advance(500);
  await sync.tick();
  await sync.tick();
  assert.equal(calls[0].id, 'one');
  assert.equal(calls[1].id, 'two');
  assert.equal(calls[2].id, 'one');
  assert.equal(calls[0].since, calls[2].since);
  assert.equal(calls[0].until, calls[2].until);
  assert.deepEqual(calls[2].cursor, { skip: 1 });
  store.close();
});

test('project-wide PR results cannot leak another repository into the watched repo', async () => {
  const provider = { async read() { return { items: [
    { pullRequestId: 1, repository: { id: 'other' }, title: 'Other repo', status: 'active', creationDate: '2026-11-17T10:00:01Z' },
    { pullRequestId: 2, repository: { id: 'A' }, title: 'Watched repo', status: 'active', creationDate: '2026-11-17T10:00:01Z' },
  ], nextCursor: null }; } };
  const { store, sync } = setup(provider, ['prs']);
  await sync.tick();
  assert.equal(store.listEvents().length, 1);
  assert.match(store.listEvents()[0].title, /Watched repo/);
  assert.equal(store.getEntity('one', 'pr', '1'), undefined);
  assert.equal(store.listEntities('one', 'pr').length, 1);
  store.close();
});

test('pausing during a read prevents follow-up reconciliation and never acknowledges existing events', async () => {
  let release;
  let reconciled = 0;
  const provider = { read() { return new Promise((resolve) => { release = () => resolve({ items: [], nextCursor: null }); }); }, async buildsById() { reconciled++; return []; } };
  const { store, sync } = setup(provider, ['activeBuilds']);
  store.insertEvents([{ id: 'existing', repoId: 'one', kind: 'push', title: 'Existing', time: '2026-11-17T10:00:00Z' }]);
  store.commitPage({ repoId: 'one', stream: 'activeBuilds', entities: [{ type: 'build', id: '42', data: { status: 'inProgress' } }] });
  const pending = sync.tick();
  store.saveRepo({ ...repo, disabled: true });
  release(); await pending;
  assert.equal(reconciled, 0);
  assert.equal(store.listEvents()[0].seen, false);
  assert.equal(store.getStreams().find((s) => s.stream === 'activeBuilds').lastSuccess, undefined);
  store.close();
});

test('completed PR snapshots retain source, target and merge result without extra reads or repeat notifications', async () => {
  let reads = 0;
  const item = { pullRequestId: 90, repository: { id: 'a' }, title: 'Fix validation', status: 'completed',
    sourceRefName: 'refs/heads/hotfix/validation', targetRefName: 'refs/heads/main',
    creationDate: '2026-11-16T09:00:00Z', closedDate: '2026-11-17T10:00:01Z',
    createdBy: { displayName: 'PR creator' }, mergeStatus: 'succeeded',
    lastMergeSourceCommit: { commitId: 'source-sha' }, lastMergeTargetCommit: { commitId: 'target-before-sha' },
    lastMergeCommit: { commitId: 'merged-result-sha' }, completionOptions: { mergeStrategy: 'squash' } };
  const { store, sync, advance } = setup({ async read() { reads++; return { items: [item], nextCursor: null }; } }, ['closedPrs']);
  await sync.tick();
  const event = store.listEvents()[0];
  assert.equal(event.data.sourceRefName, item.sourceRefName);
  assert.equal(event.data.targetRefName, item.targetRefName);
  assert.equal(event.data.sourceCommit, 'source-sha');
  assert.equal(event.data.targetCommit, 'target-before-sha');
  assert.equal(event.data.mergeCommit, 'merged-result-sha');
  assert.equal(event.data.mergeStatus, 'succeeded');
  assert.equal(event.data.mergeStrategy, 'squash');
  assert.equal(event.actor, 'PR creator', 'the recorded actor is the creator, not an inferred merger');
  assert.equal(event.seen, false);
  advance(); await sync.tick();
  assert.equal(reads, 2);
  assert.equal(store.listEvents().length, 1, 'unchanged snapshots do not produce metadata-only notifications');
  store.close();
});

test('active preview and abandoned PRs never acquire actual merge-result fields', async () => {
  const items = ['active', 'abandoned'].map((status, index) => ({ pullRequestId: 100 + index, status,
    repository: { id: 'a' }, title: status, creationDate: '2026-11-16T09:00:00Z',
    sourceRefName: 'refs/heads/feature/work', targetRefName: 'refs/heads/main',
    mergeStatus: 'succeeded', lastMergeCommit: { commitId: 'preview-only' },
    lastMergeTargetCommit: { commitId: 'target-before' }, completionOptions: { mergeStrategy: 'noFastForward' } }));
  const { store, sync } = setup({ async read() { return { items, nextCursor: null }; } }, ['prs']);
  await sync.tick();
  assert.equal(store.listEvents().length, 2);
  for (const event of store.listEvents()) {
    assert.equal(event.data.mergeCommit, undefined);
    assert.equal(event.data.targetCommit, undefined);
    assert.equal(event.data.mergeStatus, undefined);
    assert.equal(event.data.mergeStrategy, undefined);
  }
  store.close();
});

test('ingestion stores merge work atomically and leaves historical imports out of live ref state', async () => {
  const { store, sync } = setup({ read: async () => ({ items: [push(333)], nextCursor: null }) });
  await sync.tick();
  assert.equal(store.listJobs({ type: 'merge' })[0].eventId, 'one:push:333');
  const before = store.getEntity('one', 'ref', 'refs/heads/hotfix/example');
  const historical = sync.normalize(repo, 'pushes', [push(1, '2020-01-01T00:00:00Z')], { historical: true, initialized: false });
  assert.ok(historical.events.every(event => event.imported && event.seen));
  assert.equal(historical.entities.some(entity => entity.type === 'ref'), false);
  store.commitPage({ repoId: repo.id, ...historical });
  assert.deepEqual(store.getEntity('one', 'ref', 'refs/heads/hotfix/example'), before);
  store.close();
});

test('real-time due pages precede optional background enrichment and import', async () => {
  const store = createStore(); store.saveRepo(repo);
  let live = 0, background = 0;
  const sync = createSync({ store, now: () => BASE, provider: { read: async () => { live++; return { items: [], nextCursor: null }; } },
    background: { history: async () => { background++; return true; } } });
  for (let i = 0; i < 6; i++) await sync.tick();
  assert.equal(live, 6); assert.equal(background, 0);
  await sync.tick(); assert.equal(background, 1);
  store.close();
});

test('busy live queues leave turns for background work', async () => {
  const store = createStore();
  try {
    for (let id = 0; id < 12; id++) store.saveRepo({ id: String(id), name: String(id) });
    let time = BASE;
    const turns = [];
    const sync = createSync({ store, now: () => time, isForeground: () => false,
      provider: { read: async () => { turns.push('live'); return { items: [] }; } },
      background: {
        merge: async () => { turns.push('merge'); return true; },
        history: async () => { turns.push('history'); return true; },
      } });
    for (let i = 0; i < 360; i++) { await sync.tick(); time += 5000; }
    const live = turns.filter(turn => turn === 'live').length;
    assert.ok(live > 180, 'live checks retain most turns');
    assert.deepEqual(turns.slice(0, 14), ['live', 'live', 'live', 'live', 'live', 'live', 'merge',
      'live', 'live', 'live', 'live', 'live', 'live', 'history']);
    assert.ok(turns.filter(turn => turn === 'merge').length > 20);
    assert.ok(turns.filter(turn => turn === 'history').length > 20);
    assert.ok(sync.status().lastTurn.history);
    assert.ok(sync.status().lastTurn.merge);
  } finally { store.close(); }
});

test('automatic checks can be disabled while an explicit history import still gets turns', async () => {
  const store = createStore();
  try {
    store.saveRepo(repo);
    store.setSetting('refreshEnabled', false);
    const sync = createSync({ store, now: () => BASE,
      provider: { read: async () => assert.fail('live was not requested') },
      background: { merge: async () => assert.fail('merge requires automatic checks'), history: async () => true } });
    await sync.tick();
    assert.equal(sync.status().lastTurn.history, new Date(BASE).toISOString());
  } finally { store.close(); }
});

test('repositories added during the refresh cooldown still get their initial import with automatic checks off', async () => {
  const store = createStore();
  store.setSetting('refreshEnabled', false);
  const reads = [];
  const sync = createSync({ store, now: () => BASE, provider: { async read(current, stream) {
    reads.push(`${current.id}:${stream}`); return { items: [], nextCursor: null };
  } } });
  store.saveRepo(repo);
  assert.equal(sync.refresh([repo.id]).scheduled, true);
  store.saveRepo({ ...repo, id: 'two', name: 'Two' });
  assert.equal(sync.refresh(['two']).scheduled, true, 'a different repository is not on cooldown');
  assert.equal(sync.refresh(['two']).cooldown, true);
  for (let i = 0; i < 20; i++) await sync.tick();
  assert.ok(store.getStreams().every(state => state.initialized), 'every stream of both repositories imported');
  assert.ok(reads.some(entry => entry.startsWith('two:')));
  store.close();
});

test('a failing scheduled tick is contained and polling continues', async () => {
  const store = createStore();
  store.saveRepo(repo);
  let turns = 0;
  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);
  const sync = createSync({ store, pollMs: 5, provider: { async read() { return { items: [], nextCursor: null }; } },
    background: { history: async () => { turns++; throw new Error('database is locked'); } } });
  for (const state of store.getStreams()) store.saveStream({ ...state, nextAt: '2099-01-01T00:00:00Z' });
  sync.start();
  await new Promise(resolve => setTimeout(resolve, 60));
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
  let time = BASE, calls = 0;
  const sync = createSync({ store, now: () => time, intervalMs: 1000, provider: { async read() { calls++; throw Object.assign(new Error('offline'), { code: 'UNAVAILABLE' }); } } });
  sync.refresh([repo.id]);
  for (const state of store.getStreams()) if (state.stream !== 'pushes') store.saveStream({ ...state, manual: false });
  await sync.tick();
  assert.equal(calls, 1);
  assert.equal(store.getStreams().find(state => state.stream === 'pushes').error.code, 'UNAVAILABLE', 'the failure stays visible');
  time += 31 * 60000; await sync.tick();
  assert.equal(calls, 1, 'no Azure call without another refresh request');
  store.close();
});

for (const automatic of [true, false]) {
  test(`a refresh requested during a read stays due after that page commits (automatic checks ${automatic ? 'on' : 'off'})`, async () => {
    const store = createStore();
    store.saveRepo(repo);
    store.setSetting('refreshEnabled', automatic);
    let time = BASE, release, calls = 0;
    const sync = createSync({ store, now: () => time, intervalMs: 180000, provider: { read() {
      if (++calls > 1) return Promise.resolve({ items: [], nextCursor: null });
      return new Promise(done => { release = () => done({ items: [], nextCursor: null }); });
    } } });
    sync.refresh([repo.id]);
    for (const state of store.getStreams()) if (state.stream !== 'pushes') store.saveStream({ ...state, nextAt: '2099-01-01T00:00:00Z', manual: false });
    const reading = sync.tick();
    await new Promise(setImmediate);
    time += 40000;
    assert.equal(sync.refresh([repo.id]).scheduled, true);
    release(); await reading;
    const pushes = store.getStreams().find(state => state.stream === 'pushes');
    assert.equal(pushes.nextAt, new Date(time).toISOString(), 'the refresh is still due');
    await sync.tick();
    assert.equal(calls, 2, 'the requested refresh reads again');
    store.close();
  });
}

test('first-sync history at the baseline instant is imported whatever its fractional-second format', async () => {
  const { store, sync } = setup({ async read() { return { items: [push(7, '2026-11-17T10:00:00Z')], nextCursor: null }; } });
  assert.equal(store.getSetting(`baseline:${repo.id}`), '2026-11-17T10:00:00.000Z');
  await sync.tick();
  const event = store.listEvents().find(item => item.kind === 'push');
  assert.equal(event.imported, true, 'an event at the baseline instant is history, not a new update');
  store.close();
});
