import test from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../server/store.ts';
import { createNormalizer } from '../server/normalize.ts';
import { present } from './fixtures/typed.ts';

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
  store.setBaseline(repo.id, '2026-11-18T11:00:00.000Z');
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
    assert.equal(present(live.events[0]).imported, false);
    assert.equal(present(live.events[0]).seen, false);
    assert.equal(live.jobs?.length, 1);
    assert.equal(present(live.jobs?.[0]).ref, 'refs/heads/main');
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
    assert.equal(present(historical.events[0]).imported, true);
    assert.equal(present(historical.events[0]).seen, true);
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
    assert.equal(present(first.events[0]).data?.mergeCommit, undefined, 'active PR must not store completion mergeCommit');
    assert.deepEqual(present(first.events[0]).data?.voteChanges, []);
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
    assert.deepEqual(present(voted.events[0]).data?.voteChanges, [{ name: 'Sam', vote: 10 }]);

    const baseBuild = {
      id: 500,
      buildNumber: '20261118.1',
      repository: { id: 'azure-repo-1' },
      definition: { name: 'CI' },
      status: 'inProgress',
      result: undefined,
      sourceBranch: 'refs/heads/main',
      sourceVersion: NEW,
      startTime: '2026-11-18T11:40:00Z',
    };
    const build = normalize(
      repo,
      'builds',
      [
        baseBuild,
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
    assert.equal(present(build.events[0]).kind, 'build');
    assert.equal(present(build.events[0]).title, 'CI');
    store.commitPage({
      repoId: repo.id,
      stream: 'builds',
      state: { repoId: repo.id, stream: 'builds', initialized: true, nextAt: '2026-11-18T12:03:00Z' },
      ...build,
    });

    const unchangedBuild = normalize(repo, 'builds', [baseBuild], { initialized: true });
    assert.equal(unchangedBuild.events.length, 0);

    const finishedBuild = normalize(
      repo,
      'builds',
      [{ ...baseBuild, status: 'completed', result: 'succeeded', finishTime: '2026-11-18T11:45:00Z' }],
      { initialized: true },
    );
    assert.equal(finishedBuild.events.length, 1);
    assert.equal(present(finishedBuild.events[0]).data?.result, 'succeeded');
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
    assert.equal(present(next.events[1]).data?.peeledObjectId, OLD);
  } finally {
    store.close();
  }
});

test('a push that only moves pull request refs is Azure bookkeeping and makes no push row', () => {
  const { store, normalize } = makeFixture();
  const service = { displayName: 'Microsoft.VisualStudio.Services.TFS' };
  try {
    const { events, entities } = normalize(
      repo,
      'pushes',
      [
        // The shape Azure returns when it refreshes or creates the merge preview of a pull request.
        {
          pushId: 201,
          date: '2026-11-18T11:30:00Z',
          pushedBy: service,
          refUpdates: [{ name: 'refs/pull/11/merge', oldObjectId: OLD, newObjectId: NEW }],
        },
        {
          pushId: 202,
          date: '2026-11-18T11:31:00Z',
          pushedBy: service,
          refUpdates: [{ name: 'refs/pull/12/merge', oldObjectId: ZERO, newObjectId: NEW }],
        },
        { pushId: 203, date: '2026-11-18T11:32:00Z', pushedBy: service, refUpdates: [] },
        {
          pushId: 204,
          date: '2026-11-18T11:33:00Z',
          pushedBy: { displayName: 'Ada' },
          refUpdates: [
            { name: 'refs/pull/7/merge', oldObjectId: OLD, newObjectId: ZERO },
            { name: 'refs/heads/main', oldObjectId: OLD, newObjectId: NEW },
          ],
        },
      ],
      { initialized: true },
    );
    assert.deepEqual(
      events.map(event => [event.kind, event.data?.pushId, event.branch]),
      [
        ['push', 203, ''],
        ['push', 204, 'main'],
      ],
      'a push without any ref update, and one that also moves a branch, are kept',
    );
    assert.deepEqual(
      entities.filter(entity => entity.type === 'push').map(entity => entity.id),
      ['201', '202', '203', '204'],
      'every push is remembered',
    );
  } finally {
    store.close();
  }
});

test('a PR with a malformed title keeps the fingerprint and IDs main gave it, so it is not reported again live or on re-import', () => {
  const record = {
    pullRequestId: 7,
    status: 'completed',
    title: false,
    repository: { id: repo.azureId },
    sourceRefName: 'refs/heads/topic',
    targetRefName: 'refs/heads/main',
    creationDate: '2026-11-18T10:00:00Z',
    closedDate: '2026-11-18T11:00:00Z',
    lastMergeSourceCommit: { commitId: OLD },
    lastMergeCommit: { commitId: NEW },
  };
  // What origin/main 844c7b6 makes of this record: the fingerprint keeps the raw title, and both IDs hash it.
  const stored = { status: 'completed', isDraft: false, title: false, source: OLD, target: 'refs/heads/main', votes: [] };
  const fresh = makeFixture();
  try {
    const live = fresh.normalize(repo, 'prs', [record], { initialized: true });
    assert.deepEqual(
      live.events.map(event => [event.id, event.title]),
      [['repo-one:pr:7:1:6dd098039132df677cced0d5', 'PR 7 · Untitled']],
    );
    assert.deepEqual(live.entities, [{ type: 'pr', id: '7', data: { fingerprint: stored, status: 'completed', revision: 1 } }]);
    const history = fresh.normalize(repo, 'closedPrs', [record], { initialized: true, historical: true });
    assert.deepEqual(
      history.events.map(event => event.id),
      ['repo-one:pr:history:7:9e73c8a50a61a8fdc686289c'],
      'a re-import finds the row main imported',
    );
  } finally {
    fresh.store.close();
  }
  // Sol's probe: the PR as main stored it, then the identical record read again after the upgrade.
  const upgraded = makeFixture();
  try {
    upgraded.store.commitPage({
      repoId: repo.id,
      stream: 'prs',
      events: [],
      entities: [{ type: 'pr', id: '7', data: { fingerprint: stored, status: 'completed', revision: 1 } }],
    });
    assert.deepEqual(upgraded.normalize(repo, 'prs', [record], { initialized: true }).events, [], 'no second row');
  } finally {
    upgraded.store.close();
  }
});

test('active PR milestones record delayed and refreshed merge previews without repeating unchanged previews', t => {
  const { store, normalize } = makeFixture();
  t.after(() => store.close());
  const pr = {
    pullRequestId: 19,
    status: 'active',
    title: 'Check the work',
    repository: { id: repo.azureId },
    sourceRefName: 'refs/heads/topic',
    targetRefName: 'refs/heads/main',
    lastMergeSourceCommit: { commitId: OLD },
  };
  const poll = (commitId?: string) => {
    const record = commitId ? { ...pr, lastMergeCommit: { commitId } } : pr;
    const { events, entities } = normalize(repo, 'prs', [record], { initialized: true });
    store.commitPage({ repoId: repo.id, stream: 'prs', events, entities });
    return events;
  };

  assert.equal(present(poll()[0]).data?.previewCommit, undefined);
  assert.equal(present(poll(NEW)[0]).data?.previewCommit, NEW);
  assert.deepEqual(poll(NEW.toUpperCase()), []);
  const refreshed = 'c'.repeat(40);
  const milestone = present(poll(refreshed)[0]);
  assert.equal(milestone.data?.previewCommit, refreshed);
  assert.equal(milestone.data?.mergeCommit, undefined);
  assert.deepEqual(poll(refreshed), []);
});

test('the first poll adopts an active PR preview into an older fingerprint without adding an unread milestone', t => {
  const { store, normalize } = makeFixture();
  t.after(() => store.close());
  const pr = {
    pullRequestId: 23,
    status: 'active',
    title: 'Already tracked',
    repository: { id: repo.azureId },
    sourceRefName: 'refs/heads/topic',
    targetRefName: 'refs/heads/main',
    lastMergeSourceCommit: { commitId: OLD },
    lastMergeCommit: { commitId: NEW },
  };
  store.commitPage({
    repoId: repo.id,
    stream: 'prs',
    events: [],
    entities: [
      {
        type: 'pr',
        id: '23',
        data: {
          fingerprint: { status: 'active', isDraft: false, title: pr.title, source: OLD, target: pr.targetRefName, votes: [] },
          status: 'active',
          revision: 1,
        },
      },
    ],
  });

  const { events, entities } = normalize(repo, 'prs', [pr], { initialized: true });
  assert.deepEqual(events, []);
  store.commitPage({ repoId: repo.id, stream: 'prs', events, entities });
  assert.equal(store.getEntity(repo.id, 'pr', '23')?.fingerprint?.previewCommit, NEW);
  const refreshed = 'c'.repeat(40);
  const later = normalize(repo, 'prs', [{ ...pr, lastMergeCommit: { commitId: refreshed } }], { initialized: true });
  assert.equal(present(later.events[0]).data?.previewCommit, refreshed);
});
