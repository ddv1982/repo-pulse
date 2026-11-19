import test from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../server/store.js';
import { createSync } from '../server/sync.js';
import { createBackfill } from '../server/backfill.js';
import { createRewriteCheck } from '../server/rewrite-check.js';
import { mergeEvidenceBadge } from '../src/ui/merge-evidence.js';

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
const [A, B, C, D, E] = ['a', 'b', 'c', 'd', 'e'].map(char => char.repeat(40));
const ZERO = '0'.repeat(40);
/** @param {string} name @param {string} oldObjectId @param {string} newObjectId */
const move = (name, oldObjectId, newObjectId) => ({ name: `refs/heads/${name}`, oldObjectId, newObjectId });
const push = (id, refUpdates, date = LIVE) => ({ pushId: id, date, pushedBy: { displayName: 'A' }, refUpdates });
const commits = count => ({ items: Array.from({ length: count }, (_, i) => ({ commitId: String(i).repeat(40) })), nextCursor: null });
const byRef = list => [...(list || [])].sort((a, b) => a.ref.localeCompare(b.ref));

/**
 * A live sync whose only due stream is pushes, with the rewrite check as its background work.
 * @param {{ pushes?: object[], dropped?: (from: string, to: string) => Promise<object> }} options
 */
function setup({ pushes = [], dropped = async () => commits(0) } = {}) {
  const store = createStore();
  store.saveRepo(repo);
  let time = BASE;
  const calls = [];
  const offered = { pushes };
  const provider = {
    read: async (_repo, stream) => ({ items: offered[stream] || [], nextCursor: null }),
    async droppedCommits(_repo, from, to) {
      calls.push([from, to]);
      return dropped(from, to);
    },
  };
  const check = createRewriteCheck({ store, provider, now: () => time });
  /** @type {ReturnType<typeof createBackfill> | undefined} */
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
  for (const state of store.getStreams()) if (state.stream !== 'pushes') store.saveStream({ ...state, nextAt: '2099-01-01T00:00:00Z' });
  return {
    store,
    sync,
    calls,
    offered,
    backfill,
    advance(ms) {
      time += ms;
    },
    async run(turns = 6) {
      for (let i = 0; i < turns; i++) await sync.tick();
    },
  };
}

test('a live force-push checks each moved branch with one call and shows History rewritten', async () => {
  const { store, calls, run } = setup({
    pushes: [push(10, [move('main', A, B), move('feature', C, D), move('new', ZERO, E), move('gone', E, ZERO)])],
    dropped: async from => commits(from === A ? 2 : 0),
  });
  await run(8);
  assert.deepEqual(
    calls.sort(),
    [
      [A, B],
      [C, D],
    ],
    'one call per moved branch; created and deleted branches are not checked',
  );
  const event = store.getEvent('one:push:10');
  assert.deepEqual(byRef(event.data.mergeEvidence.rewrite), [
    { ref: 'refs/heads/feature', status: 'fast-forward' },
    { ref: 'refs/heads/main', status: 'rewrite', dropped: 2 },
  ]);
  assert.match(mergeEvidenceBadge(event), /History rewritten · 2 commits dropped/);
  assert.deepEqual(store.listJobs({ type: 'rewrite' }), []);
  store.close();
});

test('a live fast-forward push makes one call and shows no badge', async () => {
  const { store, calls, run } = setup({ pushes: [push(11, [move('main', A, B)])] });
  await run();
  assert.deepEqual(calls, [[A, B]]);
  const event = store.getEvent('one:push:11');
  assert.deepEqual(event.data.mergeEvidence.rewrite, [{ ref: 'refs/heads/main', status: 'fast-forward' }]);
  assert.equal(mergeEvidenceBadge(event), '');
  store.close();
});

test('imported pushes are never checked, from the first sync or from a history import', async () => {
  const { store, calls, run, offered, backfill } = setup({
    pushes: [push(12, [move('main', A, B)], new Date(BASE - 60000).toISOString())],
  });
  await run();
  assert.equal(store.getEvent('one:push:12').imported, true);
  offered.pushes = [push(18, [move('main', C, D)], new Date(BASE - 2 * 86400000).toISOString())];
  backfill.start(repo.id, 30);
  await run(20);
  assert.equal(store.getEvent('one:push:18').imported, true);
  assert.deepEqual(calls, []);
  assert.deepEqual(store.listJobs({ type: 'rewrite' }), []);
  store.close();
});

test('an old tip Azure no longer has leaves the check unknown after one call', async () => {
  const { store, calls, run } = setup({
    pushes: [push(13, [move('main', A, B)])],
    dropped: async () => {
      throw Object.assign(new Error('gone'), { code: 'NOT_FOUND' });
    },
  });
  await run();
  assert.equal(calls.length, 1);
  const event = store.getEvent('one:push:13');
  assert.deepEqual(event.data.mergeEvidence.rewrite, [{ ref: 'refs/heads/main', status: 'unknown' }]);
  assert.equal(mergeEvidenceBadge(event), '');
  assert.deepEqual(store.listJobs({ type: 'rewrite' }), []);
  store.close();
});

test('a failing check backs off, retries and gives up as unknown', async () => {
  const { store, calls, run, advance } = setup({
    pushes: [push(14, [move('main', A, B)])],
    dropped: async () => {
      throw Object.assign(new Error('busy'), { code: 'THROTTLED' });
    },
  });
  await run();
  assert.equal(calls.length, 1, 'no retry before the back-off ends');
  const [job] = store.listJobs({ type: 'rewrite' });
  assert.equal(job.attempts, 1);
  assert.equal(store.getEvent('one:push:14').data.mergeEvidence, undefined, 'nothing is saved while retrying');
  for (let i = 0; i < 40; i++) {
    advance(30000);
    await run(2);
  }
  assert.equal(calls.length, 4);
  assert.deepEqual(store.getEvent('one:push:14').data.mergeEvidence.rewrite, [{ ref: 'refs/heads/main', status: 'unknown' }]);
  assert.deepEqual(store.listJobs({ type: 'rewrite' }), []);
  store.close();
});

test('a PR link on the same push survives the rewrite result, in either order', async () => {
  const pr = (id, target, mergeCommit) => ({
    id: `one:pr:${id}`,
    repoId: repo.id,
    kind: 'pr',
    time: LIVE,
    data: { pullRequestId: id, status: 'completed', targetRefName: `refs/heads/${target}`, mergeCommit },
  });
  const { store, run, offered, advance } = setup({ pushes: [push(15, [move('main', A, B)])], dropped: async () => commits(1) });
  store.insertEvents([pr(7, 'main', B)]);
  await run();
  const first = store.getEvent('one:push:15');
  assert.deepEqual(
    first.data.mergeEvidence.prs.map(item => item.pullRequestId),
    [7],
  );
  assert.deepEqual(first.data.mergeEvidence.rewrite, [{ ref: 'refs/heads/main', status: 'rewrite', dropped: 1 }]);
  assert.match(mergeEvidenceBadge(first), /Completed PR linked.*History rewritten · 1 commit dropped/);
  offered.pushes = [push(16, [move('release', C, D)])];
  advance(60000);
  await run();
  store.insertEvents([pr(8, 'release', D)]);
  const second = store.getEvent('one:push:16');
  assert.deepEqual(
    second.data.mergeEvidence.prs.map(item => item.pullRequestId),
    [8],
  );
  assert.deepEqual(second.data.mergeEvidence.rewrite, [{ ref: 'refs/heads/release', status: 'rewrite', dropped: 1 }]);
  store.close();
});

test('a disabled repository keeps its checks waiting and a removed one drops them', async () => {
  const { store, sync, calls, run } = setup({ pushes: [push(17, [move('main', A, B)])] });
  await sync.tick();
  assert.equal(store.listJobs({ type: 'rewrite' }).length, 1);
  store.saveRepo({ ...repo, disabled: true });
  await run();
  assert.deepEqual(calls, []);
  assert.equal(store.listJobs({ type: 'rewrite' }).length, 1);
  store.removeRepo(repo.id);
  assert.deepEqual(store.listJobs({ type: 'rewrite' }), []);
  store.close();
});
