import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import { createStore } from '../server/store.ts';
import { createApp, startApp, type AppOptions } from '../server/runtime.ts';
import { createRouter, type Handlers } from '../server/http.ts';
import { seedDemo, idleSyncStatus } from '../server/demo.ts';
import type { AzureProvider } from '../server/azure-client.ts';
import type { createCheckoutGit } from '../server/checkout-git.ts';
import { ROUTES, type CheckoutStatus, type ConnectionStatus, type HistoryImportJob } from '../src/contract.ts';
import { TEST_KEY, fetchWithKey, keyedFetch, portOf, rememberRuntime } from './fixtures/access.ts';
import { stub } from './fixtures/typed.ts';

const fetch = keyedFetch();
/** What the server answers for a path no route matches. */
const UNMATCHED = { message: 'Not found.' };

async function app(t: TestContext, options: Partial<AppOptions> = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'repo-pulse-routes-'));
  const store = createStore(join(directory, 'test.sqlite'));
  seedDemo(store);
  const connections: (string | undefined)[] = [];
  const server = createApp({
    store,
    provider: stub<AzureProvider>({
      checkConnection: async (organization, repo) => {
        connections.push((repo as { id?: string } | undefined)?.id);
        return stub<ConnectionStatus>({ available: true, message: 'ok' });
      },
      pushCommits: async () => ({ items: [], nextCursor: null }),
      prReview: async () => ({ threads: { open: 0, resolved: 0 }, policies: [] }),
    }),
    sync: { refresh: () => ({ scheduled: true }), status: () => idleSyncStatus() },
    historyImporter: { start: () => stub<HistoryImportJob>({ id: 'job' }) },
    checkoutGit: stub<ReturnType<typeof createCheckoutGit>>({
      status: async () => stub<CheckoutStatus>({ state: 'not-linked' }),
      localBranches: async () => [],
    }),
    discover: async () => ({ repositories: [], warnings: [] }),
    browse: async () => ({ path: '/', parent: null, breadcrumbs: [], folders: [], repositories: [], warnings: [] }),
    demo: false,
    accessKey: TEST_KEY,
    ...options,
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    store.close();
    await rm(directory, { recursive: true, force: true });
  });
  const url = `http://127.0.0.1:${portOf(server)}`;
  const send = (method: string, path: string, body?: unknown) =>
    fetch(url + path, {
      method,
      ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    });
  return { url, send, store, connections };
}

const unmatched = async (response: Response) =>
  response.status === 404 && JSON.stringify(await response.json()) === JSON.stringify(UNMATCHED);

test('every route in the shared map reaches a handler on the server', async t => {
  const { send } = await app(t);
  for (const key of Object.keys(ROUTES)) {
    const [method = '', pattern = ''] = key.split(' ');
    const path = pattern.replace(':id', 'demo-orders').replace(/:[A-Za-z]+/g, '1');
    const response = await send(method, path, method === 'POST' || method === 'PATCH' ? {} : undefined);
    assert.equal(await unmatched(response), false, `${key} is not registered`);
  }
});

test('repository-scoped routes live under /api/repos/:id and the old paths are gone', async t => {
  const { send, connections } = await app(t);
  const moved: [string, string, string, unknown?][] = [
    ['GET', '/api/events/demo-branch-1', '/api/activity/demo-branch-1'],
    ['GET', '/api/push/demo-orders/1/commits', '/api/repos/demo-orders/pushes/1/commits'],
    ['GET', '/api/pr/demo-orders/1/review', '/api/repos/demo-orders/prs/1/review'],
    ['POST', '/api/backfill', '/api/repos/demo-orders/backfill', { repoId: 'demo-orders', days: 30 }],
  ];
  for (const [method, before, after, body] of moved) {
    assert.equal(await unmatched(await send(method, after, body && { days: 30 })), false, `${method} ${after} is served`);
    assert.equal(await unmatched(await send(method, before, body)), true, `${method} ${before} is gone`);
  }
  const detail = await send('GET', '/api/activity/demo-branch-1');
  assert.equal(detail.status, 200);
  assert.equal((await detail.json()).event.id, 'demo-branch-1');
  const job = await send('POST', '/api/repos/demo-orders/backfill', { days: 30 });
  assert.equal(job.status, 202);
  connections.length = 0;
  assert.equal((await send('GET', '/api/repos/demo-orders/connection')).status, 200);
  assert.equal((await send('GET', '/api/connection?repoId=demo-orders')).status, 200);
  assert.deepEqual(connections, ['demo-orders', undefined], 'only the nested path checks a repository');
});

test('settings change with PATCH; POST is no longer a route', async t => {
  const { send, store } = await app(t);
  assert.equal((await send('PATCH', '/api/settings', { refreshEnabled: false })).status, 200);
  assert.equal(store.getSetting('refreshEnabled'), false);
  assert.equal(await unmatched(await send('POST', '/api/settings', { refreshEnabled: true })), true);
  assert.equal(store.getSetting('refreshEnabled'), false);
});

test('the unread lookup is not read as an activity ID', async t => {
  const { send } = await app(t);
  const response = await send('GET', '/api/activity/unseen');
  assert.equal(response.status, 200);
  assert.ok(Array.isArray((await response.json()).ids));
});

test('the server refuses route handlers that do not cover the route map exactly', () => {
  const handlers = Object.fromEntries(Object.keys(ROUTES).map(key => [key, () => ({})])) as unknown as Handlers;
  assert.doesNotThrow(() => createRouter(handlers));
  const missing: Partial<Handlers> = { ...handlers };
  delete missing['GET /api/state'];
  assert.throws(() => createRouter(missing as Handlers), /Missing: GET \/api\/state\. Not in the map: none\./);
  const extra = { ...handlers, 'POST /api/settings': () => ({}) };
  assert.throws(() => createRouter(extra), /Missing: none\. Not in the map: POST \/api\/settings\./);
});

test('request shapes are checked at the route: up to 1000 Seen IDs, a known Activity view, a valid history period', async t => {
  const { send } = await app(t);
  const ids = (count: number) => Array.from({ length: count }, (_, index) => `id-${index}`);
  assert.equal((await send('POST', '/api/ack', { ids: ids(1000) })).status, 200);
  const tooMany = await send('POST', '/api/ack', { ids: ids(1001) });
  assert.equal(tooMany.status, 400);
  assert.equal((await tooMany.json()).message, 'Send up to 1000 explicit event IDs.');
  const view = await send('GET', '/api/activity?view=everything');
  assert.equal(view.status, 400);
  assert.equal((await view.json()).message, 'Invalid activity view.');
  assert.equal((await send('POST', '/api/repos/demo-orders/backfill', { days: 60 })).status, 400);
  assert.equal((await send('POST', '/api/repos/missing/backfill', { days: 30 })).status, 404);
});

test('demo mode refuses every route it cannot serve with 403', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'repo-pulse-demo-routes-'));
  const runtime = rememberRuntime(await startApp({ demo: true, port: 0, dataDir: directory }));
  t.after(async () => {
    await runtime.close();
    await rm(directory, { recursive: true, force: true });
  });
  const send = (method: string, path: string, body?: unknown) =>
    fetchWithKey(runtime.url + path, {
      method,
      ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    });
  const expected = { branch: 'main', head: 'a'.repeat(40), upstream: 'origin/main', identity: 'i', switchIdentity: 's' };
  const refused: [string, string, unknown?][] = [
    ['POST', '/api/repos', { url: 'https://dev.azure.com/org/project/_git/repo' }],
    ['POST', '/api/repos/demo-orders/backfill', { days: 30 }],
    ['POST', '/api/reset', {}],
    ['GET', '/api/repos/demo-orders/graph'],
    ['GET', '/api/repos/demo-orders/graph/snapshot'],
    ['GET', '/api/repos/demo-orders/checkout/status'],
    ['GET', '/api/repos/demo-orders/checkout/branches'],
    ['POST', '/api/repos/demo-orders/checkout', { operation: 'check', expected }],
  ];
  for (const [method, path, body] of refused) {
    const response = await send(method, path, body);
    assert.equal(response.status, 403, `${method} ${path}`);
    assert.equal((await response.json()).code, 'NOT_IN_DEMO', `${method} ${path}`);
  }
  // Refused before the body is read, so a request without one still learns why.
  for (const [method, path] of refused.filter(([method]) => method === 'POST')) {
    const response = await send(method, path);
    assert.equal(response.status, 403, `${method} ${path} without a body`);
    assert.equal((await response.json()).code, 'NOT_IN_DEMO', `${method} ${path} without a body`);
  }
  assert.equal((await send('GET', '/api/state')).status, 200);
  assert.equal((await send('POST', '/api/demo/event', {})).status, 201);
});

test('live mode answers 404 for the demo-only route, with or without a body', async t => {
  const { send } = await app(t);
  assert.equal((await send('POST', '/api/demo/event', {})).status, 404);
  assert.equal((await send('POST', '/api/demo/event')).status, 404);
});

test('a sync without reset refuses Start from scratch instead of reporting it started', async t => {
  const { send } = await app(t);
  const response = await send('POST', '/api/reset', {});
  assert.equal(response.status, 403);
});

test('a checkout command is read at the route into one operation, and its answer names that operation', async t => {
  const calls: string[] = [];
  const checkout = stub<CheckoutStatus>({ state: 'current' });
  const { send } = await app(t, {
    checkoutGit: stub<ReturnType<typeof createCheckoutGit>>({
      update: async (repo, operation) => {
        calls.push(operation);
        return { checkout, updated: false };
      },
      branchAction: async (repo, action) => {
        calls.push(action.operation);
        return { checkout, message: 'Reviewed.' };
      },
    }),
  });
  const expected = { branch: 'main', head: 'a'.repeat(40), upstream: 'origin/main', identity: 'i' };
  const planId = '0b0e3f9e-5a8e-4f43-9b52-2b4c3d1a0f11';
  const post = (body: unknown) => send('POST', '/api/repos/demo-orders/checkout', body);
  const check = await post({ operation: 'check', expected });
  assert.equal(check.status, 200);
  assert.deepEqual(await check.json(), { operation: 'check', checkout, updated: false });
  const review = await post({ operation: 'review', planId, expected });
  assert.deepEqual(await review.json(), { operation: 'review', checkout, message: 'Reviewed.' });
  for (const body of [
    { operation: 'pull' },
    { operation: 'pull', expected: { ...expected, upstream: null } },
    { operation: 'carry', planId, commits: [], expected },
    { operation: 'remove', planId: 'not-a-plan', expected },
    { operation: 'rebase', expected },
  ]) {
    const refused = await post(body);
    assert.equal(refused.status, 400, JSON.stringify(body));
    assert.equal((await refused.json()).message, 'Choose a checkout and Git action.');
  }
  assert.deepEqual(calls, ['check', 'review']);
});
