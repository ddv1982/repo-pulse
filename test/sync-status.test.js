import test from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../server/store.ts';
import { createSync } from '../server/sync.ts';
import { syncStatus } from '../server/sync-status.ts';

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
    inProgress: [],
    settings: { refreshEnabled: true, refreshResumedAt: null },
    startedAt: NOW - 60 * MINUTE,
    now: NOW,
    ...rest,
  });
}

test('healthy repositories are synced since their oldest successful read', () => {
  const result = status({ a: { refs: { lastSuccess: ago(8) } } });
  assert.deepEqual(result.repos.a, { state: 'synced', since: ago(8), lastCheck: ago(1) });
  assert.deepEqual(result.repos.b, { state: 'synced', since: ago(1), lastCheck: ago(1) });
  assert.deepEqual(result.overall, { state: 'synced', since: ago(8), lastCheck: ago(1), repoId: 'a' });
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

test('with automatic checks off a running history import is not paused: it syncs, or waits on Azure throttling', () => {
  const settings = { refreshEnabled: false, refreshResumedAt: null };
  const jobs = [{ repoId: 'a', status: 'running' }];
  const importing = status({ settings, jobs });
  assert.equal(importing.repos.a.state, 'syncing');
  assert.equal(importing.repos.b.state, 'paused');
  const throttled = status({ settings, jobs, throttledUntil: iso(NOW + 30000) });
  assert.deepEqual(throttled.repos.a, { state: 'delayed', reason: 'Azure DevOps asked us to slow down', since: ago(1) });
  assert.equal(throttled.repos.b.state, 'paused');
  assert.equal(status({ settings, jobs: [{ repoId: 'a', status: 'completed' }] }).repos.a.state, 'paused');
});

test('an access, sign-in or missing CLI error is a problem at once and says in plain words what to do', () => {
  for (const [error, stream, reason] of [
    [forbidden, 'builds', "Your Azure account has no access to this repository's builds."],
    [forbidden, 'closedPrs', "Your Azure account has no access to this repository's pull requests."],
    [forbidden, 'refs', "Your Azure account has no access to this repository's branches."],
    [forbidden, 'pushes', "Your Azure account has no access to this repository's pushes."],
    [
      { code: 'AUTH_REQUIRED', message: 'Azure CLI sign-in is unavailable or expired. Reconnect in your terminal, then retry.' },
      'builds',
      'Sign in to Azure again.',
    ],
    [
      { code: 'CLI_MISSING', message: 'Azure CLI was not found. Install Azure CLI and its azure-devops extension.' },
      'builds',
      'Install the Azure CLI.',
    ],
    [
      { code: 'CLI_SETUP', message: 'Azure CLI or its azure-devops extension does not support this read. Check the installation.' },
      'builds',
      'Azure CLI or its azure-devops extension does not support this read. Check the installation.',
    ],
  ]) {
    const result = status({ a: { [stream]: { error, failures: 1, pending: true } } });
    assert.deepEqual(result.repos.a, { state: 'problem', reason, stream, since: ago(1) });
    assert.deepEqual(result.repos.b, { state: 'synced', since: ago(1), lastCheck: ago(1) }, 'another repository is not marked');
    assert.equal(result.overall.state, 'problem');
    assert.equal(result.overall.repoId, 'a');
  }
  const history = status({ jobs: [{ repoId: 'a', status: 'running', stream: 'builds', error: forbidden, failures: 1 }] });
  assert.deepEqual(history.repos.a, {
    state: 'problem',
    reason: "Your Azure account has no access to this repository's builds.",
    stream: 'history',
    since: ago(1),
  });
  const unknown = status({ jobs: [{ repoId: 'a', status: 'running', error: forbidden, failures: 1 }] });
  assert.equal(unknown.repos.a.reason, "Your Azure account has no access to this repository's history.");
});

test('overall Synced shows the newest check across repositories, not that of the one with the oldest data', () => {
  const result = status({
    a: { ...Object.fromEntries(STREAMS.map(stream => [stream, { lastSuccess: ago(5) }])), refs: { lastSuccess: ago(8) } },
  });
  assert.equal(result.repos.a.lastCheck, ago(5));
  assert.deepEqual(result.overall, { state: 'synced', since: ago(8), lastCheck: ago(1), repoId: 'a' });
});

test('long delays are stated in hours from 120 minutes and in days from 48 hours', () => {
  const settings = { refreshEnabled: true, refreshResumedAt: null };
  const startedAt = NOW - 10 * 24 * 60 * MINUTE;
  const behind = minutes => status({ settings, startedAt, a: { pushes: { lastSuccess: ago(minutes) } } }).repos.a.reason;
  assert.equal(behind(119), 'about 119 minutes behind');
  assert.equal(behind(119.5), 'about 120 minutes behind');
  assert.equal(behind(47.5 * 60), 'about 48 hours behind');
  assert.equal(behind(120), 'about 2 hours behind');
  assert.equal(behind(18 * 60), 'about 18 hours behind');
  assert.equal(behind(47 * 60), 'about 47 hours behind');
  assert.equal(behind(48 * 60), 'about 2 days behind');
  assert.equal(behind(3 * 24 * 60 + 100), 'about 3 days behind');
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
  const now = status({ a: { pushes: { error, failures: 1, lastSuccess: ago(0) } } });
  assert.deepEqual(now.repos.a, { state: 'delayed', reason: 'about 1 minute behind', stream: 'pushes', since: ago(1) });
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
});

test('a restart catches up for three minutes, then a check still not started is delayed by its own lateness', () => {
  const closed = Object.fromEntries(STREAMS.map(stream => [stream, { lastSuccess: ago(243), nextAt: ago(240) }]));
  const catchingUp = status({ a: closed, b: closed, startedAt: NOW - MINUTE });
  assert.deepEqual([catchingUp.repos.a.state, catchingUp.repos.b.state], ['syncing', 'syncing']);

  const unread = status({ a: { pushes: { lastSuccess: ago(200), nextAt: ago(15) } }, startedAt: NOW - 5 * MINUTE });
  assert.deepEqual(unread.repos.a, { state: 'delayed', reason: 'about 15 minutes behind', stream: 'pushes', since: ago(200) });
  assert.equal(unread.repos.b.state, 'synced');
});

test('checks starting over 3 minutes late delay only the repository they belong to', () => {
  const late = status({ a: { builds: { nextAt: ago(4), lastSuccess: ago(6) }, refs: { lastSuccess: ago(15) } } });
  assert.deepEqual(late.repos.a, { state: 'delayed', reason: 'about 4 minutes behind', stream: 'builds', since: ago(15) });
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
    inProgress: [],
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
    inProgress: [],
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
      inProgress: sync.status().inProgress,
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
    reason: "Your Azure account has no access to this repository's builds.",
    stream: 'builds',
    since: store.getStreams().find(s => s.stream === 'builds').lastSuccess,
  });
  assert.equal(
    store.getStreams().find(s => s.stream === 'builds').error.message,
    forbidden.message,
    'the stream keeps the technical message',
  );

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

/** A one-repository sync whose reads wait until `release` is called, with its status as /api/state computes it. */
function blockedSync() {
  const store = createStore();
  store.saveRepo({
    id: 'one',
    name: 'One',
    azureId: 'x',
    organization: 'https://dev.azure.com/o',
    project: 'P',
    webUrl: 'https://dev.azure.com/o/P/_git/One',
  });
  let time = NOW;
  /** @type {(() => void)[]} */
  const waiting = [];
  const sync = createSync({
    store,
    now: () => time,
    intervalMs: 1000,
    provider: {
      async read() {
        await new Promise(resolve => waiting.push(() => resolve(undefined)));
        return { items: [], nextCursor: null };
      },
    },
  });
  const current = () =>
    syncStatus({
      repos: store.listRepos(),
      streams: store.getStreams(),
      jobs: [],
      inProgress: sync.status().inProgress,
      settings: { refreshEnabled: true, refreshResumedAt: null },
      startedAt: NOW - 60 * MINUTE,
      now: time,
    }).repos.one.state;
  async function readAll() {
    for (let i = 0; i < STREAMS.length; i++) {
      const page = sync.tick();
      await new Promise(resolve => setImmediate(resolve));
      waiting.shift()?.();
      await page;
      time += 100;
    }
  }
  const advance = (/** @type {number} */ ms) => {
    time += ms;
  };
  return { store, sync, current, readAll, waiting, advance };
}

test('a page in flight is syncing even when the stream looked healthy before it started', async () => {
  const { store, sync, current, readAll, waiting, advance } = blockedSync();
  sync.refresh();
  await readAll();
  assert.equal(current(), 'synced');

  advance(MINUTE);
  const page = sync.tick();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(waiting.length, 1, 'a read is blocked');
  assert.equal(current(), 'syncing', 'page in flight');
  waiting.shift()?.();
  await page;
  advance(100);
  assert.equal(current(), 'synced');
  store.close();
});

test('a refresh the user asked for is syncing with automatic checks on until every stream has answered it', async () => {
  const { store, sync, current, readAll, advance } = blockedSync();
  sync.refresh();
  await readAll();
  assert.equal(current(), 'synced');

  advance(MINUTE);
  assert.deepEqual(sync.refresh(), { scheduled: true });
  assert.equal(current(), 'syncing', 'refresh queued');
  await readAll();
  assert.equal(current(), 'synced');
  store.close();
});

test('a repository removed and re-added inside the refresh cooldown does not stay syncing on its old refresh', async () => {
  const { store, sync, current, readAll, advance } = blockedSync();
  const repo = store.listRepos()[0];
  sync.refresh();
  await readAll();
  advance(MINUTE);
  sync.refresh();
  store.removeRepo(repo.id);
  store.saveRepo(repo);
  assert.deepEqual(sync.refresh(), { scheduled: false, cooldown: true }, 'still inside the refresh cooldown');
  await readAll();
  assert.equal(current(), 'synced');
  store.close();
});

test('a disabled repository or a stopped sync lists no queued refresh', async () => {
  const { store, sync, readAll, advance } = blockedSync();
  const repo = store.listRepos()[0];
  sync.refresh();
  await readAll();
  advance(MINUTE);
  sync.refresh();
  store.saveRepo({ ...repo, disabled: true });
  const disabled = sync.status().inProgress;
  store.saveRepo(repo);
  await sync.stop();
  const stopped = sync.status().inProgress;
  assert.deepEqual({ disabled, stopped }, { disabled: [], stopped: [] });
  store.close();
});

test('a history import that keeps failing is a problem, not endless syncing', () => {
  const error = { code: 'FAILED', message: 'Azure DevOps could not list pushes.' };
  assert.equal(status({ jobs: [{ repoId: 'a', status: 'retrying', failures: 1, error }] }).repos.a.state, 'syncing');
  assert.deepEqual(status({ jobs: [{ repoId: 'a', status: 'retrying', failures: 2, error }] }).repos.a, {
    state: 'problem',
    reason: error.message,
    stream: 'history',
    since: ago(1),
  });
  const throttled = { code: 'THROTTLED', message: 'Azure DevOps asked us to slow down. Retrying later.' };
  assert.equal(status({ jobs: [{ repoId: 'a', status: 'retrying', failures: 5, error: throttled }] }).repos.a.state, 'syncing');
  const denied = { code: 'FORBIDDEN', message: 'No access to this repository.' };
  assert.equal(status({ jobs: [{ repoId: 'a', status: 'retrying', failures: 1, error: denied }] }).repos.a.state, 'problem');
});

test('a queue paused by Azure throttling makes every running repository delayed with that reason', () => {
  const paused = status({ throttledUntil: iso(NOW + 30000) });
  assert.deepEqual(paused.repos.a, { state: 'delayed', reason: 'Azure DevOps asked us to slow down', since: ago(1) });
  assert.equal(paused.overall.state, 'delayed');
  assert.equal(status({ throttledUntil: iso(NOW - 1) }).overall.state, 'synced');
  assert.equal(status({ throttledUntil: null }).overall.state, 'synced');
  const problem = status({ throttledUntil: iso(NOW + 30000), a: { builds: { error: forbidden, failures: 1 } } });
  assert.equal(problem.repos.a.state, 'problem');
});

test('a failed reset shows overall even with no enabled repository', () => {
  const none = syncStatus({
    repos: [{ id: 'a', disabled: true }],
    streams: [],
    jobs: [],
    inProgress: [],
    settings: { refreshEnabled: true, refreshResumedAt: null },
    startedAt: NOW - 60 * MINUTE,
    now: NOW,
    resetFailed: true,
  });
  assert.deepEqual(none, { overall: { state: 'problem', reason: 'Starting from scratch failed. Try again.' }, repos: {} });
});
