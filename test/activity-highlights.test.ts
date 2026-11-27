import test from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../server/store.ts';
import type { ActivityEvent, EventData } from '../src/activity.ts';

const main = 'refs/heads/main';
const feature = 'refs/heads/feature';
const time = (minute: number) => new Date(Date.UTC(2026, 10, 26, 13, minute)).toISOString();
const event = (id: string, minute: number, kind: ActivityEvent['kind'], data: EventData): ActivityEvent => ({
  id,
  repoId: 'one',
  time: time(minute),
  observedAt: time(minute),
  kind,
  data,
});
const repo = {
  id: 'one',
  name: 'One',
  azureId: 'a',
  organization: 'https://dev.azure.com/org',
  project: 'P',
  webUrl: 'https://dev.azure.com/org/P/_git/One',
  defaultBranch: main,
};
const pr = (id: string, minute: number, fields: EventData = {}) =>
  event(id, minute, 'pr', { pullRequestId: 1, status: 'active', sourceRefName: feature, targetRefName: main, ...fields });
const push = (id: string, minute: number, ref: string, tip: string) =>
  event(id, minute, 'push', { refUpdates: [{ name: ref, oldObjectId: 'a'.repeat(40), newObjectId: tip }] });
const ids = (items: ActivityEvent[]) => items.map(item => item.id);

test('highlights are selected before pagination, with a shared unread scope and pinned late merge evidence', () => {
  const store = createStore(':memory:', { highlights: true });
  store.saveRepo(repo);
  const landing = 'b'.repeat(40);
  store.insertEvents([
    pr('draft', 1, { isDraft: true }),
    pr('ready', 2),
    pr('preview-only', 3, { previewCommit: 'preview' }),
    push('direct', 4, main, 'c'.repeat(40)),
    push('landing-push', 5, main, landing),
    push('routine', 6, feature, 'd'.repeat(40)),
  ]);
  const page = store.queryActivity({ limit: 1 });
  assert.deepEqual(ids(page.items), ['landing-push']);
  assert.equal(page.total, 3);
  assert.equal(page.newItems, 3);
  assert.ok(page.nextCursor);
  store.insertEvents([pr('merge', 7, { status: 'completed', mergeStrategy: 'squash', mergeCommit: landing })]);
  assert.deepEqual(ids(store.queryActivity({ limit: 2, cursor: page.nextCursor }).items), ['direct', 'ready']);
  assert.deepEqual(ids(store.queryActivity().items), ['merge', 'direct', 'ready']);
  assert.deepEqual(ids(store.queryActivity({ view: 'new', kind: 'push' }).items), ['direct']);
  assert.deepEqual(store.queryActivity({ search: 'routine' }).items, []);
  const unseen = store.queryActivity.unseenIds({ through: page.asOf });
  assert.deepEqual([...unseen].sort(), ['direct', 'landing-push', 'ready']);
  store.acknowledge(unseen);
  assert.deepEqual(ids(store.queryActivity({ view: 'new' }).items), ['merge']);
  assert.equal(store.getEvent('routine')?.seen, false);
  const merge = store.getEvent('merge');
  assert.ok(merge);
  assert.ok(ids(store.relatedActivity(merge)).includes('landing-push'));
  store.close();
});

test('historical terminal PRs stay seen and live transitions preserve separate milestones', () => {
  const store = createStore(':memory:', { highlights: true });
  store.saveRepo(repo);
  const approved = [{ name: 'Required', vote: 10, required: true }];
  store.insertEvents([
    { ...pr('old-active', 1, { pullRequestId: 2 }), imported: true },
    { ...pr('old-merge', 2, { pullRequestId: 3, status: 'completed' }), imported: true },
    pr('ready', 3),
    pr('retargeted', 4, { targetRefName: 'refs/heads/release' }),
    pr('blocked', 5, { targetRefName: 'refs/heads/release', voteChanges: [{ name: 'Required', vote: -5 }] }),
    pr('approval', 6, { targetRefName: 'refs/heads/release', reviewers: approved, voteChanges: approved }),
    pr('abandoned', 7, { status: 'abandoned' }),
    pr('reopened', 8),
  ]);
  assert.deepEqual(
    store.queryActivity().items.map(item => item.highlight),
    ['reopened', 'abandoned', 'review-approved', 'review-blocked', 'retargeted', 'review-ready', 'merged'],
  );
  assert.equal(store.queryActivity({ view: 'new' }).total, 6);
  store.close();
});

const run = (id: string, minute: number, definition: number, result: string, revision: string, fields: EventData = {}) =>
  event(id, minute, 'build', {
    buildId: Number(id),
    definition: { id: definition },
    result,
    status: 'completed',
    sourceBranch: 'refs/pull/1/merge',
    sourceVersion: revision,
    buildStartedAt: time(minute),
    ...fields,
  });

test('CI rolls up exact and known later revisions by pipeline, with attempts reachable through the PR', () => {
  const store = createStore(':memory:', { highlights: true });
  store.saveRepo(repo);
  store.insertEvents([
    pr('ready', 1, { previewCommit: 'old' }),
    run('1', 2, 1, 'failed', 'old'),
    run('2', 3, 1, 'failed', 'old'),
    run('3', 4, 2, 'succeeded', 'old'),
    pr('new-preview', 5, { previewCommit: 'new' }),
    run('4', 6, 1, 'succeeded', 'new'),
    run('5', 7, 1, 'failed', 'new'),
    run('6', 8, 1, 'failed', 'new', { sourceBranch: main }),
    run('7', 9, 1, 'failed', 'unknown', { sourceBranch: 'refs/pull/2/merge' }),
  ]);
  assert.deepEqual(ids(store.queryActivity().items), ['7', '6', '5', '1', 'ready']);
  const reviewed = store.queryActivity().items.find(item => item.id === 'ready');
  assert.ok(reviewed?.relatedCi?.some(ci => ci.id === '4' && ci.outcome === 'passing again'));
  assert.equal(store.queryActivity().items.find(item => item.id === '1')?.ciHost, 'ready');
  const host = store.getEvent('ready');
  assert.ok(host);
  assert.ok(ids(store.relatedActivity(host)).includes('2'));
  assert.equal(store.getEvent('2')?.seen, false);
  store.close();
});

test('a verified landing run leads validation history and an off-cap failing pipeline stays visible', () => {
  const store = createStore(':memory:', { highlights: true });
  store.saveRepo(repo);
  const landing = { sourceBranch: main, reason: 'individualCI' };
  store.insertEvents([
    pr('ready', 1, { previewCommit: 'preview' }),
    run('1', 2, 1, 'failed', 'preview'),
    pr('merge', 3, { status: 'completed', mergeCommit: 'landed' }),
    run('2', 4, 2, 'succeeded', 'landed', landing),
  ]);
  const merge = () => store.queryActivity({ search: 'main' }).items.find(item => item.id === 'merge');
  assert.deepEqual(
    merge()?.ciSummary?.results.map(result => [result.run.id, result.tone]),
    [['2', 'ok']],
  );
  assert.equal(merge()?.ciSummary?.historyCount, 1);
  store.insertEvents([
    run('3', 5, 3, 'failed', 'landed', landing),
    ...Array.from({ length: 7 }, (_, index) => run(String(index + 4), index + 6, 2, 'succeeded', 'landed', landing)),
    run('11', 13, 3, 'succeeded', 'landed', { ...landing, reason: 'schedule' }),
  ]);
  assert.ok(merge()?.ciSummary?.results.some(result => result.run.id === '3' && result.tone === 'crit'));
  assert.ok(!merge()?.relatedCi?.some(run => run.id === '11'));
  assert.equal(merge()?.ciSummary?.historyCount, 9);
  store.close();
});

test('a manual run alone cannot hide validation failure, but a verified landing retry can recover its pipeline', () => {
  const store = createStore(':memory:', { highlights: true });
  store.saveRepo(repo);
  const landing = { sourceBranch: main };
  const result = () => store.queryActivity().items.find(item => item.id === 'merge')?.ciSummary?.results[0];
  store.insertEvents([
    pr('ready', 1, { previewCommit: 'preview' }),
    run('1', 2, 1, 'failed', 'preview'),
    pr('merge', 3, { status: 'completed', mergeCommit: 'landed' }),
    run('2', 4, 2, 'succeeded', 'landed', { ...landing, reason: 'manual' }),
  ]);
  assert.equal(result()?.run.id, '1');
  store.insertEvents([run('3', 5, 2, 'failed', 'landed', { ...landing, reason: 'individualCI' })]);
  assert.equal(result()?.run.id, '3');
  store.insertEvents([run('4', 6, 2, 'succeeded', 'landed', { ...landing, reason: 'manual' })]);
  assert.equal(result()?.run.id, '4');
  assert.equal(result()?.tone, 'ok');
  store.insertEvents([run('5', 7, 3, 'failed', 'landed', { ...landing, reason: 'manual' })]);
  assert.equal(result()?.run.id, '5');
  store.insertEvents([run('6', 8, 3, 'succeeded', 'landed', { ...landing, reason: 'manual' })]);
  assert.equal(result()?.run.id, '4');

  store.insertEvents([
    pr('another-merge', 9, { pullRequestId: 2, status: 'completed', mergeCommit: 'another' }),
    run('7', 10, 3, 'succeeded', 'another', { ...landing, reason: 'manual' }),
  ]);
  const manualOnly = store.queryActivity().items.find(item => item.id === 'another-merge')?.ciSummary?.results[0];
  assert.equal(manualOnly?.note, 'trigger unverified');
  assert.equal(manualOnly?.tone, 'neutral');
  store.close();
});

test('CI heads by revision and start evidence, and a pending retry keeps the last failure visible', () => {
  const store = createStore(':memory:', { highlights: true });
  store.saveRepo(repo);
  const summary = () => store.queryActivity().items.find(item => item.id === 'ready')?.ciSummary?.results;
  store.insertEvents([
    pr('ready', 1, { previewCommit: 'preview' }),
    run('1', 15, 1, 'succeeded', 'preview', { buildStartedAt: time(10) }),
    run('2', 4, 1, 'failed', 'preview', { buildStartedAt: time(2) }),
  ]);
  assert.equal(summary()?.[0]?.run.id, '1');
  store.insertEvents([
    run('3', 13, 1, 'failed', 'preview', { buildStartedAt: time(11) }),
    run('4', 14, 1, '', 'preview', { status: 'inProgress' }),
  ]);
  assert.deepEqual(
    summary()?.map(result => [result.run.id, result.tone]),
    [
      ['3', 'crit'],
      ['4', 'neutral'],
    ],
  );
  store.insertEvents([
    pr('reviewers-updated', 16, { previewCommit: 'preview', reviewers: [{ name: 'Pat', vote: 5 }] }),
    run('5', 17, 1, 'succeeded', 'preview', { buildStartedAt: '' }),
  ]);
  assert.equal(summary()?.[0]?.note, 'retry order unknown');
  store.insertEvents([
    pr('new-preview', 22, { previewCommit: 'updated' }),
    run('6', 20, 1, 'failed', 'updated', { buildStartedAt: time(16) }),
    run('7', 21, 1, 'succeeded', 'unrecorded', { buildStartedAt: time(17) }),
  ]);
  assert.deepEqual(
    summary()?.map(result => [result.run.id, result.tone]),
    [['6', 'crit']],
  );
  store.insertEvents([run('8', 23, 1, 'succeeded', 'updated', { buildStartedAt: time(22) })]);
  assert.deepEqual(
    summary()?.map(result => [result.run.id, result.tone]),
    [['8', 'ok']],
  );
  store.insertEvents([run('9', 25, 1, 'failed', 'unrecorded', { buildStartedAt: time(24) })]);
  assert.equal(summary()?.[0]?.note, 'revision unknown');
  assert.equal(summary()?.[0]?.tone, 'warn');
  store.close();
});

test('prefers a live merge, adopts delayed landing SHA and leaves later pushes to that SHA visible', () => {
  const store = createStore(':memory:', { highlights: true });
  store.saveRepo(repo);
  const landing = 'b'.repeat(40);
  store.insertEvents([
    { ...pr('history-merge', 3, { pullRequestId: '1', status: 'completed', mergeCommit: landing }), imported: true },
    push('actual-push', 2, main, landing),
    pr('live-merge', 3, { status: 'completed' }),
    pr('new-evidence', 4, { status: 'completed', mergeCommit: landing }),
    push('later-reset', 60, main, landing),
  ]);
  const page = store.queryActivity();
  assert.deepEqual(ids(page.items), ['later-reset', 'live-merge']);
  assert.equal(page.items.find(item => item.id === 'live-merge')?.data?.mergeCommit, landing);
  assert.equal(page.newItems, 2);
  assert.equal(store.getEvent('later-reset')?.data?.mergeEvidence?.prs?.length, 1);
  store.saveRewriteResult({ eventId: 'later-reset', jobId: 'check-reset', rewrite: { ref: main, status: 'rewrite', dropped: 2 } });
  const reset = store.queryActivity().items.find(item => item.id === 'later-reset');
  assert.equal(reset?.highlight, 'rewrite');
  assert.deepEqual(reset?.data?.mergeEvidence?.prs, []);
  assert.equal(reset?.data?.mergeEvidence?.rewrite?.[0]?.dropped, 2);

  store.close();
});

test('a live draft transition after an import is shown once and a late build snapshot keeps the full failure group', () => {
  const store = createStore(':memory:', { highlights: true });
  store.saveRepo(repo);
  store.saveRepo({ ...repo, id: 'two' });
  store.insertEvents([
    { ...pr('imported-draft', 1, { isDraft: true }), imported: true },
    pr('ready', 2, { previewCommit: 'head' }),
    run('1', 4, 1, 'failed', 'head'),
    { ...run('older-running', 3, 1, '', 'head', { buildId: 1, status: 'inProgress' }) },
    { ...run('2', 5, 1, 'succeeded', 'head'), repoId: 'two' },
  ]);
  const page = store.queryActivity({ kind: 'status:failed' });
  assert.deepEqual(ids(page.items), ['1']);
  assert.deepEqual(page.items[0]?.unseenIds, ['1', 'older-running']);
  assert.deepEqual(
    store.queryActivity().items.map(item => item.highlight),
    ['ci-failed', 'review-ready'],
  );
  const unseen = store.queryActivity.unseenIds({ kind: 'status:failed', through: page.asOf });
  store.acknowledge(unseen);
  assert.ok(store.getEventGroup('1').every(event => event.seen));
  store.close();
});

test('an unverified failure does not claim recovery or mute a later verified regression', () => {
  const store = createStore(':memory:', { highlights: true });
  store.saveRepo(repo);
  store.insertEvents([
    pr('ready', 1, { previewCommit: 'known' }),
    run('1', 2, 1, 'failed', 'unknown'),
    run('2', 3, 1, 'failed', 'other-unknown'),
    run('3', 4, 1, 'succeeded', 'known'),
    run('4', 5, 1, 'failed', 'known'),
    run('5', 6, 1, 'failed', 'orphan', { sourceBranch: 'refs/pull/2/merge' }),
    run('6', 7, 1, 'failed', 'orphan', { sourceBranch: 'refs/pull/2/merge' }),
  ]);
  const page = store.queryActivity();
  assert.deepEqual(ids(page.items), ['5', '4', '1', 'ready']);
  assert.equal(page.items.find(item => item.id === 'ready')?.relatedCi?.find(ci => ci.id === '3')?.outcome, 'passed');
  store.close();
});

test('a pass on a known revision does not break deduplication or recovery on a subsequent unrecorded revision', () => {
  const store = createStore(':memory:', { highlights: true });
  store.saveRepo(repo);
  store.insertEvents([
    pr('ready', 1, { previewCommit: 'known' }),
    run('1', 2, 1, 'failed', 'unknown-old'),
    run('2', 3, 1, 'succeeded', 'known'),
    run('3', 4, 1, 'failed', 'unknown-new'),
    run('4', 5, 1, 'failed', 'unknown-new'),
    run('5', 6, 1, 'succeeded', 'unknown-new'),
    run('6', 7, 1, 'failed', 'known'),
    run('7', 8, 1, 'succeeded', 'known'),
  ]);
  const page = store.queryActivity();
  assert.deepEqual(ids(page.items), ['6', '3', '1', 'ready']);
  const ci = page.items.find(item => item.id === 'ready')?.relatedCi ?? [];
  assert.equal(ci.find(run => run.id === '5')?.outcome, 'passing again');
  assert.equal(ci.find(run => run.id === '7')?.outcome, 'passing again');
  store.close();
});

test('first live approval after an imported baseline needs a recorded vote change', () => {
  const store = createStore(':memory:', { highlights: true });
  store.saveRepo(repo);
  const reviewers = [{ name: 'Required', vote: 10, required: true }];
  store.insertEvents([
    { ...pr('baseline', 1, { reviewers: [{ name: 'Required', vote: 0, required: true }] }), imported: true },
    pr('announcement', 2, { reviewers, voteChanges: reviewers }),
    pr('other-pr', 3, { pullRequestId: 2 }),
    pr('new-preview', 4, { pullRequestId: 2, reviewers, voteChanges: [], previewCommit: 'sha' }),
  ]);
  assert.deepEqual(ids(store.queryActivity().items), ['other-pr', 'announcement']);
  assert.equal(store.queryActivity().items.find(item => item.id === 'announcement')?.highlight, 'review-approved');
  store.close();
});
