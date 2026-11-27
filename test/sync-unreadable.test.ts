// Records Azure returns unreadable: skipped records, the stream warnings that report them, and lookups by ID.
import test from 'node:test';
import assert from 'node:assert/strict';
import type { SyncProvider } from '../server/sync.ts';
import { createAzureClient } from '../server/azure-client.ts';
import type { AzurePage } from '../server/azure-client.ts';
import { fieldsOf, present } from './fixtures/typed.ts';
import { fakeCli } from './fixtures/azure.ts';
import { repo } from './fixtures/repository.ts';
import { BASE, setup, push, cachedPr, pushesState } from './fixtures/sync.ts';
/** The live client over a CLI that answers every read with these pushes, so the record guards run as in the app. */
const clientReturning = (pushes: unknown[]) => createAzureClient({ cli: fakeCli(async () => ({ value: pushes })) });
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
  const client = createAzureClient({ cli: fakeCli(async () => ({ value: pushes })) });
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
    cli: fakeCli(async args =>
      args[0] === 'repos'
        ? args.includes('1')
          ? { ...cachedPr(1, 'completed'), repository: { id: 'a' }, reviewers: { id: 'r' } }
          : { ...cachedPr(2, 'completed'), repository: { id: 'a' } }
        : { value: listed },
    ),
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
    cli: fakeCli(async args => {
      if (args.some(arg => arg.startsWith('buildIds='))) {
        asked.push('42');
        return { value: [{ ...build, status: 7 }] };
      }
      return { value: active ? [build] : [] };
    }),
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
    cli: fakeCli(async args => {
      if (args[0] === 'repos') {
        lookups.push(String(args[args.indexOf('--id') + 1]));
        return { ...cachedPr(1), repository: { id: 'a' }, reviewers: { id: 'r' } };
      }
      return { value: listed };
    }),
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
    cli: fakeCli(async args => {
      const ids = args.find(arg => arg.startsWith('buildIds='));
      if (ids) {
        lookups.push(ids);
        return { value: [{ ...build, status: 7 }] };
      }
      return { value: listed };
    }),
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
    cli: fakeCli(async args => {
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
    }),
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
      cli: fakeCli(async args =>
        args.some(arg => arg.startsWith('buildIds='))
          ? { value: answer === undefined ? [] : [answer] }
          : { value: listed ? [inProgressBuild(42)] : [] },
      ),
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
    cli: fakeCli(async args => (args.some(arg => arg.startsWith('buildIds=')) ? { value: [withoutId] } : { value: listed })),
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
    cli: fakeCli(async args => {
      if (args[0] !== 'repos') return { value: listed };
      if (args.includes('1')) {
        const withoutId: Record<string, unknown> = { ...cachedPr(1, 'completed'), repository: { id: 'a' } };
        delete withoutId.pullRequestId;
        return withoutId;
      }
      return { ...cachedPr(2, 'completed'), repository: { id: 'a' } };
    }),
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
    cli: fakeCli(async args => {
      if (args[0] !== 'repos') return { value: listed };
      const id = String(args[args.indexOf('--id') + 1]);
      asked.push(id);
      const answer: Record<string, unknown> = { ...cachedPr(Number(id), 'completed'), repository: { id: 'a' } };
      if (id === '1') delete answer.pullRequestId;
      return answer;
    }),
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
  const client = createAzureClient({ cli: fakeCli(async args => (args[0] !== 'repos' ? { value: listed } : withoutId('active'))) });
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
    cli: fakeCli(async () => ({
      value: [
        { ...build(1), repository: null },
        withoutRepository,
        { ...build(3), repository: {} },
        { ...build(4), repository: { id: 'other' } },
        build(5),
      ],
    })),
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
