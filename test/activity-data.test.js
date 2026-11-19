import test from 'node:test';
import assert from 'node:assert/strict';
import { joinActivitySearch, splitActivitySearch } from '../src/ui/activity-search.js';
import { createActivityData, activityEvents } from '../src/ui/activity-data.js';

const ui = { route: 'activity', repoIds: null, kind: '', search: '' };
const record = index => {
  const event = { id: `event-${index}`, repoId: 'repo', kind: 'push', seen: false, imported: false };
  return { ...event, groupKey: event.id, events: [event], eventIds: [event.id], unseenIds: [event.id], unseen: true };
};

test('local history appends cursor pages and polling retains the loaded window', async () => {
  const calls = [];
  const client = createActivityData(async path => {
    const query = new URL(path, 'http://local').searchParams;
    calls.push(query);
    const start = Number(query.get('cursor') || 0),
      limit = Number(query.get('limit'));
    const items = Array.from({ length: Math.min(limit, 1120 - start) }, (_, index) => record(index + start));
    return {
      items,
      nextCursor: start + items.length < 1120 ? String(start + items.length) : null,
      total: 1120,
      newItems: 1120,
      newUpdates: 1120,
    };
  });
  assert.equal((await client.read(ui)).items.length, 50);
  assert.equal((await client.read(ui, { more: true })).items.length, 100);
  assert.equal(calls[1].get('cursor'), '50');
  assert.equal((await client.read(ui)).items.length, 100);
  client.reset(450);
  assert.equal((await client.read(ui)).items.length, 450);
  assert.deepEqual(
    calls.slice(-3).map(query => Number(query.get('limit'))),
    [200, 200, 50],
  );
  const filtered = await client.read({ ...ui, kind: 'pr', search: 'old feature', repoIds: ['one'] });
  assert.equal(filtered.items.length, 50);
  assert.equal(calls.at(-1).get('kind'), 'pr');
  assert.equal(calls.at(-1).get('search'), 'old feature');
  assert.equal(calls.at(-1).get('repoIds'), 'one');
});

test('a changed filter cancels a stale page and an empty scope never queries all repos', async () => {
  let resolve;
  let calls = 0;
  const client = createActivityData(async () => {
    calls++;
    if (calls === 1)
      return new Promise(done => {
        resolve = done;
      });
    return { items: [record(2)], nextCursor: null, total: 1, newItems: 1, newUpdates: 1 };
  });
  const old = client.read(ui);
  client.reset();
  assert.equal((await client.read({ ...ui, search: 'new' })).items[0].id, 'event-2');
  resolve({ items: [record(1)], nextCursor: 'old', total: 1 });
  assert.equal(await old, null);
  const empty = await client.read({ ...ui, repoIds: [] });
  assert.equal(empty.total, 0);
  assert.equal(calls, 2);
});

test('deep-link retrieval and constituent flattening preserve exact acknowledgement flags', async () => {
  const old = { id: 'older-than-window', repoId: 'repo', kind: 'build', seen: false, imported: false };
  const newer = { ...old, id: 'latest-run-update', seen: true };
  const client = createActivityData(async path => {
    assert.equal(path, '/api/events/older-than-window');
    return { event: old, events: [newer, old] };
  });
  const detail = await client.event(old.id);
  const events = activityEvents({ items: [record(1)] }, detail);
  assert.equal(events.find(event => event.id === old.id).seen, false);
  assert.equal(events.find(event => event.id === newer.id).seen, true);
  assert.equal(events.length, 3);
});

test('a new revision replaces an old cursor snapshot when Load more is clicked', async () => {
  const calls = [];
  const client = createActivityData(async path => {
    const query = new URL(path, 'http://local').searchParams;
    calls.push(query);
    const offset = Number(query.get('cursor') || 0),
      limit = Number(query.get('limit'));
    return {
      items: Array.from({ length: limit }, (_, index) => record(offset + index)),
      nextCursor: String(offset + limit),
      total: 200,
      newItems: 200,
      newUpdates: 200,
    };
  });
  const first = await client.read(ui, { activityRevision: '1' });
  assert.equal(await client.read(ui, { activityRevision: '1' }), first);
  assert.equal(calls.length, 1);
  const more = await client.read(ui, { activityRevision: '2', more: true });
  assert.equal(more.items.length, 100);
  assert.equal(calls.at(-1).has('cursor'), false);
  assert.equal(await client.read(ui, { activityRevision: '2' }), more);
  await client.read(ui, { activityRevision: '2', force: true });
  assert.equal(calls.length, 3);
});

test('a failed response from a superseded filter does not replace the current view', async () => {
  let reject;
  const client = createActivityData(async path => {
    if (!path.includes('search='))
      return new Promise((resolve, fail) => {
        reject = fail;
      });
    return { items: [record(2)], nextCursor: null, total: 1, newItems: 1, newUpdates: 1 };
  });
  const previous = client.read(ui);
  const current = await client.read({ ...ui, search: 'current' });
  reject(new Error('Old query failed'));
  assert.equal(await previous, null);
  assert.equal(current.items[0].id, 'event-2');
});

test('People paging restarts from the top if the underlying evidence changes after the metadata read', async () => {
  const calls = [];
  const client = createActivityData(async path => {
    const query = new URL(path, 'http://local').searchParams;
    calls.push(query);
    if (query.has('cursor')) throw Object.assign(new Error('Activity changed'), { code: 'ACTIVITY_CHANGED' });
    const length = Number(query.get('limit'));
    const offset = calls.length === 1 ? 1 : 0;
    return { items: Array.from({ length }, (_, index) => record(index + offset)), nextCursor: String(length), total: 150 };
  });
  const view = { ...ui, search: 'people:Alice, Bob' };
  assert.equal((await client.read(view, { activityRevision: '4' })).items[0].id, 'event-1');
  const more = await client.read(view, { activityRevision: '4', more: true });
  assert.equal(more.items.length, 100);
  assert.equal(more.items[0].id, 'event-0');
  assert.deepEqual(
    calls.map(query => query.get('cursor')),
    [null, '50', null],
  );
});

test('the single search input preserves both parts of an existing saved filter', async () => {
  const client = createActivityData(async path => {
    const query = new URL(path, 'http://local').searchParams;
    assert.equal(query.get('search'), 'release notes, main');
    assert.equal(query.get('people'), 'Alice Morgan, Bob Smith');
    return { items: [], nextCursor: null, total: 0, newItems: 0, newUpdates: 0 };
  });
  await client.read({ ...ui, search: joinActivitySearch('release notes, main', 'Alice Morgan, Bob Smith') });
});

test('legacy search text containing reserved search syntax stays literal', () => {
  for (const search of ['people:platform', 'main | PEOPLE:platform', '"quoted"', '\name "with quotes"']) {
    for (const people of ['', 'Alice Morgan, Bob Smith']) {
      assert.deepEqual(splitActivitySearch(joinActivitySearch(search, people)), { search, people });
    }
  }
  const long = { search: 'a'.repeat(300), people: 'b'.repeat(300) };
  assert.deepEqual(splitActivitySearch(joinActivitySearch(long.search, long.people)), long);
});
