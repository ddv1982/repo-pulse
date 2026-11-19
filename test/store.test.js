import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from '../server/store.js';
import { DatabaseSync } from 'node:sqlite';
const repo = {
  id: 'one',
  name: 'One',
  azureId: 'a',
  organization: 'https://dev.azure.com/org',
  project: 'P',
  webUrl: 'https://dev.azure.com/org/P/_git/One',
};
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
  assert.deepEqual(
    store
      .listEvents({ unseen: true })
      .map(e => e.id)
      .sort(),
    ['hidden', 'incoming'],
  );
  assert.equal(store.listEvents().find(e => e.id === 'history').seen, true);
  store.acknowledge(['shown'], false);
  assert.equal(store.listEvents({ unseen: true }).length, 3);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  store.close();
  rmSync(folder, { recursive: true });
});

test('page transaction rolls back events and checkpoint together', () => {
  const store = createStore();
  store.saveRepo(repo);
  assert.throws(() =>
    store.commitPage({
      repoId: 'one',
      stream: 'pushes',
      state: { cursor: 2 },
      events: [event('good'), event('bad', { repoId: 'missing' })],
    }),
  );
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
  assert.deepEqual(
    store.listEvents().map(e => e.id),
    ['two'],
  );
  assert.throws(() => store.listEvents({ repoIds: ['unknown'] }));
  store.close();
});

const tip = 'd'.repeat(40);
const moved = (id, repoId = 'one', name = 'refs/heads/main', newObjectId = tip) =>
  event(id, { repoId, data: { pushId: id, refUpdates: [{ name, oldObjectId: 'e'.repeat(40), newObjectId }] } });
const completedPr = (id, extra = {}) => ({
  id,
  repoId: 'one',
  kind: 'pr',
  title: `PR ${id}`,
  time: '2026-11-17T11:00:00Z',
  ...extra,
  data: { pullRequestId: id, status: 'completed', targetRefName: 'refs/heads/main', mergeCommit: tip, ...extra.data },
});
const linked = (store, id) => (store.getEvent(id).data.mergeEvidence?.prs || []).map(pr => pr.pullRequestId);

test('a completed PR links only a push in its repository that moved its target ref to its merge commit', () => {
  const store = createStore();
  store.saveRepo(repo);
  store.saveRepo({ ...repo, id: 'two' });
  store.insertEvents([moved('push'), moved('elsewhere', 'two'), moved('created', 'one', 'refs/heads/new')]);
  store.insertEvents([
    completedPr('other-ref', { data: { targetRefName: 'refs/heads/release' } }),
    completedPr('no-result', { data: { mergeCommit: undefined } }),
    completedPr('active', { data: { status: 'active' } }),
  ]);
  assert.deepEqual(linked(store, 'push'), []);
  assert.deepEqual(linked(store, 'elsewhere'), []);
  assert.equal(store.getEvent('push').data.mergeEvidence, undefined, 'no evidence is claimed from an absent match');
  store.insertEvents([completedPr('match')]);
  assert.deepEqual(linked(store, 'push'), ['match']);
  assert.deepEqual(linked(store, 'elsewhere'), [], 'the same merge commit in another repository is not linked');
  assert.deepEqual(linked(store, 'created'), []);
  store.close();
});

test('upgrading a database links pairs it already stored and pushes whose PR arrives later', () => {
  const folder = mkdtempSync(join(tmpdir(), 'pulse-store-'));
  const path = join(folder, 'state.sqlite');
  let store = createStore(path);
  store.saveRepo(repo);
  store.insertEvents([moved('stored-pair'), completedPr('stored-pr'), moved('later', 'one', 'refs/heads/main', 'a'.repeat(40))]);
  store.close();
  const raw = new DatabaseSync(path);
  raw.exec('DELETE FROM enrichment; DROP TABLE IF EXISTS push_tips; PRAGMA user_version = 9;');
  raw.close();
  store = createStore(path);
  assert.deepEqual(linked(store, 'stored-pair'), ['stored-pr']);
  store.insertEvents([completedPr('later-pr', { data: { mergeCommit: 'A'.repeat(40) } })]);
  assert.deepEqual(linked(store, 'later'), ['later-pr']);
  store.close();
  rmSync(folder, { recursive: true });
});
