import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request as httpRequest } from 'node:http';
import { createStore } from '../server/store.js';
import { createApp } from '../server.js';
import { seedDemo } from '../server/demo.js';

async function fixture(t, { demo = true } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'repo-pulse-server-'));
  const store = createStore(join(directory, 'test.sqlite'));
  seedDemo(store);
  const calls = [];
  const sync = { refresh(ids) { calls.push(ids); return { queued: true }; }, status() { return { running: false }; } };
  const provider = { checkConnection: async () => ({ available: true, identity: 'test' }) };
  const app = createApp({ store, provider, sync, demo });
  await new Promise(resolve => app.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${app.address().port}`;
  t.after(async () => { await new Promise(resolve => app.close(resolve)); store.close(); await rm(directory, { recursive: true, force: true }); });
  const state = await (await fetch(`${url}/api/state`)).json();
  const mutate = (path, data, options = {}) => fetch(url + path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-repo-pulse-token': state.csrfToken }, body: JSON.stringify(data), ...options });
  return { store, app, url, state, mutate, calls };
}

test('serves real UI and blocks other origins, DNS rebinding, and mutation without token', async t => {
  const { url } = await fixture(t);
  const page = await fetch(url);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Repo Pulse/);
  assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.equal((await fetch(url + '/api/state', { headers: { origin: 'https://attacker.example' } })).status, 403);
  const hostileHostStatus = await new Promise((resolve, reject) => {
    const request = httpRequest(url + '/api/state', { headers: { host: 'attacker.example' } }, response => { response.resume(); resolve(response.statusCode); });
    request.on('error', reject); request.end();
  });
  assert.equal(hostileHostStatus, 403);
  assert.equal((await fetch(url + '/api/ack', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"ids":[]}' })).status, 403);
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

test('refresh coalesces through sync interface, pauses persist and bad input is rejected', async t => {
  const { mutate, calls, state, url } = await fixture(t);
  assert.equal((await mutate('/api/refresh', { repoIds: [state.repos[0].id] })).status, 202);
  assert.deepEqual(calls, [[state.repos[0].id]]);
  assert.equal((await mutate('/api/refresh', { repoIds: ['unknown'] })).status, 404);
  assert.equal((await mutate(`/api/repos/${state.repos[0].id}`, { paused: true }, { method: 'PATCH' })).status, 200);
  const after = await (await fetch(url + '/api/state')).json();
  assert.equal(after.repos.find(repo => repo.id === state.repos[0].id).paused, true);
  assert.equal((await mutate('/api/settings', { refreshEnabled: false })).status, 200);
  assert.equal((await mutate('/api/settings', { refreshEnabled: true })).status, 200);
  const resumed = (await (await fetch(url + '/api/state')).json()).settings.refreshResumedAt;
  assert.ok(resumed > 0);
  assert.equal((await mutate('/api/settings', { refreshEnabled: true })).status, 200);
  assert.equal((await (await fetch(url + '/api/state')).json()).settings.refreshResumedAt, resumed);
  assert.equal((await mutate('/api/repos', { url: 'https://dev.azure.com/example/Demo/_git/test' })).status, 400);
});

test('live mode cannot generate demo activity or expose arbitrary files', async t => {
  const { url, mutate } = await fixture(t, { demo: false });
  assert.equal((await mutate('/api/demo/event', {})).status, 404);
  assert.equal((await fetch(url + '/web/../server.js')).status, 404);
  assert.equal((await fetch(url + '/api/connection?organization=https://attacker.example')).status, 400);
});
