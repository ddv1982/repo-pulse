import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildState,
  activityLabel,
  activityTone,
  activityTitle,
  triggerLabel,
  streamLabel,
  activitySummary,
  labels,
} from '../src/ui/format.js';
import { renderRepositories } from '../src/ui/repositories.js';
import { renderFeed as renderPagedFeed, renderDetail } from '../src/ui/feed.js';
import { createStore } from '../server/store.js';

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
  const event = { kind: 'branch-deleted', data: { evidence: 'snapshot' } };
  assert.equal(activityLabel(event), 'No longer listed');
  assert.match(activitySummary(event), /deletion not confirmed/);
  assert.equal(activityLabel({ ...event, data: { evidence: 'push' } }), 'Branch deleted');
  const deleted = { ...event, title: 'Branch missing', branch: 'hotfix/old', data: { evidence: 'push' } };
  assert.equal(activityTitle(deleted), 'Branch deleted · hotfix/old');
  assert.equal(labels['branch-deleted'], 'Branch deleted');
});

test('repository details keep failure text and one timestamp without routine source labels', () => {
  const state = {
    watched: [{ id: 'r', name: 'Orders' }],
    settings: { refreshEnabled: false },
    syncStatus: { overall: { state: 'paused', repoId: 'r' }, repos: { r: { state: 'paused' } } },
    streams: [
      { repoId: 'r', stream: 'refs', initialized: true, lastSuccess: '2026-11-01T10:00:00Z' },
      { repoId: 'r', stream: 'prs', initialized: true, nextAt: '2026-11-01T10:00:00Z', error: 'Read refused' },
    ],
  };
  const markup = renderRepositories(state, {});
  assert.match(markup, /Last successful Azure check/);
  assert.match(markup, /Last check failures/);
  assert.match(markup, /Read refused/);
  assert.doesNotMatch(markup, /Needs attention|Check overdue|Check failed|Next check|>Branches ·/);
});

test('a disabled repository row offers only enabling or removing it', () => {
  const state = {
    watched: [
      { id: 'on', name: 'Orders', project: 'Shop', localPath: '/src/orders' },
      { id: 'off', name: 'Billing', project: 'Shop', localPath: '/src/billing', disabled: true },
    ],
    settings: {},
    syncStatus: { overall: { state: 'syncing', repoId: 'on' }, repos: { on: { state: 'syncing' } } },
    streams: [{ repoId: 'on', stream: 'refs', initialized: true, error: 'Read refused' }],
  };
  const markup = renderRepositories(state, {});
  const [enabled, disabled] = markup.split('<article').slice(1);
  assert.match(markup, /2 watched · 1 disabled/);
  assert.match(enabled, /role="switch"[^>]*data-repo-toggle[^>]*data-id="on"[^>]*checked/);
  assert.match(enabled, /Details for Orders/);
  assert.match(disabled, /role="switch"[^>]*data-repo-toggle[^>]*data-id="off"/);
  assert.doesNotMatch(disabled, /checked/);
  assert.match(disabled, />Disabled</);
  assert.match(disabled, /data-action="remove-repo"/);
  assert.doesNotMatch(disabled, /Details for|checkout-state|Check for updates|Sync older/);
});

const view = { repoIds: null, route: 'catchup', kind: '', search: '' };
function fixture() {
  const event = {
    repoId: 'r',
    kind: 'build',
    title: 'Orders CI',
    branch: 'main',
    actor: 'Developer',
    seen: false,
    imported: false,
    data: { buildId: 42, sourceVersion: 'abc123def456', reason: 'manual' },
  };
  return {
    repos: [{ id: 'r', name: 'Orders' }],
    settings: {},
    syncStatus: { overall: { state: 'synced', repoId: 'r' }, repos: { r: { state: 'synced' } } },
    streams: [],
    events: [
      {
        ...event,
        id: 'queued',
        time: '2026-11-17T10:00:00Z',
        observedAt: '2026-11-17T10:00:00Z',
        data: { ...event.data, status: 'notStarted' },
      },
      {
        ...event,
        id: 'running',
        time: '2026-11-17T10:01:00Z',
        observedAt: '2026-11-17T10:01:00Z',
        data: { ...event.data, status: 'inProgress' },
      },
    ],
  };
}

function activityPage(state, ui) {
  const store = createStore();
  try {
    for (const repo of state.repos) store.saveRepo(repo);
    store.insertEvents(state.events);
    return store.queryActivity({
      view: ui.route === 'catchup' ? 'new' : 'all',
      repoIds: ui.repoIds ?? undefined,
      kind: ui.kind,
      search: ui.search,
    });
  } finally {
    store.close();
  }
}

const renderFeed = (state, ui) => renderPagedFeed({ ...state, activity: activityPage(state, ui) }, ui);

test('one running build counts as one item and two updates; zero summary values stay neutral', () => {
  const state = fixture();
  const markup = renderFeed(state, view);
  assert.match(markup, /1 new item/);
  assert.match(markup, /2 updates/);
  assert.match(markup, /1 running/);
  assert.equal((markup.match(/class="val zero"/g) || []).length, 3);
  assert.equal((markup.match(/<li class="row /g) || []).length, 1);
  assert.doesNotMatch(markup, /notStarted|inProgress|class="bar"|0 match your watch rules/);
});

test('search filtering never folds hidden raw updates into displayed acknowledgement IDs', () => {
  const state = fixture();
  assert.deepEqual(activityPage(state, { ...view, search: 'Running' }).items[0].eventIds, ['running']);
  state.events[1].seen = true;
  assert.equal(activityPage(state, view).items[0].unseen, true, 'older queued update stays visible even if newest update was seen');
  assert.deepEqual(activityPage(state, view).items[0].unseenIds, ['queued']);
});

test('detail has readable labels, exact group IDs and abbreviated copyable commit', () => {
  const state = fixture();
  const markup = renderDetail(state.events[1], state, null, { returnRoute: 'activity', label: 'Back to Activity' });
  assert.match(markup, /Back to Activity/);
  assert.match(markup, /Triggered manually/);
  assert.match(markup, /title="abc123def456">abc123de/);
  assert.match(markup, /Copy full commit ID/);
  assert.doesNotMatch(markup, /sourceVersion|inProgress/);
  assert.match(markup, /Update history/);
  assert.match(markup, /queued/);
  assert.match(markup, /running/);
});

test('Activity shows ordinary pushes, hotfixes, and new branches in source-time order', () => {
  const state = fixture();
  const event = { repoId: 'r', kind: 'push', seen: false, imported: false, summary: 'Branch updated' };
  state.events = [
    { ...event, id: 'ordinary', branch: 'feature/new', title: 'Ordinary push', time: '2026-11-17T10:02:00Z' },
    { ...event, id: 'priority', branch: 'hotfix/fix', title: 'Priority push', time: '2026-11-17T10:01:00Z' },
    { ...event, id: 'branch', kind: 'branch-created', branch: 'feature/newest', title: 'New branch', time: '2026-11-17T10:03:00Z' },
  ];
  const ids = markup => [...markup.matchAll(/<li class="row[^"]*" data-event-id="([^"]+)"/g)].map(match => match[1]);
  assert.deepEqual(ids(renderFeed(state, view)), ['branch', 'ordinary', 'priority']);
  assert.deepEqual(ids(renderFeed(state, { ...view, route: 'activity', unseenOnly: false })), ['branch', 'ordinary', 'priority']);
  assert.doesNotMatch(renderFeed(state, view), /Prioritized|Muted|Show muted/);
});

test('build source run labels survive grouping in feed and detail, with numeric ID only as fallback', () => {
  const state = fixture();
  state.events = state.events.map(event => ({
    ...event,
    title: 'Orders CI · 20261117.6',
    data: { ...event.data, buildId: 700, definition: { name: 'Orders CI' } },
  }));
  const event = state.events[1];
  assert.equal(activityTitle(event), 'Orders CI · 20261117.6');
  assert.equal(activityTitle({ ...event, title: '' }), 'Orders CI · #700');
  assert.match(renderFeed(state, view), /Orders CI · 20261117\.6/);
  assert.match(renderDetail(event, state), /<h1>Orders CI · 20261117\.6<\/h1>/);
});

test('all activity states use the shared semantic palette independent of imported/seen state', () => {
  const cases = [
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

test('row status washes are independent of unseen flags and failure classification', () => {
  const state = fixture();
  state.events = [
    { id: 'deleted', repoId: 'r', kind: 'branch-deleted', title: 'Deleted', branch: 'hotfix/old', data: { evidence: 'push' } },
    { id: 'failed', repoId: 'r', kind: 'build', title: 'CI', data: { buildId: 42, status: 'completed', result: 'failed' } },
  ];
  const markup = renderFeed(state, view);
  assert.match(markup, /class="kind crit"[^>]*>.*Branch deleted/);
  assert.match(markup, /class="row new tone-crit" data-event-id="deleted"/);
  assert.match(markup, /class="row crit tone-crit" data-event-id="failed"/);
  assert.match(renderDetail(state.events[0], state), /status-chip crit/);
});

test('completed PRs show Merged and target direction, while successful preview merges stay Open', () => {
  const data = {
    status: 'active',
    targetRefName: 'refs/heads/main',
    sourceRefName: 'refs/heads/feature/fix',
    mergeStatus: 'succeeded',
    lastMergeCommit: { commitId: 'preview' },
  };
  const preview = { kind: 'pr', data };
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
  const tag = (data, extra = {}) => ({ id: 't', repoId: 'r', kind: 'tag', time: '2026-11-17T10:00:00Z', branch: 'v1', data, ...extra });
  const zero = '0'.repeat(40);
  const created = tag({ change: 'created', evidence: 'push', oldObjectId: zero, newObjectId: 'a'.repeat(40) });
  const moved = tag({ change: 'moved', evidence: 'push', oldObjectId: 'a'.repeat(40), newObjectId: 'b'.repeat(40) });
  const deleted = tag({ change: 'deleted', evidence: 'push', oldObjectId: 'a'.repeat(40), newObjectId: zero });
  const unlisted = tag({ change: 'deleted', evidence: 'snapshot', objectId: 'a' }, { summary: 'Missing from complete refs snapshot' });
  assert.deepEqual(
    [created, moved, deleted, unlisted].map(event => [activityLabel(event), activityTone(event), activitySummary(event)]),
    [
      ['New tag', 'info', 'Points at aaaaaaaa'],
      ['Tag moved', 'warn', 'aaaaaaaa → bbbbbbbb'],
      ['Tag deleted', 'warn', 'Remote tag deleted'],
      ['No longer listed', 'warn', 'Missing from complete refs snapshot'],
    ],
  );
  assert.equal(labels.tag, 'Tag');
});

test('a fork PR names its fork in the summary', () => {
  const pr = {
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
  const pr = { id: 'p', repoId: 'r', kind: 'pr', time: '2026-11-17T10:00:00Z' };
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
  const pr = { id: 'p', repoId: 'r', kind: 'pr', time: '2026-11-17T10:00:00Z' };
  const data = {
    status: 'active',
    targetRefName: 'refs/heads/main',
    fork: { repository: 'One-fork' },
    voteChanges: [{ name: 'Ana', vote: 10 }],
  };
  assert.equal(activitySummary({ ...pr, data }), 'From fork One-fork · Ana: approved');
});
