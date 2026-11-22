import test from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../server/store.js';
import { createHash } from 'node:crypto';
import { createSync } from '../server/sync.js';
import { createBackfill } from '../server/backfill.js';
import { activityMergeBadge } from '../src/activity-text.js';
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
function setup(provider, streams = ['pushes']) {
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
    advance(ms = 2000) {
      time += ms;
    },
  };
}
const push = (id, date = '2026-11-17T10:00:01Z') => ({
  pushId: id,
  date,
  pushedBy: { displayName: 'A' },
  refUpdates: [{ name: 'refs/heads/hotfix/example', oldObjectId: 'a'.repeat(40), newObjectId: 'b'.repeat(40) }],
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
      async read(current, stream, { cursor }) {
        calls++;
        assert.equal(current.id, repo.id);
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
  const provider = {
    async read(_repo, stream, { cursor }) {
      if (stream === 'refs') return { items: [], nextCursor: null };
      if (!acrossPages) return { items: [deletion, creation], nextCursor: null };
      return { items: cursor ? [{ ...creation, pushId: 30 }] : [{ ...deletion, pushId: 40 }], nextCursor: cursor ? null : { skip: 1 } };
    },
  };
  const { store, sync, advance } = setup(provider, ['pushes']);
  // Baseline ref stream already exists; an empty reconciliation should add no duplicate deletion.
  const refs = store.getStreams().find(state => state.stream === 'refs');
  store.saveStream({ ...refs, initialized: true });
  await sync.tick();
  assert.equal(store.getEntity(repo.id, 'ref', name).active, false);
  acrossPages = true;
  advance();
  await sync.tick();
  await sync.tick();
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
  assert.equal(Date.parse(store.getStreams().find(s => s.stream === 'pushes').nextAt) - time, 180000);
  time += 180000;
  await sync.tick();
  assert.equal(Date.parse(store.getStreams().find(s => s.stream === 'pushes').nextAt) - time, 300000);
  time += 300000;
  foreground = false;
  await sync.tick();
  assert.equal(Date.parse(store.getStreams().find(s => s.stream === 'pushes').nextAt) - time, 300000);
  assert.equal(reads, 3);
  store.close();
});

test('failed page preserves cursor across sync restart, completed window deduplicates overlap', async () => {
  let calls = 0;
  const provider = {
    async read(_repo, _stream, options) {
      calls++;
      if (!options.cursor) return { items: [push(1, '2026-11-16T10:00:00Z')], nextCursor: { skip: 1 } };
      if (calls === 2) throw Object.assign(new Error('Network unavailable'), { code: 'NETWORK' });
      return { items: [push(2)], nextCursor: null };
    },
  };
  const { store, sync, advance } = setup(provider);
  await sync.tick();
  assert.equal(store.getStreams().find(s => s.stream === 'pushes').cursor.skip, 1);
  await sync.tick();
  assert.equal(store.getStreams().find(s => s.stream === 'pushes').lastSuccess, undefined);
  assert.equal(store.listEvents().length, 1);
  advance();
  const resumed = createSync({ store, provider, now: () => BASE + 2000, intervalMs: 1000 });
  await resumed.tick();
  assert.equal(store.getStreams().find(s => s.stream === 'pushes').pending, false);
  assert.equal(store.listEvents().length, 2);
  assert.equal(store.listEvents().find(e => e.data.pushId === 1).imported, true);
  assert.equal(store.listEvents().find(e => e.data.pushId === 2).seen, false);
  store.close();
});

test('ref baseline emits nothing and only full snapshots expose newly discovered branches', async () => {
  let stage = 0;
  const provider = {
    async read(_r, _s, { cursor }) {
      if (!stage) return { items: [{ name: 'refs/heads/main', objectId: 'a' }], nextCursor: null };
      return cursor
        ? { items: [{ name: 'refs/heads/hotfix/new', objectId: 'b' }], nextCursor: null }
        : { items: [{ name: 'refs/heads/main', objectId: 'a' }], nextCursor: { next: 1 } };
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
  const { store, sync, advance } = setup({
    async read() {
      return { items: [record], nextCursor: null };
    },
  });
  await sync.tick();
  const branch = store.listEvents().find(e => e.kind === 'branch-created');
  assert.equal(branch.branch, 'hotfix/example');
  store.acknowledge([branch.id]);
  advance();
  await sync.tick();
  assert.equal(store.listEvents().length, 2);
  assert.equal(store.listEvents().find(e => e.id === branch.id).seen, true);
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
  const provider = {
    async read() {
      return { items: active ? [build] : [], nextCursor: null };
    },
    async buildsById(_r, ids) {
      assert.deepEqual(ids, ['42']);
      return [{ ...build, status: 'completed', result: 'failed', finishTime: '2026-11-17T10:01:00Z' }];
    },
  };
  const { store, sync, advance } = setup(provider, ['activeBuilds']);
  await sync.tick();
  active = false;
  advance();
  await sync.tick();
  assert.equal(store.listEvents().length, 2);
  assert.equal(store.listEvents().find(e => e.data.result === 'failed').seen, false);
  store.close();
});

test('an active build that Azure omits when asked for by ID is not asked for again', async () => {
  const build = {
    id: 42,
    repository: { id: 'a' },
    status: 'inProgress',
    queueTime: '2026-11-01T00:00:00Z',
    sourceBranch: 'refs/heads/main',
    sourceVersion: 'a',
  };
  let active = true;
  const asked = [];
  const provider = {
    async read() {
      return { items: active ? [build] : [], nextCursor: null };
    },
    // Azure answers a build removed by retention with an empty list (docs/probe-results.md).
    async buildsById(_r, ids) {
      asked.push(ids);
      return [];
    },
  };
  const { store, sync, advance } = setup(provider, ['activeBuilds']);
  await sync.tick();
  active = false;
  advance();
  await sync.tick();
  const stream = () => store.getStreams().find(state => state.stream === 'activeBuilds');
  assert.equal(stream().error, null);
  store.saveStream({ ...stream(), nextAt: new Date(BASE + 2000).toISOString() });
  await sync.tick();
  assert.deepEqual(asked, [['42']], 'the omitted build is asked for once');
  assert.equal(store.listEvents().length, 1, 'no event is invented for it');
  store.close();
});

test('PR reactivation creates a fresh event even when its state matches an earlier snapshot', async () => {
  let status = 'active';
  const provider = {
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

const cachedPr = (id, status = 'active') => ({
  pullRequestId: id,
  title: `PR ${id}`,
  status,
  creationDate: '2026-11-16T10:00:00Z',
  sourceRefName: `refs/heads/feature/${id}`,
});

test('a cached active PR that Azure can no longer read does not stall the prs stream or its later siblings', async () => {
  let listed = [1, 2, 3, 4, 5].map(id => cachedPr(id));
  const lookups = [];
  const unreadable = { 1: 'NOT_FOUND', 2: 'WRONG_REPOSITORY' };
  const provider = {
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
  const prs = () => store.getStreams().find(state => state.stream === 'prs');
  assert.equal(prs().error, null, 'one unreadable PR does not fail the page');
  assert.equal(prs().lastSuccess, new Date(BASE + 2000).toISOString(), 'the listing commits');
  assert.equal(store.getEntity(repo.id, 'pr', '3').status, 'completed', 'a readable sibling commits');
  assert.equal(store.getEntity(repo.id, 'pr', '1').status, 'active', 'an unreadable PR is left as it was');
  store.saveStream({ ...prs(), nextAt: new Date(BASE + 2000).toISOString() });
  await sync.tick();
  assert.deepEqual(lookups, ['1', '2', '3', '4', '5', '1'], 'later PRs get a turn instead of the same first three');
  assert.equal(store.getEntity(repo.id, 'pr', '5').status, 'completed');
  store.close();
});

for (const code of ['AUTH_REQUIRED', 'INVALID_RESPONSE']) {
  test(`a ${code} error during a per-PR lookup still fails the prs page`, async () => {
    let listed = [cachedPr(1), cachedPr(2)];
    const provider = {
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
    const before = store.getStreams().find(state => state.stream === 'prs').lastSuccess;
    listed = [];
    advance();
    await sync.tick();
    const prs = store.getStreams().find(state => state.stream === 'prs');
    assert.equal(prs.error?.code, code);
    assert.equal(prs.lastSuccess, before, 'the page does not commit');
    assert.equal(store.getEntity(repo.id, 'pr', '1').status, 'active', 'no sibling commits from a failed page');
    store.close();
  });
}

test('disabled repositories and disabled refresh never call Azure; concurrent ticks coalesce', async () => {
  let release;
  let calls = 0;
  const provider = {
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
  release();
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
  const provider = {
    async read() {
      return { items: [{ pullRequestId: 1, title, status: 'active', creationDate: '2026-10-01T00:00:00Z' }], nextCursor: null };
    },
  };
  const { store, sync, advance } = setup(provider, ['prs']);
  await sync.tick();
  assert.equal(store.listEvents()[0].imported, true);
  title = 'New title';
  advance();
  await sync.tick();
  const [changed] = store.listEvents({ unseen: true });
  assert.match(changed.title, /New title/);
  assert.equal(changed.time, '2026-11-17T10:00:02.000Z');
  store.close();
});

test('pagination receives a fixed window and yields between pages to another repository', async () => {
  const calls = [];
  const provider = {
    async read(repo, stream, options) {
      calls.push({ id: repo.id, stream, ...options });
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
  assert.equal(calls[0].id, 'one');
  assert.equal(calls[1].id, 'two');
  assert.equal(calls[2].id, 'one');
  assert.equal(calls[0].since, calls[2].since);
  assert.equal(calls[0].until, calls[2].until);
  assert.deepEqual(calls[2].cursor, { skip: 1 });
  store.close();
});

test('project-wide PR results cannot leak another repository into the watched repo', async () => {
  const provider = {
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
  assert.match(store.listEvents()[0].title, /Watched repo/);
  assert.equal(store.getEntity('one', 'pr', '1'), undefined);
  assert.equal(store.listEntities('one', 'pr').length, 1);
  store.close();
});

test('pausing during a read prevents follow-up reconciliation and never acknowledges existing events', async () => {
  let release;
  let reconciled = 0;
  const provider = {
    read() {
      return new Promise(resolve => {
        release = () => resolve({ items: [], nextCursor: null });
      });
    },
    async buildsById() {
      reconciled++;
      return [];
    },
  };
  const { store, sync } = setup(provider, ['activeBuilds']);
  store.insertEvents([{ id: 'existing', repoId: 'one', kind: 'push', title: 'Existing', time: '2026-11-17T10:00:00Z' }]);
  store.commitPage({ repoId: 'one', stream: 'activeBuilds', entities: [{ type: 'build', id: '42', data: { status: 'inProgress' } }] });
  const pending = sync.tick();
  store.saveRepo({ ...repo, disabled: true });
  release();
  await pending;
  assert.equal(reconciled, 0);
  assert.equal(store.listEvents()[0].seen, false);
  assert.equal(store.getStreams().find(s => s.stream === 'activeBuilds').lastSuccess, undefined);
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
    assert.equal(event.data.mergeCommit, undefined);
    assert.equal(event.data.targetCommit, undefined);
    assert.equal(event.data.mergeStatus, undefined);
    assert.equal(event.data.mergeStrategy, undefined);
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

test('busy live queues leave turns for background work', async () => {
  const store = createStore();
  try {
    for (let id = 0; id < 12; id++) store.saveRepo({ id: String(id), name: String(id) });
    let time = BASE;
    const turns = [];
    const sync = createSync({
      store,
      now: () => time,
      isForeground: () => false,
      provider: {
        read: async () => {
          turns.push('live');
          return { items: [] };
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
  const reads = [];
  const sync = createSync({
    store,
    now: () => BASE,
    provider: {
      async read(current, stream) {
        reads.push(`${current.id}:${stream}`);
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

test('a failing scheduled tick is contained and polling continues', async () => {
  const store = createStore();
  store.saveRepo(repo);
  let turns = 0;
  const unhandled = [];
  const onUnhandled = reason => unhandled.push(reason);
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
  assert.equal(store.getStreams().find(state => state.stream === 'pushes').error.code, 'UNAVAILABLE', 'the failure stays visible');
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
    fail,
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
  fail();
  await reading;
  const pending = () => sync.status().inProgress.some(entry => entry.stream === 'pushes');
  assert.equal(store.getStreams().find(state => state.stream === 'pushes').error.code, 'UNAVAILABLE', 'the failure stays visible');
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
    fail,
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
  fail();
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
    fail;
  const sinces = [];
  const sync = createSync({
    store,
    now: () => time,
    intervalMs: 1000,
    provider: {
      read(_repo, _stream, { since }) {
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
  fail();
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
      release,
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
    release();
    await reading;
    const pushes = store.getStreams().find(state => state.stream === 'pushes');
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
  const event = store.listEvents().find(item => item.kind === 'push');
  assert.equal(event.imported, true, 'an event at the baseline instant is history, not a new update');
  store.close();
});

test('a refresh in the same millisecond its stream starts reading still stays due', async () => {
  const store = createStore();
  store.saveRepo(repo);
  let release,
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
  release();
  await reading;
  const read = store.getStreams().find(state => state.initialized);
  assert.equal(read.nextAt, new Date(BASE).toISOString(), 'the refresh is still due');
  assert.equal(read.manual, true, 'a manual refresh keeps its manual flag with automatic checks off');
  store.close();
});

test('a read window saved before refresh generations existed still keeps a refresh made during its read', async () => {
  const store = createStore();
  store.saveRepo(repo);
  let release,
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
    assert.ok(refreshGeneration >= 0);
  }
  const reading = sync.tick();
  await new Promise(setImmediate);
  time += 40000;
  store.setSetting('refreshEnabled', false);
  assert.equal(sync.refresh([repo.id]).scheduled, true);
  release();
  await reading;
  const pushes = store.getStreams().find(state => state.stream === 'pushes');
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
  const tagPush = (pushId, refUpdates) => ({ pushId, date: '2026-11-17T10:00:01Z', pushedBy: { displayName: 'A' }, refUpdates });
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
  assert.deepEqual(tags.map(event => [event.data.pushId, event.branch, event.data.change]).sort(), [
    [1, 'v1', 'created'],
    [2, 'annotated', 'created'],
    [3, 'v1', 'moved'],
    [4, 'v2', 'deleted'],
  ]);
  const pushes = store.listEvents().filter(event => event.kind === 'push');
  assert.deepEqual(
    pushes.map(event => event.data.pushId),
    [2],
    'only the push that moved a branch is a push row',
  );
  assert.deepEqual(
    pushes[0].data.refUpdates.map(ref => ref.name),
    ['refs/heads/main'],
  );
  assert.equal(store.getEntity('one', 'ref', 'refs/tags/v1').objectId, 'd'.repeat(40));
  assert.equal(store.getEntity('one', 'ref', 'refs/tags/v2').active, false);
  store.close();
});

test('tags join the refs snapshot without announcing the tags that already existed', async () => {
  let items = [{ name: 'refs/heads/main', objectId: 'a' }];
  const { store, sync, advance } = setup(
    {
      async read() {
        return { items, nextCursor: null };
      },
    },
    ['refs'],
  );
  // An install from before tags: the refs stream is initialized and knows main, but has never recorded a tag.
  const refs = store.getStreams().find(state => state.stream === 'refs');
  store.commitPage({
    repoId: 'one',
    stream: 'refs',
    state: { ...refs, initialized: true, nextAt: new Date(BASE).toISOString() },
    entities: [{ type: 'ref', id: 'refs/heads/main', data: { name: 'refs/heads/main', objectId: 'a', active: true } }],
  });
  items = [items[0], { name: 'refs/tags/old', objectId: 'b' }];
  await sync.tick();
  assert.equal(store.listEvents().length, 0, 'existing tags are a baseline, not news');
  items = [items[0], { name: 'refs/tags/v2', objectId: 't', peeledObjectId: 'c' }];
  advance(600001);
  await sync.tick();
  const tags = store.listEvents().filter(event => event.kind === 'tag');
  assert.deepEqual(tags.map(event => [event.branch, event.data.change, event.data.evidence]).sort(), [
    ['old', 'deleted', 'snapshot'],
    ['v2', 'created', 'snapshot'],
  ]);
  assert.equal(tags.find(event => event.branch === 'v2').data.peeledObjectId, 'c');
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
  let items = [pr];
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
  assert.equal(store.listEvents()[0].data.fork, undefined);
  assert.equal(store.listEvents()[0].data.sourceRepositoryId, 'a', 'an active PR records where its source branch lives');
  assert.equal(store.listEvents()[0].data.targetRepositoryId, 'a');
  items = [{ ...pr, forkSource: { name: 'refs/heads/fix', repository: { id: 'f', name: 'One-fork', project: { name: 'Q' } } } }];
  advance(600001);
  await sync.tick();
  assert.equal(store.listEvents().length, 1, 'learning the fork source is not a PR update');
  items = [{ ...items[0], title: 'Fix, retitled' }];
  advance(600001);
  await sync.tick();
  const latest = store.listEvents().find(event => event.data.fork);
  assert.deepEqual(latest.data.fork, { repository: 'One-fork', project: 'Q' });
  assert.equal(latest.data.sourceRepositoryId, 'f');
  store.close();
});

test('a reviewer vote is PR activity, and PRs saved before votes were recorded adopt them quietly', async () => {
  const reviewer = (id, vote, displayName = id) => ({ id, displayName, vote });
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
  let items = [pr];
  const { store, sync, advance } = setup(
    {
      async read() {
        return { items, nextCursor: null };
      },
    },
    ['prs'],
  );
  // A snapshot from before votes were part of the fingerprint.
  const prs = store.getStreams().find(state => state.stream === 'prs');
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
    .map(event => event.data.voteChanges);
  assert.deepEqual(changes, [[{ name: 'Ana', vote: 10 }], [{ name: 'Ana', vote: 0 }]]);
  assert.deepEqual(
    store
      .listEvents()[0]
      .data.reviewers.map(item => [item.name, item.vote])
      .sort(),
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
  const sync = createSync({ store, provider: {} });
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
  assert.equal(events[0].id, `one:pr:history:8:${hash}`);
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
  let items = [pr];
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
      async read(_repo, _stream, { cursor }) {
        cursorSeen = cursor;
        return { items: [{ name: 'refs/heads/main', objectId: 'a' }], nextCursor: null, restarted: true };
      },
    },
    ['refs'],
  );
  const refs = store.getStreams().find(state => state.stream === 'refs');
  store.commitPage({
    repoId: 'one',
    stream: 'refs',
    state: {
      ...refs,
      initialized: true,
      cursor: { token: 'heads-only' },
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
  assert.equal(store.getEntity('one', 'ref', 'refs/heads/old').active, false);
  store.close();
});

for (const [order, first, second] of [
  ['push stored first', 'pushes', 'closedPrs'],
  ['PR stored first', 'closedPrs', 'pushes'],
]) {
  test(`a completed PR links to the push that is its result with no merge call, ${order}`, async () => {
    const result = 'c'.repeat(40);
    const items = {
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
    const offered = { pushes: [], closedPrs: [] };
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
      offered[stream] = items[stream];
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
      pushed.data.mergeEvidence.prs.map(pr => [pr.pullRequestId, pr.targetRefName, pr.mergeCommit, pr.relationship]),
      [[91, 'refs/heads/main', result.toUpperCase(), 'result-introduced']],
    );
    store.close();
  });
}

/**
 * Records every provider method a run calls. Pushes come in pages; every other call answers empty.
 * @param {Record<string, object[][]>} pages pages per stream, chained by a `skip` cursor
 */
function recordingProvider(pages) {
  const calls = [];
  const provider = new Proxy(
    {},
    {
      get(_target, name) {
        if (typeof name !== 'string' || name === 'then') return undefined;
        return async (_repo, stream, options) => {
          calls.push(name === 'read' ? `read:${stream}` : name);
          const list = (name === 'read' && pages[stream]) || [];
          const index = options?.cursor?.skip || 0;
          return { items: list[index] || [], nextCursor: index + 1 < list.length ? { skip: index + 1 } : null };
        };
      },
    },
  );
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
  assert.deepEqual(store.listJobs({ type: 'merge' }), []);
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
  /** @type {ReturnType<typeof createBackfill>} */
  let backfill;
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
  assert.deepEqual(store.listJobs({ type: 'merge' }), []);
  store.close();
});
