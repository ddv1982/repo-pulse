// Pull requests and builds: active lookups by ID, PR snapshots, reviewer votes, forks and merge results.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../server/store.ts';
import { createHash } from 'node:crypto';
import { createNormalizer } from '../server/normalize.ts';
import { createSync } from '../server/sync.ts';
import { activityMergeBadge } from '../src/activity-text.ts';
import type { SyncProvider } from '../server/sync.ts';
import type { AzureStreamRecord } from '../src/contract.ts';
import { dataOf, fieldsOf, present } from './fixtures/typed.ts';
import { repo } from './fixtures/repository.ts';
import { BASE, setup, push, cachedPr } from './fixtures/sync.ts';
test('old active build is refreshed by ID after disappearing from active results', async () => {
  const build = {
    id: 42,
    repository: { id: 'a' },
    status: 'inProgress',
    queueTime: '2026-11-01T00:00:00Z',
    sourceBranch: 'refs/heads/main',
    sourceVersion: 'a',
  };
  let active = true;
  const provider: SyncProvider = {
    async read() {
      return { items: active ? [build] : [], nextCursor: null };
    },
    async buildsById(_r, ids) {
      assert.deepEqual(ids, ['42']);
      return { items: [{ ...build, status: 'completed', result: 'failed', finishTime: '2026-11-17T10:01:00Z' }], nextCursor: null };
    },
  };
  const { store, sync, advance } = setup(provider, ['activeBuilds']);
  await sync.tick();
  active = false;
  advance();
  await sync.tick();
  assert.equal(store.listEvents().length, 2);
  assert.equal(present(store.listEvents().find(e => e.data?.result === 'failed')).seen, false);
  store.close();
});

for (const nextCursor of [null, { token: 'more' }]) {
  test(`an active build that Azure omits when asked for by ID is asked again only if the answer had more pages (${nextCursor ? 'more' : 'none'})`, async () => {
    const build = {
      id: 42,
      repository: { id: 'a' },
      status: 'inProgress',
      queueTime: '2026-11-01T00:00:00Z',
      sourceBranch: 'refs/heads/main',
      sourceVersion: 'a',
    };
    let active = true;
    const asked: string[][] = [];
    const provider: SyncProvider = {
      async read() {
        return { items: active ? [build] : [], nextCursor: null };
      },
      // Azure answers a build removed by retention with an empty list (docs/probe-results.md).
      async buildsById(_r, ids) {
        asked.push(ids);
        return { items: [], nextCursor };
      },
    };
    const { store, sync, advance } = setup(provider, ['activeBuilds']);
    await sync.tick();
    active = false;
    advance();
    await sync.tick();
    const stream = () => present(store.getStreams().find(state => state.stream === 'activeBuilds'));
    assert.equal(stream().error, null);
    store.saveStream({ ...stream(), nextAt: new Date(BASE + 2000).toISOString() });
    await sync.tick();
    assert.deepEqual(asked, nextCursor ? [['42'], ['42']] : [['42']], 'an omission on the only page ends the lookups');
    assert.equal(store.listEvents().length, 1, 'no event is invented for it');
    store.close();
  });
}

test('PR reactivation creates a fresh event even when its state matches an earlier snapshot', async () => {
  let status = 'active';
  const provider: SyncProvider = {
    async read() {
      return {
        items: [{ pullRequestId: 1, title: 'Fix', status, creationDate: '2026-11-16T10:00:00Z', sourceRefName: 'refs/heads/feature/x' }],
        nextCursor: null,
      };
    },
  };
  const { store, sync, advance } = setup(provider, ['prs']);
  await sync.tick();
  status = 'abandoned';
  advance();
  await sync.tick();
  status = 'active';
  advance();
  await sync.tick();
  assert.equal(store.listEvents().length, 3);
  assert.equal(store.listEvents({ unseen: true }).length, 2);
  store.close();
});

test('a repository removed and added again starts its PR lookup order afresh', async () => {
  let listed: ReturnType<typeof cachedPr>[] = [];
  const lookups: string[] = [];
  const provider: SyncProvider = {
    async read(_r, stream) {
      return { items: stream === 'prs' ? listed : [], nextCursor: null };
    },
    async pullRequest(_repo, id) {
      lookups.push(String(id));
      return cachedPr(Number(id));
    },
  };
  const { store, sync, advance } = setup(provider, ['prs']);
  const onlyPrs = () => {
    for (const state of store.getStreams()) if (state.stream !== 'prs') store.saveStream({ ...state, nextAt: '2099-01-01T00:00:00Z' });
  };
  // PRs 1 to 4 leave the active list, and one read looks up three of them.
  const lookUpOnce = async () => {
    listed = [1, 2, 3, 4].map(id => cachedPr(id));
    advance(600000);
    await sync.tick();
    listed = [];
    advance(600000);
    await sync.tick();
  };
  await lookUpOnce();
  assert.deepEqual(lookups, ['1', '2', '3']);
  store.removeRepo(repo.id);
  advance(600000);
  await sync.tick();
  store.saveRepo(repo);
  sync.refresh();
  onlyPrs();
  // Removal deleted the PRs, and a read that misses none empties the order, so the old order could only resume for
  // active PRs saved before the re-added watch's first lookup.
  store.commitPage({
    repoId: repo.id,
    stream: 'prs',
    entities: [1, 2, 3, 4].map(id => ({ type: 'pr', id: String(id), data: { status: 'active', revision: 1 } })),
  });
  lookups.length = 0;
  advance(600000);
  await sync.tick();
  assert.deepEqual(lookups, ['1', '2', '3'], 'the order the removed watch left is not resumed');
  store.close();
});

test('a cached active PR that Azure can no longer read does not stall the prs stream or its later siblings', async () => {
  let listed = [1, 2, 3, 4, 5].map(id => cachedPr(id));
  const lookups: (number | string)[] = [];
  const unreadable: Record<string, string> = { 1: 'NOT_FOUND', 2: 'WRONG_REPOSITORY' };
  const provider: SyncProvider = {
    async read() {
      return { items: listed, nextCursor: null };
    },
    async pullRequest(_repo, id) {
      lookups.push(id);
      if (unreadable[id]) throw Object.assign(new Error('unreadable'), { code: unreadable[id] });
      return cachedPr(Number(id), 'completed');
    },
  };
  const { store, sync, advance } = setup(provider, ['prs']);
  await sync.tick();
  listed = [];
  advance();
  await sync.tick();
  const prs = () => present(store.getStreams().find(state => state.stream === 'prs'));
  assert.equal(prs().error, null, 'one unreadable PR does not fail the page');
  assert.equal(prs().lastSuccess, new Date(BASE + 2000).toISOString(), 'the listing commits');
  assert.equal(fieldsOf(store.getEntity(repo.id, 'pr', '3')).status, 'completed', 'a readable sibling commits');
  assert.equal(fieldsOf(store.getEntity(repo.id, 'pr', '1')).status, 'active', 'an unreadable PR is left as it was');
  store.saveStream({ ...prs(), nextAt: new Date(BASE + 2000).toISOString() });
  await sync.tick();
  assert.deepEqual(lookups, ['1', '2', '3', '4', '5', '1'], 'later PRs get a turn instead of the same first three');
  assert.equal(fieldsOf(store.getEntity(repo.id, 'pr', '5')).status, 'completed');
  store.close();
});

test('a removed and re-added repository starts its PR lookups and stream rotation afresh', async () => {
  let listed = [1, 2, 3, 4, 5].map(id => cachedPr(id));
  const reads: string[] = [];
  const lookups: string[] = [];
  const provider: SyncProvider = {
    async read(_repo, stream) {
      reads.push(stream);
      return { items: stream === 'prs' ? listed : [], nextCursor: null };
    },
    async pullRequest(_repo, id) {
      lookups.push(String(id));
      throw Object.assign(new Error('gone'), { code: 'NOT_FOUND' });
    },
  };
  const { store, sync, advance } = setup(provider, ['prs']);
  await sync.tick();
  listed = [];
  advance();
  await sync.tick();
  assert.deepEqual(lookups, ['1', '2', '3']);
  const onlyPrsDue = () => {
    for (const state of store.getStreams())
      if (!['prs', 'closedPrs'].includes(state.stream)) store.saveStream({ ...state, nextAt: '2099-01-01T00:00:00Z' });
  };

  store.removeRepo(repo.id);
  sync.forget(repo.id);
  store.saveRepo(repo);
  assert.equal(sync.refresh([repo.id]).scheduled, true);
  onlyPrsDue();
  store.commitPage({
    repoId: repo.id,
    stream: 'prs',
    entities: [1, 2, 3, 4, 5].map(id => ({ type: 'pr', id: String(id), data: { status: 'active' } })),
  });
  reads.length = 0;
  lookups.length = 0;
  await sync.tick();
  assert.deepEqual(reads, ['prs'], 'the old watch having read prs last does not pass the new prs stream over');
  assert.deepEqual(lookups, ['1', '2', '3'], 'lookups start at the first PR, not after the last one the old watch checked');
  store.close();
});

for (const code of ['AUTH_REQUIRED', 'INVALID_RESPONSE']) {
  test(`a ${code} error during a per-PR lookup still fails the prs page`, async () => {
    let listed = [cachedPr(1), cachedPr(2)];
    const provider: SyncProvider = {
      async read() {
        return { items: listed, nextCursor: null };
      },
      async pullRequest(_repo, id) {
        if (id === '2') throw Object.assign(new Error('failed'), { code });
        return cachedPr(Number(id), 'completed');
      },
    };
    const { store, sync, advance } = setup(provider, ['prs']);
    await sync.tick();
    const before = present(store.getStreams().find(state => state.stream === 'prs')).lastSuccess;
    listed = [];
    advance();
    await sync.tick();
    const prs = present(store.getStreams().find(state => state.stream === 'prs'));
    assert.equal(prs.error?.code, code);
    assert.equal(prs.lastSuccess, before, 'the page does not commit');
    assert.equal(fieldsOf(store.getEntity(repo.id, 'pr', '1')).status, 'active', 'no sibling commits from a failed page');
    store.close();
  });
}

test('editing an old active PR after baseline is unseen using observation time', async () => {
  let title = 'Original title';
  const provider: SyncProvider = {
    async read() {
      return { items: [{ pullRequestId: 1, title, status: 'active', creationDate: '2026-10-01T00:00:00Z' }], nextCursor: null };
    },
  };
  const { store, sync, advance } = setup(provider, ['prs']);
  await sync.tick();
  assert.equal(present(store.listEvents()[0]).imported, true);
  title = 'New title';
  advance();
  await sync.tick();
  const changed = present(store.listEvents({ unseen: true })[0]);
  assert.match(present(changed.title), /New title/);
  assert.equal(changed.time, '2026-11-17T10:00:02.000Z');
  store.close();
});

test('project-wide PR results cannot leak another repository into the watched repo', async () => {
  const provider: SyncProvider = {
    async read() {
      return {
        items: [
          { pullRequestId: 1, repository: { id: 'other' }, title: 'Other repo', status: 'active', creationDate: '2026-11-17T10:00:01Z' },
          { pullRequestId: 2, repository: { id: 'A' }, title: 'Watched repo', status: 'active', creationDate: '2026-11-17T10:00:01Z' },
        ],
        nextCursor: null,
      };
    },
  };
  const { store, sync } = setup(provider, ['prs']);
  await sync.tick();
  assert.equal(store.listEvents().length, 1);
  assert.match(present(present(store.listEvents()[0]).title), /Watched repo/);
  assert.equal(store.getEntity('one', 'pr', '1'), undefined);
  assert.equal(store.listEntities('one', 'pr').length, 1);
  store.close();
});

test('completed PR snapshots retain source, target and merge result without extra reads or repeat notifications', async () => {
  let reads = 0;
  const item = {
    pullRequestId: 90,
    repository: { id: 'a' },
    title: 'Fix validation',
    status: 'completed',
    sourceRefName: 'refs/heads/hotfix/validation',
    targetRefName: 'refs/heads/main',
    creationDate: '2026-11-16T09:00:00Z',
    closedDate: '2026-11-17T10:00:01Z',
    createdBy: { displayName: 'PR creator' },
    mergeStatus: 'succeeded',
    lastMergeSourceCommit: { commitId: 'source-sha' },
    lastMergeTargetCommit: { commitId: 'target-before-sha' },
    lastMergeCommit: { commitId: 'merged-result-sha' },
    completionOptions: { mergeStrategy: 'squash' },
  };
  const { store, sync, advance } = setup(
    {
      async read() {
        reads++;
        return { items: [item], nextCursor: null };
      },
    },
    ['closedPrs'],
  );
  await sync.tick();
  const event = present(store.listEvents()[0]);
  assert.equal(dataOf(event).sourceRefName, item.sourceRefName);
  assert.equal(dataOf(event).targetRefName, item.targetRefName);
  assert.equal(dataOf(event).sourceCommit, 'source-sha');
  assert.equal(dataOf(event).targetCommit, 'target-before-sha');
  assert.equal(dataOf(event).mergeCommit, 'merged-result-sha');
  assert.equal(dataOf(event).mergeStatus, 'succeeded');
  assert.equal(dataOf(event).mergeStrategy, 'squash');
  assert.equal(event.actor, 'PR creator', 'the recorded actor is the creator, not an inferred merger');
  assert.equal(event.seen, false);
  advance();
  await sync.tick();
  assert.equal(reads, 2);
  assert.equal(store.listEvents().length, 1, 'unchanged snapshots do not produce metadata-only notifications');
  store.close();
});

test('active preview and abandoned PRs never acquire actual merge-result fields', async () => {
  const items = ['active', 'abandoned'].map((status, index) => ({
    pullRequestId: 100 + index,
    status,
    repository: { id: 'a' },
    title: status,
    creationDate: '2026-11-16T09:00:00Z',
    sourceRefName: 'refs/heads/feature/work',
    targetRefName: 'refs/heads/main',
    mergeStatus: 'succeeded',
    lastMergeCommit: { commitId: 'preview-only' },
    lastMergeTargetCommit: { commitId: 'target-before' },
    completionOptions: { mergeStrategy: 'noFastForward' },
  }));
  const { store, sync } = setup(
    {
      async read() {
        return { items, nextCursor: null };
      },
    },
    ['prs'],
  );
  await sync.tick();
  assert.equal(store.listEvents().length, 2);
  for (const event of store.listEvents()) {
    assert.equal(dataOf(event).mergeCommit, undefined);
    assert.equal(dataOf(event).targetCommit, undefined);
    assert.equal(dataOf(event).mergeStatus, undefined);
    assert.equal(dataOf(event).mergeStrategy, undefined);
  }
  store.close();
});

test('a fork PR keeps where it came from without changing the fingerprint of PRs seen before', async () => {
  const pr = {
    pullRequestId: 5,
    title: 'Fix',
    status: 'active',
    creationDate: '2026-11-16T10:00:00Z',
    sourceRefName: 'refs/heads/fix',
    targetRefName: 'refs/heads/main',
    repository: { id: 'a' },
  };
  let items: AzureStreamRecord[] = [pr];
  const { store, sync, advance } = setup(
    {
      async read() {
        return { items, nextCursor: null };
      },
    },
    ['prs'],
  );
  await sync.tick();
  assert.equal(store.listEvents().length, 1);
  assert.equal(dataOf(store.listEvents()[0]).fork, undefined);
  assert.equal(dataOf(store.listEvents()[0]).sourceRepositoryId, 'a', 'an active PR records where its source branch lives');
  assert.equal(dataOf(store.listEvents()[0]).targetRepositoryId, 'a');
  const forkSource = { name: 'refs/heads/fix', repository: { id: 'f', name: 'One-fork', project: { name: 'Q' } } };
  const forked = { ...pr, forkSource };
  items = [forked];
  advance(600001);
  await sync.tick();
  assert.equal(store.listEvents().length, 1, 'learning the fork source is not a PR update');
  items = [{ ...forked, title: 'Fix, retitled' }];
  advance(600001);
  await sync.tick();
  const latest = present(store.listEvents().find(event => dataOf(event).fork));
  assert.deepEqual(dataOf(latest).fork, { repository: 'One-fork', project: 'Q' });
  assert.equal(dataOf(latest).sourceRepositoryId, 'f');
  store.close();
});

test('a reviewer vote is PR activity, and PRs saved before votes were recorded adopt them quietly', async () => {
  const reviewer = (id: string, vote: number, displayName = id) => ({ id, displayName, vote });
  const pr = {
    pullRequestId: 6,
    title: 'Fix',
    status: 'active',
    creationDate: '2026-11-16T10:00:00Z',
    sourceRefName: 'refs/heads/fix',
    targetRefName: 'refs/heads/main',
    repository: { id: 'a' },
    reviewers: [reviewer('ana', 0, 'Ana'), reviewer('sam', -5, 'Sam')],
  };
  let items: AzureStreamRecord[] = [pr];
  const { store, sync, advance } = setup(
    {
      async read() {
        return { items, nextCursor: null };
      },
    },
    ['prs'],
  );
  // A snapshot from before votes were part of the fingerprint.
  const prs = present(store.getStreams().find(state => state.stream === 'prs'));
  const old = { status: 'active', isDraft: false, title: 'Fix', target: 'refs/heads/main' };
  store.commitPage({
    repoId: 'one',
    stream: 'prs',
    state: { ...prs, initialized: true },
    entities: [{ type: 'pr', id: '6', data: { fingerprint: old, status: 'active', revision: 1 } }],
  });
  await sync.tick();
  assert.equal(store.listEvents().length, 0, 'existing votes are not news after an upgrade');
  items = [{ ...pr, reviewers: [reviewer('ana', 10, 'Ana'), reviewer('sam', -5, 'Sam')] }];
  advance(600001);
  await sync.tick();
  items = [{ ...pr, reviewers: [reviewer('ana', 0, 'Ana'), reviewer('sam', -5, 'Sam')] }];
  advance(600001);
  await sync.tick();
  const changes = store
    .listEvents()
    .sort((a, b) => a.observedAt.localeCompare(b.observedAt))
    .map(event => dataOf(event).voteChanges);
  assert.deepEqual(changes, [[{ name: 'Ana', vote: 10 }], [{ name: 'Ana', vote: 0 }]]);
  assert.deepEqual(
    present(dataOf(store.listEvents()[0]).reviewers)
      .map(item => [item.name, item.vote])
      .sort(([a], [b]) => String(a).localeCompare(String(b))),
    [
      ['Ana', 0],
      ['Sam', -5],
    ],
  );
  store.close();
});

test('a historical PR import keeps the event ID it had before votes were recorded', () => {
  const store = createStore();
  store.saveRepo(repo);
  const normalizer = createNormalizer({ store });
  const closed = {
    pullRequestId: 8,
    title: 'Fix',
    status: 'completed',
    closedDate: '2026-11-10T10:00:00Z',
    targetRefName: 'refs/heads/main',
    lastMergeSourceCommit: { commitId: 'c'.repeat(40) },
    repository: { id: 'a' },
    reviewers: [{ id: 'ana', displayName: 'Ana', vote: 10 }],
  };
  const { events } = normalizer.normalize(repo, 'closedPrs', [closed], { historical: true, initialized: false });
  const before = { status: 'completed', isDraft: false, title: 'Fix', source: 'c'.repeat(40), target: 'refs/heads/main' };
  const hash = createHash('sha256').update(JSON.stringify(before)).digest('hex').slice(0, 24);
  assert.equal(present(events[0]).id, `one:pr:history:8:${hash}`);
  store.close();
});

test('adding a reviewer who has not voted is not PR activity', async () => {
  const pr = {
    pullRequestId: 9,
    title: 'Fix',
    status: 'active',
    creationDate: '2026-11-16T10:00:00Z',
    targetRefName: 'refs/heads/main',
    repository: { id: 'a' },
    reviewers: [{ id: 'ana', displayName: 'Ana', vote: 10 }],
  };
  let items: AzureStreamRecord[] = [pr];
  const { store, sync, advance } = setup(
    {
      async read() {
        return { items, nextCursor: null };
      },
    },
    ['prs'],
  );
  await sync.tick();
  items = [{ ...pr, reviewers: [...pr.reviewers, { id: 'team', displayName: 'Team', vote: 0, isRequired: true }] }];
  advance(600001);
  await sync.tick();
  assert.equal(store.listEvents().length, 1);
  store.close();
});

for (const [order, first, second] of [
  ['push stored first', 'pushes', 'closedPrs'],
  ['PR stored first', 'closedPrs', 'pushes'],
] satisfies [string, string, string][]) {
  test(`a completed PR links to the push that is its result with no merge call, ${order}`, async () => {
    const result = 'c'.repeat(40);
    const items: Record<string, AzureStreamRecord[]> = {
      pushes: [{ ...push(30), refUpdates: [{ name: 'refs/heads/main', oldObjectId: 'a'.repeat(40), newObjectId: result }] }],
      closedPrs: [
        {
          pullRequestId: 91,
          repository: { id: 'a' },
          title: 'Ship it',
          status: 'completed',
          sourceRefName: 'refs/heads/feature/ship',
          targetRefName: 'refs/heads/main',
          closedDate: '2026-11-17T10:00:01Z',
          lastMergeCommit: { commitId: result.toUpperCase() },
          completionOptions: { mergeStrategy: 'squash' },
        },
      ],
    };
    const offered: Record<string, AzureStreamRecord[]> = { pushes: [], closedPrs: [] };
    const store = createStore();
    store.saveRepo(repo);
    let time = BASE;
    const sync = createSync({
      store,
      provider: { read: async (_repo, stream) => ({ items: offered[stream] || [], nextCursor: null }) },
      now: () => time,
      intervalMs: 1000,
    });
    sync.refresh();
    for (const state of store.getStreams())
      if (!['pushes', 'closedPrs'].includes(state.stream)) store.saveStream({ ...state, nextAt: '2099-01-01T00:00:00Z' });
    for (const stream of [first, second]) {
      offered[stream] = present(items[stream]);
      for (let i = 0; i < 2; i++) {
        time += 2000;
        await sync.tick();
      }
    }
    const pushed = store.getEvent('one:push:30');
    assert.ok(pushed, 'push stored');
    assert.ok(
      store.listEvents().some(event => event.kind === 'pr'),
      'PR stored',
    );
    assert.equal(activityMergeBadge(pushed), 'PR evidence');
    assert.deepEqual(
      dataOf(pushed).mergeEvidence?.prs?.map(pr => [pr.pullRequestId, pr.targetRefName, pr.mergeCommit, pr.relationship]),
      [[91, 'refs/heads/main', result.toUpperCase(), 'result-introduced']],
    );
    store.close();
  });
}
