import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createStore } from '../server/store.ts';
import { createNormalizer } from '../server/normalize.ts';
import { createHistoryImporter } from '../server/history-import.ts';
import type { AzurePage, AzureProvider, ReadOptions } from '../server/azure-client.ts';
import type { ActivityEvent } from '../src/activity.ts';
import type { AzureStream, Repository } from '../src/contract.ts';
import { fieldsOf, present, stub } from './fixtures/typed.ts';

type Provider = Pick<AzureProvider, 'read'>;
type Normalize = Parameters<typeof createHistoryImporter>[0]['normalize'];
/** What a fake provider was asked to read. */
type ReadCall = { stream: AzureStream } & ReadOptions;

const BASE = Date.parse('2026-11-17T10:00:00Z');
const DAY = 86400000;
const repo = stub<Repository>({ id: 'one', name: 'One', azureId: 'a' });
const iso = (value: number) => new Date(value).toISOString();
/** A record the fake providers below return. It has the fields a build needs, so it types as an Azure record. */
type Item = { id: number; date: string; repository: { id: string } };
const normalizer: Normalize = (repo, stream, records, state) => {
  assert.equal(state.historical, true);
  // The records are the items the test's fake provider returned.
  const items = records as Item[];
  return {
    events: items.map((item): ActivityEvent => ({
      id: `${repo.id}:${stream}:${item.id}`,
      repoId: repo.id,
      kind: stream === 'pushes' ? 'push' : stream === 'builds' ? 'build' : 'pr',
      time: item.date,
      observedAt: iso(BASE),
      imported: false,
      seen: false,
      data: { pushId: item.id },
    })),
    entities: items.flatMap(item => [
      { type: stream === 'pushes' ? 'push' : 'build', id: String(item.id), data: { date: item.date, status: 'historical' } },
      { type: 'ref', id: 'refs/heads/main', data: { objectId: 'old' } },
    ]),
  };
};
function setup(
  provider: Provider,
  { now = () => BASE, path, normalize = normalizer }: { now?: () => number; path?: string; normalize?: Normalize } = {},
) {
  const store = createStore(path);
  if (!store.listRepos().length) store.saveRepo(repo);
  store.setBaseline(repo.id, iso(BASE));
  const historyImporter = createHistoryImporter({ store, provider, normalize, now });
  return { store, historyImporter };
}

test('history sign-in retry covers due and recovering jobs and coalesces repeat clicks', () => {
  const { store, historyImporter } = setup({
    async read() {
      return { items: [], nextCursor: null };
    },
  });
  const second = { ...repo, id: 'two' };
  store.saveRepo(second);
  const one = historyImporter.start(repo.id);
  const two = historyImporter.start(second.id);
  const later = iso(BASE + 1800000);
  const auth = { code: 'AUTH_REQUIRED', message: 'Sign in again' };
  store.saveJob({ ...one, status: 'retrying', nextAt: later, error: auth });
  store.saveJob({ ...two, status: 'running', nextAt: iso(BASE), error: auth });
  assert.deepEqual(historyImporter.retrySignIn([repo.id]), { scheduled: true });
  assert.equal(historyImporter.status().find(job => job.id === one.id)?.nextAt, iso(BASE));
  assert.deepEqual(historyImporter.retrySignIn([repo.id]), { scheduled: false, cooldown: true });
  assert.deepEqual(historyImporter.retrySignIn([second.id]), { scheduled: true });
  store.saveJob({ ...one, status: 'retrying', nextAt: later, error: { code: 'UNAVAILABLE', message: 'Offline' } });
  assert.deepEqual(historyImporter.retrySignIn([repo.id]), { scheduled: false });
  assert.equal(historyImporter.status().find(job => job.id === one.id)?.nextAt, later);
  store.close();
});

test('a sign-in retry requested during a history read survives failure on the old credentials', async () => {
  const oldRead = Promise.withResolvers<AzurePage>();
  const auth = { code: 'AUTH_REQUIRED', message: 'Sign in again' };
  let calls = 0;
  const { store, historyImporter } = setup({
    async read() {
      if (++calls === 1) return oldRead.promise;
      return { items: [], nextCursor: null };
    },
  });
  const job = historyImporter.start(repo.id);
  store.saveJob({ ...job, status: 'retrying', error: auth, failures: 6 });
  const inFlight = historyImporter.tick();
  assert.equal(calls, 1);
  assert.deepEqual(historyImporter.retrySignIn([repo.id]), { scheduled: true });
  oldRead.reject(Object.assign(new Error(auth.message), { code: auth.code }));
  await inFlight;
  assert.equal(await historyImporter.tick(), true, 'retry without waiting for the stale read’s backoff');
  assert.equal(calls, 2);
  assert.equal(historyImporter.status()[0]?.error, null);
  store.close();
});

test('historical imports mark only new history read without changing live state', async () => {
  const calls: ReadCall[] = [];
  const provider: Provider = {
    async read(_repo, stream, given) {
      const options = present(given);
      calls.push({ stream, ...options });
      return {
        items: [{ id: stream === 'pushes' ? 1 : stream === 'closedPrs' ? 2 : 3, date: iso(BASE - DAY), repository: { id: 'a' } }],
        nextCursor: null,
      };
    },
  };
  const { store, historyImporter } = setup(provider);
  store.insertEvents([{ id: 'live', repoId: repo.id, kind: 'push', time: iso(BASE + 1000), seen: false }]);
  store.saveStream({
    repoId: repo.id,
    stream: 'pushes',
    initialized: true,
    nextAt: iso(BASE),
    lastSuccess: iso(BASE),
    cursor: { skip: 100 },
  });
  store.commitPage({
    repoId: repo.id,
    entities: [
      { type: 'build', id: '3', data: { status: 'inProgress' } },
      { type: 'ref', id: 'refs/heads/main', data: { objectId: 'current' } },
    ],
  });
  const streams = store.getStreams();
  const initial = historyImporter.start(repo.id);
  assert.equal(historyImporter.start(repo.id).id, initial.id);
  for (let page = 0; page < 3; page++) assert.equal(await historyImporter.tick(), true);
  assert.equal(await historyImporter.tick(), false);
  assert.deepEqual(
    calls.map(call => call.stream),
    ['pushes', 'closedPrs', 'builds'],
  );
  assert.equal(present(historyImporter.status()[0]).status, 'completed');
  assert.ok(
    store
      .listEvents()
      .filter(event => event.id !== 'live')
      .every(event => event.imported && event.seen),
  );
  assert.equal(present(store.listEvents().find(event => event.id === 'live')).seen, false);
  assert.deepEqual(store.getStreams(), streams);
  assert.equal(fieldsOf(store.getEntity(repo.id, 'build', 3)).status, 'inProgress');
  assert.equal(fieldsOf(store.getEntity(repo.id, 'ref', 'refs/heads/main')).objectId, 'current');
  assert.equal(fieldsOf(store.getEntity(repo.id, 'push', 1)).date, iso(BASE - DAY));
  store.close();
});

test('failed pages retain durable fixed windows and cursors across restart and retry', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'repo-pulse-backfill-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'test.sqlite');
  let time = BASE,
    fail = true;
  const calls: ReadCall[] = [];
  const provider: Provider = {
    async read(_repo, stream, given) {
      const options = present(given);
      calls.push({ stream, ...options });
      if (options.cursor && fail) throw Object.assign(new Error('Connection unavailable'), { code: 'UNAVAILABLE' });
      return {
        items: [{ id: options.cursor ? 2 : 1, date: iso(BASE - DAY), repository: { id: 'a' } }],
        nextCursor: options.cursor ? null : { skip: 100 },
      };
    },
  };
  let { store, historyImporter } = setup(provider, { path, now: () => time });
  historyImporter.start(repo.id, 90);
  await historyImporter.tick();
  await historyImporter.tick();
  const failed = present(historyImporter.status()[0]);
  assert.equal(failed.status, 'retrying');
  assert.deepEqual(failed.cursor, { skip: 100 });
  assert.equal(store.listEvents().length, 1);
  store.close();
  ({ store, historyImporter } = setup(provider, { path, now: () => time }));
  assert.equal(await historyImporter.tick(), false, 'retry delay cannot be bypassed by restart');
  fail = false;
  time += 60001;
  await historyImporter.tick();
  assert.deepEqual(present(calls[2]).cursor, { skip: 100 });
  assert.equal(present(calls[0]).since, present(calls[2]).since);
  assert.equal(present(calls[0]).until, present(calls[2]).until);
  assert.equal(present(historyImporter.status()[0]).stream, 'closedPrs');
  assert.equal(store.listEvents().length, 2);
  store.close();
});

test('a page cut off by closing the queue is not a failed attempt and resumes without back-off', async () => {
  let closed = true;
  const calls: ReadCall[] = [];
  const provider: Provider = {
    async read(_repo, stream, given) {
      const options = present(given);
      calls.push({ stream, ...options });
      if (closed) throw Object.assign(new Error('Azure CLI queue is closed.'), { code: 'CLOSED' });
      return { items: [], nextCursor: null };
    },
  };
  const { store, historyImporter } = setup(provider);
  historyImporter.start(repo.id, 90);
  const before = present(historyImporter.status()[0]);
  await historyImporter.tick();
  const after = present(historyImporter.status()[0]);
  assert.equal(after.failures ?? 0, 0);
  assert.equal(after.error ?? null, null);
  assert.equal(after.nextAt, before.nextAt);
  closed = false;
  assert.equal(await historyImporter.tick(), true, 'the page is due again at once');
  assert.equal(calls.length, 2);
  store.close();
});

test('all available history uses explicit 2010 boundary and keeps scanning older empty windows', async () => {
  const time = Date.parse('2010-02-05T00:00:00Z');
  const calls: ReadCall[] = [];
  const { store, historyImporter } = setup(
    {
      async read(_repo, stream, given) {
        const options = present(given);
        calls.push({ stream, ...options });
        return { items: [], nextCursor: null };
      },
    },
    { now: () => time },
  );
  store.setBaseline(repo.id, iso(time));
  const job = historyImporter.start(repo.id, 'all');
  assert.equal(job.rangeStart, '2010-01-01T00:00:00.000Z');
  assert.match(job.note, /retention and permissions/);
  for (let page = 0; page < 6; page++) await historyImporter.tick();
  assert.equal(calls.length, 6, 'an empty recent window does not prove no older history');
  assert.equal(present(historyImporter.status()[0]).status, 'completed');
  assert.equal(present(historyImporter.status()[0]).windowsCompleted, 2);
  assert.equal(present(calls[3]).until, present(calls[0]).since);
  assert.equal(present(calls[3]).since, job.rangeStart);
  store.close();
});

test('pause, removal and concurrent tick calls cannot duplicate work or resurrect jobs', async () => {
  let release: (() => void) | undefined,
    reads = 0;
  const { store, historyImporter } = setup({
    read() {
      reads++;
      return new Promise<AzurePage>(resolve => {
        release = () => resolve({ items: [{ id: 1, date: iso(BASE - DAY), repository: { id: 'a' } }], nextCursor: null });
      });
    },
  });
  historyImporter.start(repo.id);
  store.saveRepo({ ...repo, disabled: true });
  assert.equal(await historyImporter.tick(), false);
  assert.equal(reads, 0);
  store.saveRepo({ ...repo, disabled: false });
  const first = historyImporter.tick(),
    same = historyImporter.tick();
  assert.equal(first, same);
  assert.equal(reads, 1);
  store.saveRepo({ ...repo, disabled: true });
  assert.ok(release);
  release();
  await first;
  assert.equal(store.listEvents().length, 0);
  store.saveRepo({ ...repo, disabled: false });
  const second = historyImporter.tick();
  store.removeRepo(repo.id);
  assert.ok(release);
  release();
  await second;
  assert.equal(store.listJobs().length, 0);
  assert.equal(store.listEvents().length, 0);
  store.close();
});

test('provider windows widened for builds cannot mark post-monitoring live changes as imported', async () => {
  const { store, historyImporter } = setup({
    async read() {
      return {
        items: [
          { id: 1, date: iso(BASE - 1), repository: { id: 'a' } },
          { id: 2, date: iso(BASE + 1), repository: { id: 'a' } },
          { id: 3, date: iso(BASE - 31 * DAY), repository: { id: 'a' } },
        ],
        nextCursor: null,
      };
    },
  });
  historyImporter.start(repo.id);
  await historyImporter.tick();
  assert.deepEqual(
    store.listEvents().map(event => event.data?.pushId),
    [1],
  );
  assert.deepEqual(
    store.listEntities(repo.id, 'push').map(entity => entity.id),
    ['1'],
  );
  store.close();
});

test('transaction failure keeps the page resumable and validation rejects ambiguous requests', async () => {
  let time = BASE;
  const { store, historyImporter } = setup(
    {
      async read() {
        return { items: [{ id: 1, date: iso(BASE - DAY), repository: { id: 'a' } }], nextCursor: { skip: 100 } };
      },
    },
    {
      now: () => time,
    },
  );
  historyImporter.start(repo.id);
  assert.throws(() => historyImporter.start(repo.id, 90), { kind: 'conflict' });
  // Fail inside the actual transaction after its event inserts, before the job checkpoint.
  const original = store.commitPage;
  store.commitPage = page => {
    const invalid = {
      id: 'invalid',
      type: 'rewrite',
      repoId: 'not-watched',
      eventId: 'none',
      ref: 'refs/heads/main',
      oldObjectId: 'a'.repeat(40),
      newObjectId: 'b'.repeat(40),
      attempts: 0,
      nextAt: iso(BASE),
    } satisfies import('../server/jobs.ts').RewriteJob;
    original({ ...page, jobs: [...present(page.jobs), invalid] });
  };
  await historyImporter.tick();
  assert.equal(store.listEvents().length, 0);
  assert.equal(present(historyImporter.status()[0]).cursor, null);
  assert.equal(present(historyImporter.status()[0]).status, 'retrying');
  store.commitPage = original;
  time += 60001;
  await historyImporter.tick();
  assert.equal(store.listEvents().length, 1);
  assert.deepEqual(present(historyImporter.status()[0]).cursor, { skip: 100 });
  store.close();
});

test('a build queued before an internal window boundary and completed after it remains imported', async () => {
  const store = createStore();
  store.saveRepo(repo);
  store.setBaseline(repo.id, iso(BASE));
  const boundary = iso(BASE - 30 * DAY);
  const build = {
    id: 99,
    repository: { id: repo.azureId },
    status: 'completed',
    result: 'succeeded',
    queueTime: iso(BASE - 31 * DAY),
    finishTime: iso(BASE - 29 * DAY),
    sourceBranch: 'refs/heads/main',
    definition: { name: 'CI' },
  };
  const provider: Provider = {
    async read(_repo, stream, given) {
      const options = present(given);
      return { items: stream === 'builds' && options.until === boundary ? [build] : [], nextCursor: null };
    },
  };
  const normalizer = createNormalizer({ store, now: () => BASE });
  const historyImporter = createHistoryImporter({ store, provider, normalize: normalizer.normalize, now: () => BASE });
  historyImporter.start(repo.id, 90);
  for (let i = 0; i < 9; i++) await historyImporter.tick();
  assert.equal(present(historyImporter.status()[0]).status, 'completed');
  const events = store.listEvents();
  assert.equal(events.length, 1);
  assert.equal(present(events[0]).data?.buildId, 99);
  assert.equal(present(events[0]).time, build.finishTime);
  assert.equal(present(events[0]).imported, true);
  assert.equal(present(events[0]).seen, true);
  store.close();
});

test('records Azure returns unreadable during a history import are counted on the job with their stream and fields', async () => {
  const pages: Partial<Record<AzureStream, AzurePage[]>> = {
    pushes: [
      { items: [], nextCursor: { skip: 100 }, unreadable: { count: 1, fields: ['pushId'] } },
      { items: [], nextCursor: null, unreadable: { count: 2, fields: ['date'] } },
    ],
    closedPrs: [{ items: [], nextCursor: null, unreadable: { count: 1, fields: ['status'] } }],
    builds: [{ items: [], nextCursor: null, unreadable: { count: 1, fields: ['repository.id'] } }],
  };
  const provider: Provider = {
    async read(_repo, stream) {
      return pages[stream]?.shift() ?? { items: [], nextCursor: null };
    },
  };
  const { store, historyImporter } = setup(provider);
  historyImporter.start(repo.id);
  while (await historyImporter.tick());
  const job = present(historyImporter.status()[0]);
  assert.equal(job.status, 'completed');
  assert.deepEqual(job.warnings, [
    {
      stream: 'pushes',
      code: 'UNREADABLE_RECORDS',
      count: 3,
      fields: ['pushId', 'date'],
      message: 'Skipped 3 records in pushes that Azure returned without a readable value for pushId or date.',
    },
    {
      stream: 'closedPrs',
      code: 'UNREADABLE_RECORDS',
      count: 1,
      fields: ['status'],
      message: 'Skipped 1 record in pull requests that Azure returned without a readable value for status.',
    },
    {
      stream: 'builds',
      code: 'UNREADABLE_RECORDS',
      count: 1,
      fields: ['repository.id'],
      message: 'Skipped 1 record in builds that Azure returned without a readable value for repository.id.',
    },
  ]);
  store.close();
});
