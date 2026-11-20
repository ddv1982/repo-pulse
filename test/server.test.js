import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, stat, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request as httpRequest } from 'node:http';
import { createStore } from '../server/store.js';
import { createApp, startApp } from '../server.js';
import { seedDemo } from '../server/demo.js';
import { createAzureClient } from '../server/azure-client.js';
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
  const stylesheet = await globalThis.fetch(url + '/web/app.css');
  assert.equal(stylesheet.status, 200);
  assert.equal(stylesheet.headers.get('content-type'), 'text/css; charset=utf-8');
  const imports = [...(await stylesheet.text()).matchAll(/@import\s+['"]([^'"]+)['"]\s*;/g)].map(match => match[1]);
  assert.deepEqual(imports, [
    '/web/styles/tokens.css',
    '/web/styles/base.css',
    '/web/styles/layout.css',
    '/web/styles/feed.css',
    '/web/styles/repositories.css',
    '/web/styles/settings.css',
  ]);
  for (const href of imports) {
    const part = await globalThis.fetch(new URL(href, url));
    assert.equal(part.status, 200, `${href} should be served`);
    assert.equal(part.headers.get('content-type'), 'text/css; charset=utf-8', `${href} should have text/css content-type`);
  }
  assert.equal((await fetch(url + '/package.json')).status, 404);
  assert.equal((await fetch(url + '/server/store.js')).status, 404);
});

test('state reports no merge queue', async t => {
  const { state } = await fixture(t);
  assert.equal('mergeQueue' in state, false);
});

test('state carries a sync status per enabled repository and overall', async t => {
  const demo = (await fixture(t)).state;
  const enabled = demo.repos.filter(repo => !repo.disabled).map(repo => repo.id);
  assert.deepEqual(Object.keys(demo.syncStatus.repos).sort(), enabled.sort());
  assert.equal(demo.syncStatus.overall.state, 'synced');

  // The demo seed refuses CI reads for one repository; outside demo mode that is a problem for it alone.
  const live = (await fixture(t, { demo: false })).state.syncStatus;
  assert.equal(live.repos['demo-billing'].state, 'problem');
  assert.equal(live.repos['demo-billing'].stream, 'builds');
  assert.equal(live.overall.state, 'problem');
  assert.equal(live.overall.repoId, 'demo-billing');
  assert.ok(Object.entries(live.repos).every(([id, status]) => id === 'demo-billing' || status.state !== 'problem'));
});

test('a queue paused by Azure throttling shows in diagnostics and makes the other repositories delayed', async t => {
  const throttledUntil = new Date(Date.now() + 60000).toISOString();
  const { state } = await fixture(t, { demo: false, cli: { diagnostics: () => ({ throttledUntil }) } });
  assert.equal(state.diagnostics.throttledUntil, throttledUntil);
  const others = Object.entries(state.syncStatus.repos).filter(([id]) => id !== 'demo-billing');
  assert.ok(others.length);
  for (const [, status] of others) assert.equal(status.reason, 'Azure DevOps asked us to slow down');
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

test('Activity checkout mutations resolve the target from an event in the requested repository', async t => {
  const calls = [];
  const checkoutGit = {
    status: async () => ({ state: 'not-linked' }),
    switchToActivityBranch: async (repo, branch, expected) => {
      calls.push({ repo: repo.id, branch, expected });
      return { checkout: { branch } };
    },
  };
  const { store, mutate } = await fixture(t, { demo: false, checkoutGit });
  const event = {
    id: 'switchable-branch',
    repoId: 'demo-billing',
    kind: 'branch-created',
    data: { name: 'refs/heads/feature/topic' },
  };
  const merged = {
    id: 'merged-pr',
    repoId: 'demo-billing',
    kind: 'pr',
    data: { status: 'completed', sourceRefName: 'refs/heads/feature/topic', targetRefName: 'refs/heads/main' },
  };
  store.insertEvents([event, { ...event, id: 'deleted-branch', kind: 'branch-deleted' }, merged]);
  const expected = { branch: 'main', head: 'a'.repeat(40), upstream: null, identity: 'fixture', switchIdentity: 'git-directory' };
  const input = { operation: 'switch-activity', eventId: event.id, branch: 'ignored', expected };
  const endpoint = '/api/repos/demo-billing/checkout';
  assert.equal((await mutate(endpoint, { ...input, expected: { ...expected, switchIdentity: undefined } })).status, 400);
  assert.equal((await mutate(endpoint, { ...input, eventId: 'deleted-branch' })).status, 400);
  assert.equal((await mutate(endpoint, { ...input, eventId: 'demo-branch-1' })).status, 404);
  assert.equal((await mutate(endpoint, input)).status, 200);
  assert.equal((await mutate(endpoint, { ...input, eventId: 'merged-pr' })).status, 200);
  assert.deepEqual(calls, [
    { repo: 'demo-billing', branch: 'feature/topic', expected },
    { repo: 'demo-billing', branch: 'main', expected },
  ]);
});

test('Repositories switches only to a branch the repository still lists', async t => {
  const calls = [];
  const checkoutGit = {
    status: async () => ({ state: 'clean' }),
    localBranches: async () => ['main', 'feature/local'],
    switchToActivityBranch: async (repo, branch, expected, options) => {
      calls.push({ repo: repo.id, branch, options });
      return { checkout: { branch } };
    },
  };
  const { store, mutate, url } = await fixture(t, { demo: false, checkoutGit });
  const ref = (name, data = {}) => ({ type: 'ref', id: name, data: { name, objectId: 'a'.repeat(40), active: true, ...data } });
  store.commitPage({
    repoId: 'demo-billing',
    entities: [
      ref('refs/heads/feature/old', { lastPushId: 3 }),
      ref('refs/heads/feature/new', { lastPushId: 9 }),
      ref('refs/heads/feature/local'),
      ref('refs/heads/main', { lastPushId: 1 }),
      ref('refs/heads/gone', { active: false, lastPushId: 20 }),
      ref('refs/tags/v1'),
    ],
  });
  const expected = { branch: 'feature/new', head: 'a'.repeat(40), upstream: null, identity: 'fixture', switchIdentity: 'git-directory' };
  const endpoint = '/api/repos/demo-billing/checkout';
  const input = { operation: 'switch-branch', branch: 'main', expected };
  assert.equal((await mutate(endpoint, { ...input, branch: 'gone' })).status, 400);
  assert.equal((await mutate(endpoint, { ...input, branch: 'unknown' })).status, 400);
  assert.equal((await mutate(endpoint, { ...input, branch: 'v1' })).status, 400);
  assert.equal((await mutate(endpoint, { ...input, branch: 7 })).status, 400);
  assert.equal((await mutate(endpoint, { ...input, confirmation: 'token' })).status, 200);
  assert.deepEqual(calls, [{ repo: 'demo-billing', branch: 'main', options: { confirmation: 'token' } }]);

  const listed = await (await fetch(`${url}/api/repos/demo-billing/checkout/branches`)).json();
  assert.deepEqual(listed, {
    branches: [
      { name: 'main', local: true },
      { name: 'feature/new', local: false },
      { name: 'feature/old', local: false },
      { name: 'feature/local', local: true },
    ],
  });
});

test('demo mode lists and switches no checkout branches', async t => {
  const { mutate, url } = await fixture(t);
  assert.equal((await fetch(`${url}/api/repos/demo-billing/checkout/branches`)).status, 403);
  const expected = { branch: 'a', head: 'a'.repeat(40), upstream: null, identity: 'i', switchIdentity: 's' };
  assert.equal((await mutate('/api/repos/demo-billing/checkout', { operation: 'switch-branch', branch: 'main', expected })).status, 403);
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
  store.saveRepo({ ...store.getRepo('demo-billing'), disabled: false });
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
  let running;
  // Close before removing: Windows cannot delete the open database, and an open server keeps the test file running.
  t.after(async () => {
    await running?.close();
    await rm(directory, { recursive: true, force: true });
  });
  await writeFile(join(directory, 'access-key'), 'k'.repeat(43), { mode: 0o644 });
  const first = (running = await startApp({ demo: true, port: 0, dataDir: directory }));
  const token = new URL(first.launchUrl).hash.slice('#launch='.length);
  assert.equal(new URL(first.launchUrl).search, '');
  const exchange = (url, value) => globalThis.fetch(url + '/api/session', { method: 'POST', headers: { 'x-repo-pulse-launch': value } });
  assert.equal((await exchange(first.url, 'wrong')).status, 401);
  const session = await exchange(first.url, token);
  assert.deepEqual(await session.json(), { key: first.accessKey });
  assert.equal((await exchange(first.url, token)).status, 401);
  const oldKey = first.accessKey;
  await first.close();
  running = undefined;
  await assert.rejects(stat(join(directory, 'access-key')), { code: 'ENOENT' });
  const second = (running = await startApp({ demo: true, port: 0, dataDir: directory }));
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

test('Load push commits pages through the Azure client by push ID', async t => {
  const reads = [];
  const cli = {
    run: async args => {
      const query = Object.fromEntries(args.slice(args.indexOf('--query-parameters') + 1).map(pair => pair.split('=')));
      reads.push(query);
      const length = Number(query.skip) === 0 ? 100 : 3;
      return { value: Array.from({ length }, (_, index) => ({ commitId: `${query.skip}-${index}`, comment: 'Change', author: {} })) };
    },
  };
  const { url } = await fixture(t, { demo: false, provider: createAzureClient({ cli }) });
  const first = await (await fetch(`${url}/api/push/demo-billing/7/commits`)).json();
  assert.equal(first.items.length, 100);
  assert.deepEqual(first.items[0], { commitId: '0-0', comment: 'Change' });
  assert.deepEqual(first.nextCursor, { skip: 100 });
  const second = await (await fetch(`${url}/api/push/demo-billing/7/commits?skip=${first.nextCursor.skip}`)).json();
  assert.deepEqual(
    second.items.map(item => item.commitId),
    ['100-0', '100-1', '100-2'],
  );
  assert.equal(second.nextCursor, null);
  assert.deepEqual(
    reads.map(query => [query.pushId, query.top, query.skip]),
    [
      ['7', '100', '0'],
      ['7', '100', '100'],
    ],
  );
});

test('saved Activity filters validate inputs and preserve an explicit empty scope across Activity reset', async t => {
  const { url, mutate, store } = await fixture(t);
  const path = '/api/activity-filters';
  const filters = { search: 'main', people: 'Alice, Bob', kind: 'push', repoIds: [], view: 'all' };
  assert.equal((await globalThis.fetch(url + path, { method: 'POST' })).status, 401);
  assert.equal((await mutate(path, { name: 'Invalid', filters: { ...filters, people: 'a'.repeat(301) } })).status, 400);
  assert.equal((await mutate(path, { name: 'Invalid', filters: { ...filters, repoIds: 'all' } })).status, 400);
  const created = await mutate(path, { name: '  Team  ', filters });
  assert.equal(created.status, 201);
  const preset = await created.json();
  assert.equal(preset.name, 'Team');
  assert.deepEqual(preset.filters, filters);
  store.resetActivity();
  const state = await (await fetch(url + '/api/state')).json();
  assert.deepEqual(state.savedFilters, [preset]);
  assert.equal((await mutate(path + '/' + preset.id, { filters: { ...filters, repoIds: null } }, { method: 'PATCH' })).status, 200);
  const after = await (await fetch(url + '/api/state')).json();
  assert.equal(after.savedFilters[0].filters.repoIds, null);
  assert.equal((await fetch(url + path + '/' + preset.id, { method: 'DELETE' })).status, 200);
  assert.deepEqual((await (await fetch(url + '/api/state')).json()).savedFilters, []);
});

test('the unread lookup honours a page snapshot and rejects an invalid one', async t => {
  const { url, store } = await fixture(t);
  const page = await (await fetch(`${url}/api/activity?view=new`)).json();
  const before = (await (await fetch(`${url}/api/activity/unseen`)).json()).ids;
  assert.ok(before.length > 0);
  const repoId = store.listRepos()[0].id;
  store.insertEvents([{ id: 'after-snapshot', repoId, kind: 'push', title: 'Later', time: '2020-01-01T00:00:00Z' }]);
  const bounded = (await (await fetch(`${url}/api/activity/unseen?through=${page.asOf}`)).json()).ids;
  assert.deepEqual(new Set(bounded), new Set(before));
  assert.ok((await (await fetch(`${url}/api/activity/unseen`)).json()).ids.includes('after-snapshot'));
  for (const bad of ['-1', '1.5', 'x']) assert.equal((await fetch(`${url}/api/activity/unseen?through=${bad}`)).status, 400, bad);
});

test('malformed percent-encoding in route parameters returns 400 and CSP forbids inline styles', async t => {
  const { url } = await fixture(t, { demo: false });
  const page = await globalThis.fetch(url + '/');
  assert.equal(page.status, 200);
  const csp = page.headers.get('content-security-policy') || '';
  assert.match(csp, /style-src 'self';/);
  assert.doesNotMatch(csp, /unsafe-inline/);
  for (const [method, path] of [
    ['GET', '/api/events/%E0%A4%A'],
    ['DELETE', '/api/activity-filters/%E0%A4%A'],
    ['DELETE', '/api/repos/%E0%A4%A'],
    ['GET', '/api/repos/%E0%A4%A/checkout/status'],
  ]) {
    const response = await fetch(url + path, { method });
    assert.equal(response.status, 400, `${method} ${path}`);
  }
});
