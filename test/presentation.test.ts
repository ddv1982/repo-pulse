import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildState,
  activityLabel as activityLabelOf,
  activityTone as activityToneOf,
  activityTitle as activityTitleOf,
  triggerLabel,
  streamLabel,
  activitySummary as activitySummaryOf,
  labels,
} from '../src/ui/format.ts';
import { renderRepositories as renderRepositoriesHtml } from '../src/ui/repositories.ts';
import { scopeName } from '../src/ui/header.ts';
import { createStore } from '../server/store.ts';
import type { ActivityEvent, ActivityKind, EventData, EvidencePr } from '../src/activity.ts';
import type { Repository, StreamError, StreamState } from '../src/contract.d.ts';
import type { PageState } from '../src/ui/refresh.ts';
import { present, stub } from './fixtures/typed.ts';

// The tests give the views and labels only the fields they read: an event of a kind with its data, a page state
// without the parts a view leaves alone.
type Event = Partial<ActivityEvent>;
type State = Partial<PageState>;
const stringError = (stream: Partial<StreamState>, error: string) =>
  stub<StreamState>({ ...stream, error: error as unknown as StreamError });
const activityLabel = (event: Event) => activityLabelOf(stub<ActivityEvent>(event));
const activityTone = (event: Event) => activityToneOf(stub<ActivityEvent>(event));
const activityTitle = (event: Event) => activityTitleOf(stub<ActivityEvent>(event));
const activitySummary = (event: Event) => activitySummaryOf(stub<ActivityEvent>(event));
const renderRepositories = (state: State, ...rest: Parameters<typeof renderRepositoriesHtml> extends [unknown, ...infer R] ? R : never) =>
  String(renderRepositoriesHtml(stub<PageState>(state), ...rest));

test('CI presentation maps real statuses and results without calling a running retry failed', () => {
  assert.deepEqual(buildState({ data: { status: 'notStarted' } }), { label: 'Queued', tone: 'info' });
  assert.equal(buildState({ data: { status: 'inProgress', result: 'failed' } }).label, 'Running');
  assert.equal(buildState({ data: { status: 'completed', result: 'failed' } }).label, 'Failed');
  assert.equal(buildState({ data: { status: 'completed', result: 'partiallySucceeded' } }).label, 'Partially succeeded');
  assert.equal(buildState({ data: { status: 'completed', result: 'canceled' } }).label, 'Canceled');
  assert.equal(buildState({ data: { status: 'completed' } }).label, 'Unknown');
  assert.equal(triggerLabel('manual'), 'Triggered manually');
  assert.equal(streamLabel('closedPrs'), 'Closed pull requests');
});

test('missing branch observations are never presented as confirmed deletions', () => {
  const event: Event = { kind: 'branch-deleted', data: { evidence: 'snapshot' } };
  assert.equal(activityLabel(event), 'No longer listed');
  assert.match(activitySummary(event), /deletion not confirmed/);
  assert.equal(activityLabel({ ...event, data: { evidence: 'push' } }), 'Branch deleted');
  const deleted: Event = { ...event, title: 'Branch missing', branch: 'hotfix/old', data: { evidence: 'push' } };
  assert.equal(activityTitle(deleted), 'Branch deleted · hotfix/old');
  assert.equal(labels['branch-deleted'], 'Branch deleted');
});

test('repository details keep failure text and one timestamp without routine source labels', () => {
  const state: State = {
    watched: [stub<Repository>({ id: 'r', name: 'Orders' })],
    settings: { refreshEnabled: false },
    syncStatus: { overall: { state: 'paused', repoId: 'r' }, repos: { r: { state: 'paused' } } },
    streams: [
      stub<StreamState>({ repoId: 'r', stream: 'refs', initialized: true, lastSuccess: '2026-11-01T10:00:00Z' }),
      stringError({ repoId: 'r', stream: 'prs', initialized: true, nextAt: '2026-11-01T10:00:00Z' }, 'Read refused'),
    ],
  };
  const markup = renderRepositories(state, {});
  assert.match(markup, /Last successful Azure check/);
  assert.match(markup, /Last check problems/);
  assert.match(markup, /Read refused/);
  assert.doesNotMatch(markup, /Needs attention|Check overdue|Check failed|Next check|>Branches ·/);
});

test('search filtering never folds hidden raw updates into displayed acknowledgement IDs', () => {
  const store = createStore();
  try {
    store.saveRepo(stub<Repository>({ id: 'r', name: 'Orders' }));
    const build = { repoId: 'r', kind: 'build', title: 'Orders CI' } satisfies Event;
    store.insertEvents([
      { ...build, id: 'queued', time: '2026-11-17T10:00:00Z', data: { buildId: 42, status: 'notStarted' } },
      { ...build, id: 'running', time: '2026-11-17T10:01:00Z', data: { buildId: 42, status: 'inProgress' } },
    ]);
    assert.deepEqual(present(store.queryActivity({ view: 'new', search: 'Running' }).items[0]).eventIds, ['running']);
    store.acknowledge(['running']);
    const row = present(store.queryActivity({ view: 'new' }).items[0]);
    assert.equal(row.unseen, true, 'older queued update stays visible even if newest update was seen');
    assert.deepEqual(row.unseenIds, ['queued']);
  } finally {
    store.close();
  }
});

test('all activity states use the shared semantic palette independent of imported/seen state', () => {
  const cases: [ActivityKind, EventData, string][] = [
    ['build', { status: 'completed', result: 'failed' }, 'crit'],
    ['branch-deleted', { evidence: 'push' }, 'crit'],
    ['branch-deleted', { evidence: 'snapshot' }, 'warn'],
    ['build', { status: 'completed', result: 'canceled' }, 'warn'],
    ['build', { status: 'cancelling' }, 'warn'],
    ['pr', { status: 'abandoned' }, 'warn'],
    ['build', { status: 'completed', result: 'partiallySucceeded' }, 'warn'],
    ['build', { status: 'completed', result: 'succeeded' }, 'ok'],
    ['pr', { status: 'completed' }, 'ok'],
    ['branch-created', {}, 'info'],
    ['pr', { status: 'active' }, 'info'],
    ['build', { status: 'notStarted' }, 'info'],
    ['build', { status: 'inProgress' }, 'info'],
    ['push', {}, 'info'],
    ['pr', { status: 'active', isDraft: true }, 'neutral'],
    ['build', { status: 'completed', result: 'skipped' }, 'neutral'],
    ['build', { status: 'unknown' }, 'neutral'],
  ];
  for (const [kind, data, tone] of cases) {
    assert.equal(activityTone({ kind, data }), tone, `${kind} ${JSON.stringify(data)}`);
    assert.equal(activityTone({ kind, data, imported: true, seen: true }), tone);
  }
  assert.equal(activityLabel({ kind: 'pr', data: { status: 'completed', isDraft: true } }), 'Merged');
});

test('completed PRs show Merged and target direction, while successful preview merges stay Open', () => {
  const data = {
    status: 'active',
    targetRefName: 'refs/heads/main',
    sourceRefName: 'refs/heads/feature/fix',
    mergeStatus: 'succeeded',
    lastMergeCommit: { commitId: 'preview' },
  };
  const preview: Event = { kind: 'pr', data };
  assert.equal(activityLabel(preview), 'Open PR');
  assert.equal(activitySummary(preview), 'Target: main');
  assert.equal(activityTone(preview), 'info');
  const merged = { ...preview, data: { ...data, status: 'completed' } };
  assert.equal(activityLabel(merged), 'Merged');
  assert.equal(activitySummary(merged), 'Merged into main');
  assert.equal(activityTone(merged), 'ok');
  assert.equal(activityTone({ kind: 'push' }), 'info');
});

test('tag rows say what happened to the tag and never claim a commit for a pushed tag object', () => {
  const tag = (data: EventData, extra: Event = {}): Event => ({
    id: 't',
    repoId: 'r',
    kind: 'tag',
    time: '2026-11-17T10:00:00Z',
    branch: 'v1',
    data,
    ...extra,
  });
  const zero = '0'.repeat(40);
  const created = tag({ change: 'created', evidence: 'push', oldObjectId: zero, newObjectId: 'a'.repeat(40) });
  const moved = tag({ change: 'moved', evidence: 'push', oldObjectId: 'a'.repeat(40), newObjectId: 'b'.repeat(40) });
  const deleted = tag({ change: 'deleted', evidence: 'push', oldObjectId: 'a'.repeat(40), newObjectId: zero });
  const unlisted = tag({ change: 'deleted', evidence: 'snapshot', objectId: 'a' }, { summary: 'Missing from complete refs snapshot' });
  assert.deepEqual(
    [created, moved, deleted, unlisted].map(event => [activityLabel(event), activityTone(event), activitySummary(event)]),
    [
      ['New tag', 'info', 'Points at aaaaaaa'],
      ['Tag moved', 'warn', 'aaaaaaa → bbbbbbb'],
      ['Tag deleted', 'warn', 'Remote tag deleted'],
      ['No longer listed', 'warn', 'Missing from complete refs snapshot'],
    ],
  );
  assert.equal(labels.tag, 'Tag');
});

test('a push that creates a branch names its tip, not a new branch or a start, in the short commit length the server stores', () => {
  const push: Event = {
    kind: 'push',
    data: { refUpdates: [{ name: 'refs/heads/feature/a', oldObjectId: '0'.repeat(40), newObjectId: '54a2ad26'.padEnd(40, 'c') }] },
  };
  assert.equal(activitySummary(push), 'Tip at 54a2ad2');
});

test('a fork PR names its fork in the summary', () => {
  const pr: Event = {
    id: 'p',
    repoId: 'r',
    kind: 'pr',
    time: '2026-11-17T10:00:00Z',
    data: { status: 'active', targetRefName: 'refs/heads/main' },
  };
  assert.equal(activitySummary(pr), 'Target: main');
  assert.equal(
    activitySummary({ ...pr, data: { ...pr.data, fork: { repository: 'One-fork', project: 'Q' } } }),
    'From fork One-fork in Q · Target: main',
  );
});

test('vote changes on an open PR read as words, and a closed PR keeps its merge summary', () => {
  const pr: Event = { id: 'p', repoId: 'r', kind: 'pr', time: '2026-11-17T10:00:00Z' };
  const data = {
    status: 'active',
    targetRefName: 'refs/heads/main',
    voteChanges: [
      { name: 'Ana', vote: 10 },
      { name: 'Sam', vote: 0 },
    ],
  };
  assert.equal(activitySummary({ ...pr, data }), 'Ana: approved · Sam: vote reset');
  assert.equal(activitySummary({ ...pr, data: { ...data, status: 'completed' } }), 'Merged into main');
  assert.equal(activitySummary({ ...pr, data: { ...data, voteChanges: [{ name: 'Lee', vote: -10 }] } }), 'Lee: rejected');
});

test('a vote change on a fork PR still names the fork', () => {
  const pr: Event = { id: 'p', repoId: 'r', kind: 'pr', time: '2026-11-17T10:00:00Z' };
  const data = {
    status: 'active',
    targetRefName: 'refs/heads/main',
    fork: { repository: 'One-fork' },
    voteChanges: [{ name: 'Ana', vote: 10 }],
  };
  assert.equal(activitySummary({ ...pr, data }), 'From fork One-fork · Ana: approved');
});

test('push headlines name a single matching PR result without inferring the cause of the push', () => {
  const title = 'Microsoft.VisualStudio.Services.TFS pushed to main';
  const result = 'a'.repeat(40);
  const push: Event = {
    kind: 'push',
    actor: 'Microsoft.VisualStudio.Services.TFS',
    title,
    data: { refUpdates: [{ name: 'refs/heads/main', newObjectId: result }] },
  };
  const pr: EvidencePr = {
    pullRequestId: 12,
    relationship: 'result-introduced',
    targetRefName: 'refs/heads/main',
    mergeCommit: result.toUpperCase(),
  };
  const linked = (...prs: EvidencePr[]) => ({ ...push, data: { ...push.data, mergeEvidence: { prs } } });
  assert.equal(activityTitle(linked(pr)), 'Merge of PR 12 pushed to main');
  assert.equal(activityTitle(linked({ ...pr, targetRefName: 'refs/heads/other' })), 'Azure DevOps service pushed to main');
  assert.equal(activityTitle(linked({ ...pr, relationship: 'constituent-related' })), 'Azure DevOps service pushed to main');
  assert.equal(
    activityTitle(linked(pr, { ...pr, pullRequestId: 14, relationship: 'constituent-related' })),
    'Merge of PR 12 pushed to main',
  );
  assert.equal(activityTitle(linked(pr, { ...pr, pullRequestId: 13 })), 'Azure DevOps service pushed to main');
  assert.equal(activityTitle({ ...push, actor: 'Alice', title: 'Alice pushed to main' }), 'Alice pushed to main');
  assert.equal(activitySummary({ ...push, data: {} }), 'Branch details unavailable');
});

test('the scope reads 1 repository when only one exists, and All N repositories when there are more', () => {
  const repos = [stub<Repository>({ id: 'a' }), stub<Repository>({ id: 'b' })];
  assert.equal(scopeName({ repos: repos.slice(0, 1) }, { repoIds: null }), '1 repository');
  assert.equal(scopeName({ repos }, { repoIds: null }), 'All 2 repositories');
  assert.equal(scopeName({ repos }, { repoIds: ['a'] }), '1 repository shown');
});
