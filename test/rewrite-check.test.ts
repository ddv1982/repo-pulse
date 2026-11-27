import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createStore } from '../server/store.ts';
import { createSync } from '../server/sync.ts';
import { createBackfill } from '../server/backfill.ts';
import { createRewriteCheck, type RewriteJob } from '../server/rewrite-check.ts';
import { mergeEvidenceBadge as mergeEvidenceBadgeHtml } from '../src/ui/merge-evidence.ts';
import { activityTitle } from '../src/activity-text.ts';
import type { AzurePage, AzureProvider } from '../server/azure-client.ts';
import type { AzureStreamRecord } from '../src/contract.ts';
import type { ActivityEvent, RewriteResult } from '../src/activity.ts';
import { present, stub } from './fixtures/typed.ts';

const mergeEvidenceBadge = (...args: Parameters<typeof mergeEvidenceBadgeHtml>) => String(mergeEvidenceBadgeHtml(...args));

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
const sha = (char: string) => char.repeat(40);
const [A, B, C, D, E] = [sha('a'), sha('b'), sha('c'), sha('d'), sha('e')];
const ZERO = '0'.repeat(40);
const move = (name: string, oldObjectId: string, newObjectId: string) => ({ name: `refs/heads/${name}`, oldObjectId, newObjectId });
const push = (id: number, refUpdates: ReturnType<typeof move>[], date = LIVE) => ({
  pushId: id,
  date,
  pushedBy: { displayName: 'A' },
  refUpdates,
});
const commits = (count: number): AzurePage<unknown> => ({
  items: Array.from({ length: count }, (_, i) => ({ commitId: String(i).repeat(40) })),
  nextCursor: null,
});
const byRef = (list: RewriteResult[] | undefined) => [...(list || [])].sort((a, b) => a.ref.localeCompare(b.ref));

/**
 * A live sync whose only due stream is pushes, with the rewrite check as its background work.
 */
function setup({
  pushes = [],
  dropped = async () => commits(0),
}: { pushes?: AzureStreamRecord[]; dropped?: (from: string, to: string) => Promise<AzurePage<unknown>> } = {}) {
  const store = createStore();
  store.saveRepo(repo);
  let time = BASE;
  const calls: [string, string][] = [];
  const offered: Record<string, AzureStreamRecord[]> = { pushes };
  const provider = stub<AzureProvider>({
    read: async (_repo, stream) => ({ items: offered[stream] || [], nextCursor: null }),
    async droppedCommits(_repo, from, to) {
      calls.push([from, to]);
      return dropped(from, to);
    },
  });
  const check = createRewriteCheck({ store, provider, now: () => time });
  let backfill: ReturnType<typeof createBackfill> | undefined;
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
    advance(this: void, ms: number) {
      time += ms;
    },
    async run(this: void, turns = 6) {
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
    calls.sort(([a], [b]) => a.localeCompare(b)),
    [
      [A, B],
      [C, D],
    ],
    'one call per moved branch; created and deleted branches are not checked',
  );
  const event = present(store.getEvent('one:push:10'));
  assert.deepEqual(byRef(event.data?.mergeEvidence?.rewrite), [
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
  const event = present(store.getEvent('one:push:11'));
  assert.deepEqual(event.data?.mergeEvidence?.rewrite, [{ ref: 'refs/heads/main', status: 'fast-forward' }]);
  assert.equal(mergeEvidenceBadge(event), '');
  store.close();
});

test('imported pushes are never checked, from the first sync or from a history import', async () => {
  const { store, calls, run, offered, backfill } = setup({
    pushes: [push(12, [move('main', A, B)], new Date(BASE - 60000).toISOString())],
  });
  await run();
  assert.equal(store.getEvent('one:push:12')?.imported, true);
  offered.pushes = [push(18, [move('main', C, D)], new Date(BASE - 2 * 86400000).toISOString())];
  backfill.start(repo.id, 30);
  await run(20);
  assert.equal(store.getEvent('one:push:18')?.imported, true);
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
  const event = present(store.getEvent('one:push:13'));
  assert.deepEqual(event.data?.mergeEvidence?.rewrite, [{ ref: 'refs/heads/main', status: 'unknown' }]);
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
  const job = present(store.listJobs({ type: 'rewrite' })[0]);
  assert.equal(job.attempts, 1);
  assert.equal(present(present(store.getEvent('one:push:14')).data).mergeEvidence, undefined, 'nothing is saved while retrying');
  for (let i = 0; i < 40; i++) {
    advance(30000);
    await run(2);
  }
  assert.equal(calls.length, 4);
  assert.deepEqual(store.getEvent('one:push:14')?.data?.mergeEvidence?.rewrite, [{ ref: 'refs/heads/main', status: 'unknown' }]);
  assert.deepEqual(store.listJobs({ type: 'rewrite' }), []);
  store.close();
});

test('a PR link on the same push survives the rewrite result, in either order', async () => {
  const pr = (id: number, target: string, mergeCommit: string): ActivityEvent => ({
    id: `one:pr:${id}`,
    repoId: repo.id,
    kind: 'pr',
    time: LIVE,
    data: { pullRequestId: id, status: 'completed', targetRefName: `refs/heads/${target}`, mergeCommit },
  });
  const { store, run, offered, advance } = setup({ pushes: [push(15, [move('main', A, B)])], dropped: async () => commits(1) });
  store.insertEvents([pr(7, 'main', B)]);
  await run();
  const first = present(store.getEvent('one:push:15'));
  assert.deepEqual(
    first.data?.mergeEvidence?.prs?.map(item => item.pullRequestId),
    [7],
  );
  assert.deepEqual(first.data?.mergeEvidence?.rewrite, [{ ref: 'refs/heads/main', status: 'rewrite', dropped: 1 }]);
  assert.equal(activityTitle(first), 'Merge of PR 7 pushed to main');
  assert.match(mergeEvidenceBadge(first), /History rewritten · 1 commit dropped/);
  assert.doesNotMatch(mergeEvidenceBadge(first), /Completed PR linked/);
  offered.pushes = [push(16, [move('release', C, D)])];
  advance(60000);
  await run();
  store.insertEvents([pr(8, 'release', D)]);
  const second = present(store.getEvent('one:push:16'));
  assert.deepEqual(
    second.data?.mergeEvidence?.prs?.map(item => item.pullRequestId),
    [8],
  );
  assert.deepEqual(second.data?.mergeEvidence?.rewrite, [{ ref: 'refs/heads/release', status: 'rewrite', dropped: 1 }]);
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

test('due rewrite checks and a history import share background turns', async () => {
  const refs = Array.from({ length: 10 }, (_, i) => move(`b${i}`, A, B));
  const { store, calls, run, backfill } = setup({ pushes: [push(19, refs)] });
  await run(1);
  assert.equal(store.listJobs({ type: 'rewrite' }).length, 10);
  backfill.start(repo.id, 'all');
  await run(10);
  assert.equal(calls.length, 5, 'rewrite checks take the first and every other turn');
  assert.equal(present(store.listJobs({ type: 'backfill' })[0]).pages, 5, 'history import takes the turns between them');
  store.close();
});

test('a check whose result cannot be stored keeps its job and saves no evidence', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'pulse-rewrite-'));
  const path = join(folder, 'state.sqlite');
  const store = createStore(path);
  store.saveRepo(repo);
  store.insertEvents([{ id: 'one:push:20', repoId: repo.id, kind: 'push', title: 'push', time: LIVE }]);
  const job: Pick<RewriteJob, 'id' | 'type' | 'repoId' | 'eventId'> = {
    id: 'rewrite:one:push:20:refs/heads/main',
    type: 'rewrite',
    repoId: repo.id,
    eventId: 'one:push:20',
  };
  store.saveJob({ ...job, ref: 'refs/heads/main', oldObjectId: A, newObjectId: B, attempts: 0, nextAt: new Date(BASE).toISOString() });
  const raw = new DatabaseSync(path);
  raw.exec("CREATE TRIGGER fail BEFORE DELETE ON jobs BEGIN SELECT RAISE(ABORT, 'disk full'); END");
  raw.close();
  const check = createRewriteCheck({ store, provider: { droppedCommits: async () => commits(1) }, now: () => BASE });
  await check.tick();
  assert.equal(present(present(store.getEvent('one:push:20')).data).mergeEvidence, undefined, 'evidence and job removal commit together');
  assert.equal(store.listJobs({ type: 'rewrite' }).length, 1);
  store.close();
  rmSync(folder, { recursive: true });
});

test('closing the app during the last attempt leaves the check to resume on restart', async () => {
  const { store, calls, run, advance } = setup({
    pushes: [push(21, [move('main', A, B)])],
    dropped: async () => {
      throw Object.assign(new Error(calls.length < 4 ? 'busy' : 'closed'), { code: calls.length < 4 ? 'THROTTLED' : 'CLOSED' });
    },
  });
  await run();
  for (let i = 0; i < 40 && calls.length < 4; i++) {
    advance(30000);
    await run(2);
  }
  assert.equal(calls.length, 4);
  const [job] = store.listJobs({ type: 'rewrite' });
  assert.equal(job?.attempts, 3, 'shutdown does not use up an attempt');
  assert.equal(present(present(store.getEvent('one:push:21')).data).mergeEvidence, undefined);
  store.close();
});

test('a failed save waits instead of taking every turn, and a proven rewrite is never stored as unknown', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'pulse-rewrite-'));
  const path = join(folder, 'state.sqlite');
  const store = createStore(path);
  store.saveRepo(repo);
  store.insertEvents([{ id: 'one:push:21', repoId: repo.id, kind: 'push', title: 'push', time: LIVE }]);
  const job: Pick<RewriteJob, 'id' | 'type' | 'repoId' | 'eventId'> = {
    id: 'rewrite:one:push:21:refs/heads/main',
    type: 'rewrite',
    repoId: repo.id,
    eventId: 'one:push:21',
  };
  store.saveJob({ ...job, ref: 'refs/heads/main', oldObjectId: A, newObjectId: B, attempts: 3, nextAt: new Date(BASE).toISOString() });
  let raw = new DatabaseSync(path);
  raw.exec("CREATE TRIGGER fail BEFORE DELETE ON jobs BEGIN SELECT RAISE(ABORT, 'disk full'); END");
  raw.close();
  let time = BASE;
  let calls = 0;
  const throttled = Object.assign(new Error('slow down'), { code: 'THROTTLED' });
  const check = createRewriteCheck({
    store,
    provider: { droppedCommits: async () => (calls++ ? Promise.reject(throttled) : commits(2)) },
    now: () => time,
  });
  assert.equal(await check.tick(), true);
  assert.equal(await check.tick(), false, 'the failed check waits, so other background work gets the turn');
  assert.equal(calls, 1);
  raw = new DatabaseSync(path);
  raw.exec('DROP TRIGGER fail');
  raw.close();
  time += 2 * 60000;
  assert.equal(await check.tick(), true);
  assert.equal(present(store.getEvent('one:push:21')?.data?.mergeEvidence?.rewrite?.[0]).status, 'rewrite');
  assert.equal(calls, 1, 'the saved Azure answer is written, not asked for again');
  assert.equal(store.listJobs({ type: 'rewrite' }).length, 0);
  store.close();
  rmSync(folder, { recursive: true });
});

test('a re-added repository reruns a rewrite check whose old result could not be saved', async t => {
  const store = createStore();
  t.after(() => store.close());
  const eventId = 'one:push:22';
  const ref = 'refs/heads/main';
  const id = `rewrite:${eventId}:${ref}`;
  const add = () => {
    store.saveRepo(repo);
    store.insertEvents([{ id: eventId, repoId: repo.id, kind: 'push', title: 'push', time: LIVE }]);
    store.saveJob({
      id,
      type: 'rewrite',
      repoId: repo.id,
      eventId,
      ref,
      oldObjectId: A,
      newObjectId: B,
      attempts: 0,
      nextAt: new Date(BASE).toISOString(),
    });
  };
  add();
  let time = BASE;
  let calls = 0;
  const check = createRewriteCheck({
    store,
    provider: { droppedCommits: async () => commits(calls++ ? 0 : 1) },
    now: () => time,
  });
  const failedSave = t.mock.method(store, 'saveRewriteResult', () => {
    throw new Error('database write failed');
  });
  assert.equal(await check.tick(), true);
  assert.equal(failedSave.mock.calls.length, 1);
  failedSave.mock.restore();
  store.removeRepo(repo.id);
  check.forget(repo.id);
  add();
  time += 120000;
  assert.equal(await check.tick(), true);
  assert.deepEqual(store.getEvent(eventId)?.data?.mergeEvidence?.rewrite, [{ ref, status: 'fast-forward' }]);
  assert.equal(calls, 2);
});

test('a reset forgets a result that could not be saved, so a later check asks Azure again', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'pulse-rewrite-'));
  const path = join(folder, 'state.sqlite');
  const store = createStore(path);
  store.saveRepo(repo);
  store.insertEvents([{ id: 'one:push:22', repoId: repo.id, kind: 'push', title: 'push', time: LIVE }]);
  const job: Pick<RewriteJob, 'id' | 'type' | 'repoId' | 'eventId'> = {
    id: 'rewrite:one:push:22:refs/heads/main',
    type: 'rewrite',
    repoId: repo.id,
    eventId: 'one:push:22',
  };
  store.saveJob({ ...job, ref: 'refs/heads/main', oldObjectId: A, newObjectId: B, attempts: 0, nextAt: new Date(BASE).toISOString() });
  let raw = new DatabaseSync(path);
  raw.exec("CREATE TRIGGER fail BEFORE DELETE ON jobs BEGIN SELECT RAISE(ABORT, 'disk full'); END");
  raw.close();
  let time = BASE;
  let calls = 0;
  const check = createRewriteCheck({ store, provider: { droppedCommits: async () => (calls++, commits(0)) }, now: () => time });
  await check.tick();
  raw = new DatabaseSync(path);
  raw.exec('DROP TRIGGER fail');
  raw.close();
  check.reset();
  time += 2 * 60000;
  assert.equal(await check.tick(), true);
  assert.equal(calls, 2);
  store.close();
  rmSync(folder, { recursive: true });
});
