import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from '../server/store.js';
import { renderMergeEvidence, mergeEvidenceBadge } from '../src/ui/merge-evidence.js';

const repo = { id: 'repo', name: 'Repo', azureId: 'a' };
const event = (id, extra = {}) => ({
  id,
  repoId: repo.id,
  kind: 'push',
  title: id,
  summary: '',
  branch: 'main',
  time: '2026-11-17T10:00:00Z',
  observedAt: '2026-11-17T10:00:00Z',
  ...extra,
});
const build = (id, status, extra = {}) => event(id, { kind: 'build', title: status, data: { buildId: 42, status }, ...extra });
const setup = () => {
  const store = createStore();
  store.saveRepo(repo);
  return store;
};

test('v1 migration preserves raw events and acknowledgement and queues no merge work', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pulse-migration-')),
    path = join(dir, 'v1.sqlite');
  const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE repositories(id TEXT PRIMARY KEY,data TEXT NOT NULL);
    CREATE TABLE events(id TEXT PRIMARY KEY,repo_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
      time TEXT NOT NULL,observed_at TEXT NOT NULL,seen INTEGER NOT NULL,imported INTEGER NOT NULL,data TEXT NOT NULL);
    PRAGMA user_version=1;`);
  db.prepare('INSERT INTO repositories VALUES(?,?)').run(repo.id, JSON.stringify(repo));
  const raw = event('old', { seen: true, imported: true, data: { pushId: 11 } });
  db.prepare('INSERT INTO events VALUES(?,?,?,?,?,?,?)').run(raw.id, repo.id, raw.time, raw.observedAt, 1, 1, JSON.stringify(raw));
  db.close();
  let store = createStore(path);
  assert.deepEqual(store.getEvent('old'), raw);
  assert.equal(store.queryActivity().total, 1);
  assert.equal(store.queryActivity({ view: 'new' }).newItems, 0);
  assert.deepEqual(store.listJobs(), []);
  store.close();
  store = createStore(path);
  assert.deepEqual(store.getEvent('old'), raw);
  assert.deepEqual(store.listJobs(), []);
  store.close();
  rmSync(dir, { recursive: true });
});

test('server-side group pagination reaches history beyond 1000 records and keeps complete build membership', () => {
  const store = setup();
  store.insertEvents(
    Array.from({ length: 1105 }, (_, i) =>
      event(`push-${i}`, { observedAt: new Date(Date.parse('2026-11-17T10:00:00Z') + i).toISOString() }),
    ),
  );
  store.insertEvents(
    Array.from({ length: 1200 }, (_, i) =>
      build(`build-${i}`, `status-${i}`, { observedAt: new Date(Date.parse('2026-11-17T11:00:00Z') + i).toISOString() }),
    ),
  );
  const first = store.queryActivity({ limit: 50 });
  assert.equal(first.total, 1106);
  assert.equal(first.newItems, 1106);
  assert.equal(first.newUpdates, 2305);
  assert.equal(first.items[0].eventIds.length, 1200);
  assert.equal(first.counts.build, 1);
  assert.equal(first.counts.push, 1105);
  let cursor = first.nextCursor;
  const seenGroups = new Set(first.items.map(item => item.groupKey));
  store.insertEvents([event('arrived-after-first-page', { observedAt: '2026-11-17T12:00:00Z' })]);
  while (cursor) {
    const page = store.queryActivity({ limit: 50, cursor });
    assert.equal(page.total, 1106);
    page.items.forEach(item => {
      assert.equal(seenGroups.has(item.groupKey), false);
      seenGroups.add(item.groupKey);
    });
    cursor = page.nextCursor;
  }
  assert.equal(seenGroups.size, 1106);
  assert.equal(store.queryActivity().total, 1107);
  store.close();
});

test('new-view keyset cursor survives acknowledgement between pages without skipping unseen groups', () => {
  const store = setup();
  store.insertEvents(Array.from({ length: 6 }, (_, i) => event(String(i), { observedAt: `2026-11-17T10:00:0${i}Z` })));
  const first = store.queryActivity({ view: 'new', limit: 2 });
  store.acknowledge(first.items.flatMap(item => item.unseenIds));
  const second = store.queryActivity({ view: 'new', limit: 2, cursor: first.nextCursor });
  assert.deepEqual(
    second.items.map(item => item.id),
    ['3', '2'],
  );
  assert.throws(() => store.queryActivity({ view: 'all', cursor: first.nextCursor }), /cursor/);
  store.close();
});

test('raw filters apply before grouping and never acknowledge hidden group members', () => {
  const store = setup();
  store.insertEvents([build('queued', 'Queued'), build('running', 'Running', { observedAt: '2026-11-17T10:01:00Z' })]);
  const filtered = store.queryActivity({ view: 'new', kind: 'build', search: 'Running' });
  assert.equal(filtered.total, 1);
  assert.deepEqual(filtered.items[0].eventIds, ['running']);
  assert.equal(store.getEventGroup('running').length, 2);
  store.acknowledge(filtered.items[0].unseenIds);
  assert.equal(store.getEvent('queued').seen, false);
  assert.equal(store.queryActivity({ view: 'new' }).items[0].eventIds.length, 2);
  assert.equal(store.queryActivity({ repoIds: [] }).total, 0);
  store.close();
});

test('kind-filtering a deletion supporting push keeps its matching raw record visible', () => {
  const store = setup();
  const ref = { name: 'refs/heads/hotfix/a', oldObjectId: 'a'.repeat(40), newObjectId: '0'.repeat(40) };
  store.insertEvents([
    event('push', { data: { pushId: 4, refUpdates: [ref], commits: [] } }),
    event('branch', { kind: 'branch-deleted', data: { pushId: 4, ...ref } }),
  ]);
  assert.equal(store.queryActivity().total, 1);
  assert.deepEqual(store.queryActivity({ kind: 'push' }).items[0].eventIds, ['push']);
  assert.equal(store.getEventGroup('branch').length, 2);
  store.close();
});

test('enrichment is durable search metadata without changing raw identity, timing or alert flags', () => {
  const store = setup();
  const raw = event('push', { imported: true, seen: true, data: { pushId: 3 } });
  store.insertEvents([raw]);
  store.enrichEvent('push', {
    commits: [{ comment: 'Searchable merged change' }],
    id: 'cannot-change-event-id',
    time: 'future',
    seen: false,
  });
  const enriched = store.getEvent('push');
  assert.equal(enriched.id, 'push');
  assert.equal(enriched.time, raw.time);
  assert.equal(enriched.seen, true);
  assert.equal(enriched.imported, true);
  assert.equal(store.queryActivity({ search: 'Searchable merged' }).total, 1);
  assert.equal(store.queryActivity({ view: 'new' }).total, 0);
  store.insertEvents([raw]);
  assert.equal(store.getEvent('push').data.commits.length, 1);
  assert.equal(store.listEvents().length, 1);
  store.close();
});

test('job, event and stream writes roll back together', () => {
  const store = setup();
  const job = { id: 'backfill:repo', repoId: repo.id, type: 'backfill', status: 'pending', nextAt: '2026-01-01T00:00:00Z' };
  assert.throws(() =>
    store.commitPage({
      repoId: repo.id,
      stream: 'pushes',
      state: { cursor: 1 },
      events: [event('a')],
      jobs: [{ ...job, repoId: 'missing' }],
    }),
  );
  assert.equal(store.getEvent('a'), undefined);
  assert.equal(store.getStreams().length, 0);
  store.commitPage({ repoId: repo.id, events: [event('a')], jobs: [job] });
  assert.equal(store.listJobs({ type: 'backfill', dueBefore: '2026-12-01T00:00:00Z' }).length, 1);
  store.removeRepo(repo.id);
  assert.deepEqual(store.listJobs(), []);
  store.close();
});

test('visible Running label filters only the matching build update and repository-name search uses the current name', () => {
  const store = setup();
  store.saveRepo({ ...repo, name: 'Customer Billing API' });
  store.insertEvents([
    build('queued', 'Build #42', { data: { buildId: 42, status: 'notStarted' } }),
    build('running', 'Build #42', { data: { buildId: 42, status: 'inProgress', reason: 'manual' }, observedAt: '2026-11-17T10:01:00Z' }),
  ]);
  const filtered = store.queryActivity({ view: 'new', search: 'Running' });
  assert.equal(filtered.total, 1);
  assert.deepEqual(filtered.items[0].eventIds, ['running']);
  assert.equal(store.queryActivity({ search: 'Triggered manually' }).items[0].eventIds.length, 1);
  store.acknowledge(filtered.items[0].unseenIds);
  assert.equal(store.getEvent('queued').seen, false);
  const repoSearch = store.queryActivity({ search: 'customer billing' });
  assert.equal(repoSearch.total, 1);
  assert.equal(repoSearch.items[0].eventIds.length, 2);
  store.saveRepo({ ...repo, name: 'Renamed Service' });
  assert.equal(store.queryActivity({ search: 'customer billing' }).total, 0);
  assert.equal(store.queryActivity({ search: 'renamed service' }).total, 1);
  store.close();
});

test('v2 search indexes migrate to visible semantic labels without changing existing acknowledgement', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pulse-search-migration-')),
    path = join(dir, 'v2.sqlite');
  let store = createStore(path);
  store.saveRepo(repo);
  store.insertEvents([build('old-running', 'Build #42', { seen: true, data: { buildId: 42, status: 'inProgress' } })]);
  store.close();
  const db = new DatabaseSync(path);
  db.prepare('UPDATE activity_members SET search_text=?').run('old index without label');
  db.exec('PRAGMA user_version=2');
  db.close();
  store = createStore(path);
  assert.equal(store.queryActivity({ search: 'Running' }).total, 1);
  assert.equal(store.getEvent('old-running').seen, true);
  assert.equal(store.queryActivity({ view: 'new' }).total, 0);
  store.close();
  rmSync(dir, { recursive: true });
});

test('activity pages follow source chronology across imported streams while build representatives stay latest-observed', () => {
  const store = setup();
  store.insertEvents([
    event('nov17-merge', { kind: 'pr', time: '2026-11-17T12:00:00Z', observedAt: '2026-11-17T13:00:00Z', data: { status: 'completed' } }),
    event('july-active-pr', { kind: 'pr', time: '2026-07-01T12:00:00Z', observedAt: '2026-11-17T14:00:00Z', imported: true }),
    event('nov16-push', { time: '2026-11-16T12:00:00Z', observedAt: '2026-11-17T13:01:00Z' }),
    build('nov11-build', 'Completed', {
      kind: 'build',
      time: '2026-11-11T12:00:00Z',
      observedAt: '2026-11-17T15:00:00Z',
      imported: true,
      data: { buildId: 7, status: 'completed' },
    }),
    build('older-graph-update', 'Running', {
      time: '2026-11-12T12:00:00Z',
      observedAt: '2026-11-17T13:00:00Z',
      data: { buildId: 8, status: 'inProgress' },
    }),
    build('latest-observed-update', 'Completed', {
      time: '2026-11-12T11:00:00Z',
      observedAt: '2026-11-17T16:00:00Z',
      data: { buildId: 8, status: 'completed' },
    }),
  ]);
  const first = store.queryActivity({ limit: 2 });
  assert.deepEqual(
    first.items.map(item => item.id),
    ['nov17-merge', 'nov16-push'],
  );
  const second = store.queryActivity({ limit: 2, cursor: first.nextCursor });
  assert.deepEqual(
    second.items.map(item => item.id),
    ['latest-observed-update', 'nov11-build'],
  );
  assert.equal(second.items[0].events[0].id, 'latest-observed-update');
  const last = store.queryActivity({ limit: 2, cursor: second.nextCursor });
  assert.deepEqual(
    last.items.map(item => item.id),
    ['july-active-pr'],
  );
  assert.equal(last.nextCursor, null);
  store.close();
});

test('v3 migration queues no merge work and drops what was queued while preserving metadata and read flags', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pulse-range-migration-')),
    path = join(dir, 'v3.sqlite');
  let store = createStore(path);
  store.saveRepo(repo);
  const sha = value => value.repeat(40);
  const ref = (oldObjectId, newObjectId, name = 'refs/heads/main') => ({ name, oldObjectId, newObjectId });
  const records = [
    event('eligible', { seen: true, imported: true, data: { pushId: 41, refUpdates: [ref(sha('a'), sha('b'))], commits: [] } }),
    event('in-progress', { data: { pushId: 42, refUpdates: [ref(sha('b'), sha('c'))] } }),
    event('new-branch', { data: { pushId: 43, refUpdates: [ref(sha('0'), sha('c'))] } }),
    event('deleted-branch', { data: { pushId: 44, refUpdates: [ref(sha('c'), sha('0'))] } }),
    event('same-tip', { data: { pushId: 45, refUpdates: [ref(sha('a'), sha('a'))] } }),
    event('tag', { data: { pushId: 46, refUpdates: [ref(sha('a'), sha('b'), 'refs/tags/v1')] } }),
  ];
  store.insertEvents(records);
  store.enrichEvent('eligible', {
    mergeEvidence: { status: 'complete', introducedCommitsComplete: true, commits: [], prs: [] },
    kept: 'metadata',
  });
  store.saveJob({
    id: 'merge:in-progress',
    type: 'merge',
    repoId: repo.id,
    eventId: 'in-progress',
    stage: 'hydrate',
    cursor: { skip: 5 },
    commitIds: ['old-cursor-data'],
  });
  const before = store.listEvents({ limit: 100 });
  store.close();
  const db = new DatabaseSync(path);
  db.exec('PRAGMA user_version=3');
  db.close();
  store = createStore(path);
  assert.deepEqual(store.listJobs(), []);
  assert.deepEqual(store.listEvents({ limit: 100 }), before);
  assert.equal(store.getEvent('eligible').data.kept, 'metadata');
  assert.equal(store.getEvent('eligible').data.mergeEvidence.status, 'complete');
  assert.equal(store.getEvent('eligible').seen, true);
  assert.equal(store.getEvent('eligible').imported, true);
  store.close();
  store = createStore(path);
  assert.deepEqual(store.listJobs(), []);
  assert.deepEqual(store.listEvents({ limit: 100 }), before);
  store.close();
  rmSync(dir, { recursive: true });
});

test('opening a database with merge work left drops the jobs and keeps evidence without claiming it is in progress', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pulse-stop-merge-')),
    path = join(dir, 'v10.sqlite');
  let store = createStore(path);
  store.saveRepo(repo);
  const refUpdates = [{ name: 'refs/heads/main', oldObjectId: 'a'.repeat(40), newObjectId: 'b'.repeat(40) }];
  store.insertEvents([event('done', { data: { pushId: 1, refUpdates } }), event('partial', { data: { pushId: 2, refUpdates } })]);
  const done = { status: 'complete', checkedAt: '2026-11-17T10:05:00Z', commits: [], prs: [], limitations: [] };
  store.enrichEvent('done', { mergeEvidence: done });
  store.enrichEvent('partial', {
    mergeEvidence: {
      status: 'enriching',
      checkedAt: '2026-11-17T10:06:00Z',
      commits: [],
      prs: [],
      candidateCommitIds: ['interior'],
      limitations: ['Source branch unknown', 'Merge enrichment is still in progress.'],
    },
  });
  store.insertEvents([event('retrying', { data: { refUpdates: [{ name: 'refs/heads/main', oldObjectId: 'a', newObjectId: 'b' }] } })]);
  store.enrichEvent('retrying', {
    mergeEvidence: {
      status: 'partial',
      error: { code: 'ENRICHMENT_FAILED', message: 'Merge evidence could not be read. Retrying later.' },
      limitations: ['Merge enrichment is still in progress.', 'Merge evidence could not be read. Retrying later.'],
    },
  });
  for (const id of ['done', 'partial', 'retrying'])
    store.saveJob({ id: `merge:${id}`, type: 'merge', repoId: repo.id, eventId: id, status: 'enriching', nextAt: '2026-11-17T10:00:00Z' });
  store.saveJob({ id: 'backfill:repo', type: 'backfill', repoId: repo.id, status: 'pending', nextAt: '2026-11-17T10:00:00Z' });
  store.close();
  const db = new DatabaseSync(path);
  db.exec('PRAGMA user_version=10');
  db.close();
  store = createStore(path);
  assert.deepEqual(
    store.listJobs().map(job => job.id),
    ['backfill:repo'],
  );
  assert.deepEqual(store.getEvent('done').data.mergeEvidence, done);
  const partial = store.getEvent('partial');
  assert.deepEqual(partial.data.mergeEvidence.candidateCommitIds, ['interior']);
  assert.deepEqual(partial.data.mergeEvidence.limitations, ['Source branch unknown']);
  assert.equal(partial.data.mergeEvidence.status, 'incomplete');
  const retrying = store.getEvent('retrying').data.mergeEvidence;
  assert.equal(retrying.status, 'incomplete');
  assert.deepEqual(retrying.limitations, ['Merge evidence could not be read.']);
  assert.deepEqual(retrying.error, { code: 'ENRICHMENT_FAILED', message: 'Merge evidence could not be read.' });
  const html = renderMergeEvidence(partial.data) + mergeEvidenceBadge(partial);
  assert.doesNotMatch(html, /in progress|Checking/i);
  assert.match(html, /Evidence incomplete/);
  store.close();
  rmSync(dir, { recursive: true });
});

test('opening a v11 database deletes the cached commit and commit-pr entities, retires the Merge commit filter and shrinks the file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pulse-cache-')),
    path = join(dir, 'v11.sqlite');
  let store = createStore(path);
  store.saveRepo(repo);
  const padding = 'x'.repeat(2000);
  const cached = Array.from({ length: 500 }, (_, index) => [
    { type: 'commit', id: `c${index}`, data: { commitId: `c${index}`, parents: [], comment: padding } },
    { type: 'commit-pr', id: `c${index}`, data: { associations: [], comment: padding } },
  ]).flat();
  store.commitPage({ repoId: repo.id, entities: [...cached, { type: 'ref', id: 'refs/heads/main', data: { objectId: 'a' } }] });
  store.insertEvents([event('graph')]);
  store.enrichEvent('graph', { mergeEvidence: { status: 'complete', commits: [{ commitId: 'm', parents: ['a', 'b'] }], prs: [] } });
  store.close();
  const db = new DatabaseSync(path);
  db.exec(`PRAGMA user_version=11; CREATE TABLE IF NOT EXISTS rules (id TEXT PRIMARY KEY,data TEXT NOT NULL);
    UPDATE activity_members SET evidence_id='merge-commit' WHERE event_id='graph';`);
  db.close();
  const before = statSync(path).size;
  store = createStore(path);
  store.close();
  const check = new DatabaseSync(path);
  assert.deepEqual(
    check
      .prepare('SELECT type,COUNT(*) AS count FROM entities GROUP BY type')
      .all()
      .map(row => ({ ...row })),
    [{ type: 'ref', count: 1 }],
  );
  assert.equal(check.prepare("SELECT 1 FROM sqlite_schema WHERE name='rules'").get(), undefined);
  assert.equal(check.prepare("SELECT evidence_id FROM activity_members WHERE event_id='graph'").get().evidence_id, '');
  check.close();
  assert.ok(statSync(path).size < before / 2, `${statSync(path).size} bytes after, ${before} before`);
  rmSync(dir, { recursive: true });
});

test('Activity revision advances only for committed changes to page data', () => {
  const store = setup();
  try {
    let revision = store.activityRevision();
    const stable = () => assert.equal(store.activityRevision(), revision);
    const changed = () => {
      const next = store.activityRevision();
      assert.notEqual(next, revision);
      revision = next;
    };
    store.saveRepo({ ...repo, disabled: true });
    changed();
    store.saveRepo({ ...repo, disabled: true });
    store.setSetting('refreshEnabled', false);
    stable();
    assert.throws(() => store.commitPage({ repoId: repo.id, events: [event('rolled-back')], jobs: [{ id: 'invalid' }] }));
    stable();
    assert.equal(store.getEvent('rolled-back'), undefined);
    store.commitPage({ repoId: repo.id, events: [event('history', { imported: true }), event('live')] });
    changed();
    store.insertEvents([event('live')]);
    store.acknowledge(['history']);
    stable();
    store.acknowledge(['live']);
    changed();
    store.acknowledge(['live']);
    stable();
    store.acknowledge(['live'], false);
    changed();
    store.enrichEvent('live', { mergeEvidence: { status: 'complete' } });
    changed();
    store.enrichEvent('live', { mergeEvidence: { status: 'complete' } });
    stable();
    store.saveRepo({ ...repo, name: 'Renamed' });
    changed();
    assert.equal(store.queryActivity({ search: 'Renamed' }).total, 2);
    store.removeRepo(repo.id);
    changed();
  } finally {
    store.close();
  }
});

test('filter options come from the full scoped history and stay available when a status is selected', () => {
  const store = setup();
  try {
    store.saveRepo({ id: 'other', name: 'Other' });
    store.insertEvents([
      event('older-canceled', {
        kind: 'build',
        time: '2026-11-15T10:00:00Z',
        imported: true,
        data: { status: 'completed', result: 'canceled' },
      }),
      event('merged', { kind: 'pr', data: { status: 'completed' } }),
      event('push-evidence'),
      event('other-failed', { repoId: 'other', kind: 'build', data: { status: 'completed', result: 'failed' } }),
    ]);
    store.enrichEvent('push-evidence', { mergeEvidence: { prs: [{ pullRequestId: 5 }] } });
    const scope = { repoIds: [repo.id], limit: 1 };
    const all = store.queryActivity(scope);
    assert.deepEqual(all.filterOptions, ['push', 'pr', 'build', 'status:canceled', 'status:merged', 'evidence:pr-linked']);
    assert.equal(store.queryActivity({ ...scope, cursor: all.nextCursor }).filterOptions, undefined);
    const canceled = store.queryActivity({ ...scope, kind: 'status:Canceled' });
    assert.equal(canceled.items[0].id, 'older-canceled');
    assert.deepEqual(canceled.filterOptions, all.filterOptions);
    assert.equal(store.queryActivity({ ...scope, kind: 'evidence:Completed PR linked' }).items[0].id, 'push-evidence');
    assert.equal(store.queryActivity({ ...scope, view: 'new' }).filterOptions.includes('status:canceled'), false);
    assert.deepEqual(store.queryActivity({ ...scope, search: 'merged' }).filterOptions, ['pr', 'status:merged']);
  } finally {
    store.close();
  }
});

test('New activity offers the displayed run status even when only an earlier update is unseen', () => {
  const store = setup();
  try {
    store.insertEvents([
      build('a-running', 'Orders CI', { data: { buildId: 42, status: 'inProgress' } }),
      build('a-succeeded', 'Orders CI', {
        seen: true,
        observedAt: '2026-11-17T10:02:00Z',
        data: { buildId: 42, status: 'completed', result: 'succeeded' },
      }),
      build('b-failed', 'Other CI', { data: { buildId: 43, status: 'completed', result: 'failed' } }),
    ]);
    const base = { view: 'new', repoIds: [repo.id], limit: 1 };
    const page = store.queryActivity(base);
    assert.deepEqual(page.filterOptions, ['build', 'status:failed', 'status:succeeded']);
    assert.equal(page.items[0].id, 'a-succeeded');
    assert.equal(store.queryActivity({ ...base, cursor: page.nextCursor }).items[0].id, 'b-failed');
    assert.equal(store.queryActivity({ ...base, kind: 'status:running' }).total, 0);
    const succeeded = store.queryActivity({ ...base, kind: 'status:succeeded' });
    assert.equal(succeeded.items[0].id, 'a-succeeded');
    assert.deepEqual(succeeded.items[0].unseenIds, ['a-running']);
    store.acknowledge(succeeded.items[0].unseenIds);
    assert.equal(store.queryActivity({ ...base, kind: 'status:succeeded' }).total, 0);
    assert.equal(store.getEvent('b-failed').seen, false);
  } finally {
    store.close();
  }
});

test('v8 migration turns paused repositories into disabled ones', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pulse-disabled-migration-')),
    path = join(dir, 'v7.sqlite');
  createStore(path).close();
  const db = new DatabaseSync(path);
  db.prepare('INSERT INTO repositories(id,data) VALUES(?,?)').run('paused', JSON.stringify({ id: 'paused', name: 'Paused', paused: true }));
  db.prepare('INSERT INTO repositories(id,data) VALUES(?,?)').run(
    'active',
    JSON.stringify({ id: 'active', name: 'Active', paused: false }),
  );
  db.exec('PRAGMA user_version=7');
  db.close();
  const store = createStore(path);
  try {
    assert.deepEqual(
      store.listRepos().map(({ id, disabled, paused }) => ({ id, disabled, paused })),
      [
        { id: 'paused', disabled: true, paused: undefined },
        { id: 'active', disabled: false, paused: undefined },
      ],
    );
  } finally {
    store.close();
    rmSync(dir, { recursive: true });
  }
});

test('a v6 database keeps event IDs, seen flags and repositories when its activity labels become status IDs', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pulse-migration-')),
    path = join(dir, 'v6.sqlite');
  const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE repositories(id TEXT PRIMARY KEY,data TEXT NOT NULL);
    CREATE TABLE events(id TEXT PRIMARY KEY,repo_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
      time TEXT NOT NULL,observed_at TEXT NOT NULL,seen INTEGER NOT NULL,imported INTEGER NOT NULL,data TEXT NOT NULL);
    CREATE TABLE activity_members(sequence INTEGER PRIMARY KEY AUTOINCREMENT,event_id TEXT UNIQUE NOT NULL REFERENCES events(id) ON DELETE CASCADE,
      group_key TEXT NOT NULL,kind TEXT NOT NULL,label TEXT NOT NULL DEFAULT '',evidence TEXT NOT NULL DEFAULT '',search_text TEXT NOT NULL,observed REAL NOT NULL,time REAL NOT NULL);
    CREATE INDEX activity_label ON activity_members(label);
    PRAGMA user_version=6;`);
  db.prepare('INSERT INTO repositories VALUES(?,?)').run(repo.id, JSON.stringify({ ...repo, paused: true }));
  const seen = build('seen-build', 'completed', { data: { buildId: 42, status: 'completed', result: 'succeeded' } });
  const unseen = event('unseen-push', { data: { pushId: 12 } });
  for (const [raw, flag] of [
    [seen, 1],
    [unseen, 0],
  ]) {
    db.prepare('INSERT INTO events VALUES(?,?,?,?,?,?,?)').run(raw.id, repo.id, raw.time, raw.observedAt, flag, 0, JSON.stringify(raw));
    db.prepare(
      'INSERT INTO activity_members(event_id,group_key,kind,label,evidence,search_text,observed,time) VALUES(?,?,?,?,?,?,?,?)',
    ).run(raw.id, raw.id, raw.kind, 'old label', 'old evidence', '', 0, 0);
  }
  db.close();
  const store = createStore(path);
  assert.deepEqual(
    store
      .listEvents()
      .map(({ id, seen }) => ({ id, seen }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    [
      { id: 'seen-build', seen: true },
      { id: 'unseen-push', seen: false },
    ],
  );
  assert.equal(store.listRepos()[0].disabled, true);
  store.close();
  const check = new DatabaseSync(path);
  const columns = check
    .prepare('PRAGMA table_info(activity_members)')
    .all()
    .map(column => column.name);
  assert.ok(columns.includes('status_id') && columns.includes('evidence_id') && !columns.includes('label'));
  assert.deepEqual(
    check
      .prepare('SELECT event_id,status_id FROM activity_members ORDER BY event_id')
      .all()
      .map(row => ({ ...row })),
    [
      { event_id: 'seen-build', status_id: 'succeeded' },
      { event_id: 'unseen-push', status_id: 'push' },
    ],
    'labels are reindexed as status IDs',
  );
  check.close();
  rmSync(dir, { recursive: true });
});

test('v9 migration drops the old Pull journal and keeps repositories and events', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pulse-journal-migration-')),
    path = join(dir, 'v8.sqlite');
  const old = createStore(path);
  old.saveRepo(repo);
  old.insertEvents([event('kept-push')]);
  old.close();
  const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE IF NOT EXISTS pull_operations (checkout TEXT PRIMARY KEY, operation_id TEXT NOT NULL, data TEXT NOT NULL);
    INSERT INTO pull_operations VALUES('/work/repo','abandoned','{"pid":null}');
    PRAGMA user_version=8;`);
  db.close();
  const store = createStore(path);
  try {
    assert.deepEqual(
      store.listRepos().map(({ id }) => id),
      [repo.id],
    );
    assert.deepEqual(
      store.listEvents().map(({ id }) => id),
      ['kept-push'],
    );
  } finally {
    store.close();
  }
  const check = new DatabaseSync(path);
  assert.equal(check.prepare("SELECT name FROM sqlite_master WHERE name='pull_operations'").get(), undefined);
  assert.equal(check.prepare('PRAGMA user_version').get().user_version, 13);
  check.close();
  rmSync(dir, { recursive: true });
});

test('a fresh database is created with its final activity columns', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pulse-fresh-')),
    path = join(dir, 'fresh.sqlite');
  createStore(path).close();
  const check = new DatabaseSync(path);
  const columns = check.prepare('PRAGMA table_info(activity_members)').all();
  assert.deepEqual(
    columns
      .filter(column => ['status_id', 'evidence_id'].includes(column.name))
      .map(({ name, notnull, dflt_value }) => ({ name, notnull, dflt_value })),
    [
      { name: 'status_id', notnull: 1, dflt_value: "''" },
      { name: 'evidence_id', notnull: 1, dflt_value: "''" },
    ],
  );
  assert.equal(check.prepare('PRAGMA user_version').get().user_version, 13);
  check.close();
  rmSync(dir, { recursive: true });
});

test('every older database version and a fresh database end at the latest version, and a newer one is refused', () => {
  const latest = 13;
  const dir = mkdtempSync(join(tmpdir(), 'pulse-versions-'));
  const versionOf = path => {
    const db = new DatabaseSync(path);
    try {
      return db.prepare('PRAGMA user_version').get().user_version;
    } finally {
      db.close();
    }
  };
  try {
    const fresh = join(dir, 'fresh.sqlite');
    createStore(fresh).close();
    assert.equal(versionOf(fresh), latest);
    for (let version = 0; version < latest; version++) {
      const path = join(dir, `v${version}.sqlite`);
      createStore(path).close();
      const db = new DatabaseSync(path);
      db.exec(`PRAGMA user_version=${version}`);
      db.close();
      createStore(path).close();
      assert.equal(versionOf(path), latest, `v${version} upgrades to v${latest}`);
    }
    const newer = join(dir, 'newer.sqlite');
    const db = new DatabaseSync(newer);
    db.exec(`PRAGMA user_version=${latest + 1}`);
    db.close();
    assert.throws(() => createStore(newer), /newer Repo Pulse version/);
    assert.equal(versionOf(newer), latest + 1);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test('a compaction left pending by an earlier start runs on the next start', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pulse-compact-'));
  const path = join(dir, 'state.sqlite');
  createStore(path).close();
  const raw = new DatabaseSync(path);
  raw.exec(`PRAGMA foreign_keys=OFF; WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<200)
    INSERT INTO entities(repo_id,type,id,data) SELECT 'r','cache','c'||i,hex(zeroblob(2048)) FROM n;
    DELETE FROM entities; INSERT INTO settings(key,data) VALUES('compactPending','true');`);
  raw.close();
  const before = statSync(path).size;
  createStore(path).close();
  const after = new DatabaseSync(path);
  assert.equal(after.prepare("SELECT 1 FROM settings WHERE key='compactPending'").get(), undefined);
  after.close();
  assert.ok(statSync(path).size < before / 2, 'the start compacts the file');
  rmSync(dir, { recursive: true });
});

test('migration 13 rebuilds search_text from named fields and preserves enrichment search without changing read state', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pulse-search-v13-'));
  const path = join(dir, 'state.sqlite');
  let store = createStore(path);
  store.saveRepo(repo);
  store.insertEvents([
    build('b-1', 'Build #42', {
      seen: true,
      data: {
        buildId: 42,
        status: 'inProgress',
        definition: { name: 'Nightly CI', url: 'https://dev.azure.com/org/_apis/build/Definitions/42' },
      },
    }),
    event('p-1', {
      imported: true,
      seen: true,
      data: { pushId: 9, refUpdates: [{ name: 'refs/heads/main', oldObjectId: '1111aaaa', newObjectId: '2222bbbb' }] },
    }),
  ]);
  store.enrichEvent('p-1', {
    commits: [{ commitId: '3333cccc', comment: 'Enriched note' }],
    mergeEvidence: {
      commits: [{ commitId: '4444dddd', parents: ['5555eeee'] }],
      rewrite: [{ ref: 'refs/heads/main', status: 'fast-forward' }],
    },
  });
  store.close();
  const db = new DatabaseSync(path);
  db.prepare('UPDATE activity_members SET search_text=?').run('{"definition":{"url":"_apis/build/definitions/42"}}');
  db.exec('PRAGMA user_version=12');
  db.close();
  store = createStore(path);
  assert.equal(store.queryActivity({ search: 'Nightly CI' }).total, 1);
  assert.equal(store.queryActivity({ search: 'inProgress' }).total, 1);
  assert.equal(store.queryActivity({ search: '_apis/build/definitions/42' }).total, 0);
  assert.equal(store.queryActivity({ search: 'Enriched note' }).total, 1);
  assert.equal(store.queryActivity({ search: '5555eeee' }).total, 1);
  assert.equal(store.queryActivity({ search: 'fast-forward' }).total, 1);
  assert.equal(store.getEvent('b-1').seen, true);
  assert.equal(store.getEvent('p-1').imported, true);
  store.close();
  rmSync(dir, { recursive: true });
});

test('People filters recorded identities before grouping and binds the cursor to the canonical name list', () => {
  const store = setup();
  try {
    store.insertEvents([
      build('alice-build', 'queued', { actor: 'Alice Morgan' }),
      build('chris-build', 'completed', { actor: 'Chris' }),
      event('bob', { actor: 'Bob Smith' }),
      event('branch-only', { branch: 'feature/Alice' }),
      event('assigned', { kind: 'pr', data: { reviewers: [{ name: 'Alice Morgan' }] } }),
      event('closer', { kind: 'pr', actor: 'Chris', data: { closedBy: 'Bob Smith' } }),
      event('vote', { kind: 'pr', actor: 'Chris', data: { voteChanges: [{ name: 'Alice Morgan', vote: 10 }] } }),
      event('linked', { actor: 'Microsoft.VisualStudio.Services.TFS' }),
      event('unknown', { actor: 'Unknown' }),
    ]);
    store.enrichEvent('linked', { mergeEvidence: { prs: [{ pullRequestId: 12, closedBy: { displayName: 'Bob Smith' } }] } });
    const names = ' ALICE, Bob, alice, ';
    const first = store.queryActivity({ people: names, limit: 1 });
    const rest = store.queryActivity({ people: 'bob, alice', cursor: first.nextCursor });
    assert.equal(first.total, 5);
    assert.deepEqual([...first.items, ...rest.items].flatMap(item => item.eventIds).sort(), [
      'alice-build',
      'bob',
      'closer',
      'linked',
      'vote',
    ]);
    assert.throws(() => store.queryActivity({ people: 'Chris', cursor: first.nextCursor }), /cursor does not match/);
    assert.equal(store.queryActivity({ people: names, kind: 'build' }).items[0].unseenIds.join(), 'alice-build');
    assert.equal(store.queryActivity({ people: 'Bob', search: 'branch-only' }).total, 0);
    assert.equal(store.queryActivity({ people: 'unknown, Microsoft' }).total, 0);
    assert.equal(store.queryActivity({ people: '%_' }).total, 0);
    assert.throws(() => store.queryActivity({ people: 'a'.repeat(301) }), /300 characters/);
  } finally {
    store.close();
  }
});
