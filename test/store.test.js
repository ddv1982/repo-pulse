import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from '../server/store.js';
const repo = { id: 'one', name: 'One', azureId: 'a', organization: 'https://dev.azure.com/org', project: 'P', webUrl: 'https://dev.azure.com/org/P/_git/One' };
const event = (id, extra = {}) => ({ id, repoId: 'one', kind: 'push', title: id, time: '2026-11-17T10:00:00Z', ...extra });

test('durable exact acknowledgement does not consume hidden or incoming events', () => {
  const folder = mkdtempSync(join(tmpdir(), 'pulse-store-'));
  const path = join(folder, 'state.sqlite');
  let store = createStore(path);
  store.saveRepo(repo);
  store.insertEvents([event('shown'), event('hidden'), event('history', { imported: true })]);
  store.acknowledge(['shown']);
  store.insertEvents([event('incoming'), event('shown')]);
  store.close();
  store = createStore(path);
  assert.deepEqual(store.listEvents({ unseen: true }).map((e) => e.id).sort(), ['hidden', 'incoming']);
  assert.equal(store.listEvents().find((e) => e.id === 'history').seen, true);
  store.acknowledge(['shown'], false);
  assert.equal(store.listEvents({ unseen: true }).length, 3);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  store.close();
  rmSync(folder, { recursive: true });
});

test('page transaction rolls back events and checkpoint together', () => {
  const store = createStore();
  store.saveRepo(repo);
  assert.throws(() => store.commitPage({ repoId: 'one', stream: 'pushes',
    state: { cursor: 2 }, events: [event('good'), event('bad', { repoId: 'missing' })] }));
  assert.equal(store.listEvents().length, 0);
  assert.equal(store.getStreams().length, 0);
  store.commitPage({ repoId: 'one', stream: 'pushes', state: { cursor: 2 }, events: [event('good')] });
  assert.equal(store.getStreams()[0].cursor, 2);
  store.close();
});

test('repository removal cascades only its local data', () => {
  const store = createStore();
  store.saveRepo(repo);
  store.saveRepo({ ...repo, id: 'two' });
  store.insertEvents([event('one'), event('two', { repoId: 'two' })]);
  store.removeRepo('one');
  assert.deepEqual(store.listEvents().map((e) => e.id), ['two']);
  assert.throws(() => store.listEvents({ repoIds: ['unknown'] }));
  store.close();
});
