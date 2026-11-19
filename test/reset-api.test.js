import test from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../server/store.js';
import { createSync } from '../server/sync.js';
import { seedDemo } from '../server/demo.js';
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
  const app = createApp({ store, provider, sync, accessKey: TEST_KEY });
  await new Promise(resolve => app.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await sync.stop();
    await new Promise(resolve => app.close(resolve));
    store.close();
  });
  const url = `http://127.0.0.1:${app.address().port}`;
  const reset = (send = fetch) => send(url + '/api/reset', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  const state = async () => (await fetch(url + '/api/state')).json();
  async function drain() {
    for (let i = 0; i < 6; i++) await sync.tick();
  }
  sync.refresh();
  await drain();
  return { store, sync, reads, offered, control, reset, state, drain };
}

test('POST /api/reset needs the access key, clears activity and starts a first import that reads Azure again', async t => {
  const { store, reads, reset, state, drain } = await live(t);
  assert.equal(store.listEvents().length, 1);
  assert.equal((await state()).syncStatus.overall.state, 'synced');

  const refused = await reset(globalThis.fetch);
  assert.equal(refused.status, 401);
  assert.equal(store.listEvents().length, 1);

  const response = await reset();
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, status: { scheduled: true } });
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

test('a reset during a page in flight leaves none of that page behind', async t => {
  const { store, sync, offered, control, reset } = await live(t);
  for (const state of store.getStreams()) store.saveStream({ ...state, nextAt: new Date(0).toISOString() });
  offered.pushes = [push(2)];
  control.hold = true;
  const page = sync.tick();
  await new Promise(resolve => setImmediate(resolve));
  const response = reset();
  await new Promise(resolve => setTimeout(resolve, 50));
  control.hold = false;
  control.release();
  await page;
  assert.equal((await response).status, 200);
  assert.deepEqual(store.listEvents(), []);
  assert.ok(store.getStreams().every(state => !state.initialized));
});

test('a running scheduler resumes after a reset and imports again without a manual turn', async t => {
  const { store, sync, reset } = await live(t, { pollMs: 5 });
  sync.start();
  assert.equal((await reset()).status, 200);
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
