import test from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../server/store.js';
import { createNormalizer } from '../server/normalize.js';

const repo = {
  id: 'repo-one',
  name: 'One',
  azureId: 'azure-repo-1',
  organization: 'https://dev.azure.com/org',
  project: 'Proj',
  webUrl: 'https://dev.azure.com/org/Proj/_git/One',
};

const NOW = Date.parse('2026-11-18T12:00:00Z');
const ZERO = '0'.repeat(40);
const OLD = 'a'.repeat(40);
const NEW = 'b'.repeat(40);

function makeFixture() {
  const store = createStore();
  store.saveRepo(repo);
  store.setSetting(`baseline:${repo.id}`, '2026-11-18T11:00:00.000Z');
  const normalizer = createNormalizer({ store, now: () => NOW });
  return { store, ...normalizer };
}

test('normalize emits push events, ref updates, and rewrite jobs only for live branch moves', () => {
  const { store, normalize } = makeFixture();
  try {
    const live = normalize(
      repo,
      'pushes',
      [
        {
          pushId: 101,
          date: '2026-11-18T11:30:00Z',
          pushedBy: { displayName: 'Ada' },
          refUpdates: [{ name: 'refs/heads/main', oldObjectId: OLD, newObjectId: NEW }],
        },
        {
          pushId: 102,
          date: '2026-11-18T11:35:00Z',
          pushedBy: { displayName: 'Ada' },
          refUpdates: [{ name: 'refs/tags/v1.0.0', oldObjectId: ZERO, newObjectId: NEW }],
        },
      ],
      { initialized: true },
    );

    assert.deepEqual(
      live.events.map(e => e.kind),
      ['push', 'tag'],
    );
    assert.equal(live.events[0].imported, false);
    assert.equal(live.events[0].seen, false);
    assert.equal(live.jobs?.length, 1);
    assert.equal(live.jobs?.[0].ref, 'refs/heads/main');
    assert.ok(live.entities.some(e => e.type === 'ref' && e.id === 'refs/heads/main' && e.data.lastPushId === 101));

    const historical = normalize(
      repo,
      'pushes',
      [
        {
          pushId: 99,
          date: '2026-11-18T10:00:00Z',
          pushedBy: { displayName: 'Grace' },
          refUpdates: [{ name: 'refs/heads/main', oldObjectId: OLD, newObjectId: NEW }],
        },
      ],
      { initialized: false, historical: true },
    );

    assert.equal(historical.events.length, 1);
    assert.equal(historical.events[0].imported, true);
    assert.equal(historical.events[0].seen, true);
    assert.equal(historical.jobs?.length, 0);
    assert.equal(
      historical.entities.some(e => e.type === 'ref'),
      false,
    );
  } finally {
    store.close();
  }
});

test('normalize fingerprints PRs and builds, filters foreign repos, and tracks reviewer votes', () => {
  const { store, normalize } = makeFixture();
  try {
    const basePr = {
      pullRequestId: 42,
      repository: { id: 'azure-repo-1' },
      title: 'Add metrics',
      status: 'active',
      isDraft: false,
      sourceRefName: 'refs/heads/feat/metrics',
      targetRefName: 'refs/heads/main',
      creationDate: '2026-11-18T11:10:00Z',
      createdBy: { displayName: 'Ada' },
      lastMergeSourceCommit: { commitId: OLD },
      lastMergeCommit: { commitId: NEW },
      mergeStatus: 'succeeded',
      reviewers: [{ id: 'rev-1', displayName: 'Sam', vote: 0, isRequired: true }],
    };

    const foreignPr = { ...basePr, pullRequestId: 99, repository: { id: 'other-repo' } };
    const first = normalize(repo, 'prs', [basePr, foreignPr], { initialized: true });
    assert.equal(first.events.length, 1);
    assert.equal(first.events[0].data?.mergeCommit, undefined, 'active PR must not store completion mergeCommit');
    assert.deepEqual(first.events[0].data?.voteChanges, []);
    store.commitPage({
      repoId: repo.id,
      stream: 'prs',
      state: { repoId: repo.id, stream: 'prs', initialized: true, nextAt: '2026-11-18T12:03:00Z' },
      ...first,
    });

    const unchanged = normalize(repo, 'prs', [basePr], { initialized: true });
    assert.equal(unchanged.events.length, 0);

    const voted = normalize(repo, 'prs', [{ ...basePr, reviewers: [{ id: 'rev-1', displayName: 'Sam', vote: 10, isRequired: true }] }], {
      initialized: true,
    });
    assert.equal(voted.events.length, 1);
    assert.deepEqual(voted.events[0].data?.voteChanges, [{ name: 'Sam', vote: 10 }]);

    const build = normalize(
      repo,
      'builds',
      [
        {
          id: 500,
          buildNumber: '20261118.1',
          repository: { id: 'azure-repo-1' },
          definition: { name: 'CI' },
          status: 'completed',
          result: 'succeeded',
          sourceBranch: 'refs/heads/main',
          sourceVersion: NEW,
          finishTime: '2026-11-18T11:45:00Z',
        },
        {
          id: 501,
          repository: { id: 'other-repo' },
          status: 'completed',
          result: 'failed',
        },
      ],
      { initialized: true },
    );
    assert.equal(build.events.length, 1);
    assert.equal(build.events[0].kind, 'build');
    assert.equal(build.events[0].title, 'CI · 20261118.1');
  } finally {
    store.close();
  }
});

test('reconcileRefs records baseline silently and reports later branch and tag additions and removals', () => {
  const { store, reconcileRefs } = makeFixture();
  try {
    const baseline = reconcileRefs(
      repo,
      [
        { name: 'refs/heads/main', objectId: OLD },
        { name: 'refs/tags/v1', objectId: OLD, peeledObjectId: NEW },
        { name: 'refs/pull/1/merge', objectId: OLD },
      ],
      { initialized: false, window: { until: '2026-11-18T12:00:00.000Z' } },
    );
    assert.equal(baseline.events.length, 0);
    assert.ok(baseline.entities.some(e => e.type === 'ref-baseline' && e.id === 'tags'));
    assert.equal(
      baseline.entities.some(e => e.id === 'refs/pull/1/merge'),
      false,
    );
    store.commitPage({
      repoId: repo.id,
      stream: 'refs',
      state: { repoId: repo.id, stream: 'refs', initialized: true, nextAt: '2026-11-18T12:10:00Z' },
      ...baseline,
    });

    const next = reconcileRefs(
      repo,
      [
        { name: 'refs/heads/release', objectId: NEW },
        { name: 'refs/tags/v2', objectId: NEW, peeledObjectId: OLD },
      ],
      { initialized: true, window: { until: '2026-11-18T12:10:00.000Z' } },
    );
    assert.deepEqual(
      next.events.map(e => [e.kind, e.branch, e.data?.change ?? null]),
      [
        ['branch-created', 'release', null],
        ['tag', 'v2', 'created'],
        ['branch-deleted', 'main', null],
        ['tag', 'v1', 'deleted'],
      ],
    );
    assert.equal(next.events[1].data?.peeledObjectId, OLD);
  } finally {
    store.close();
  }
});
