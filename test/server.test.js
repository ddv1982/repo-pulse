import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, stat, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request as httpRequest } from 'node:http';
import { createStore } from '../server/store.js';
import { createApp, startApp } from '../server.js';
import { seedDemo } from '../server/demo.js';
import { TEST_KEY, keyedFetch } from './fixtures/access.js';

const fetch = keyedFetch();

async function fixture(t, { demo = true, ...options } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'repo-pulse-server-'));
  const store = createStore(join(directory, 'test.sqlite'));
  seedDemo(store);
  const calls = [];
  const sync = {
    refresh(ids) {
      calls.push(ids);
      return { queued: true };
    },
    status() {
      return { running: false };
    },
  };
  const app = createApp({
    store,
    provider: { checkConnection: async () => ({ available: true, identity: 'test' }) },
    sync,
    demo,
    accessKey: TEST_KEY,
    ...options,
  });
  await new Promise(resolve => app.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${app.address().port}`;
  t.after(async () => {
    await new Promise(resolve => app.close(resolve));
    store.close();
    await rm(directory, { recursive: true, force: true });
  });
  const state = await (await fetch(`${url}/api/state`)).json();
  const mutate = (path, data, options = {}) =>
    fetch(url + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(data),
      ...options,
    });
  return { store, app, url, state, mutate, calls };
}

test('serves real UI and blocks other origins, DNS rebinding, and API requests without the access key', async t => {
  const { url } = await fixture(t);
  const page = await fetch(url);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Repo Pulse/);
  assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.equal((await fetch(url + '/api/state', { headers: { origin: 'https://attacker.example' } })).status, 403);
  const hostileHostStatus = await new Promise((resolve, reject) => {
    const request = httpRequest(url + '/api/state', { headers: { host: 'attacker.example' } }, response => {
      response.resume();
      resolve(response.statusCode);
    });
    request.on('error', reject);
    request.end();
  });
  assert.equal(hostileHostStatus, 403);
  const ack = { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"ids":[]}' };
  for (const headers of [{}, { 'x-repo-pulse-key': 'wrong' }, { 'x-repo-pulse-key': TEST_KEY.slice(0, -1) + 'X' }]) {
    const read = await globalThis.fetch(url + '/api/state', { headers });
    assert.equal(read.status, 401);
    assert.deepEqual(await read.json(), {
      message:
        'Open the newest link printed in the terminal where Repo Pulse runs. Each link works once; restart Repo Pulse for a new one.',
      code: 'ACCESS_KEY',
    });
    assert.equal((await globalThis.fetch(url + '/api/ack', { ...ack, headers: { ...ack.headers, ...headers } })).status, 401);
  }
  assert.equal((await fetch(url + '/api/ack', ack)).status, 200);
  assert.equal((await globalThis.fetch(url + '/api/state', { method: 'PUT' })).status, 401);
  assert.equal((await globalThis.fetch(url + '/app.css')).status, 200);
  assert.equal((await fetch(url + '/package.json')).status, 404);
  assert.equal((await fetch(url + '/server/store.js')).status, 404);
});

test('acknowledges exact shown IDs; a concurrently incoming demo branch stays unseen', async t => {
  const { mutate, url } = await fixture(t);
  const events = async () => (await (await fetch(url + '/api/activity')).json()).items.flatMap(item => item.events);
  const shown = (await events()).filter(event => event.repoId === 'demo-billing').map(event => event.id);
  const incoming = await (await mutate('/api/demo/event', {})).json();
  assert.equal((await mutate('/api/ack', { ids: shown })).status, 200);
  const after = await events();
  assert.ok(after.filter(event => shown.includes(event.id)).every(event => event.seen));
  assert.equal(after.find(event => event.id === incoming.id).seen, false);
  assert.ok(after.some(event => event.repoId === 'demo-orders' && !event.seen));
  assert.equal((await mutate('/api/ack', { ids: shown, seen: false })).status, 200);
  const undo = await events();
  assert.ok(undo.filter(event => shown.includes(event.id)).every(event => !event.seen));
});

test('refresh coalesces through sync interface, disabling persists and bad input is rejected', async t => {
  const { mutate, calls, state, url } = await fixture(t);
  assert.equal((await mutate('/api/refresh', { repoIds: [state.repos[0].id] })).status, 202);
  assert.deepEqual(calls, [[state.repos[0].id]]);
  assert.equal((await mutate('/api/refresh', { repoIds: ['unknown'] })).status, 404);
  assert.equal((await mutate(`/api/repos/${state.repos[0].id}`, { paused: true }, { method: 'PATCH' })).status, 400);
  assert.equal((await mutate(`/api/repos/${state.repos[0].id}`, { disabled: true }, { method: 'PATCH' })).status, 200);
  const after = await (await fetch(url + '/api/state')).json();
  assert.equal(after.repos.find(repo => repo.id === state.repos[0].id).disabled, true);
  assert.equal(calls.length, 1);
  assert.equal((await mutate(`/api/repos/${state.repos[0].id}`, { disabled: false }, { method: 'PATCH' })).status, 200);
  assert.deepEqual(calls.at(-1), [state.repos[0].id]);
  assert.equal((await mutate('/api/settings', { refreshEnabled: false })).status, 200);
  assert.equal((await mutate('/api/settings', { refreshEnabled: true })).status, 200);
  const resumed = (await (await fetch(url + '/api/state')).json()).settings.refreshResumedAt;
  assert.ok(resumed > 0);
  assert.equal((await mutate('/api/settings', { refreshEnabled: true })).status, 200);
  assert.equal((await (await fetch(url + '/api/state')).json()).settings.refreshResumedAt, resumed);
  assert.equal((await mutate('/api/repos', { url: 'https://dev.azure.com/example/Demo/_git/test' })).status, 400);
});

test('a disabled repository disappears from activity and event details until enabled again', async t => {
  const { mutate, url, state } = await fixture(t);
  const activity = async (query = '') => (await (await fetch(`${url}/api/activity${query}`)).json()).items.flatMap(item => item.events);
  const id = 'demo-billing';
  const eventId = (await activity()).find(event => event.repoId === id).id;
  const revision = state.activityRevision;
  assert.equal((await mutate(`/api/repos/${id}`, { disabled: true }, { method: 'PATCH' })).status, 200);
  const after = await (await fetch(url + '/api/state')).json();
  assert.notEqual(after.activityRevision, revision);
  assert.ok(after.repos.some(repo => repo.id === id && repo.disabled));
  assert.ok((await activity()).length > 0);
  assert.ok((await activity()).every(event => event.repoId !== id));
  assert.deepEqual(await activity(`?repoIds=${id}`), []);
  assert.ok((await activity(`?repoIds=${id},demo-orders`)).every(event => event.repoId === 'demo-orders'));
  assert.equal((await fetch(`${url}/api/events/${encodeURIComponent(eventId)}`)).status, 404);
  assert.equal((await mutate(`/api/repos/${id}`, { disabled: false }, { method: 'PATCH' })).status, 200);
  assert.ok((await activity()).some(event => event.repoId === id));
  assert.equal((await fetch(`${url}/api/events/${encodeURIComponent(eventId)}`)).status, 200);
});

test('checkout status skips disabled repositories', async t => {
  const checked = [];
  const checkoutGit = {
    status: async repo => {
      checked.push(repo.id);
      return { state: 'clean' };
    },
  };
  const { url, store } = await fixture(t, { demo: false, checkoutGit });
  store.saveRepo({ ...store.getRepo('demo-billing'), disabled: true });
  const result = await (await fetch(url + '/api/checkouts')).json();
  assert.deepEqual(Object.keys(result).sort(), ['demo-orders', 'demo-shared']);
  assert.deepEqual(checked.sort(), ['demo-orders', 'demo-shared']);
});

test('a disabled repository makes no direct Azure reads', async t => {
  const reads = [];
  const provider = {
    checkConnection: async (org, repo) => {
      reads.push(['connection', repo?.id]);
      return { available: true };
    },
    pushCommits: async repo => {
      reads.push(['commits', repo.id]);
      return { items: [], nextCursor: null };
    },
  };
  const checkoutGit = {
    status: async () => ({ state: 'clean' }),
    update: async repo => {
      reads.push(['checkout', repo.id]);
      return {};
    },
  };
  const { url, store, mutate } = await fixture(t, { demo: false, provider, checkoutGit });
  store.saveRepo({ ...store.getRepo('demo-billing'), disabled: true });
  assert.equal((await fetch(`${url}/api/push/demo-billing/1/commits`)).status, 409);
  assert.equal((await fetch(`${url}/api/connection?repoId=demo-billing`)).status, 409);
  const expected = { branch: 'main', head: 'a', upstream: 'origin/main', identity: 'i' };
  assert.equal((await mutate('/api/repos/demo-billing/checkout', { operation: 'check', expected })).status, 409);
  assert.deepEqual(reads, []);
  store.saveJob({ id: 'merge:x', type: 'merge', repoId: 'demo-billing' });
  assert.deepEqual({ ...store.mergeQueueSummary() }, { pending: 0, errors: 0 });
  store.saveRepo({ ...store.getRepo('demo-billing'), disabled: false });
  assert.deepEqual({ ...store.mergeQueueSummary() }, { pending: 1, errors: 0 });
  assert.equal((await fetch(`${url}/api/push/demo-billing/1/commits`)).status, 200);
});

test('live mode cannot generate demo activity or expose arbitrary files', async t => {
  const { url, mutate } = await fixture(t, { demo: false });
  assert.equal((await mutate('/api/demo/event', {})).status, 404);
  assert.equal((await fetch(url + '/web/../server.js')).status, 404);
  assert.equal((await fetch(url + '/api/connection?organization=https://attacker.example')).status, 400);
});

test('every start has a new key, the launch token works once, and the old key file is removed', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'repo-pulse-key-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, 'access-key'), 'k'.repeat(43), { mode: 0o644 });
  const first = await startApp({ demo: true, port: 0, dataDir: directory });
  const token = new URL(first.launchUrl).hash.slice('#launch='.length);
  assert.equal(new URL(first.launchUrl).search, '');
  const exchange = (url, value) => globalThis.fetch(url + '/api/session', { method: 'POST', headers: { 'x-repo-pulse-launch': value } });
  assert.equal((await exchange(first.url, 'wrong')).status, 401);
  const session = await exchange(first.url, token);
  assert.deepEqual(await session.json(), { key: first.accessKey });
  assert.equal((await exchange(first.url, token)).status, 401);
  const oldKey = first.accessKey;
  await first.close();
  await assert.rejects(stat(join(directory, 'access-key')), { code: 'ENOENT' });
  const second = await startApp({ demo: true, port: 0, dataDir: directory });
  t.after(() => second.close());
  assert.notEqual(second.accessKey, oldKey);
  assert.equal((await globalThis.fetch(second.url + '/api/state', { headers: { 'x-repo-pulse-key': oldKey } })).status, 401);
  assert.equal((await globalThis.fetch(second.url + '/api/state', { headers: { 'x-repo-pulse-key': second.accessKey } })).status, 200);
});

test('the data directory is closed to other accounts', { skip: typeof process.getuid !== 'function' }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'repo-pulse-dir-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await chmod(directory, 0o755);
  const runtime = await startApp({ demo: true, port: 0, dataDir: directory });
  await runtime.close();
  assert.equal((await stat(directory)).mode & 0o777, 0o700);
});

test('an invalid repository URL is a bad request', async t => {
  const { mutate } = await fixture(t, { demo: false, provider: { resolveRepository: async () => assert.fail('not reached') } });
  const response = await mutate('/api/repos', { url: 'https://%E0%A4%A@dev.azure.com/org/Project/_git/Repo' });
  assert.equal(response.status, 400);
  assert.equal((await response.json()).code, 'INVALID_REPOSITORY');
});

test('a cross-site page load reaches the app page, but cross-site API calls stay refused', async t => {
  const { url } = await fixture(t);
  // node:http, because fetch replaces sec-fetch-mode with its own value.
  const status = (path, mode) =>
    new Promise((resolve, reject) => {
      const headers = { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': mode, 'x-repo-pulse-key': TEST_KEY };
      const request = httpRequest(url + path, { headers }, response => {
        response.resume();
        resolve(response.statusCode);
      });
      request.on('error', reject);
      request.end();
    });
  assert.equal(await status('/', 'navigate'), 200);
  assert.equal(await status('/api/state', 'navigate'), 403);
  assert.equal(await status('/', 'no-cors'), 403);
  assert.equal(await status('/app.css', 'navigate'), 403);
  assert.equal(await status('/api/state', 'cors'), 403);
});
