import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore, type Store } from '../server/store.ts';
import { copyBeforeUpgrade } from '../server/store-migrations.ts';
import { SEARCH_INDEX_VERSION } from '../src/activity-text.ts';
import { DatabaseSync } from 'node:sqlite';
import { spawn } from 'node:child_process';
import type { ActivityEvent, EventData } from '../src/activity.ts';
import type { StreamState } from '../src/contract.ts';
import { dataOf, fieldsOf, present } from './fixtures/typed.ts';
import { historyJob, rewriteJob } from './fixtures/jobs.ts';

const repo = {
  id: 'one',
  name: 'One',
  azureId: 'a',
  organization: 'https://dev.azure.com/org',
  project: 'P',
  webUrl: 'https://dev.azure.com/org/P/_git/One',
};
const event = (id: string, extra: Partial<ActivityEvent> = {}): ActivityEvent => ({
  id,
  repoId: 'one',
  kind: 'push',
  title: id,
  time: '2026-11-17T10:00:00Z',
  ...extra,
});

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
  assert.equal(store.listEvents().find(e => e.id === 'history')?.seen, true);
  store.acknowledge(['shown'], false);
  assert.equal(store.listEvents({ unseen: true }).length, 3);
  // Windows reports no POSIX permission bits.
  if (process.platform !== 'win32') assert.equal(statSync(path).mode & 0o777, 0o600);
  store.close();
  rmSync(folder, { recursive: true });
});

test('page transaction rolls back events and checkpoint together', () => {
  const store = createStore();
  store.saveRepo(repo);
  const state: StreamState = { repoId: 'one', stream: 'pushes', initialized: false, nextAt: '2026-11-19T00:00:00Z', cursor: { skip: 2 } };
  assert.throws(() =>
    store.commitPage({
      repoId: 'one',
      stream: 'pushes',
      state,
      events: [event('good'), event('bad', { repoId: 'missing' })],
    }),
  );
  assert.equal(store.listEvents().length, 0);
  assert.equal(store.getStreams().length, 0);
  store.commitPage({ repoId: 'one', stream: 'pushes', state, events: [event('good')] });
  assert.deepEqual(present(store.getStreams()[0]).cursor, { skip: 2 });
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
const moved = (id: string, repoId = 'one', name = 'refs/heads/main', newObjectId = tip) =>
  event(id, { repoId, data: { pushId: id, refUpdates: [{ name, oldObjectId: 'e'.repeat(40), newObjectId }] } });
const completedPr = (id: string, extra: Partial<ActivityEvent> = {}): ActivityEvent => ({
  id,
  repoId: 'one',
  kind: 'pr',
  title: `PR ${id}`,
  time: '2026-11-17T11:00:00Z',
  ...extra,
  data: { pullRequestId: id, status: 'completed', targetRefName: 'refs/heads/main', mergeCommit: tip, ...extra.data },
});
const linked = (store: Store, id: string) => (dataOf(store.getEvent(id)).mergeEvidence?.prs || []).map(pr => pr.pullRequestId);

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
  assert.equal(dataOf(store.getEvent('push')).mergeEvidence, undefined, 'no evidence is claimed from an absent match');
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
    dataOf(store.getEvent('push')).mergeEvidence?.prs?.map(pr => [pr.pullRequestId, pr.relationship, fieldsOf(pr).title, pr.mergeCommit]),
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
  assert.equal(present(dataOf(store.getEvent('reset')).mergeEvidence?.prs?.[0]).relationship, 'constituent-related');
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
    jobs: [rewriteJob('one', 'push-0')],
  });
  store.saveJob(historyJob('one'));
  store.enrichEvent('push-0', { mergeEvidence: { status: 'complete' } });
  store.setSetting('baseline:one', '2026-11-01T00:00:00.000Z');
  store.setSetting('baseline:two', '2026-11-01T00:00:00.000Z');
  store.setSetting('checkout:one', { identity: 'abc' });
  store.setSetting('checkout-followup:one', {
    id: 'plan',
    source: 'refs/heads/feature',
    path: '/checkout',
    sourceHead: 'a'.repeat(40),
    targetRef: 'refs/heads/main',
    result: 'b'.repeat(40),
  });
  store.setSetting('refreshEnabled', false);
  store.setSetting('refreshResumedAt', 123);
  const revision = Number(store.activityRevision());
  const diskSize = () => statSync(path).size + (existsSync(`${path}-wal`) ? statSync(`${path}-wal`).size : 0);
  const before = diskSize();

  store.resetActivity();

  const db = new DatabaseSync(path, { readOnly: true });
  const count = (table: string) => present(db.prepare(`SELECT count(*) AS n FROM ${table}`).get()).n;
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
    ['activityRevision', 'checkout-followup:one', 'checkout:one', 'refreshEnabled', 'refreshResumedAt', 'searchIndexVersion'],
  );
  assert.equal(Number(store.activityRevision()), revision + 1, 'the page reloads its activity');
  assert.ok(diskSize() < before / 4, `compacted from ${before} to ${diskSize()} bytes`);
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
  // The wrapper below calls the original with its database receiver.
  // oxlint-disable-next-line typescript/unbound-method
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
    return { ids: page.items.map(item => item.id).sort(), total: page.total, newItems: page.newItems, pushes: page.counts?.push };
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

test('upgrading copies the database first and keeps only the latest copy; a fresh or current database gets none', () => {
  const folder = mkdtempSync(join(tmpdir(), 'pulse-store-'));
  const path = join(folder, 'state.sqlite');
  const service = 'Microsoft.VisualStudio.Services.TFS';
  const copies = () => readdirSync(folder).filter(name => name.includes('.pre-v'));
  let store = createStore(path);
  assert.deepEqual(copies(), [], 'a new database is not copied');
  store.saveRepo(repo);
  store.insertEvents([event('preview', { actor: service, branch: '', data: { pushId: 1, refUpdates: [] } })]);
  store.close();
  createStore(path).close();
  assert.deepEqual(copies(), [], 'a current database is not copied');
  const downgrade = (version: number) => {
    const raw = new DatabaseSync(path);
    raw.exec(`PRAGMA user_version = ${version};`);
    raw.close();
  };
  downgrade(12);
  createStore(path).close();
  assert.deepEqual(copies(), ['state.sqlite.pre-v12']);
  // Migration 13 left the row; 14 is the step that deletes it.
  const db = new DatabaseSync(path);
  db.exec("INSERT INTO activity_members(event_id,group_key,kind,search_text,observed,time) VALUES('preview','g','push','',0,0)");
  db.exec('PRAGMA user_version = 13;');
  db.close();
  store = createStore(path);
  assert.equal(store.queryActivity({ view: 'all' }).total, 0, 'migration 14 removed the row');
  store.close();
  assert.deepEqual(copies(), ['state.sqlite.pre-v13'], 'only the latest copy stays');
  const copy = new DatabaseSync(join(folder, 'state.sqlite.pre-v13'), { readOnly: true });
  assert.equal(present(copy.prepare('PRAGMA user_version').get()).user_version, 13);
  assert.equal(present(copy.prepare("SELECT COUNT(*) AS n FROM activity_members WHERE event_id='preview'").get()).n, 1);
  copy.close();
  // A file someone named after a copy is not one of ours.
  writeFileSync(join(folder, 'state.sqlite.pre-v12.keep'), 'mine');
  downgrade(14);
  createStore(path).close();
  assert.deepEqual(copies().sort(), ['state.sqlite.pre-v12.keep', 'state.sqlite.pre-v14'], 'other files with the prefix stay');
  rmSync(folder, { recursive: true });
});

test('a write waits for another process that briefly holds the write lock instead of failing at once', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'pulse-store-'));
  const path = join(folder, 'state.sqlite');
  const store = createStore(path);
  // node:sqlite blocks its thread while waiting, so the lock is held and released by another process. It writes a
  // marker inside its locked transaction and commits only after it has said the lock is held.
  const holder = spawn(
    process.execPath,
    [
      '-e',
      `const { DatabaseSync } = require('node:sqlite');
       const db = new DatabaseSync(process.argv[1]);
       db.exec('BEGIN IMMEDIATE');
       db.exec("INSERT INTO settings(key,data) VALUES('demoSeeded','true')");
       process.stdout.write('locked');
       setTimeout(() => { db.exec('COMMIT'); db.close(); }, 300);`,
      path,
    ],
    { stdio: ['ignore', 'pipe', 'inherit'] },
  );
  const exited = new Promise((resolve, reject) => {
    holder.once('error', reject);
    holder.once('exit', code => (code === 0 ? resolve(undefined) : reject(new Error(`lock holder exited with ${code}`))));
  });
  await Promise.race([
    new Promise(resolve => holder.stdout.once('data', resolve)),
    exited.then(() => {
      throw new Error('lock holder exited before taking the lock');
    }),
  ]);
  // The lock is held now; without a busy timeout this throws "database is locked".
  store.setSetting('refreshEnabled', false);
  assert.equal(store.getSetting('demoSeeded', false), true, 'the write returned only after the holder committed');
  assert.equal(store.getSetting('refreshEnabled', true), false);
  await exited;
  store.close();
  rmSync(folder, { recursive: true });
});

test('rows indexed under older search terms are rebuilt once when the search index version changes', () => {
  const folder = mkdtempSync(join(tmpdir(), 'pulse-store-'));
  const path = join(folder, 'state.sqlite');
  let store = createStore(path);
  assert.equal(store.getSetting('searchIndexVersion', null), SEARCH_INDEX_VERSION, 'a new database records the current version');
  store.saveRepo(repo);
  store.insertEvents([event('row', { title: 'Nightly deploy' })]);
  store.close();
  const stale = (version: number) => {
    const raw = new DatabaseSync(path);
    raw.exec("UPDATE activity_members SET search_text='old terms'");
    raw.prepare("UPDATE settings SET data=? WHERE key='searchIndexVersion'").run(JSON.stringify(version));
    raw.close();
  };
  stale(SEARCH_INDEX_VERSION);
  store = createStore(path);
  assert.equal(store.queryActivity({ search: 'Nightly' }).total, 0, 'an unchanged version does not reindex');
  store.close();
  stale(SEARCH_INDEX_VERSION - 1);
  store = createStore(path);
  assert.equal(store.queryActivity({ search: 'Nightly' }).total, 1, 'the old row matches the current terms');
  assert.equal(store.getSetting('searchIndexVersion', null), SEARCH_INDEX_VERSION);
  store.close();
  rmSync(folder, { recursive: true });
});

test('an opener whose database another opener already upgraded keeps the copy that one made', () => {
  const folder = mkdtempSync(join(tmpdir(), 'pulse-store-'));
  const path = join(folder, 'state.sqlite');
  const copy = `${path}.pre-v14`;
  createStore(path).close();
  // Another opener copied the v14 file and then upgraded it to v15 after this opener read version 14.
  writeFileSync(copy, 'the copy the other opener made');
  const db = new DatabaseSync(path);
  copyBeforeUpgrade(db, path, 14);
  assert.equal(readFileSync(copy, 'utf8'), 'the copy the other opener made', 'a v15 database is not saved as pre-v14');
  assert.deepEqual(
    readdirSync(folder).filter(name => name.includes('.tmp-')),
    [],
    'no temporary copy is left',
  );
  // At the version it read, the copy is replaced.
  db.exec('PRAGMA user_version = 14');
  copyBeforeUpgrade(db, path, 14);
  db.close();
  const check = new DatabaseSync(copy, { readOnly: true });
  assert.equal(present(check.prepare('PRAGMA user_version').get()).user_version, 14);
  check.close();
  rmSync(folder, { recursive: true });
});

test('a database that cannot be copied before upgrading is not upgraded', () => {
  const folder = mkdtempSync(join(tmpdir(), 'pulse-store-'));
  const path = join(folder, 'state.sqlite');
  createStore(path).close();
  const raw = new DatabaseSync(path);
  raw.exec('PRAGMA user_version = 13;');
  raw.close();
  // A directory where the copy belongs makes VACUUM INTO fail, as a full disk would.
  mkdirSync(`${path}.pre-v13`);
  writeFileSync(join(`${path}.pre-v13`, 'keep'), '');
  assert.throws(() => createStore(path), /copy/i);
  const check = new DatabaseSync(path, { readOnly: true });
  assert.equal(present(check.prepare('PRAGMA user_version').get()).user_version, 13, 'the database is left as it was');
  check.close();
  rmSync(folder, { recursive: true });
});

test('upgrading queues a fork check once for each stored branch creation a sync recorded', () => {
  const folder = mkdtempSync(join(tmpdir(), 'pulse-store-'));
  const path = join(folder, 'state.sqlite');
  const tip = 'c'.repeat(40);
  const created = (id: string, extra: Partial<ActivityEvent> = {}, data: EventData = {}) =>
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
  const job = present(store.listJobs({ type: 'fork' }).filter(item => item.eventId === 'live')[0]);
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

test('upgrading leaves imported branch creations unchecked in a repository that ran a history import', () => {
  const folder = mkdtempSync(join(tmpdir(), 'pulse-store-'));
  const path = join(folder, 'state.sqlite');
  const created = (id: string, extra: Partial<ActivityEvent> = {}) =>
    event(id, {
      kind: 'branch-created',
      time: '2026-11-16T10:00:00Z',
      ...extra,
      data: { evidence: 'push', name: `refs/heads/${id}`, newObjectId: 'c'.repeat(40), pushId: 7 },
    });
  let store = createStore(path);
  store.saveRepo(repo);
  store.setSetting('baseline:one', '2026-11-17T10:00:00.000Z');
  store.insertEvents([
    created('live'),
    created('imported', { imported: true }),
    {
      ...created('stored-result'),
      data: { ...created('x').data, name: 'refs/heads/stored-result', forkOrigin: { status: 'orphan' } },
    },
  ]);
  store.saveJob(historyJob('one', { status: 'completed', nextAt: '2026-11-17T10:00:00.000Z' }));
  store.close();
  const raw = new DatabaseSync(path);
  raw.exec('PRAGMA user_version = 14;');
  raw.close();
  store = createStore(path);
  assert.deepEqual(
    store.listJobs({ type: 'fork' }).map(job => job.eventId),
    ['live'],
  );
  store.close();
  rmSync(folder, { recursive: true });
});

test('file-backed stores use WAL mode and index push and pull request lookups', () => {
  const folder = mkdtempSync(join(tmpdir(), 'repo-pulse-wal-'));
  const path = join(folder, 'store.sqlite');
  const store = createStore(path);
  store.saveRepo(repo);
  store.insertEvents([event('e1', { kind: 'push', data: { pushId: 1 } })]);
  const raw = new DatabaseSync(path);
  assert.equal(present(raw.prepare('PRAGMA journal_mode').get()).journal_mode, 'wal');
  const indexes = new Set(
    raw
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='events'")
      .all()
      .map(row => row.name),
  );
  for (const name of ['events_pr_source', 'events_pr_id', 'events_push_id']) {
    assert.ok(indexes.has(name), name);
  }
  raw.close();
  store.close();
  rmSync(folder, { recursive: true });
});

test('upgrading incomplete merge evidence does not persist an object as its error message', t => {
  const folder = mkdtempSync(join(tmpdir(), 'pulse-store-'));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const path = join(folder, 'state.sqlite');
  {
    const store = createStore(path);
    try {
      store.saveRepo(repo);
      store.insertEvents([event('one')]);
    } finally {
      store.close();
    }
  }
  {
    using db = new DatabaseSync(path);
    db.prepare('INSERT INTO enrichment(event_id,data) VALUES(?,?)').run(
      'one',
      JSON.stringify({ mergeEvidence: { status: 'enriching', error: { message: {} } } }),
    );
    db.exec('PRAGMA user_version = 10');
  }
  const upgraded = createStore(path);
  try {
    assert.equal(upgraded.getEvent('one')?.data?.mergeEvidence?.status, 'incomplete');
    assert.deepEqual(upgraded.getEvent('one')?.data?.mergeEvidence?.error, { message: '' });
  } finally {
    upgraded.close();
  }
});

test('Activity resolves CI across pages and keeps failures and filtered runs visible', t => {
  const store = createStore();
  t.after(() => store.close());
  store.saveRepo(repo);
  const main = 'refs/heads/main';
  const sha = 'a'.repeat(40);
  const stamp = (minute: number) => `2026-11-17T10:${String(minute).padStart(2, '0')}:00Z`;
  const run = (id: string, minute: number, sourceBranch: string, result: string, reason = 'individualCI') =>
    event(id, {
      kind: 'build',
      time: stamp(minute),
      data: { buildId: minute, status: 'completed', result, reason, sourceBranch, sourceVersion: sha },
    });
  store.insertEvents([
    event('push-main', { data: { refUpdates: [{ name: main, oldObjectId: 'b'.repeat(40), newObjectId: sha }] } }),
    event('pr-open', {
      kind: 'pr',
      time: stamp(1),
      data: { pullRequestId: 42, status: 'active', previewCommit: sha, reviewers: [{ name: 'Jo', vote: 0 }] },
    }),
    event('merge', {
      kind: 'pr',
      seen: true,
      time: stamp(3),
      data: { pullRequestId: 42, status: 'completed', targetRefName: main, mergeCommit: sha, reviewers: [{ name: 'Jo', vote: 10 }] },
    }),
    { ...run('preview', 2, 'refs/pull/42/merge', 'succeeded', 'pullRequest'), seen: true },
    { ...run('passing', 4, main, 'succeeded'), seen: true },
    run('unread-pass', 8, main, 'succeeded'),
    run('legacy-preview', 9, 'refs/pull/43/merge', 'succeeded', 'pullRequest'),
    event('other-pr', { kind: 'pr', time: stamp(2), data: { pullRequestId: 43, status: 'active' } }),
    event('new-pr-preview', { kind: 'pr', time: stamp(2), data: { pullRequestId: 42, status: 'active', previewCommit: 'd'.repeat(40) } }),
    run('wrong-ref', 5, 'refs/heads/other', 'succeeded'),
    run('scheduled', 6, main, 'succeeded', 'schedule'),
    run('failed', 7, main, 'failed'),
  ]);
  const first = store.queryActivity({ limit: 1 });
  assert.equal(first.items[0]?.id, 'legacy-preview');
  const all = [...first.items];
  let cursor = first.nextCursor;
  while (cursor) {
    const page = store.queryActivity({ limit: 1, cursor });
    all.push(...page.items);
    cursor = page.nextCursor;
  }
  assert.deepEqual(
    all.map(item => item.id),
    ['legacy-preview', 'unread-pass', 'failed', 'scheduled', 'wrong-ref', 'merge', 'other-pr', 'new-pr-preview', 'pr-open', 'push-main'],
  );
  assert.deepEqual(
    all.find(item => item.id === 'merge')?.relatedCi?.map(run => [run.id, run.outcome, run.postMerge, new Date(run.time).toISOString()]),
    [
      ['unread-pass', 'passed', true, new Date(stamp(8)).toISOString()],
      ['failed', 'failed', true, new Date(stamp(7)).toISOString()],
      ['passing', 'passed', true, new Date(stamp(4)).toISOString()],
    ],
  );
  assert.deepEqual(
    all.find(item => item.id === 'merge')?.ciSummary?.results.map(result => [result.run.id, result.tone]),
    [['failed', 'crit']],
  );
  assert.ok(all.find(item => item.id === 'merge')?.eventIds.includes('passing'));
  assert.deepEqual(all.find(item => item.id === 'merge')?.unseenIds, []);
  assert.equal(all.find(item => item.id === 'failed')?.ciHost, 'merge');
  assert.equal(all.find(item => item.id === 'other-pr')?.relatedCi, undefined);
  assert.equal(all.find(item => item.id === 'new-pr-preview')?.relatedCi, undefined);
  assert.equal(all.find(item => item.id === 'merge')?.latestPrMilestone, true);
  assert.equal(all.find(item => item.id === 'pr-open')?.latestPrMilestone, false);
  assert.equal(all.find(item => item.id === 'pr-open')?.relatedCi?.[0]?.validation, true);
  assert.deepEqual(
    store.queryActivity({ kind: 'build' }).items.map(item => item.id),
    ['legacy-preview', 'unread-pass', 'failed', 'scheduled', 'wrong-ref', 'passing', 'preview'],
  );
  assert.equal(store.queryActivity({ search: 'passing' }).items[0]?.id, 'passing');
  store.acknowledge(['passing'], false);
  assert.throws(() => store.queryActivity({ limit: 1, cursor: present(first.nextCursor) }), { code: 'ACTIVITY_CHANGED' });
  assert.ok(store.queryActivity().items.some(item => item.id === 'passing'));

  const retry = run('retry', 10, main, '');
  store.insertEvents([{ ...retry, data: { ...retry.data, status: 'inProgress' } }]);
  const withRetry = store.queryActivity().items;
  const merge = withRetry.find(item => item.id === 'merge');
  assert.deepEqual(
    merge?.ciSummary?.results.map(result => [result.run.id, result.run.outcome]),
    [
      ['failed', 'failed'],
      ['retry', 'running'],
    ],
  );
  assert.equal(merge?.foldedCi, undefined);
  assert.deepEqual(merge?.eventIds, ['merge']);
  assert.equal(withRetry.find(item => item.id === 'retry')?.ciHost, undefined);
});

test('related CI keeps legacy numeric run times and orders them with ISO timestamps', t => {
  const store = createStore();
  t.after(() => store.close());
  store.saveRepo(repo);
  const main = 'refs/heads/main';
  const sha = 'a'.repeat(40);
  const day = '2026-11-17T';
  const legacyMillis = Date.parse(`${day}11:30:00Z`);
  const run = (id: number, time: string | number) =>
    event(`run-${id}`, {
      kind: 'build',
      time,
      data: { buildId: id, status: 'completed', result: 'succeeded', reason: 'individualCI', sourceBranch: main, sourceVersion: sha },
    });
  store.insertEvents([
    event('merge', {
      kind: 'pr',
      data: { status: 'completed', pullRequestId: 42, mergeCommit: sha, targetRefName: main },
    }),
    run(1, `${day}11:00:00Z`),
    run(2, legacyMillis),
    run(3, `${day}12:00:00Z`),
  ]);
  const merge = store.queryActivity().items.find(item => item.id === 'merge');
  assert.deepEqual(
    merge?.relatedCi?.map(({ time }) => time),
    [`${day}12:00:00Z`, legacyMillis, `${day}11:00:00Z`],
  );
});
