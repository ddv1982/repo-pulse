import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import { createStore } from '../server/store.ts';
import { createApp, type AppOptions } from '../server.ts';
import { seedDemo } from '../server/demo.ts';
import { cliError } from '../server/azure-cli.ts';
import type { AzureProvider } from '../server/azure-client.ts';
import type { SyncEngineStatus } from '../src/contract.d.ts';
import { TEST_KEY, keyedFetch, portOf } from './fixtures/access.ts';
import { stub } from './fixtures/typed.ts';

const fetch = keyedFetch();
const GENERIC = 'Something went wrong. Try again; cached data is kept.';

async function app(t: TestContext, options: Partial<AppOptions>) {
  const directory = await mkdtemp(join(tmpdir(), 'repo-pulse-errors-'));
  const store = createStore(join(directory, 'test.sqlite'));
  seedDemo(store);
  const server = createApp({
    store,
    provider: stub<AzureProvider>({}),
    sync: { refresh: () => ({ scheduled: true }), status: () => stub<SyncEngineStatus>({ running: false }) },
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
  const post = (path: string, data: unknown) =>
    fetch(url + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) });
  return { url, post };
}

test('an unexpected error that carries a code is a 500 with the generic message, not a 502 with its own text', async t => {
  const { post } = await app(t, {
    discover: async () => {
      throw Object.assign(new Error('EACCES: permission denied, scandir /home/someone/private'), { code: 'EACCES' });
    },
  });
  const response = await post('/api/discover', { path: '/home/someone' });
  assert.equal(response.status, 500);
  assert.equal((await response.json()).message, GENERIC);
});

test('a repository URL with credentials in it is a bad request', async t => {
  const { post } = await app(t, {
    provider: stub<AzureProvider>({ resolveRepository: async () => assert.fail('not reached') }),
  });
  const response = await post('/api/repos', { url: 'https://user:secret@dev.azure.com/Org/Project/_git/Repo' });
  assert.equal(response.status, 400);
  const body = await response.json();
  assert.equal(body.code, 'REMOTE_PASSWORD');
  assert.doesNotMatch(body.message, /secret/);
});

test('Azure failures keep their status: not found is 404, every other Azure failure is 502 with its own message', async t => {
  const failures = [cliError('NOT_FOUND', 'Not there.'), cliError('FORBIDDEN', 'Refused.')];
  const { url } = await app(t, {
    provider: stub<AzureProvider>({
      prReview: async () => {
        throw failures.shift();
      },
    }),
  });
  const review = () => fetch(`${url}/api/pr/demo-orders/1/review`);
  const missing = await review();
  assert.equal(missing.status, 404);
  assert.deepEqual(await missing.json(), { message: 'Not there.', code: 'NOT_FOUND' });
  const refused = await review();
  assert.equal(refused.status, 502);
  assert.deepEqual(await refused.json(), { message: 'Refused.', code: 'FORBIDDEN' });
});
