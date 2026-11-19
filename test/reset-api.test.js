import test from 'node:test';
import { request } from 'node:http';
import assert from 'node:assert/strict';
import { createStore } from '../server/store.js';
import { createSync } from '../server/sync.js';
import { seedDemo } from '../server/demo.js';
import { createBackfill } from '../server/backfill.js';
import { createApp } from '../server.js';
import { TEST_KEY, keyedFetch } from './fixtures/access.js';

const fetch = keyedFetch();
const repo = {
  id: 'one',
  name: 'One',
  azureId: 'a',
  organization: 'https://dev.azure.com/org',
  project: 'P',
  webUrl: 'https://dev.azure.com/org/P/_git/One',
};
const push = id => ({
  pushId: id,
  date: '2026-11-18T10:00:00Z',
  pushedBy: { displayName: 'A' },
  refUpdates: [{ name: 'refs/heads/main', oldObjectId: 'a'.repeat(40), newObjectId: 'b'.repeat(40) }],
});

/** A live app over a real sync whose pushes stream offers `offered.pushes`; `hold` makes reads wait for `release`. */
async function live(t, { pollMs } = {}) {
  const store = createStore();
  store.saveRepo(repo);
  store.setSetting('checkout:one', { head: 'abc' });
  const reads = [];
  const offered = { pushes: [push(1)] };
  const control = { hold: false, release: () => {} };
  const provider = {
    async read(_repo, stream) {
      reads.push(stream);
      const items = offered[stream] || [];
      if (control.hold) await new Promise(resolve => (control.release = resolve));
      return { items, nextCursor: null };
    },
  };
  const sync = createSync({ store, provider, pollMs });
  const backfill = createBackfill({ store, provider, normalize: sync.normalize });
  const app = createApp({ store, provider, sync, backfill, accessKey: TEST_KEY });
  await new Promise(resolve => app.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    control.hold = false;
    control.release();
    await sync.stop();
    await new Promise(resolve => app.close(resolve));
    store.close();
  });
  const url = `http://127.0.0.1:${app.address().port}`;
  const reset = (send = fetch) => send(url + '/api/reset', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  const state = async () => (await fetch(url + '/api/state')).json();
  const importHistory = () =>
    fetch(url + '/api/backfill', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ repoId: 'one', days: 30 }),
    });
  async function drain() {
    for (let i = 0; i < 6; i++) await sync.tick();
  }
  /** The reset is done once its first import has put back six unread streams. */
  async function settled() {
    for (let i = 0; i < 200; i++) {
      const streams = store.getStreams();
      if (streams.length === 6 && streams.every(stream => !stream.initialized)) return;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error('The reset did not finish.');
  }
  /** Marks every stream due and starts a turn whose read waits for `control.release`. */
  async function holdPage() {
    for (const stream of store.getStreams()) store.saveStream({ ...stream, nextAt: new Date(0).toISOString() });
    control.hold = true;
    const before = reads.length;
    const page = sync.tick();
    while (reads.length === before) await new Promise(resolve => setImmediate(resolve));
    return { page };
  }
  function release() {
    control.hold = false;
    control.release();
  }
  /** Sends the headers of a history import now and its body only when `send` is called. */
  function slowImportHistory() {
    const payload = JSON.stringify({ repoId: 'one', days: 30 });
    const req = request(url + '/api/backfill', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload), 'x-repo-pulse-key': TEST_KEY },
    });
    const response = new Promise((resolve, reject) => {
      req.on('error', reject);
      req.on('response', res => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', chunk => (text += chunk));
        res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(text) }));
      });
    });
    req.flushHeaders();
    return { send: () => req.end(payload), response };
  }
  sync.refresh();
  await drain();
  return { store, sync, reads, offered, control, reset, state, drain, settled, holdPage, release, importHistory, slowImportHistory };
}

/** Resolves to 'waiting' when `promise` has not settled within `ms`. */
const within = (promise, ms = 300) => Promise.race([promise, new Promise(resolve => setTimeout(() => resolve('waiting'), ms))]);

test('POST /api/reset needs the access key, clears activity and starts a first import that reads Azure again', async t => {
  const { store, reads, reset, state, drain, settled } = await live(t);
  assert.equal(store.listEvents().length, 1);
  assert.equal((await state()).syncStatus.overall.state, 'synced');

  const refused = await reset(globalThis.fetch);
  assert.equal(refused.status, 401);
  assert.equal(store.listEvents().length, 1);

  const response = await reset();
  assert.equal(response.status, 202);
  assert.deepEqual(await response.json(), { started: true });
  await settled();
  assert.deepEqual(store.listEvents(), []);
  assert.deepEqual(store.listRepos(), [{ ...repo, disabled: false }]);
  assert.deepEqual(store.getSetting('checkout:one'), { head: 'abc' });
  const after = await state();
  assert.equal(after.syncStatus.overall.state, 'syncing');
  assert.ok(after.streams.length === 6 && after.streams.every(stream => !stream.initialized));

  reads.length = 0;
  await drain();
  assert.equal(reads.length, 6, 'every stream is read again');
  assert.deepEqual(
    store.listEvents().map(event => [event.id, event.imported]),
    [['one:push:1', true]],
    'the first import brings the push back as history',
  );
  assert.equal((await state()).syncStatus.overall.state, 'synced');
});

test('a reset during a page in flight answers at once, reports syncing, and leaves none of that page behind', async t => {
  const { store, offered, reset, state, settled, holdPage, release } = await live(t);
  offered.pushes = [push(2)];
  const { page } = await holdPage();
  const response = await within(reset());
  assert.notEqual(response, 'waiting', 'the reset answers while the page is still waiting on Azure');
  assert.equal(response.status, 202);
  assert.deepEqual(await response.json(), { started: true });
  const during = (await state()).syncStatus;
  assert.equal(during.overall.state, 'syncing');
  assert.deepEqual(during.repos, { one: { state: 'syncing' } });
  release();
  await page;
  await settled();
  assert.deepEqual(store.listEvents(), []);
  assert.ok(store.getStreams().every(stream => !stream.initialized));
});

test('overlapping resets share the one in progress and clear once', async t => {
  const { store, reset, settled, holdPage, release } = await live(t);
  let clears = 0;
  const resetActivity = store.resetActivity.bind(store);
  store.resetActivity = () => {
    clears++;
    resetActivity();
  };
  const { page } = await holdPage();
  const first = await within(reset());
  const second = await within(reset());
  release();
  await page;
  await settled();
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.notEqual(first, 'waiting');
  assert.notEqual(second, 'waiting');
  assert.deepEqual([first.status, second.status], [202, 202]);
  assert.equal(clears, 1, 'the second request joins the first reset');
});

test('a history import asked for while a reset is pending is refused with a retryable message', async t => {
  const { store, reset, settled, holdPage, release, importHistory } = await live(t);
  const { page } = await holdPage();
  const pending = reset();
  await within(pending);
  const refused = await importHistory();
  assert.equal(refused.status, 409);
  assert.deepEqual(await refused.json(), { message: 'Starting from scratch is in progress. Try again in a moment.' });
  release();
  await page;
  await pending;
  await settled();
  assert.deepEqual(store.listJobs({ type: 'backfill' }), []);
  assert.equal((await importHistory()).status, 202, 'the import is accepted once the reset is done');
});

test('a history import whose body arrives after a reset started is refused', async t => {
  const { store, reset, settled, holdPage, release, slowImportHistory } = await live(t);
  const slow = slowImportHistory();
  await new Promise(resolve => setTimeout(resolve, 50));
  const { page } = await holdPage();
  const pending = reset();
  await within(pending);
  slow.send();
  const refused = await slow.response;
  assert.equal(refused.status, 409);
  assert.deepEqual(refused.body, { message: 'Starting from scratch is in progress. Try again in a moment.' });
  release();
  await page;
  await pending;
  await settled();
  assert.deepEqual(store.listJobs({ type: 'backfill' }), []);
});

test('a failed reset shows a problem on every repository until a later reset succeeds', async t => {
  const { store, reset, state, settled } = await live(t);
  const resetActivity = store.resetActivity.bind(store);
  store.resetActivity = () => {
    throw new Error('disk full');
  };
  assert.equal((await reset()).status, 202);
  let status;
  for (let i = 0; i < 100; i++) {
    status = (await state()).syncStatus;
    if (status.overall.state === 'problem') break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  const problem = { state: 'problem', reason: 'Starting from scratch failed. Try again.' };
  assert.deepEqual(status.repos, { one: problem });
  assert.deepEqual(status.overall, { ...problem, repoId: 'one' });
  assert.equal(store.listEvents().length, 1, 'the failed reset kept the stored activity');

  store.resetActivity = resetActivity;
  assert.equal((await reset()).status, 202);
  await settled();
  assert.equal((await state()).syncStatus.overall.state, 'syncing', 'the successful reset clears the problem');
});

test('a stop during a reset wins and nothing restarts polling', async t => {
  const { sync, reads, reset, holdPage, release } = await live(t, { pollMs: 5 });
  sync.start();
  const { page } = await holdPage();
  const pending = reset();
  await within(pending, 50);
  const stopped = sync.stop();
  release();
  await page;
  await stopped;
  await pending;
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(sync.status().stopped, true, 'the reset does not undo the stop');
  const after = reads.length;
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(reads.length, after, 'no turn runs after the stop');
});

test('a running scheduler resumes after a reset and imports again without a manual turn', async t => {
  const { store, sync, reset } = await live(t, { pollMs: 5 });
  sync.start();
  assert.equal((await reset()).status, 202);
  for (let i = 0; i < 200 && !store.listEvents().length; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.deepEqual(
    store.listEvents().map(event => event.id),
    ['one:push:1'],
  );
});

test('demo mode refuses a reset and keeps its data', async t => {
  const store = createStore();
  seedDemo(store);
  const sync = { refresh: () => ({ demo: true }), status: () => ({ demo: true, running: false }) };
  const app = createApp({ store, provider: {}, sync, demo: true, accessKey: TEST_KEY });
  await new Promise(resolve => app.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise(resolve => app.close(resolve));
    store.close();
  });
  const before = store.listEvents().length;
  const response = await fetch(`http://127.0.0.1:${app.address().port}/api/reset`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { message: 'Demo data cannot be cleared. Start live mode to start from scratch.' });
  assert.equal(store.listEvents().length, before);
});
