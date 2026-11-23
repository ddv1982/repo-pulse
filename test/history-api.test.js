import test from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../server/store.ts';
import { createApp } from '../server.ts';
import { TEST_KEY, keyedFetch } from './fixtures/access.js';

const fetch = keyedFetch();

test('paged history and deep links reach old unseen activity beyond latest 1000', async t => {
  const store = createStore();
  store.saveRepo({ id: 'r', name: 'Repo' });
  store.insertEvents(
    Array.from({ length: 1101 }, (_, i) => ({
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
  const app = createApp({ store, provider: {}, sync: { status: () => ({}) }, accessKey: TEST_KEY });
  await new Promise(resolve => app.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise(resolve => app.close(resolve));
    store.close();
  });
  const base = `http://127.0.0.1:${app.address().port}`;
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
  store.saveRepo({ id: 'r', name: 'Repo' });
  const starts = [];
  const app = createApp({
    store,
    provider: {},
    sync: { status: () => ({}) },
    backfill: {
      start: (repoId, days) => {
        starts.push({ repoId, days });
        return { status: 'pending' };
      },
    },
    accessKey: TEST_KEY,
  });
  await new Promise(resolve => app.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise(resolve => app.close(resolve));
    store.close();
  });
  const base = `http://127.0.0.1:${app.address().port}`;
  const post = (body, key = TEST_KEY) =>
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
