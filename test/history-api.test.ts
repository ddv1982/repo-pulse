import test from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../server/store.ts';
import { createApp, type AppProvider, type AppSync } from '../server.ts';
import type { SyncStatus } from '../server/sync.ts';
import type { ActivityEvent } from '../src/activity.ts';
import type { HistoryJob, Repository } from '../src/contract.d.ts';
import { TEST_KEY, keyedFetch, portOf } from './fixtures/access.ts';
import { stub } from './fixtures/typed.ts';

const provider = stub<AppProvider>({});
const sync = stub<AppSync>({ status: () => stub<SyncStatus>({}) });

const fetch = keyedFetch();

test('paged history and deep links reach old unseen activity beyond latest 1000', async t => {
  const store = createStore();
  store.saveRepo(stub<Repository>({ id: 'r', name: 'Repo' }));
  store.insertEvents(
    Array.from({ length: 1101 }, (_, i): ActivityEvent => ({
      id: `event${i}`,
      repoId: 'r',
      kind: 'push',
      title: `Push ${i}`,
      time: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(),
      seen: i !== 0,
      imported: false,
      data: {},
    })),
  );
  const app = createApp({ store, provider, sync, accessKey: TEST_KEY });
  await new Promise<void>(resolve => app.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise(resolve => app.close(resolve));
    store.close();
  });
  const base = `http://127.0.0.1:${portOf(app)}`;
  const metadata = await (await fetch(base + '/api/state')).json();
  assert.equal(Object.hasOwn(metadata, 'events'), false);
  assert.equal(typeof metadata.activityRevision, 'string');
  const unseen = await (await fetch(base + '/api/activity?view=new')).json();
  assert.equal(unseen.items[0].id, 'event0');
  assert.equal(unseen.newItems, 1);
  let cursor,
    count = 0;
  do {
    const response = await fetch(base + '/api/activity?limit=100' + (cursor ? '&cursor=' + encodeURIComponent(cursor) : ''));
    assert.equal(response.status, 200);
    const page = await response.json();
    count += page.items.length;
    cursor = page.nextCursor;
  } while (cursor);
  assert.equal(count, 1101);
  const detail = await (await fetch(base + '/api/events/event0')).json();
  assert.equal(detail.event.id, 'event0');
  assert.equal(detail.events.length, 1);
  assert.equal((await fetch(base + '/api/activity?limit=10000')).status, 400);
});

test('historical import endpoint validates repository, range and access key', async t => {
  const store = createStore();
  store.saveRepo(stub<Repository>({ id: 'r', name: 'Repo' }));
  const starts: { repoId: string; days?: number | 'all' | undefined }[] = [];
  const app = createApp({
    store,
    provider,
    sync,
    backfill: {
      start: (repoId, days) => {
        starts.push({ repoId, days });
        return stub<HistoryJob>({ status: 'pending' });
      },
    },
    accessKey: TEST_KEY,
  });
  await new Promise<void>(resolve => app.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise(resolve => app.close(resolve));
    store.close();
  });
  const base = `http://127.0.0.1:${portOf(app)}`;
  const post = (body: unknown, key = TEST_KEY) =>
    globalThis.fetch(base + '/api/backfill', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-repo-pulse-key': key },
      body: JSON.stringify(body),
    });
  assert.equal((await post({ repoId: 'r', days: 30 }, 'bad-key')).status, 401);
  assert.equal((await post({ repoId: 'r', days: 365 })).status, 400);
  assert.equal((await post({ repoId: 'missing', days: 30 })).status, 404);
  assert.equal((await post({ repoId: 'r', days: 'all' })).status, 202);
  assert.deepEqual(starts, [{ repoId: 'r', days: 'all' }]);
  assert.equal((await fetch(base + '/api/activity?cursor=invalid')).status, 400);
});
