import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createStore, type Store } from '../server/store.ts';
import type { StoredEvent } from '../src/contract.ts';

const repo = {
  id: 'one',
  name: 'One',
  azureId: 'a',
  organization: 'https://dev.azure.com/org',
  project: 'P',
  webUrl: 'https://dev.azure.com/org/P/_git/One',
};
const stream = { repoId: 'one', stream: 'pushes', initialized: true, nextAt: '2026-11-19T00:00:00Z' };
const event: StoredEvent = { id: 'push-1', repoId: 'one', kind: 'push', time: '2026-11-17T10:00:00Z', observedAt: '2026-11-17T10:00:00Z' };
const rewrite = {
  id: 'rewrite:one',
  type: 'rewrite',
  repoId: 'one',
  eventId: 'push-1',
  ref: 'refs/heads/main',
  oldObjectId: 'a'.repeat(40),
  newObjectId: 'b'.repeat(40),
  attempts: 0,
  nextAt: '2026-11-17T10:00:00Z',
};

/** A database holding one valid row per table, with `plant` run on it before the store opens it again. */
function withRows(t: import('node:test').TestContext, plant: (db: DatabaseSync) => void): Store {
  const folder = mkdtempSync(join(tmpdir(), 'pulse-corrupt-'));
  let store: Store | undefined;
  // Close before removing: Windows cannot delete a database file that is still open, and hooks run in order.
  t.after(() => {
    store?.close();
    rmSync(folder, { recursive: true });
  });
  const path = join(folder, 'state.sqlite');
  const seeded = createStore(path);
  seeded.saveRepo(repo);
  seeded.insertEvents([event]);
  seeded.close();
  const db = new DatabaseSync(path);
  db.prepare('INSERT INTO streams(repo_id,stream,data) VALUES(?,?,?)').run('one', 'pushes', JSON.stringify(stream));
  db.prepare('INSERT INTO jobs(id,repo_id,type,next_at,data) VALUES(?,?,?,?,?)').run(
    rewrite.id,
    'one',
    'rewrite',
    rewrite.nextAt,
    JSON.stringify(rewrite),
  );
  plant(db);
  db.close();
  store = createStore(path);
  return store;
}

const corrupt = (table: string, id: string, field: string, reason = 'is missing or malformed') => ({
  code: 'CORRUPT_ROW',
  table,
  id,
  field,
  message: `The stored ${table} row "${id}" cannot be read: ${field} ${reason}.`,
});

const cases: { name: string; plant: (db: DatabaseSync) => void; read: (store: Store) => unknown; error: object }[] = [
  {
    name: 'a repository without a name',
    plant: db => db.prepare('UPDATE repositories SET data=? WHERE id=?').run(JSON.stringify({ ...repo, name: 7 }), 'one'),
    read: store => store.listRepos(),
    error: corrupt('repositories', 'one', 'name'),
  },
  {
    // The JSON indexes on events refuse text that is not JSON, so a stream row stands in for any table without one.
    name: 'a stream whose data is not JSON',
    plant: db => db.prepare('UPDATE streams SET data=?').run('{"repoId":'),
    read: store => store.getStreams(),
    error: corrupt('streams', 'one/pushes', 'data', 'is not valid JSON'),
  },
  {
    name: 'an event of an unknown kind',
    plant: db => db.prepare('UPDATE events SET data=? WHERE id=?').run(JSON.stringify({ ...event, kind: 'commit' }), 'push-1'),
    read: store => store.getEvent('push-1'),
    error: corrupt('events', 'push-1', 'kind'),
  },
  {
    name: 'enrichment that is not an object',
    plant: db => db.prepare('INSERT INTO enrichment(event_id,data) VALUES(?,?)').run('push-1', '[]'),
    read: store => store.getEvent('push-1'),
    error: corrupt('enrichment', 'push-1', 'data'),
  },
  {
    name: 'a stream without its initialized flag',
    plant: db => db.prepare('UPDATE streams SET data=?').run(JSON.stringify({ ...stream, initialized: undefined })),
    read: store => store.getStreams(),
    error: corrupt('streams', 'one/pushes', 'initialized'),
  },
  {
    name: 'a ref whose last push is not a number',
    plant: db =>
      db
        .prepare('INSERT INTO entities(repo_id,type,id,data) VALUES(?,?,?,?)')
        .run('one', 'ref', 'refs/heads/main', JSON.stringify({ name: 'refs/heads/main', active: true, lastPushId: 'x' })),
    read: store => store.listEntities('one', 'ref'),
    error: corrupt('entities', 'one/ref/refs/heads/main', 'lastPushId'),
  },
  {
    name: 'a PR snapshot whose revision is not a number',
    plant: db =>
      db
        .prepare('INSERT INTO entities(repo_id,type,id,data) VALUES(?,?,?,?)')
        .run('one', 'pr', '7', JSON.stringify({ fingerprint: { status: 'active' }, status: 'active', revision: '1' })),
    read: store => store.getEntity('one', 'pr', '7'),
    error: corrupt('entities', 'one/pr/7', 'revision'),
  },
  {
    name: 'a rewrite job without its ref',
    plant: db => db.prepare('UPDATE jobs SET data=? WHERE id=?').run(JSON.stringify({ ...rewrite, ref: undefined }), rewrite.id),
    read: store => store.listJobs({ type: 'rewrite' }),
    error: corrupt('jobs', 'rewrite:one', 'ref'),
  },
  {
    name: 'an event with a conflicting JSON ID',
    plant: db => db.prepare('UPDATE events SET data=? WHERE id=?').run(JSON.stringify({ ...event, id: 'other' }), 'push-1'),
    read: store => store.queryActivity({ people: 'Alice' }),
    error: corrupt('events', 'push-1', 'id', 'does not match its column'),
  },
  {
    name: 'an empty enrichment column',
    plant: db => db.prepare('INSERT INTO enrichment(event_id,data) VALUES(?,?)').run('push-1', ''),
    read: store => store.getEvent('push-1'),
    error: corrupt('enrichment', 'push-1', 'data', 'is not valid JSON'),
  },
  {
    name: 'a job whose data is not JSON when filtering by status',
    plant: db => db.prepare('UPDATE jobs SET data=? WHERE id=?').run('{', rewrite.id),
    read: store => store.listJobs({ type: 'rewrite', status: 'pending' }),
    error: corrupt('jobs', 'rewrite:one', 'data', 'is not valid JSON'),
  },
  {
    name: 'a job table row with an unknown type',
    plant: db => db.prepare('UPDATE jobs SET type=? WHERE id=?').run('unrecognized', rewrite.id),
    read: store => store.listJobs(),
    error: corrupt('jobs', 'rewrite:one', 'type'),
  },
  {
    name: 'an invalid activity revision counter',
    plant: db => db.prepare('UPDATE settings SET data=? WHERE key=?').run('"one"', 'activityRevision'),
    read: store => store.activityRevision(),
    error: corrupt('settings', 'activityRevision', 'data'),
  },
  {
    name: 'a setting of the wrong type',
    plant: db => db.prepare('INSERT INTO settings(key,data) VALUES(?,?)').run('refreshEnabled', '"yes"'),
    read: store => store.getSetting('refreshEnabled', true),
    error: corrupt('settings', 'refreshEnabled', 'data'),
  },
  {
    name: 'a checkout observation without its identity',
    plant: db => db.prepare('INSERT INTO settings(key,data) VALUES(?,?)').run('checkout:one:x', '{"tracking":"main"}'),
    read: store => store.getCheckoutObservation('one', 'x'),
    error: corrupt('settings', 'checkout:one:x', 'identity'),
  },
  {
    name: 'saved activity filters with a malformed nested selection',
    plant: db =>
      db
        .prepare('INSERT INTO settings(key,data) VALUES(?,?)')
        .run(
          'savedActivityFilters',
          JSON.stringify([{ id: 'one', name: 'One', filters: { search: '', people: '', kind: '', view: 'all', repoIds: [1] } }]),
        ),
    read: store => store.getSetting('savedActivityFilters'),
    error: corrupt('settings', 'savedActivityFilters', 'filters.repoIds'),
  },
  {
    name: 'a checkout followup without its source head',
    plant: db =>
      db
        .prepare('INSERT INTO settings(key,data) VALUES(?,?)')
        .run(
          'checkout-followup:one',
          JSON.stringify({ id: 'plan', path: '/checkout', source: 'feature', targetRef: 'refs/heads/main', result: 'b' }),
        ),
    read: store => store.getCheckoutFollowup('one'),
    error: corrupt('settings', 'checkout-followup:one', 'sourceHead'),
  },
];

for (const { name, plant, read, error } of cases)
  test(`${name} is reported by table and row`, t => {
    const store = withRows(t, plant);
    assert.throws(() => read(store), error);
  });

test('valid rows and absent rows keep their values and fallbacks', t => {
  const store = withRows(t, () => {});
  assert.deepEqual(store.getStreams(), [stream]);
  assert.deepEqual(store.listJobs({ type: 'rewrite' }), [rewrite]);
  assert.deepEqual(store.listJobs(), [rewrite]);
  assert.equal(store.getEvent('push-1')?.id, 'push-1');
  assert.equal(store.getEvent('absent'), undefined);
  assert.equal(store.getSetting('refreshEnabled', false), false);
});

test('SQLite reads retain older provider values and checkpoint shapes', t => {
  const refs = {
    repoId: 'one',
    stream: 'refs',
    initialized: true,
    nextAt: stream.nextAt,
    cursor: { token: 'next' },
    pendingItems: [{ name: 'refs/heads/main', objectId: 'a' }, { name: 'refs/heads/bad', objectId: null }, null],
  };
  const legacyPr = { fingerprint: { title: ['Raw title'], votes: [['reviewer', null]] }, revision: 1, status: null };
  const earlierPr = { fingerprint: { title: 'Before vote tracking' }, revision: 2 };
  const legacyRef = { name: 'refs/heads/main', active: true, objectId: null, lastPushId: null };
  const legacyEvent = { ...event, time: 2026, actor: { displayName: 'First author' }, data: { oldField: 'kept' } };
  const overlay = {
    mergeEvidence: { status: 'complete', prs: [{ id: 7, closedBy: { displayName: 'Author' } }], refRanges: [] },
  };
  const legacyRepo = { ...repo, disabled: false, projectId: null };
  const store = withRows(t, db => {
    db.prepare('UPDATE repositories SET data=? WHERE id=?').run(JSON.stringify(legacyRepo), repo.id);
    db.prepare('INSERT INTO streams(repo_id,stream,data) VALUES(?,?,?)').run('one', 'refs', JSON.stringify(refs));
    const entity = db.prepare('INSERT INTO entities(repo_id,type,id,data) VALUES(?,?,?,?)');
    entity.run('one', 'pr', '7', JSON.stringify(legacyPr));
    entity.run('one', 'pr', '8', JSON.stringify(earlierPr));
    entity.run('one', 'ref', 'refs/heads/main', JSON.stringify(legacyRef));
    entity.run('one', 'ref-baseline', 'tags', JSON.stringify({ at: stream.nextAt }));
    db.prepare('UPDATE events SET data=? WHERE id=?').run(JSON.stringify(legacyEvent), event.id);
    db.prepare('INSERT INTO enrichment(event_id,data) VALUES(?,?)').run(event.id, JSON.stringify(overlay));
  });
  assert.deepEqual(
    store.getStreams().find(state => state.stream === 'refs'),
    refs,
  );
  assert.deepEqual(store.getEntity('one', 'pr', 7), legacyPr);
  assert.deepEqual(store.getEntity('one', 'pr', 8), earlierPr);
  assert.deepEqual(store.getEntity('one', 'ref', 'refs/heads/main'), legacyRef);
  assert.deepEqual(store.getEntity('one', 'ref-baseline', 'tags'), { at: stream.nextAt });
  assert.deepEqual(store.getEvent(event.id), { ...legacyEvent, seen: false, imported: false, data: { ...legacyEvent.data, ...overlay } });
});

test('SQLite reads retain checkout settings saved before per-identity keys', t => {
  const observation = {
    identity: 'checkout-identity',
    missing: { head: 'a'.repeat(40), advice: { branch: 'main', id: 7, verified: false, strategy: null } },
  };
  const followup = {
    id: 'plan',
    path: '/checkout',
    source: 'feature',
    sourceHead: 'a'.repeat(40),
    targetRef: 'refs/heads/main',
    result: 'b'.repeat(40),
  };
  const store = withRows(t, db => {
    const setting = db.prepare('INSERT INTO settings(key,data) VALUES(?,?)');
    setting.run('checkout:one', JSON.stringify(observation));
    setting.run('checkout-followup:one', JSON.stringify(followup));
  });
  assert.deepEqual(store.getCheckoutObservation('one', 'checkout-identity'), observation);
  assert.deepEqual(store.getCheckoutFollowup('one'), followup);
});
