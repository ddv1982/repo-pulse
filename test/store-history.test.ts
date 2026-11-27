import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from '../server/store.ts';
import { buildActivityTree } from '../src/activity-tree.ts';
import { renderMergeEvidence, mergeEvidenceBadge } from '../src/ui/merge-evidence.ts';
import type { ActivityEvent, ActivityRequest, EventData } from '../src/activity.ts';
import type { Repository, StreamState } from '../src/contract.d.ts';
import { dataOf, fieldsOf, present, stub } from './fixtures/typed.ts';
import { historyJob } from './fixtures/jobs.ts';
import type { Job } from '../server/store-records.ts';

type Reviewer = NonNullable<EventData['reviewers']>[number];
const repo = stub<Repository>({ id: 'repo', name: 'Repo', azureId: 'a' });
const event = (id: string, extra: Partial<ActivityEvent> = {}): ActivityEvent => ({
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
const build = (id: string, status: string, extra: Partial<ActivityEvent> = {}) =>
  event(id, { kind: 'build', title: status, data: { buildId: 42, status }, ...extra });
/** Writes a job of the retired merge type as store.saveJob wrote it, with no `nextAt` due at the epoch. */
function insertMergeJob(db: DatabaseSync, job: { id: string; type: 'merge'; repoId: string; nextAt?: string; [field: string]: unknown }) {
  db.prepare('INSERT INTO jobs(id,repo_id,type,next_at,data) VALUES(?,?,?,?,?)').run(
    job.id,
    job.repoId,
    job.type,
    job.nextAt || '1970-01-01T00:00:00.000Z',
    JSON.stringify(job),
  );
}
const setup = () => {
  const store = createStore();
  store.saveRepo(repo);
  return store;
};

test('cached branch lifetimes separate pushes across seen, filtered and paginated boundaries', () => {
  const store = setup();
  try {
    const ref = 'refs/heads/topic';
    const time = (minute: number) => new Date(Date.UTC(2026, 10, 17, 10, minute)).toISOString();
    const topic = (id: string, minute: number, extra: Partial<ActivityEvent> = {}) =>
      event(id, { branch: 'topic', time: time(minute), ...extra });
    store.insertEvents([
      topic('old-push', 0),
      topic('deletion', 1, { kind: 'branch-deleted', data: { name: ref, evidence: 'push' } }),
      topic('recreation', 2, { kind: 'branch-created', data: { name: ref, evidence: 'push' } }),
      topic('new-push', 3),
    ]);
    store.acknowledge(['deletion', 'recreation']);
    for (const filters of [{ kind: 'push' }, { view: 'new' }] satisfies ActivityRequest[]) {
      const first = store.queryActivity({ ...filters, limit: 1 });
      const second = store.queryActivity({ ...filters, limit: 1, cursor: present(first.nextCursor) });
      const items = [...first.items, ...second.items];
      assert.deepEqual(
        items.map(row => [row.id, row.branchLifetimes?.[ref]]),
        [
          ['new-push', 'recreation'],
          ['old-push', ''],
        ],
      );
      assert.ok(buildActivityTree(items).rows.every(row => !row.node.up && !row.node.down));
    }
  } finally {
    store.close();
  }
});

test('a merge cannot connect to a newer lifetime of its pull request source', () => {
  const store = setup();
  try {
    const ref = 'refs/heads/topic';
    store.insertEvents([
      event('new-topic', {
        kind: 'branch-created',
        branch: 'topic',
        time: '2026-11-17T10:01:00Z',
        data: { name: ref, evidence: 'push' },
      }),
      event('new-work', { branch: 'topic', time: '2026-11-17T10:02:00Z' }),
      event('old-merge', {
        kind: 'pr',
        branch: 'topic',
        time: '2026-11-17T10:03:00Z',
        data: {
          pullRequestId: 2,
          status: 'completed',
          sourceRefName: ref,
          targetRefName: 'refs/heads/main',
          pullRequestCreatedAt: '2026-11-17T10:00:00Z',
        },
      }),
    ]);
    const { items } = store.queryActivity({ view: 'new' });
    assert.equal(present(items[0]).prSourceLifetime, '');
    assert.equal(present(items[0]).branchLifetimes?.[ref], 'new-topic');
    const { rows } = buildActivityTree(items);
    assert.equal(present(present(rows[0]).mergeFrom).down, false);
    assert.equal(present(rows[1]).node.up, false);
  } finally {
    store.close();
  }
});

test('both legacy merges and merges that auto-delete the source can join the source lane', () => {
  const ref = 'refs/heads/topic';
  for (const autoDeleted of [false, true]) {
    const store = setup();
    try {
      store.insertEvents([
        event('creation', { kind: 'branch-created', branch: 'topic', data: { name: ref, evidence: 'push' } }),
        event('work', { branch: 'topic', time: '2026-11-17T10:02:00Z' }),
        ...(autoDeleted
          ? [
              event('deletion', {
                kind: 'branch-deleted',
                branch: 'topic',
                time: '2026-11-17T10:03:00Z',
                data: { name: ref, evidence: 'push' },
              }),
            ]
          : []),
        event('merge', {
          kind: 'pr',
          branch: 'topic',
          time: '2026-11-17T10:04:00Z',
          data: {
            pullRequestId: 7,
            status: 'completed',
            sourceRefName: ref,
            targetRefName: 'refs/heads/main',
            ...(autoDeleted ? { pullRequestCreatedAt: '2026-11-17T10:01:00Z' } : {}),
          },
        }),
      ]);
      const { rows } = buildActivityTree(store.queryActivity({ view: 'new' }).items);
      assert.equal(present(present(rows[0]).mergeFrom).down, true);
      assert.equal(present(rows[1]).node.up, true);
    } finally {
      store.close();
    }
  }
});

test('a dotted fork can reach its PR target when the PR is on an earlier activity page', () => {
  const store = setup();
  try {
    store.insertEvents([
      event('main-push'),
      event('topic', { kind: 'branch-created', branch: 'topic', time: '2026-11-17T10:01:00Z' }),
      event('open', {
        kind: 'pr',
        branch: 'topic',
        time: '2026-11-17T10:02:00Z',
        data: { pullRequestId: 7, status: 'active', sourceRefName: 'refs/heads/topic', targetRefName: 'refs/heads/main' },
      }),
    ]);
    const first = store.queryActivity({ view: 'new', limit: 1 });
    const second = store.queryActivity({ view: 'new', limit: 2, cursor: present(first.nextCursor) });
    const { rows } = buildActivityTree([...first.items, ...second.items]);
    const fork = present(present(rows[1]).forkFrom);
    assert.equal(fork.evidence, 'pr');
    assert.equal(fork.down, true);
  } finally {
    store.close();
  }
});

test('same-second lifetime boundaries follow numeric push ID instead of insertion order', () => {
  const store = setup();
  try {
    const ref = 'refs/heads/topic';
    const sameSecond = { branch: 'topic', time: '2026-11-17T10:01:00Z' };
    store.insertEvents([
      event('recreated', { ...sameSecond, kind: 'branch-created', data: { name: ref, evidence: 'push', pushId: 102 } }),
      event('deleted', { ...sameSecond, kind: 'branch-deleted', data: { name: ref, evidence: 'push', pushId: 101 } }),
      event('first-life', { ...sameSecond, kind: 'branch-created', data: { name: ref, evidence: 'push', pushId: 99 } }),
      event('old-push', { ...sameSecond, data: { pushId: 100 } }),
      event('new-push', { ...sameSecond, data: { pushId: 103 } }),
    ]);
    const { items } = store.queryActivity();
    const lifetime = Object.fromEntries(items.map(item => [item.id, item.branchLifetimes?.[ref]]));
    assert.deepEqual(lifetime, {
      'first-life': 'first-life',
      'old-push': 'first-life',
      deleted: 'first-life',
      recreated: 'recreated',
      'new-push': 'recreated',
    });
  } finally {
    store.close();
  }
});

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
  db.prepare('INSERT INTO events VALUES(?,?,?,?,?,?,?)').run(raw.id, repo.id, raw.time, present(raw.observedAt), 1, 1, JSON.stringify(raw));
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
  assert.equal(present(first.items[0]).eventIds.length, 1200);
  assert.equal(first.counts?.build, 1);
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
  const second = store.queryActivity({ view: 'new', limit: 2, cursor: first.nextCursor ?? undefined });
  assert.deepEqual(
    second.items.map(item => item.id),
    ['3', '2'],
  );
  assert.throws(() => store.queryActivity({ view: 'all', cursor: first.nextCursor ?? undefined }), /cursor/);
  store.close();
});

test('raw filters apply before grouping and never acknowledge hidden group members', () => {
  const store = setup();
  store.insertEvents([build('queued', 'Queued'), build('running', 'Running', { observedAt: '2026-11-17T10:01:00Z' })]);
  const filtered = store.queryActivity({ view: 'new', kind: 'build', search: 'Running' });
  assert.equal(filtered.total, 1);
  assert.deepEqual(present(filtered.items[0]).eventIds, ['running']);
  assert.deepEqual(store.queryActivity.unseenIds({ kind: 'build', search: 'Running' }), ['running']);
  assert.equal(store.getEventGroup('running').length, 2);
  store.acknowledge(present(filtered.items[0]).unseenIds);
  assert.equal(present(store.getEvent('queued')).seen, false);
  assert.equal(present(store.queryActivity({ view: 'new' }).items[0]).eventIds.length, 2);
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
  assert.deepEqual(present(store.queryActivity({ kind: 'push' }).items[0]).eventIds, ['push']);
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
  const enriched = present(store.getEvent('push'));
  assert.equal(enriched.id, 'push');
  assert.equal(enriched.time, raw.time);
  assert.equal(enriched.seen, true);
  assert.equal(enriched.imported, true);
  assert.equal(store.queryActivity({ search: 'Searchable merged' }).total, 1);
  assert.equal(store.queryActivity({ view: 'new' }).total, 0);
  store.insertEvents([raw]);
  assert.equal(dataOf(store.getEvent('push')).commits?.length, 1);
  assert.equal(store.listEvents().length, 1);
  store.close();
});

test('job, event and stream writes roll back together', () => {
  const store = setup();
  const job = historyJob(repo.id, { nextAt: '2026-01-01T00:00:00Z' });
  const state: StreamState = { repoId: repo.id, stream: 'pushes', initialized: false, nextAt: '2026-01-01T00:00:00Z', cursor: { skip: 1 } };
  assert.throws(() =>
    store.commitPage({
      repoId: repo.id,
      stream: 'pushes',
      state,
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
  assert.deepEqual(present(filtered.items[0]).eventIds, ['running']);
  assert.equal(present(store.queryActivity({ search: 'Triggered manually' }).items[0]).eventIds.length, 1);
  store.acknowledge(present(filtered.items[0]).unseenIds);
  assert.equal(present(store.getEvent('queued')).seen, false);
  const repoSearch = store.queryActivity({ search: 'customer billing' });
  assert.equal(repoSearch.total, 1);
  assert.equal(present(repoSearch.items[0]).eventIds.length, 2);
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
  assert.equal(present(store.getEvent('old-running')).seen, true);
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
  const second = store.queryActivity({ limit: 2, cursor: first.nextCursor ?? undefined });
  assert.deepEqual(
    second.items.map(item => item.id),
    ['latest-observed-update', 'nov11-build'],
  );
  assert.equal(present(present(second.items[0]).events[0]).id, 'latest-observed-update');
  const last = store.queryActivity({ limit: 2, cursor: second.nextCursor ?? undefined });
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
  const sha = (value: string) => value.repeat(40);
  const ref = (oldObjectId: string, newObjectId: string, name = 'refs/heads/main') => ({ name, oldObjectId, newObjectId });
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
  const before = store.listEvents({ limit: 100 });
  store.close();
  const db = new DatabaseSync(path);
  // A merge job as the earlier merge analysis saved it; no current job type has this shape.
  insertMergeJob(db, {
    id: 'merge:in-progress',
    type: 'merge',
    repoId: repo.id,
    eventId: 'in-progress',
    stage: 'hydrate',
    cursor: { skip: 5 },
    commitIds: ['old-cursor-data'],
  });
  db.exec('PRAGMA user_version=3');
  db.close();
  store = createStore(path);
  assert.deepEqual(store.listJobs(), []);
  assert.deepEqual(store.listEvents({ limit: 100 }), before);
  assert.equal(dataOf(store.getEvent('eligible')).kept, 'metadata');
  assert.equal(dataOf(store.getEvent('eligible')).mergeEvidence?.status, 'complete');
  assert.equal(present(store.getEvent('eligible')).seen, true);
  assert.equal(present(store.getEvent('eligible')).imported, true);
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
  store.saveJob(historyJob(repo.id, { status: 'pending', nextAt: '2026-11-17T10:00:00Z' }));
  store.close();
  const db = new DatabaseSync(path);
  for (const id of ['done', 'partial', 'retrying'])
    insertMergeJob(db, {
      id: `merge:${id}`,
      type: 'merge',
      repoId: repo.id,
      eventId: id,
      status: 'enriching',
      nextAt: '2026-11-17T10:00:00Z',
    });
  db.exec('PRAGMA user_version=10');
  db.close();
  store = createStore(path);
  assert.deepEqual(
    store.listJobs().map(job => job.id),
    ['backfill:repo'],
  );
  assert.deepEqual(dataOf(store.getEvent('done')).mergeEvidence, done);
  const partial = present(store.getEvent('partial'));
  const partialEvidence = present(dataOf(partial).mergeEvidence);
  // candidateCommitIds is a field of the earlier merge analysis, kept as it was stored.
  assert.deepEqual(fieldsOf(partialEvidence).candidateCommitIds, ['interior']);
  assert.deepEqual(partialEvidence.limitations, ['Source branch unknown']);
  assert.equal(partialEvidence.status, 'incomplete');
  const retrying = present(dataOf(store.getEvent('retrying')).mergeEvidence);
  assert.equal(retrying.status, 'incomplete');
  assert.deepEqual(retrying.limitations, ['Merge evidence could not be read.']);
  assert.deepEqual(retrying.error, { code: 'ENRICHMENT_FAILED', message: 'Merge evidence could not be read.' });
  const html = String(renderMergeEvidence(partial.data)) + String(mergeEvidenceBadge(partial));
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
  store.commitPage({ repoId: repo.id, entities: [{ type: 'ref', id: 'refs/heads/main', data: { objectId: 'a' } }] });
  store.insertEvents([event('graph')]);
  store.enrichEvent('graph', { mergeEvidence: { status: 'complete', commits: [{ commitId: 'm', parents: ['a', 'b'] }], prs: [] } });
  store.close();
  const db = new DatabaseSync(path);
  // Commits and their PR lookups as the earlier merge analysis cached them; no current entity type has these shapes.
  const insert = db.prepare('INSERT INTO entities(repo_id,type,id,data) VALUES(?,?,?,?)');
  for (let index = 0; index < 500; index++) {
    insert.run(repo.id, 'commit', `c${index}`, JSON.stringify({ commitId: `c${index}`, parents: [], comment: padding }));
    insert.run(repo.id, 'commit-pr', `c${index}`, JSON.stringify({ associations: [], comment: padding }));
  }
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
  assert.equal(present(check.prepare("SELECT evidence_id FROM activity_members WHERE event_id='graph'").get()).evidence_id, '');
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
    assert.throws(() => store.commitPage({ repoId: repo.id, events: [event('rolled-back')], jobs: [stub<Job>({ id: 'invalid' })] }));
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
    store.saveRepo(stub<Repository>({ id: 'other', name: 'Other' }));
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
    assert.equal(store.queryActivity({ ...scope, cursor: all.nextCursor ?? undefined }).filterOptions, undefined);
    const canceled = store.queryActivity({ ...scope, kind: 'status:Canceled' });
    assert.equal(present(canceled.items[0]).id, 'older-canceled');
    assert.deepEqual(canceled.filterOptions, all.filterOptions);
    assert.equal(present(store.queryActivity({ ...scope, kind: 'evidence:Completed PR linked' }).items[0]).id, 'push-evidence');
    assert.equal(present(store.queryActivity({ ...scope, search: 'Completed PR linked' }).items[0]).id, 'push-evidence');
    assert.equal(store.queryActivity({ ...scope, view: 'new' }).filterOptions?.includes('status:canceled'), false);
    assert.deepEqual(store.queryActivity({ ...scope, search: 'merged' }).filterOptions, ['pr', 'status:merged']);
  } finally {
    store.close();
  }
});

test('New activity offers the displayed run status even when only an earlier update is unseen', () => {
  const store = setup();
  try {
    store.insertEvents([
      build('a-failed', 'Orders CI', { data: { buildId: 42, status: 'completed', result: 'failed' } }),
      build('a-succeeded', 'Orders CI', {
        seen: true,
        observedAt: '2026-11-17T10:02:00Z',
        data: { buildId: 42, status: 'completed', result: 'succeeded' },
      }),
      build('b-failed', 'Other CI', { data: { buildId: 43, status: 'completed', result: 'failed' } }),
    ]);
    const base: ActivityRequest = { view: 'new', repoIds: [repo.id], limit: 1 };
    const page = store.queryActivity(base);
    assert.deepEqual(page.filterOptions, ['build', 'status:failed', 'status:succeeded']);
    assert.deepEqual(page.newBuildCounts, { running: 0, queued: 0, failed: 1 });
    assert.equal(present(page.items[0]).id, 'a-succeeded');
    assert.equal(present(store.queryActivity({ ...base, cursor: page.nextCursor ?? undefined }).items[0]).id, 'b-failed');
    const failed = store.queryActivity({ ...base, kind: 'status:failed' });
    assert.deepEqual(
      failed.items.map(item => item.id),
      ['b-failed'],
    );
    assert.deepEqual(failed.newBuildCounts, page.newBuildCounts);
    const succeeded = store.queryActivity({ ...base, kind: 'status:succeeded' });
    assert.equal(present(succeeded.items[0]).id, 'a-succeeded');
    assert.deepEqual(present(succeeded.items[0]).unseenIds, ['a-failed']);
    assert.deepEqual(store.queryActivity.unseenIds({ ...base, kind: 'status:succeeded' }), ['a-failed']);
    store.acknowledge(present(succeeded.items[0]).unseenIds);
    assert.equal(store.queryActivity({ ...base, kind: 'status:succeeded' }).total, 0);
    assert.equal(present(store.getEvent('b-failed')).seen, false);
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
      // paused is a field of the earlier repository format; the migration drops it.
      store.listRepos().map(repo => ({ id: repo.id, disabled: repo.disabled, paused: fieldsOf(repo).paused })),
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
  const rows: [ActivityEvent, number][] = [
    [seen, 1],
    [unseen, 0],
  ];
  for (const [raw, flag] of rows) {
    db.prepare('INSERT INTO events VALUES(?,?,?,?,?,?,?)').run(
      raw.id,
      repo.id,
      raw.time,
      present(raw.observedAt),
      flag,
      0,
      JSON.stringify(raw),
    );
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
  assert.equal(present(store.listRepos()[0]).disabled, true);
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
  assert.equal(present(check.prepare('PRAGMA user_version').get()).user_version, 15);
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
      .filter(column => ['status_id', 'evidence_id'].includes(String(column.name)))
      .map(({ name, notnull, dflt_value }) => ({ name, notnull, dflt_value })),
    [
      { name: 'status_id', notnull: 1, dflt_value: "''" },
      { name: 'evidence_id', notnull: 1, dflt_value: "''" },
    ],
  );
  assert.equal(present(check.prepare('PRAGMA user_version').get()).user_version, 15);
  check.close();
  rmSync(dir, { recursive: true });
});

test('every older database version and a fresh database end at the latest version, and a newer one is refused', () => {
  const latest = 15;
  const dir = mkdtempSync(join(tmpdir(), 'pulse-versions-'));
  const versionOf = (path: string) => {
    const db = new DatabaseSync(path);
    try {
      return present(db.prepare('PRAGMA user_version').get()).user_version;
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
  // The definition as Azure sends it, with a URL the event type leaves out.
  const nightly = { name: 'Nightly CI', url: 'https://dev.azure.com/org/_apis/build/Definitions/42' };
  let store = createStore(path);
  store.saveRepo(repo);
  store.insertEvents([
    build('b-1', 'Build #42', {
      seen: true,
      data: {
        buildId: 42,
        status: 'inProgress',
        definition: nightly,
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
  assert.equal(present(store.getEvent('b-1')).seen, true);
  assert.equal(present(store.getEvent('p-1')).imported, true);
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
      event('assigned', { kind: 'pr', data: { reviewers: [stub<Reviewer>({ name: 'Alice Morgan' })] } }),
      event('closer', { kind: 'pr', actor: 'Chris', data: { closedBy: 'Bob Smith' } }),
      event('vote', { kind: 'pr', actor: 'Chris', data: { voteChanges: [{ name: 'Alice Morgan', vote: 10 }] } }),
      event('linked', { actor: 'Microsoft.VisualStudio.Services.TFS' }),
      event('unknown', { actor: 'Unknown' }),
      event('unnamed-vote', { kind: 'pr', data: { voteChanges: [{ name: 'Unknown reviewer', vote: 10 }] } }),
    ]);
    store.enrichEvent('linked', { mergeEvidence: { prs: [{ pullRequestId: 12, closedBy: { displayName: 'Bob Smith' } }] } });
    const names = ' ALICE, Bob, alice, ';
    const first = store.queryActivity({ people: names, limit: 1 });
    const rest = store.queryActivity({ people: 'bob, alice', cursor: first.nextCursor ?? undefined });
    assert.equal(first.total, 5);
    assert.deepEqual([...first.items, ...rest.items].flatMap(item => item.eventIds).sort(), [
      'alice-build',
      'bob',
      'closer',
      'linked',
      'vote',
    ]);
    assert.throws(() => store.queryActivity({ people: 'Chris', cursor: first.nextCursor ?? undefined }), /cursor does not match/);
    assert.equal(present(store.queryActivity({ people: names, kind: 'build' }).items[0]).unseenIds.join(), 'alice-build');
    assert.equal(store.queryActivity({ people: 'Bob', search: 'branch-only' }).total, 0);
    assert.equal(store.queryActivity({ people: 'unknown, Microsoft' }).total, 0);
    assert.equal(store.queryActivity({ people: '%_' }).total, 0);
    store.enrichEvent('branch-only', { mergeEvidence: { prs: [{ closedBy: 'Bob Smith' }] } });
    assert.throws(() => store.queryActivity({ people: names, cursor: first.nextCursor ?? undefined }), { code: 'ACTIVITY_CHANGED' });
    assert.equal(store.queryActivity({ people: names }).total, 6);
    assert.throws(() => store.queryActivity({ people: 'a'.repeat(301) }), /300 characters/);
  } finally {
    store.close();
  }
});

test('Activity search finds short names across accents and People matches name fragments', () => {
  const store = setup();
  try {
    store.saveRepo(stub<Repository>({ id: 'other', name: 'Équipe' }));
    store.insertEvents([
      event('jose', { actor: 'José van Dijk' }),
      event('alice', { actor: 'Alice Morgan' }),
      event('branch', { branch: 'feature/Jose' }),
      event('split', { actor: 'Jose Smith', kind: 'pr', data: { closedBy: 'Alice Dijk' } }),
      event('other', { repoId: 'other', actor: 'JOSÉ SÁNCHEZ' }),
    ]);
    const ids = (filters: ActivityRequest) =>
      store
        .queryActivity({ repoIds: [repo.id], ...filters })
        .items.map(item => item.id)
        .sort();
    assert.deepEqual(ids({ search: 'Jose' }), ['branch', 'jose', 'split']);
    assert.deepEqual(ids({ search: 'José' }), ['branch', 'jose', 'split']);
    assert.deepEqual(ids({ people: 'Jo, AL' }), ['alice', 'jose', 'split']);
    assert.deepEqual(ids({ people: 'Jo Dij, Ali Mor' }), ['alice', 'jose']);
    assert.deepEqual(ids({ people: 'Jose Dijk', search: 'Jose' }), ['jose']);
    assert.deepEqual(ids({ repoIds: ['other'], search: 'equipe' }), ['other']);
    const first = store.queryActivity({ people: 'José, ALI', limit: 1 });
    const rest = store.queryActivity({ people: 'ali, JOSÉ', cursor: first.nextCursor ?? undefined });
    assert.deepEqual([...first.items, ...rest.items].map(item => item.id).sort(), ['alice', 'jose', 'other', 'split']);
  } finally {
    store.close();
  }
});

test('name search preserves decomposed non-Latin text and handles punctuation within name fragments', () => {
  const store = setup();
  try {
    store.insertEvents([
      event('mixed', { actor: 'André Κο\u0301στας' }),
      event('lane', { actor: 'Andre\u0301 Lane' }),
      event('francois', { actor: 'François' }),
      event('abe', { actor: 'Abe' }),
      event('virama', { actor: 'A\u094Dbe' }),
      event('john', { actor: 'John O’Connor' }),
      event('jean', { actor: 'Jean-Luc Picard' }),
    ]);
    assert.equal(store.queryActivity({ search: 'André Κο' }).items[0]?.id, 'mixed');
    assert.equal(store.queryActivity({ people: 'Andre Κο' }).items[0]?.id, 'mixed');
    for (const mode of ['search', 'people']) {
      assert.deepEqual(
        store.queryActivity({ [mode]: '\u0301 Lane' }).items.map(item => item.id),
        ['lane'],
      );
      assert.deepEqual(
        store.queryActivity({ [mode]: 'A\u094Dbe' }).items.map(item => item.id),
        ['virama'],
      );
      assert.equal(store.queryActivity({ [mode]: 'Franc' }).items[0]?.id, 'francois');
    }
    assert.deepEqual(
      store
        .queryActivity({ people: 'Jo O’Con, Jean-L Pi' })
        .items.map(item => item.id)
        .sort(),
      ['jean', 'john'],
    );
  } finally {
    store.close();
  }
});

test('comma-separated text search matches any term within the same repository scope', () => {
  const store = setup();
  try {
    store.saveRepo(stub<Repository>({ id: 'other', name: 'Elsewhere' }));
    store.insertEvents([
      event('alice', { actor: 'Alice Morgan' }),
      event('bob', { actor: 'Bob Smith' }),
      event('branch', { branch: 'feature/Alice Morgan' }),
      event('unrelated', { actor: 'Chris' }),
      event('other-alice', { repoId: 'other', actor: 'Alice Morgan' }),
    ]);
    const scope = { repoIds: [repo.id], search: ' Alice Morgan, Bob Smith, alice morgan, ' };
    const first = store.queryActivity({ ...scope, limit: 1 });
    const rest = store.queryActivity({ ...scope, search: 'BOB SMITH, alice morgan', cursor: first.nextCursor ?? undefined });
    assert.equal(first.total, 3);
    assert.deepEqual([...first.items, ...rest.items].map(item => item.id).sort(), ['alice', 'bob', 'branch']);
    assert.deepEqual(
      store.queryActivity({ ...scope, people: 'Alice Morgan' }).items.map(item => item.id),
      ['alice'],
    );
    assert.equal(store.queryActivity({ ...scope, search: ', ,' }).total, 4);
    assert.throws(() => store.queryActivity({ search: 'a,'.repeat(600) }), /300 characters/);
  } finally {
    store.close();
  }
});

test('a CI run on a pull request ref carries the refs of the stored pull request, also when that PR is on another page', () => {
  const store = setup();
  const pr = (id: string, time: string, data: EventData) =>
    event(id, {
      kind: 'pr',
      branch: 'feature/a',
      time,
      data: { pullRequestId: 7, status: 'active', targetRefName: 'refs/heads/main', ...data },
    });
  const run = (id: string, branch: string, time: string) =>
    event(id, { kind: 'build', branch, time, data: { buildId: id, status: 'completed' } });
  store.insertEvents([
    pr('pr-old', '2026-11-10T10:00:00Z', { sourceRefName: 'refs/heads/feature/old-name' }),
    pr('pr-new', '2026-11-11T10:00:00Z', { sourceRefName: 'refs/heads/feature/a', fork: { repository: 'Fork', project: 'Other' } }),
    run('run-7', 'refs/pull/7/merge', '2026-11-17T12:00:00Z'),
    run('run-8', 'refs/pull/8/merge', '2026-11-17T11:00:00Z'),
    run('run-main', 'main', '2026-11-17T10:30:00Z'),
  ]);
  const page = store.queryActivity({ limit: 3 });
  assert.deepEqual(
    page.items.map(item => [item.id, dataOf(item).pullRequest]),
    [
      [
        'run-7',
        { id: 7, sourceRefName: 'refs/heads/feature/a', targetRefName: 'refs/heads/main', fork: { repository: 'Fork', project: 'Other' } },
      ],
      ['run-8', undefined],
      ['run-main', undefined],
    ],
  );
  assert.equal(dataOf(store.getEvent('run-7')).pullRequest, undefined, 'the saved event is not changed');
  // A PR event that names its source only as the row branch still resolves, as it does in the tree.
  store.insertEvents([
    event('pr-9', { kind: 'pr', branch: 'fix/b', data: { pullRequestId: 9 } }),
    run('run-9', 'refs/pull/9/merge', '2026-11-18T12:00:00Z'),
  ]);
  assert.deepEqual(dataOf(store.queryActivity({ limit: 1 }).items[0]).pullRequest, { id: 9, sourceRefName: 'fix/b' });
  // Timestamps with and without fractions compare by time, and a PR event without a source ref is passed over.
  store.insertEvents([
    pr('pr-retarget', '2026-11-11T10:00:00.800Z', { sourceRefName: 'refs/heads/feature/a', targetRefName: 'refs/heads/release' }),
    { ...pr('pr-bare', '2026-11-12T10:00:00Z', {}), branch: '' },
  ]);
  assert.deepEqual(dataOf(store.queryActivity({ limit: 2 }).items[1]).pullRequest, {
    id: 7,
    sourceRefName: 'refs/heads/feature/a',
    targetRefName: 'refs/heads/release',
  });
  store.close();
});

test('a compaction blocked by an open reader stays pending and finishes on the next start', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pulse-compact-busy-'));
  const path = join(dir, 'state.sqlite');
  createStore(path).close();
  const raw = new DatabaseSync(path);
  raw.exec(`PRAGMA foreign_keys=OFF; WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<200)
    INSERT INTO entities(repo_id,type,id,data) SELECT 'r','cache','c'||i,hex(zeroblob(2048)) FROM n;
    DELETE FROM entities; INSERT INTO settings(key,data) VALUES('compactPending','true');`);
  raw.close();
  const before = statSync(path).size;
  // A read-only snapshot, such as scripts/probe-coverage.ts, blocks the checkpoint that returns the space.
  const reader = new DatabaseSync(path, { readOnly: true });
  reader.exec('BEGIN');
  reader.prepare('SELECT COUNT(*) FROM settings').get();
  createStore(path).close();
  reader.exec('COMMIT');
  reader.close();
  const pending = new DatabaseSync(path);
  assert.ok(pending.prepare("SELECT 1 FROM settings WHERE key='compactPending'").get(), 'the blocked compaction stays pending');
  pending.close();
  createStore(path).close();
  const after = new DatabaseSync(path);
  assert.equal(after.prepare("SELECT 1 FROM settings WHERE key='compactPending'").get(), undefined);
  after.close();
  assert.ok(statSync(path).size < before / 2, 'the next start compacts the file');
  rmSync(dir, { recursive: true });
});
