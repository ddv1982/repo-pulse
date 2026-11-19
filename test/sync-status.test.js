import test from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../server/store.js';
import { createSync } from '../server/sync.js';
import { syncStatus } from '../server/sync-status.js';

const NOW = Date.parse('2026-11-19T12:00:00Z');
const MINUTE = 60000;
/** @param {number} minutes */
/** @param {number} ms */
const iso = ms => new Date(ms).toISOString();
const ago = minutes => new Date(NOW - minutes * MINUTE).toISOString();
const STREAMS = ['pushes', 'refs', 'prs', 'closedPrs', 'builds', 'activeBuilds'];
const forbidden = { code: 'FORBIDDEN', message: 'Azure DevOps refused this read. Check the CLI identity and repository permissions.' };

/** Healthy streams for a repository; `changes` maps a stream name to the fields it overrides. */
function streams(repoId, changes = {}) {
  return STREAMS.map(stream => ({
    repoId,
    stream,
    initialized: true,
    lastSuccess: ago(1),
    lastAttempt: ago(1),
    nextAt: ago(-2),
    error: null,
    failures: 0,
    pending: false,
    ...changes[stream],
  }));
}

function status({ a = {}, b = {}, ...rest } = {}) {
  return syncStatus({
    repos: [{ id: 'a' }, { id: 'b' }],
    streams: [...streams('a', a), ...streams('b', b)],
    jobs: [],
    settings: { refreshEnabled: true, refreshResumedAt: null },
    startedAt: NOW - 60 * MINUTE,
    now: NOW,
    ...rest,
  });
}

test('healthy repositories are synced since their oldest successful read', () => {
  const result = status({ a: { refs: { lastSuccess: ago(8) } } });
  assert.deepEqual(result.repos.a, { state: 'synced', since: ago(8) });
  assert.deepEqual(result.repos.b, { state: 'synced', since: ago(1) });
  assert.deepEqual(result.overall, { state: 'synced', since: ago(8), repoId: 'a' });
});

test('automatic checks off pause every repository unless a manual refresh is outstanding', () => {
  const settings = { refreshEnabled: false, refreshResumedAt: null };
  const paused = status({ settings, a: { builds: { error: forbidden, failures: 3, lastSuccess: ago(300) } } });
  assert.deepEqual(paused.repos.a, { state: 'paused', since: ago(300) });
  assert.deepEqual(paused.overall, { state: 'paused', since: ago(300), repoId: 'a' });

  const manual = status({ settings, a: { pushes: { manual: true, nextAt: ago(0) } } });
  assert.equal(manual.repos.a.state, 'syncing');
  assert.equal(manual.repos.b.state, 'paused');
  assert.equal(manual.overall.state, 'syncing');
});

test('an access, sign-in or missing CLI error is a problem at once and names the stream and what to do', () => {
  for (const error of [
    forbidden,
    { code: 'AUTH_REQUIRED', message: 'Azure CLI sign-in is unavailable or expired. Reconnect in your terminal, then retry.' },
    { code: 'CLI_MISSING', message: 'Azure CLI was not found. Install Azure CLI and its azure-devops extension.' },
  ]) {
    const result = status({ a: { builds: { error, failures: 1, pending: true } } });
    assert.deepEqual(result.repos.a, { state: 'problem', reason: error.message, stream: 'builds', since: ago(1) });
    assert.deepEqual(result.repos.b, { state: 'synced', since: ago(1) }, 'another repository is not marked');
    assert.equal(result.overall.state, 'problem');
    assert.equal(result.overall.repoId, 'a');
  }
});

test('a single failed read is not a problem; a second one is', () => {
  const error = { code: 'UNAVAILABLE', message: 'Azure DevOps could not be reached. Check your connection or VPN.' };
  const once = status({ a: { prs: { error, failures: 1, pending: true } } });
  assert.equal(once.repos.a.state, 'syncing');
  const twice = status({ a: { prs: { error, failures: 2, pending: true } } });
  assert.deepEqual(twice.repos.a, { state: 'problem', reason: error.message, stream: 'prs', since: ago(1) });
});

test('throttling is a delay, never a problem', () => {
  const error = { code: 'THROTTLED', message: 'Azure DevOps asked us to slow down. Retrying later.' };
  const result = status({ a: { pushes: { error, failures: 5, pending: true, lastSuccess: ago(4) } } });
  assert.deepEqual(result.repos.a, { state: 'delayed', reason: 'about 4 minutes behind', stream: 'pushes', since: ago(4) });
  assert.equal(result.repos.b.state, 'synced');
  const first = status({ a: Object.fromEntries(STREAMS.map(stream => [stream, { initialized: false, lastSuccess: undefined, error }])) });
  assert.deepEqual(first.repos.a, { state: 'delayed', reason: 'Checks are behind schedule', stream: 'pushes' });
});

test('a read older than 10 minutes, or 20 for branches, is delayed', () => {
  assert.deepEqual(status({ a: { prs: { lastSuccess: ago(11) } } }).repos.a, {
    state: 'delayed',
    reason: 'about 11 minutes behind',
    stream: 'prs',
    since: ago(11),
  });
  assert.equal(status({ a: { refs: { lastSuccess: ago(15) } } }).repos.a.state, 'synced');
  assert.equal(status({ a: { refs: { lastSuccess: ago(21) } } }).repos.a.state, 'delayed');
});

test('old reads are catching up, not delayed, until the app or resumed checks have run that long', () => {
  // A stream backing off after a failed read is old but not yet due.
  const old = { a: { pushes: { lastSuccess: ago(120), nextAt: ago(-1) } } };
  assert.equal(status({ ...old, startedAt: NOW - 5 * MINUTE }).repos.a.state, 'syncing');
  assert.equal(status({ ...old, settings: { refreshEnabled: true, refreshResumedAt: NOW - 5 * MINUTE } }).repos.a.state, 'syncing');
  assert.equal(status({ ...old, startedAt: NOW - 11 * MINUTE }).repos.a.state, 'delayed');
  // A check due long before the app started is late only from the start.
  const due = { a: { pushes: { lastSuccess: ago(120), nextAt: ago(120) } } };
  assert.equal(status({ ...due, startedAt: NOW - 2 * MINUTE }).repos.a.state, 'syncing');
  assert.equal(status({ ...due, startedAt: NOW - 4 * MINUTE }).repos.a.state, 'delayed');
});

test('checks starting over 3 minutes late delay only the repository they belong to', () => {
  const late = status({ a: { builds: { nextAt: ago(4), lastSuccess: ago(6) } } });
  assert.deepEqual(late.repos.a, { state: 'delayed', reason: 'about 6 minutes behind', stream: 'builds', since: ago(6) });
  assert.equal(late.repos.b.state, 'synced');
  assert.equal(status({ a: { builds: { nextAt: ago(2) } } }).repos.a.state, 'synced');
});

test('a first import, an open page, a manual refresh or a running history import is syncing', () => {
  assert.deepEqual(status({ a: { refs: { initialized: false, lastSuccess: undefined } } }).repos.a, { state: 'syncing' });
  assert.equal(status({ a: { pushes: { pending: true, cursor: { skip: 100 } } } }).repos.a.state, 'syncing');
  assert.equal(status({ a: { pushes: { manual: true } } }).repos.a.state, 'syncing');
  const importing = status({ jobs: [{ repoId: 'a', status: 'running' }] });
  assert.equal(importing.repos.a.state, 'syncing');
  assert.equal(importing.repos.b.state, 'synced');
  assert.equal(status({ jobs: [{ repoId: 'a', status: 'completed' }] }).repos.a.state, 'synced');
});

test('problem beats delayed beats syncing, within a repository and overall', () => {
  const stale = { lastSuccess: ago(30) };
  assert.equal(status({ a: { pushes: stale, builds: { error: forbidden, failures: 2 } } }).repos.a.state, 'problem');
  assert.equal(status({ a: { pushes: stale, refs: { initialized: false } } }).repos.a.state, 'delayed');

  const problemAndDelay = status({ a: { pushes: stale }, b: { builds: { error: forbidden, failures: 2 } } });
  assert.deepEqual([problemAndDelay.overall.state, problemAndDelay.overall.repoId], ['problem', 'b']);
  const delayAndSync = status({ a: { pushes: { cursor: { skip: 1 } } }, b: { pushes: stale } });
  assert.deepEqual([delayAndSync.overall.state, delayAndSync.overall.repoId], ['delayed', 'b']);
});

test('overall delay reports the repository furthest behind', () => {
  const result = status({ a: { prs: { lastSuccess: ago(12) } }, b: { prs: { lastSuccess: ago(30) } } });
  assert.deepEqual(result.overall, { state: 'delayed', reason: 'about 30 minutes behind', stream: 'prs', since: ago(30), repoId: 'b' });
});

test('a disabled repository is ignored, and no enabled repository gives an empty result', () => {
  const disabled = syncStatus({
    repos: [{ id: 'a' }, { id: 'b', disabled: true }],
    streams: [...streams('a'), ...streams('b', { builds: { error: forbidden, failures: 9 } })],
    jobs: [{ repoId: 'b', status: 'running' }],
    settings: { refreshEnabled: true, refreshResumedAt: null },
    startedAt: NOW - 60 * MINUTE,
    now: NOW,
  });
  assert.deepEqual(Object.keys(disabled.repos), ['a']);
  assert.equal(disabled.overall.state, 'synced');

  const none = syncStatus({
    repos: [{ id: 'b', disabled: true }],
    streams: streams('b'),
    jobs: [],
    settings: { refreshEnabled: true, refreshResumedAt: null },
    startedAt: NOW - 60 * MINUTE,
    now: NOW,
  });
  assert.deepEqual(none, { overall: { state: 'empty' }, repos: {} });
});

test('demo mode is synced whatever its seeded streams say', () => {
  const result = status({ demo: true, a: { builds: { error: forbidden, failures: 3, lastSuccess: ago(45) } } });
  assert.equal(result.repos.a.state, 'synced');
  assert.equal(result.overall.state, 'synced');
});

test('through createSync: first import syncs, a refused stream is a problem, and success or a stall moves it on', async () => {
  const BASE = Date.parse('2026-11-19T09:00:00Z');
  const store = createStore();
  store.saveRepo({
    id: 'one',
    name: 'One',
    azureId: 'x',
    organization: 'https://dev.azure.com/o',
    project: 'P',
    webUrl: 'https://dev.azure.com/o/P/_git/One',
  });
  let time = BASE;
  let refuse = false;
  const sync = createSync({
    store,
    now: () => time,
    intervalMs: 1000,
    provider: {
      async read(_repo, stream) {
        if (refuse && stream === 'builds') throw Object.assign(new Error(forbidden.message), { code: forbidden.code });
        return { items: [], nextCursor: null };
      },
    },
  });
  const current = () =>
    syncStatus({
      repos: store.listRepos(),
      streams: store.getStreams(),
      jobs: store.listJobs({ type: 'backfill' }),
      settings: { refreshEnabled: true, refreshResumedAt: null },
      startedAt: BASE,
      now: time,
    }).repos.one;
  /** Ticks until every due stream has been read once. */
  async function drain() {
    for (let i = 0; i < 12; i++) {
      await sync.tick();
      time += 100;
    }
  }

  sync.refresh();
  assert.equal(current().state, 'syncing', 'first import');
  await drain();
  assert.equal(current().state, 'synced');

  refuse = true;
  time += 11 * MINUTE;
  await drain();
  assert.deepEqual(current(), {
    state: 'problem',
    reason: forbidden.message,
    stream: 'builds',
    since: store.getStreams().find(s => s.stream === 'builds').lastSuccess,
  });

  // The first good read finishes the window that failed, so the data is still as old as the first failure.
  refuse = false;
  time += 31 * MINUTE;
  await drain();
  assert.deepEqual(current(), {
    state: 'delayed',
    reason: 'about 31 minutes behind',
    stream: 'builds',
    since: iso(BASE + 11 * MINUTE + 1500),
  });
  time += 5 * MINUTE;
  await drain();
  assert.equal(current().state, 'synced');

  time += 9 * MINUTE;
  assert.deepEqual(current().state, 'delayed', 'checks due five minutes ago have not started');
  store.close();
});
