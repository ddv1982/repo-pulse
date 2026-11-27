// Refs snapshots: branches and tags, their baselines, and what a push or an incomplete snapshot records.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createSync } from '../server/sync.ts';
import type { SyncProvider } from '../server/sync.ts';
import { createAzureClient } from '../server/azure-client.ts';
import type { AzurePage, ReadOptions } from '../server/azure-client.ts';
import type { AzureStreamRecord } from '../src/contract.ts';
import { dataOf, fieldsOf, present, watchedIdOf } from './fixtures/typed.ts';
import { fakeCli } from './fixtures/azure.ts';
import { repo } from './fixtures/repository.ts';
import { BASE, DAY, setup, push, pushesState } from './fixtures/sync.ts';
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

test('ingestion stores pushes and leaves historical imports out of live ref state', async () => {
  const { store, sync, normalizer } = setup({ read: async () => ({ items: [push(333)], nextCursor: null }) });
  await sync.tick();
  assert.ok(store.getEvent('one:push:333'));
  const before = store.getEntity('one', 'ref', 'refs/heads/hotfix/example');
  const historical = normalizer.normalize(repo, 'pushes', [push(1, '2020-01-01T00:00:00Z')], { historical: true, initialized: false });
  assert.ok(historical.events.every(event => event.imported && event.seen));
  assert.equal(
    historical.entities.some(entity => entity.type === 'ref'),
    false,
  );
  store.commitPage({ repoId: repo.id, ...historical });
  assert.deepEqual(store.getEntity('one', 'ref', 'refs/heads/hotfix/example'), before);
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

test('a ref Azure returns unreadable is not reported as no longer listed, and neither is any ref until a complete snapshot', async () => {
  let refs: unknown[] = [
    { name: 'refs/heads/a', objectId: 'a' },
    { name: 'refs/heads/b', objectId: 'b' },
    { name: 'refs/heads/c', objectId: 'c' },
  ];
  const { store, sync, advance } = setup(createAzureClient({ cli: fakeCli(async () => ({ value: refs })) }), ['refs']);
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

test('a branch unreadable in the first refs snapshot is not announced as first seen once it reads', async () => {
  let refs: unknown[] = [
    { name: 'refs/heads/main', objectId: 'a' },
    { name: 'refs/heads/b', objectId: 7 },
  ];
  const { store, sync, advance } = setup(createAzureClient({ cli: fakeCli(async () => ({ value: refs })) }), ['refs']);
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
  const { store, sync, advance } = setup(createAzureClient({ cli: fakeCli(async () => ({ value: refs })) }), ['refs']);
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
  const client = createAzureClient({ cli: fakeCli(async () => ({ value: refs })) });
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
    const client = createAzureClient({ cli: fakeCli(async () => ({ value: refs })) });
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
  const client = createAzureClient({ cli: fakeCli(async () => ({ value: refs })) });
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
  const { store, sync, advance } = setup(createAzureClient({ cli: fakeCli(async () => ({ value: refs })) }), ['refs']);
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
