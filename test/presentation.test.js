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
import { renderRepositories as renderRepositoriesHtml } from '../src/ui/repositories.js';
import { renderFeed as renderPagedFeedHtml, renderDetail as renderDetailHtml } from '../src/ui/feed.js';
import { forkText, treeLegend } from '../src/ui/activity-tree.js';
import { createStore } from '../server/store.js';

const renderRepositories = (...args) => String(renderRepositoriesHtml(...args));
const renderPagedFeed = (...args) => String(renderPagedFeedHtml(...args));
const renderDetail = (...args) => String(renderDetailHtml(...args));

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

test('a completed pull request detail offers a switch to the branch it merged into', () => {
  const state = fixture();
  const pr = {
    id: 'merged',
    repoId: 'on',
    kind: 'pr',
    title: 'PR 7 · Merge',
    branch: 'feature/topic',
    time: '2026-11-17T10:00:00Z',
    data: { pullRequestId: 7, status: 'completed', sourceRefName: 'refs/heads/feature/topic', targetRefName: 'refs/heads/main' },
  };
  state.events = [pr];
  state.repos = [{ id: 'on', name: 'Orders', localPath: '/src/orders' }];
  assert.match(renderDetail(pr, state, null), /data-action="switch-activity-branch">Switch to main…</);
  const onMain = renderDetail(pr, state, null, { checkouts: { on: { branch: 'main' } } });
  assert.match(onMain, />View in Repositories</);
  assert.doesNotMatch(renderDetail(pr, { ...state, demo: true }, null), /Switch to/);
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
  assert.match(markup, /class="row crit new tone-crit" data-event-id="failed"/);
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

test('push headlines name a single matching PR result without inferring the cause of the push', () => {
  const title = 'Microsoft.VisualStudio.Services.TFS pushed to main';
  const result = 'a'.repeat(40);
  const push = {
    kind: 'push',
    actor: 'Microsoft.VisualStudio.Services.TFS',
    title,
    data: { refUpdates: [{ name: 'refs/heads/main', newObjectId: result }] },
  };
  const pr = { pullRequestId: 12, relationship: 'result-introduced', targetRefName: 'refs/heads/main', mergeCommit: result.toUpperCase() };
  const linked = (...prs) => ({ ...push, data: { ...push.data, mergeEvidence: { prs } } });
  assert.equal(activityTitle(linked(pr)), 'Push to main · Linked PR #12');
  assert.equal(activityTitle(linked({ ...pr, targetRefName: 'refs/heads/other' })), 'Azure DevOps service pushed to main');
  assert.equal(activityTitle(linked({ ...pr, relationship: 'constituent-related' })), 'Azure DevOps service pushed to main');
  assert.equal(
    activityTitle(linked(pr, { ...pr, pullRequestId: 14, relationship: 'constituent-related' })),
    'Push to main · Linked PR #12',
  );
  assert.equal(activityTitle(linked(pr, { ...pr, pullRequestId: 13 })), 'Azure DevOps service pushed to main');
  assert.equal(activityTitle({ ...push, actor: 'Alice', title: 'Alice pushed to main' }), 'Alice pushed to main');
  assert.equal(activitySummary({ ...push, data: {} }), 'Branch details unavailable');
});

test('All activity draws a branch tree with the fork evidence in the row text; New updates stays a plain list', () => {
  const state = fixture();
  const base = { repoId: 'r', actor: 'Developer', seen: false, imported: false, branch: 'feature/a' };
  state.events = [
    {
      ...base,
      id: 'pr',
      kind: 'pr',
      title: 'PR 7 · Add a',
      time: '2026-11-17T10:02:00Z',
      observedAt: '2026-11-17T10:02:00Z',
      data: { pullRequestId: 7, status: 'active', sourceRefName: 'refs/heads/feature/a', targetRefName: 'refs/heads/main' },
    },
    {
      ...base,
      id: 'branch',
      kind: 'branch-created',
      time: '2026-11-17T10:01:00Z',
      observedAt: '2026-11-17T10:01:00Z',
      data: { name: 'refs/heads/feature/a', evidence: 'refs' },
    },
  ];
  const all = renderFeed(state, { ...view, route: 'activity' });
  assert.match(all, /<ul class="rows with-tree" data-tree-lanes="2">/);
  assert.equal((all.match(/<svg class="tree" aria-hidden="true"/g) || []).length, 2);
  assert.match(all, /<path class="lane-\d assumed" d="M5 18C5 9 15 9 15 0"\/>/);
  assert.match(all, /<circle class="lane-\d hole" cx="15" cy="0" r="3.75"\/>/);
  assert.match(
    all,
    /<div class="help event-origin"><svg aria-hidden="true"[^]*?<\/svg><span>PR 7 targets main, origin not checked<\/span><\/div>/,
  );
  assert.match(all, /class="help tree-legend"/);
  assert.match(all, /Lines can pass rows of other branches\./);
  const updates = renderFeed(state, view);
  assert.equal((updates.match(/<li class="row /g) || []).length, 2);
  assert.doesNotMatch(updates, /with-tree|class="tree"|tree-legend|origin not checked/);
});

test('a CI run on a pull request ref names the source branch and the pull request once the PR is known', () => {
  const state = fixture();
  const run = { repoId: 'r', kind: 'build', branch: 'refs/pull/7/merge', seen: false, imported: false, time: '2026-11-17T10:02:00Z' };
  state.events = [
    {
      ...run,
      id: 'known',
      data: { buildId: 1, pullRequest: { id: 7, sourceRefName: 'refs/heads/feature/a', targetRefName: 'refs/heads/main' } },
    },
    { ...run, id: 'unknown', branch: 'refs/pull/8/merge', data: { buildId: 2 } },
  ];
  const out = String(renderFeed(state, view));
  const branch = (/** @type {string} */ name) =>
    new RegExp(
      `<span class="ref-branch" title="${name}"><svg aria-hidden="true"[^]*?</svg><span class="sr"> · branch </span><span class="ref-name">${name}</span></span>`,
    );
  assert.match(out, branch('feature/a'));
  assert.match(out, /<span class="chip ref-pr"><span class="sr"> · <\/span>PR 7<\/span>/);
  assert.match(out, branch('refs/pull/8/merge'));
  assert.equal(out.match(/ref-pr/g)?.length, 1);
  // No separators are drawn between tokens; spacing does that job.
  assert.doesNotMatch(out, /<span class="subref">[^]*? \/ [^]*?<\/button>/);
});

test('a row names its repository only when more than one repository is shown', () => {
  const state = fixture();
  const subref = (/** @type {unknown} */ out) => String(out).match(/<span class="subref">.*?<\/span><\/button>/)?.[0] ?? '';
  assert.doesNotMatch(subref(renderFeed(state, view)), /Orders/);
  state.repos.push({ id: 'other', name: 'Billing' });
  assert.match(subref(renderFeed(state, view)), /<span class="ref-repo"><span class="sr"> · repository <\/span>Orders<\/span>/);
  // The selected scope decides, not which repositories happen to have rows on the page.
  assert.doesNotMatch(subref(renderFeed(state, { ...view, repoIds: ['r'] })), /Orders/);
});

test('a row leaves out the branch its title already names, except on pull requests and CI runs', () => {
  const state = fixture();
  const base = { repoId: 'r', seen: false, imported: false, time: '2026-11-17T10:00:00Z' };
  state.events = [
    { ...base, id: 'push', kind: 'push', branch: 'feature/a', title: 'Ana pushed to feature/a', data: {} },
    { ...base, id: 'created', kind: 'branch-created', branch: 'feature/b', title: 'feature/b', data: {} },
    { ...base, id: 'deleted', kind: 'branch-deleted', branch: 'feature/c', title: 'Branch deleted', data: {} },
    { ...base, id: 'tag', kind: 'tag', branch: 'v1.0', title: 'Tag moved · v1.0', data: {} },
    { ...base, id: 'old-push', kind: 'push', branch: 'feature/d', title: 'Ana pushed', data: {} },
    { ...base, id: 'other-ref', kind: 'push', branch: 'main', title: 'Ana pushed to main-old', data: {} },
    { ...base, id: 'pr', kind: 'pr', branch: 'main', title: 'PR 3 · Fix main menu', data: { id: 3 } },
    { ...base, id: 'build', kind: 'build', branch: 'main', title: 'main CI · 1', data: { buildId: 1 } },
  ];
  const out = String(renderFeed(state, view));
  const refLine = (/** @type {string} */ id) => out.match(new RegExp(`data-event-id="${id}"[^]*?</button>`))?.[0] ?? '';
  for (const id of ['push', 'created', 'deleted', 'tag']) assert.doesNotMatch(refLine(id), /class="subref"/, id);
  for (const [id, name] of [
    ['old-push', 'feature/d'],
    ['other-ref', 'main'],
    ['pr', 'main'],
    ['build', 'main'],
  ])
    assert.match(refLine(id), new RegExp(`<span class="ref-name">${name}</span>`), id);
  // With several repositories shown the line stays for the repository alone.
  state.repos.push({ id: 'other', name: 'Billing' });
  assert.match(
    String(renderFeed(state, view)).match(/data-event-id="push"[^]*?<\/button>/)?.[0] ?? '',
    /<span class="subref"><span class="ref-repo">[^]*?<\/span><\/span><\/button>/,
  );
});

test('the event column puts what happened first, then who and when, each actor with its role', () => {
  const state = fixture();
  const base = { repoId: 'r', seen: false, imported: false, time: '2026-11-17T10:00:00Z' };
  state.events = [
    {
      ...base,
      id: 'pr',
      kind: 'pr',
      branch: 'feature/a',
      title: 'PR 3 · Fix',
      actor: 'Ana',
      data: { id: 3, status: 'active', targetRefName: 'refs/heads/main' },
    },
    { ...base, id: 'build', kind: 'build', branch: 'main', title: 'CI · 1', actor: 'Bo', data: { buildId: 1, reason: 'manual' } },
    { ...base, id: 'created', kind: 'branch-created', branch: 'feature/b', title: 'feature/b', actor: 'Cy', data: {} },
    { ...base, id: 'named', kind: 'push', branch: 'feature/c', title: 'Di pushed to feature/c', actor: 'Di', summary: 'Tidy up', data: {} },
    { ...base, id: 'linked', kind: 'push', branch: 'main', title: 'Cleanup push', actor: 'Ed', summary: 'Merge', data: {} },
    { ...base, id: 'unknown', kind: 'tag', branch: 'v1', title: 'Tag moved · v1', actor: 'Unknown', data: {} },
  ];
  const out = String(renderFeed(state, view));
  const event = (/** @type {string} */ id) =>
    out.match(new RegExp(`data-event-id="${id}"[^]*?<div class="event">([^]*?)<div class="rowact">`))?.[1] ?? '';
  const meta = (/** @type {string} */ id) => event(id).match(/<div class="help event-meta">([^]*?)<\/div>/)?.[1] ?? '';
  assert.match(event('pr'), /^<div class="event-main"><span>Target: main<\/span><\/div><div class="help event-meta">/);
  assert.match(meta('pr'), /^Created by <span class="actor">Ana<\/span> · <time datetime="2026-11-17T10:00:00Z" title="[^"]*2026[^"]*">/);
  assert.match(meta('build'), /^Requested by <span class="actor">Bo<\/span> · <time/);
  assert.match(meta('created'), /^Pushed by <span class="actor">Cy<\/span> · <time/);
  assert.match(meta('linked'), /^Pushed by <span class="actor">Ed<\/span> · <time/);
  // The title already says who pushed, and an unknown actor has no role to name.
  assert.match(meta('named'), /^<time/);
  assert.match(meta('unknown'), /^<span class="actor">Unknown<\/span> · <time/);
});

test('a PR row lists each vote change on its own and names a fork source on the origin line', () => {
  const state = fixture();
  const base = {
    repoId: 'r',
    kind: 'pr',
    branch: 'feature/a',
    title: 'PR 3 · Fix',
    actor: 'Ana',
    seen: false,
    imported: false,
    time: '2026-11-17T10:00:00Z',
  };
  const fork = { repository: 'One-fork', project: 'Q' };
  state.events = [
    {
      ...base,
      id: 'votes',
      data: {
        id: 3,
        status: 'active',
        targetRefName: 'refs/heads/main',
        fork,
        voteChanges: [
          { name: 'Bo', vote: 10 },
          { name: 'Cy', vote: -5 },
          { name: 'Di', vote: 0 },
        ],
      },
    },
    { ...base, id: 'target', data: { id: 4, status: 'active', targetRefName: 'refs/heads/main', fork } },
  ];
  const out = String(renderFeed(state, view));
  const event = (/** @type {string} */ id) =>
    out.match(new RegExp(`data-event-id="${id}"[^]*?<div class="event">([^]*?)<div class="rowact">`))?.[1] ?? '';
  assert.match(
    event('votes'),
    /^<div class="event-main"><span class="status-text ok"><span class="status-dot" aria-hidden="true"><\/span>Bo: approved<\/span><span class="status-text warn"><span class="status-dot" aria-hidden="true"><\/span>Cy: waiting for author<\/span><span class="status-text neutral"><span class="status-dot" aria-hidden="true"><\/span>Di: vote reset<\/span><\/div>/,
  );
  assert.match(event('target'), /^<div class="event-main"><span>Target: main<\/span><\/div>/);
  for (const id of ['votes', 'target'])
    assert.match(event(id), /<div class="help event-origin"><svg[^]*?<\/svg><span>From fork One-fork in Q<\/span><\/div>/, id);
  // Search and the detail page keep the single summary sentence.
  assert.equal(activitySummary(state.events[1]), 'From fork One-fork in Q · Target: main');
});

test('each fork origin has its own row text, and only an unchecked PR target is dotted', () => {
  const base = 'd'.repeat(40);
  assert.deepEqual(
    [
      { evidence: 'tip', parent: 'main' },
      { evidence: 'recorded', parent: 'feature/a', base },
      { evidence: 'contained', parent: 'main', base },
      { evidence: 'pr', parent: 'main', pullRequestId: 7 },
      { evidence: 'ambiguous', parent: null, base, branches: ['main', 'release'] },
      { evidence: 'refuted', parent: null, base, pullRequestId: 7, target: 'release/x' },
      { evidence: 'unplaced', parent: null, base },
      { evidence: 'orphan', parent: null },
      { evidence: 'merge', parent: null },
    ].map(forkText),
    [
      'Started at a revision seen on main',
      'Started at ddddddd, the tip of feature/a',
      'Started at ddddddd, already on main',
      'PR 7 targets main, origin not checked',
      'Started at ddddddd, on main and release',
      'PR 7 targets release/x, which did not hold ddddddd',
      'Started at ddddddd, no branch match found',
      'Started with no earlier commit',
      'Started with a merge commit',
    ],
  );
  assert.equal(forkText(null), '');
  assert.doesNotMatch(String(treeLegend), /assumed from the pull request target</);
  assert.match(String(treeLegend), /PR target, origin not checked/);
});

test('a grouped row counts its unread updates beside the title only when there is more than one', () => {
  const state = fixture();
  const ref = { name: 'refs/heads/topic', oldObjectId: 'a'.repeat(40), newObjectId: '0'.repeat(40) };
  const base = { repoId: 'r', branch: 'topic', time: '2026-11-17T10:00:00Z' };
  state.events = [
    { ...base, id: 'paired-push', kind: 'push', title: 'Cleanup push', data: { pushId: 10001, refUpdates: [ref], commits: [] } },
    { ...base, id: 'paired-deletion', kind: 'branch-deleted', title: 'Branch deleted', data: { pushId: 10001, ...ref } },
  ];
  const markup = renderFeed(state, view);
  assert.equal(markup.toString().match(/<li /g)?.length, 1);
  assert.match(markup, /<span class="pill u new-count">2 new<\/span>/);
  state.events = [state.events[0]];
  assert.doesNotMatch(renderFeed(state, view), /new-count/);
});

test('a CI row without a known trigger shows no summary line, and the detail page still names the gap', () => {
  const state = fixture();
  const base = { repoId: 'r', kind: 'build', title: 'CI', time: '2026-11-17T10:00:00Z' };
  state.events = [
    { ...base, id: 'omitted', data: { buildId: 1, status: 'completed', result: 'succeeded' } },
    { ...base, id: 'none', data: { buildId: 2, status: 'completed', result: 'succeeded', reason: 'none' } },
    { ...base, id: 'manual', data: { buildId: 3, status: 'completed', result: 'succeeded', reason: 'manual' } },
  ];
  const markup = String(renderFeed(state, view));
  assert.doesNotMatch(markup, /Not supplied/);
  assert.match(markup, /<div class="event"><div class="event-main"><span>Triggered manually<\/span><\/div>/);
  // With no summary, who and when is the column's first line.
  assert.match(markup, /<div class="event"><div class="help event-meta">/);
  assert.match(String(renderDetail(state.events[1], state)), /<dt>Trigger<\/dt><dd>Not supplied<\/dd>/);
});

test('the summary counts every unread item in scope, not only the loaded rows', () => {
  const state = fixture();
  const at = minute => `2026-11-20T10:${String(minute).padStart(2, '0')}:00Z`;
  const extra = [
    ...[0, 1, 2, 3, 4].map(i => ({ id: `p${i}`, repoId: 'r', kind: 'push', title: `Push ${i}`, branch: `f/${i}`, time: at(i) })),
    { id: 'b1', repoId: 'r', kind: 'branch-created', title: 'New branch', branch: 'f/new', time: at(5) },
  ];
  const store = createStore();
  try {
    for (const repo of state.repos) store.saveRepo(repo);
    store.insertEvents([...state.events, ...extra]);
    const activity = store.queryActivity({ view: 'all', limit: 2 });
    const markup = renderPagedFeed({ ...state, events: [...state.events, ...extra], activity }, { ...view, route: 'activity' });
    const summary = markup.slice(markup.indexOf('Activity summary'), markup.indexOf('</section>'));
    assert.match(summary, /<b class="">7 new items<\/b> · 8 updates/);
    assert.match(summary, /Showing 2 of 7 items/);
    assert.match(summary, /data-summary-kind="Pushes"><div class="label">Pushes<\/div><div class="val t-info">5</);
    assert.match(
      summary,
      /data-summary-kind="Branches"><div class="label">Branches<\/div><div class="val t-info">1<\/div><div class="sub">1 new</,
    );
    // The CI row is not loaded, so its status line would describe nothing on screen.
    assert.match(summary, /data-summary-kind="CI runs"><div class="label">CI runs<\/div><div class="val t-info">1<\/div><\/div>/);
  } finally {
    store.close();
  }
});
