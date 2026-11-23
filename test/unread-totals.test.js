import test from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../server/store.ts';

const repo = { id: 'repo', name: 'Repo', azureId: 'a' };
const base = Date.parse('2026-11-20T08:00:00Z');
const push = (id, minute) => ({
  id,
  repoId: repo.id,
  kind: 'push',
  title: id,
  summary: '',
  branch: `feature/${id}`,
  time: new Date(base + minute * 60000).toISOString(),
  observedAt: new Date(base + minute * 60000).toISOString(),
});

// The reported case: the newest 53 updates are seen, 235 older ones are still unread.
function reportedCase() {
  const store = createStore();
  store.saveRepo(repo);
  const older = Array.from({ length: 235 }, (_, i) => push(`older-${i}`, i));
  const newer = Array.from({ length: 53 }, (_, i) => push(`newer-${i}`, 300 + i));
  store.insertEvents([...older, ...newer]);
  store.acknowledge(newer.map(event => event.id));
  return store;
}

test('unread totals in the reported case ignore paging in both views', () => {
  const store = reportedCase();
  for (const view of /** @type {const} */ (['all', 'new'])) {
    const first = store.queryActivity({ view });
    assert.equal(first.items.length, 50);
    const second = store.queryActivity({ view, cursor: first.nextCursor ?? undefined });
    for (const page of [first, second]) {
      assert.equal(page.newItems, 235, view);
      assert.equal(page.newUpdates, 235, view);
      assert.deepEqual(page.newCounts, { push: 235 }, view);
    }
  }
});

test('pages report the snapshot they were read at, and the unread lookup stops there', () => {
  const store = reportedCase();
  const page = store.queryActivity({ view: 'all' });
  assert.equal(typeof page.asOf, 'number');
  assert.ok(page.nextCursor);
  // Recorded after the page was read, with a source time older than everything on it.
  store.insertEvents([push('late', -60)]);
  assert.equal(store.queryActivity({ view: 'all', cursor: page.nextCursor }).asOf, page.asOf);
  const ids = store.queryActivity.unseenIds({ through: page.asOf });
  assert.equal(ids.length, 235);
  assert.ok(!ids.includes('late'));
  assert.ok(store.queryActivity.unseenIds({}).includes('late'));
  store.acknowledge(ids);
  const after = store.queryActivity({ view: 'new' });
  assert.equal(after.newUpdates, 1);
  assert.deepEqual(
    after.items.map(item => item.id),
    ['late'],
  );
});
