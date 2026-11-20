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

test('the tip match upgrades a saved weaker link to the same PR and keeps its details', () => {
  const store = createStore();
  store.saveRepo(repo);
  store.insertEvents([moved('push')]);
  const weaker = { pullRequestId: 'pr', targetRefName: 'refs/heads/main', relationship: 'constituent-related', title: 'Kept' };
  store.enrichEvent('push', { mergeEvidence: { status: 'complete', prs: [weaker] } });
  store.insertEvents([completedPr('pr')]);
  assert.deepEqual(
    store.getEvent('push').data.mergeEvidence.prs.map(pr => [pr.pullRequestId, pr.relationship, pr.title, pr.mergeCommit]),
    [['pr', 'result-introduced', 'Kept', tip]],
  );
  store.close();
});

test('a saved complete analysis proving the push did not introduce the merge commit keeps the weaker link', () => {
  const store = createStore();
  store.saveRepo(repo);
  store.insertEvents([moved('reset')]);
  const weaker = { pullRequestId: 'old', targetRefName: 'refs/heads/main', relationship: 'constituent-related' };
  store.enrichEvent('reset', { mergeEvidence: { status: 'complete', introducedCommitIds: [], prs: [weaker] } });
  store.insertEvents([completedPr('old')]);
  assert.equal(store.getEvent('reset').data.mergeEvidence.prs[0].relationship, 'constituent-related');
  store.close();
});

test('starting from scratch clears activity, checkpoints, jobs and baselines but keeps repositories and settings', () => {
  const folder = mkdtempSync(join(tmpdir(), 'pulse-store-'));
  const path = join(folder, 'state.sqlite');
  const store = createStore(path);
  store.saveRepo(repo);
  store.saveRepo({ ...repo, id: 'two', name: 'Two', disabled: true });
  const moved = { name: 'refs/heads/main', oldObjectId: 'a'.repeat(40), newObjectId: 'b'.repeat(40) };
  const pushes = Array.from({ length: 300 }, (_, i) =>
    event(`push-${i}`, { data: { pushId: i + 1, refUpdates: [moved] }, summary: 'x'.repeat(2000) }),
  );
  store.commitPage({
    repoId: 'one',
    stream: 'pushes',
    state: { repoId: 'one', stream: 'pushes', initialized: true, nextAt: '2026-11-19T00:00:00Z' },
    events: pushes,
    entities: [{ type: 'push', id: '1', data: { date: '2026-11-17T10:00:00Z' } }],
    jobs: [{ id: 'rewrite:one', type: 'rewrite', repoId: 'one', eventId: 'push-0' }],
  });
  store.saveJob({ id: 'backfill:one', type: 'backfill', repoId: 'one', status: 'pending' });
  store.enrichEvent('push-0', { mergeEvidence: { status: 'complete' } });
  for (const [key, value] of [
    ['baseline:one', '2026-11-01T00:00:00.000Z'],
    ['baseline:two', '2026-11-01T00:00:00.000Z'],
    ['checkout:one', { head: 'abc' }],
    ['checkout-followup:one', { source: 'refs/heads/feature' }],
    ['refreshEnabled', false],
    ['refreshResumedAt', 123],
  ])
    store.setSetting(key, value);
  const revision = Number(store.activityRevision());
  const before = statSync(path).size;

  store.resetActivity();

  const db = new DatabaseSync(path, { readOnly: true });
  const count = table => db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n;
  assert.deepEqual(
    Object.fromEntries(['events', 'activity_members', 'enrichment', 'push_tips', 'entities', 'streams', 'jobs'].map(t => [t, count(t)])),
    { events: 0, activity_members: 0, enrichment: 0, push_tips: 0, entities: 0, streams: 0, jobs: 0 },
  );
  assert.deepEqual(
    store.listRepos().map(item => [item.id, item.disabled]),
    [
      ['one', false],
      ['two', true],
    ],
  );
  assert.deepEqual(
    db
      .prepare('SELECT key FROM settings ORDER BY key')
      .all()
      .map(row => row.key),
    ['activityRevision', 'checkout-followup:one', 'checkout:one', 'refreshEnabled', 'refreshResumedAt'],
  );
  assert.equal(Number(store.activityRevision()), revision + 1, 'the page reloads its activity');
  assert.ok(statSync(path).size < before / 4, `compacted from ${before} to ${statSync(path).size} bytes`);
  db.close();
  store.close();
  rmSync(folder, { recursive: true });
});

test('a reset whose compaction fails still clears the data and compacts on the next start', () => {
  const folder = mkdtempSync(join(tmpdir(), 'pulse-store-'));
  const path = join(folder, 'state.sqlite');
  let store = createStore(path);
  store.saveRepo(repo);
  store.insertEvents([event('one')]);
  const exec = DatabaseSync.prototype.exec;
  DatabaseSync.prototype.exec = function (sql) {
    if (sql === 'VACUUM') throw new Error('database or disk is full');
    return exec.call(this, sql);
  };
  try {
    assert.doesNotThrow(() => store.resetActivity());
  } finally {
    DatabaseSync.prototype.exec = exec;
  }
  assert.deepEqual(store.listEvents(), []);
  assert.equal(store.getSetting('compactPending'), true);
  store.close();
  store = createStore(path);
  assert.equal(store.getSetting('compactPending'), undefined);
  store.close();
  rmSync(folder, { recursive: true });
});

test('upgrading hides saved service pushes that name no branch, and keeps the same push by a person', () => {
  const folder = mkdtempSync(join(tmpdir(), 'pulse-store-'));
  const path = join(folder, 'state.sqlite');
  const service = 'Microsoft.VisualStudio.Services.TFS';
  let store = createStore(path);
  store.saveRepo(repo);
  store.insertEvents([
    event('preview', { actor: service, branch: '', data: { pushId: 1, refUpdates: [] } }),
    event('person', { actor: 'Ada', branch: '', data: { pushId: 2, refUpdates: [] } }),
    event('service-branch', { actor: service, branch: 'main', data: { pushId: 3, refUpdates: [{ name: 'refs/heads/main' }] } }),
  ]);
  const shown = () => {
    const page = store.queryActivity({ view: 'new' });
    return { ids: page.items.map(item => item.id).sort(), total: page.total, newItems: page.newItems, pushes: page.counts.push };
  };
  assert.equal(shown().total, 3);
  store.close();
  const raw = new DatabaseSync(path);
  raw.exec('PRAGMA user_version = 13;');
  raw.close();
  store = createStore(path);
  assert.deepEqual(shown(), { ids: ['person', 'service-branch'], total: 2, newItems: 2, pushes: 2 });
  assert.deepEqual(
    store
      .queryActivity({ view: 'all' })
      .items.map(item => item.id)
      .sort(),
    ['person', 'service-branch'],
  );
  store.close();
  rmSync(folder, { recursive: true });
});

test('upgrading queues a fork check once for each stored branch creation a sync recorded', () => {
  const folder = mkdtempSync(join(tmpdir(), 'pulse-store-'));
  const path = join(folder, 'state.sqlite');
  const tip = 'c'.repeat(40);
  const created = (id, extra = {}, data = {}) =>
    event(id, {
      kind: 'branch-created',
      time: '2026-11-16T10:00:00Z',
      ...extra,
      data: { evidence: 'push', name: `refs/heads/${id}`, oldObjectId: '0'.repeat(40), newObjectId: tip, pushId: 7, ...data },
    });
  let store = createStore(path);
  store.saveRepo(repo);
  store.setSetting('baseline:one', '2026-11-17T10:00:00.000Z');
  store.insertEvents([
    created('live'),
    created('checked'),
    created('in-window', { imported: true, time: '2026-11-10T10:00:01Z' }),
    created('before-window', { imported: true, time: '2026-11-10T09:59:59Z' }),
    created('snapshot', {}, { evidence: 'snapshot', newObjectId: undefined, objectId: tip }),
    created('no-tip', {}, { newObjectId: 'not-a-sha' }),
  ]);
  store.enrichEvent('checked', { forkOrigin: { status: 'orphan' } });
  store.close();
  const raw = new DatabaseSync(path);
  raw.exec('PRAGMA user_version = 14;');
  raw.close();
  store = createStore(path);
  const queued = () =>
    store
      .listJobs({ type: 'fork' })
      .map(job => job.eventId)
      .sort();
  assert.deepEqual(queued(), ['in-window', 'live']);
  const [job] = store.listJobs({ type: 'fork' }).filter(item => item.eventId === 'live');
  assert.deepEqual(
    { ref: job.ref, pushId: job.pushId, at: job.at, reads: job.reads, attempts: job.attempts },
    { ref: 'refs/heads/live', pushId: 7, at: tip, reads: 0, attempts: 0 },
  );
  store.close();
  store = createStore(path);
  assert.deepEqual(queued(), ['in-window', 'live'], 'reopening queues nothing more');
  store.close();
  rmSync(folder, { recursive: true });
});
