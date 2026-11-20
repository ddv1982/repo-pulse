import test from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../server/store.js';
import { createSync } from '../server/sync.js';
import { createBackfill } from '../server/backfill.js';
import { createForkOriginCheck, MAX_READS } from '../server/fork-origin.js';

const repo = {
  id: 'one',
  name: 'One',
  azureId: 'a',
  organization: 'https://dev.azure.com/org',
  project: 'P',
  webUrl: 'https://dev.azure.com/org/P/_git/One',
};
const BASE = Date.parse('2026-11-17T10:00:00Z');
const LIVE = '2026-11-17T10:00:01Z';
const [A, B, C, D, E, F] = ['a', 'b', 'c', 'd', 'e', 'f'].map(char => char.repeat(40));
const ZERO = '0'.repeat(40);
const move = (name, oldObjectId, newObjectId) => ({ name: `refs/heads/${name}`, oldObjectId, newObjectId });
const push = (id, refUpdates, date = LIVE) => ({ pushId: id, date, pushedBy: { displayName: 'A' }, refUpdates });
const pr = (id, source, target) => ({
  pullRequestId: id,
  status: 'active',
  title: `PR ${id}`,
  sourceRefName: `refs/heads/${source}`,
  targetRefName: `refs/heads/${target}`,
  repository: { id: 'a' },
  createdBy: { displayName: 'A' },
  creationDate: '2026-11-17T09:59:00Z',
});
const page = count => ({ items: Array.from({ length: count }, (_, i) => ({ commitId: String(i).repeat(40) })), nextCursor: null });
const notFound = () => Object.assign(new Error('gone'), { code: 'NOT_FOUND' });

/**
 * A live sync of pushes and PRs, with the fork origin check as its background work.
 * `graph` maps a commit to its parents and the push that brought it; `contains(base, tip)` answers ancestry checks.
 */
function setup({ pushes = [], prs = [], graph = {}, contains = () => false, commit, pages } = {}) {
  const store = createStore();
  store.saveRepo(repo);
  let time = BASE;
  const reads = [];
  const checks = [];
  const offered = { pushes, prs };
  const provider = {
    read: async (_repo, stream, { cursor } = {}) =>
      stream === 'pushes' && pages
        ? { items: pages[cursor?.skip ? 1 : 0], nextCursor: cursor?.skip ? null : { skip: 100 } }
        : { items: offered[stream] || [], nextCursor: null },
    async commit(_repo, id) {
      reads.push(id);
      if (commit) return commit(id);
      if (!graph[id]) throw notFound();
      return graph[id];
    },
    async droppedCommits(_repo, from, to) {
      checks.push([from, to]);
      const held = contains(from, to);
      if (held instanceof Error) throw held;
      return page(held ? 0 : 2);
    },
  };
  const check = createForkOriginCheck({ store, provider, now: () => time });
  let backfill;
  const sync = createSync({
    store,
    provider,
    now: () => time,
    intervalMs: 60000,
    background: { rewrite: () => check.tick(), history: () => backfill?.tick() },
  });
  backfill = createBackfill({ store, provider, normalize: sync.normalize, now: () => time });
  sync.refresh();
  for (const state of store.getStreams())
    if (!['pushes', 'prs'].includes(state.stream)) store.saveStream({ ...state, nextAt: '2099-01-01T00:00:00Z' });
  return {
    store,
    reads,
    checks,
    offered,
    backfill,
    check,
    sync,
    advance(ms) {
      time += ms;
    },
    async run(turns = 12) {
      for (let i = 0; i < turns; i++) await sync.tick();
    },
  };
}
const origin = (store, pushId, name) => store.getEvent(`one:branch-created:${pushId}:refs/heads/${name}`)?.data.forkOrigin;

test('a branch created at the latest recorded tip of another branch is settled with one commit read', async () => {
  const { store, reads, checks, run } = setup({
    pushes: [push(10, [move('feature', ZERO, B)]), push(5, [move('main', A, B)])],
    graph: { [B]: { parents: [A], pushId: 5 } },
  });
  await run();
  assert.deepEqual(reads, [B]);
  assert.deepEqual(checks, []);
  assert.deepEqual(origin(store, 10, 'feature'), { status: 'found', base: B, on: ['refs/heads/main'], via: 'tip' });
  assert.deepEqual(store.listJobs({ type: 'fork' }), []);
  store.close();
});

test('the walk passes the commits the creating push brought and stops at the first older one', async () => {
  const { store, reads, run } = setup({
    // feature-b was cut from feature-a's tip C and pushed with two new commits.
    pushes: [push(10, [move('feature-b', ZERO, E)]), push(6, [move('feature-a', ZERO, C)]), push(5, [move('main', ZERO, A)])],
    graph: {
      [E]: { parents: [D], pushId: 10 },
      [D]: { parents: [C], pushId: 10 },
      [C]: { parents: [A], pushId: 6 },
      [A]: { parents: [], pushId: 5 },
    },
  });
  await run(16);
  assert.deepEqual(
    reads.filter(id => [E, D].includes(id)),
    [E, D],
  );
  assert.equal(reads.length, 6, 'three reads for feature-b, two for feature-a, one for main');
  assert.deepEqual(origin(store, 5, 'main'), { status: 'orphan' });
  assert.deepEqual(origin(store, 10, 'feature-b'), { status: 'found', base: C, on: ['refs/heads/feature-a'], via: 'tip' });
  assert.deepEqual(origin(store, 6, 'feature-a'), { status: 'found', base: A, on: ['refs/heads/main'], via: 'tip' });
  store.close();
});

test('only the latest recorded tip before the creating push counts, including a move in that same push', async () => {
  const { store, run } = setup({
    pushes: [
      push(10, [move('tie', ZERO, B)]),
      push(9, [move('late', ZERO, C)]),
      push(8, [move('main', C, D)]),
      push(7, [move('main', B, C), move('release', ZERO, B)]),
      push(5, [move('main', A, B)]),
    ],
    graph: { [B]: { parents: [A], pushId: 5 }, [C]: { parents: [B], pushId: 7 } },
  });
  await run(16);
  assert.deepEqual(origin(store, 10, 'tie'), { status: 'found', base: B, on: ['refs/heads/release'], via: 'tip' });
  assert.deepEqual(origin(store, 9, 'late'), { status: 'none', base: C, notOn: [] });
  const tips = store.branchTipsBefore('one', 11);
  assert.equal(tips.get('refs/heads/main'), D);
  assert.deepEqual(
    origin(store, 7, 'release'),
    { status: 'found', base: B, on: ['refs/heads/main'], via: 'tip' },
    'main moved in the same push, so its tip before that push counts',
  );
  store.close();
});

test('two branches whose tip is the base are both named, so no single parent is claimed', async () => {
  const { store, run } = setup({
    pushes: [push(10, [move('feature', ZERO, B)]), push(6, [move('release', ZERO, B)]), push(5, [move('main', A, B)])],
    graph: { [B]: { parents: [A], pushId: 5 } },
  });
  await run(16);
  assert.deepEqual(origin(store, 10, 'feature'), { status: 'found', base: B, on: ['refs/heads/main', 'refs/heads/release'], via: 'tip' });
  store.close();
});

test('without a tip match the pull request targets and the common target are checked for containing the base', async () => {
  const { store, checks, run } = setup({
    // feature started at C, an older commit of main, and asks to merge into release/x.
    pushes: [
      push(10, [move('feature', ZERO, E)]),
      push(8, [move('main', C, D)]),
      push(7, [move('release/x', ZERO, F)]),
      push(5, [move('main', A, C)]),
    ],
    prs: [pr(1, 'feature', 'release/x'), pr(2, 'other', 'main'), pr(3, 'more', 'main')],
    graph: { [E]: { parents: [C], pushId: 10 }, [C]: { parents: [A], pushId: 5 } },
    contains: (base, tip) => base === C && tip === D,
  });
  await run(16);
  assert.deepEqual(checks, [
    [C, F],
    [C, D],
  ]);
  assert.deepEqual(origin(store, 10, 'feature'), {
    status: 'found',
    base: C,
    on: ['refs/heads/main'],
    via: 'contained',
    notOn: ['refs/heads/release/x'],
  });
  store.close();
});

test('a pull request target that does not contain the base is recorded as not holding it', async () => {
  const { store, run } = setup({
    pushes: [push(10, [move('feature', ZERO, E)]), push(8, [move('main', A, D)])],
    prs: [pr(1, 'feature', 'main')],
    graph: { [E]: { parents: [C], pushId: 10 }, [C]: { parents: [A], pushId: 4 } },
  });
  await run(16);
  assert.deepEqual(origin(store, 10, 'feature'), { status: 'none', base: C, notOn: ['refs/heads/main'] });
  store.close();
});

test('an orphan branch, a merge commit and a long walk end without a base', async () => {
  const orphan = setup({ pushes: [push(10, [move('orphan', ZERO, E)])], graph: { [E]: { parents: [], pushId: 10 } } });
  await orphan.run();
  assert.deepEqual(origin(orphan.store, 10, 'orphan'), { status: 'orphan' });
  orphan.store.close();

  const merge = setup({ pushes: [push(10, [move('merge', ZERO, E)])], graph: { [E]: { parents: [C, D], pushId: 10 } } });
  await merge.run();
  assert.deepEqual(origin(merge.store, 10, 'merge'), { status: 'merge' });
  merge.store.close();

  const long = setup({ pushes: [push(10, [move('long', ZERO, E)])], commit: () => ({ parents: [D], pushId: 10 }) });
  await long.run(30);
  assert.equal(long.reads.length, MAX_READS);
  assert.deepEqual(origin(long.store, 10, 'long'), { status: 'unknown' });
  long.store.close();
});

test('imported branch creations are never checked', async () => {
  const { store, reads, run } = setup({
    pushes: [push(10, [move('feature', ZERO, B)], new Date(BASE - 60000).toISOString())],
    graph: { [B]: { parents: [A], pushId: 5 } },
  });
  await run();
  assert.equal(store.getEvent('one:branch-created:10:refs/heads/feature').imported, true);
  assert.deepEqual(reads, []);
  assert.deepEqual(store.listJobs({ type: 'fork' }), []);
  store.close();
});

test('a commit Azure no longer has ends the check as unknown after one read, and other failures retry first', async () => {
  const gone = setup({ pushes: [push(10, [move('feature', ZERO, B)])] });
  await gone.run();
  assert.deepEqual(gone.reads, [B]);
  assert.deepEqual(origin(gone.store, 10, 'feature'), { status: 'unknown' });
  gone.store.close();

  const busy = setup({
    pushes: [push(10, [move('feature', ZERO, B)])],
    commit: () => {
      throw Object.assign(new Error('busy'), { code: 'THROTTLED' });
    },
  });
  await busy.run();
  assert.equal(busy.reads.length, 1);
  assert.equal(origin(busy.store, 10, 'feature'), undefined);
  assert.equal(busy.store.listJobs({ type: 'fork' })[0].attempts, 1);
  for (let i = 0; i < 4; i++) {
    busy.advance(10 * 60000);
    await busy.run(4);
  }
  assert.equal(busy.reads.length, 4);
  assert.deepEqual(origin(busy.store, 10, 'feature'), { status: 'unknown' });
  assert.deepEqual(busy.store.listJobs({ type: 'fork' }), []);
  busy.store.close();
});

test('fork candidates are the branch pull request targets, oldest first, then the most common target', async () => {
  const { store, run } = setup({
    prs: [
      pr(1, 'feature', 'release/x'),
      pr(2, 'a', 'main'),
      pr(3, 'b', 'main'),
      pr(6, 'd', 'main'),
      pr(4, 'c', 'develop'),
      pr(5, 'feature', 'develop'),
    ],
  });
  await run(4);
  assert.deepEqual(store.forkCandidates('one', 'refs/heads/feature'), ['refs/heads/release/x', 'refs/heads/develop', 'refs/heads/main']);
  assert.deepEqual(store.forkCandidates('one', 'refs/heads/main'), []);
  store.close();
});

test('a check waits while the push stream is still reading older pages of the same window', async () => {
  const { store, reads, check, sync, run } = setup({
    pages: [[push(10, [move('feature', ZERO, B)])], [push(5, [move('main', A, B)])]],
    graph: { [B]: { parents: [A], pushId: 5 } },
  });
  while (!store.getEvent('one:branch-created:10:refs/heads/feature')) await sync.tick();
  assert.equal(store.getEvent('one:push:5'), undefined, 'the older page is not read yet');
  assert.equal(await check.tick(), false);
  assert.deepEqual(reads, []);
  await run();
  assert.deepEqual(origin(store, 10, 'feature'), { status: 'found', base: B, on: ['refs/heads/main'], via: 'tip' });
});

test('a failed ancestry read keeps the base and the candidates already ruled out', async () => {
  const { store, run } = setup({
    pushes: [push(10, [move('feature', ZERO, E)]), push(8, [move('main', C, D)]), push(7, [move('release/x', ZERO, F)])],
    prs: [pr(1, 'feature', 'release/x'), pr(2, 'other', 'main')],
    graph: { [E]: { parents: [C], pushId: 10 }, [C]: { parents: [A], pushId: 4 } },
    contains: (_base, tip) => (tip === D ? notFound() : false),
  });
  await run(16);
  assert.deepEqual(origin(store, 10, 'feature'), {
    status: 'none',
    base: C,
    notOn: ['refs/heads/release/x'],
    unanswered: ['refs/heads/main'],
  });
  store.close();
});

test('a candidate whose read fails is skipped, and the others are still checked', async () => {
  const { store, checks, run } = setup({
    pushes: [push(10, [move('feature', ZERO, E)]), push(8, [move('main', C, D)]), push(7, [move('release/x', ZERO, F)])],
    prs: [pr(1, 'feature', 'release/x'), pr(2, 'other', 'main'), pr(3, 'more', 'main')],
    graph: { [E]: { parents: [C], pushId: 10 }, [C]: { parents: [A], pushId: 4 } },
    contains: (_base, tip) => (tip === F ? notFound() : tip === D),
  });
  await run(16);
  assert.deepEqual(checks, [
    [C, F],
    [C, D],
  ]);
  assert.deepEqual(origin(store, 10, 'feature'), {
    status: 'found',
    base: C,
    on: ['refs/heads/main'],
    via: 'contained',
    notOn: [],
    unanswered: ['refs/heads/release/x'],
  });
  store.close();
});

test('a push window that starts after the creation does not hold the check back', async () => {
  const { store, reads, check, sync } = setup({
    pages: [[push(10, [move('feature', ZERO, B)]), push(5, [move('main', A, B)])], []],
    graph: { [B]: { parents: [A], pushId: 5 } },
  });
  while (!store.getEvent('one:push:5')) await sync.tick();
  const state = store.getStreams().find(entry => entry.stream === 'pushes');
  const since = new Date(Date.parse(LIVE) + 60000).toISOString();
  store.saveStream({ ...state, window: { since, until: since } });
  assert.equal(await check.tick(), true);
  assert.deepEqual(reads, [B]);
  store.close();
});

test('only a commit from a strictly earlier push is taken as the base', async () => {
  for (const pushId of [null, 11]) {
    const { store, run } = setup({ pushes: [push(10, [move('feature', ZERO, B)])], graph: { [B]: { parents: [A], pushId } } });
    await run();
    assert.deepEqual(origin(store, 10, 'feature'), { status: 'unknown' }, `push ${pushId}`);
    store.close();
  }
});
