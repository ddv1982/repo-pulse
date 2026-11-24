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
import { renderFeed as renderPagedFeedHtml, renderDetail as renderDetailHtml } from '../src/ui/feed.ts';
import { forkText, treeLegend } from '../src/ui/activity-tree.ts';
import type { TreeFork } from '../src/activity-tree.ts';
import { scopeName } from '../src/ui/header.ts';
import { createStore } from '../server/store.ts';
import type { ActivityEvent, ActivityKind, EventData, EvidencePr } from '../src/activity.ts';
import type { Repository, StreamError, StreamState } from '../src/contract.ts';
import type { CheckoutSnapshot } from '../src/ui/checkout.ts';
import type { PageState } from '../src/ui/refresh.ts';
import { parse, one, all, row, text, srText } from './fixtures/dom.ts';
import { present, stub } from './fixtures/typed.ts';

// The tests give the views and labels only the fields they read: an event of a kind with its data, a page state
// without the parts a view leaves alone.
type Event = Partial<ActivityEvent>;
type State = Partial<PageState>;
type FeedUi = Parameters<typeof renderPagedFeedHtml>[1];
type DetailOptions = Parameters<typeof renderDetailHtml>[3];
/** A stream whose error is a plain string, a shape streamError() also reads. */
const stringError = (stream: Partial<StreamState>, error: string) =>
  stub<StreamState>({ ...stream, error: error as unknown as StreamError });
const activityLabel = (event: Event) => activityLabelOf(stub<ActivityEvent>(event));
const activityTone = (event: Event) => activityToneOf(stub<ActivityEvent>(event));
const activityTitle = (event: Event) => activityTitleOf(stub<ActivityEvent>(event));
const activitySummary = (event: Event) => activitySummaryOf(stub<ActivityEvent>(event));
const renderRepositories = (state: State, ...rest: Parameters<typeof renderRepositoriesHtml> extends [unknown, ...infer R] ? R : never) =>
  String(renderRepositoriesHtml(stub<PageState>(state), ...rest));
const renderPagedFeed = (state: State, ui: Partial<FeedUi>) => String(renderPagedFeedHtml(stub<PageState>(state), stub<FeedUi>(ui)));
// The detail only tests commits for truthiness, so a test's null stands for "not loaded" as undefined does.
const renderDetail = (
  event: Event,
  state: State,
  commits?: Parameters<typeof renderDetailHtml>[2] | null,
  options?: Partial<DetailOptions>,
) =>
  String(
    renderDetailHtml(stub<ActivityEvent>(event), stub<PageState>(state), commits ?? undefined, options && stub<DetailOptions>(options)),
  );

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
  assert.match(markup, /Last check failures/);
  assert.match(markup, /Read refused/);
  assert.doesNotMatch(markup, /Needs attention|Check overdue|Check failed|Next check|>Branches ·/);
});

test('a disabled repository row offers only enabling or removing it', () => {
  const state: State = {
    watched: [
      stub<Repository>({ id: 'on', name: 'Orders', project: 'Shop', localPath: '/src/orders' }),
      stub<Repository>({ id: 'off', name: 'Billing', project: 'Shop', localPath: '/src/billing', disabled: true }),
    ],
    settings: {},
    syncStatus: { overall: { state: 'syncing', repoId: 'on' }, repos: { on: { state: 'syncing' } } },
    streams: [stringError({ repoId: 'on', stream: 'refs', initialized: true }, 'Read refused')],
  };
  const doc = parse(renderRepositories(state, {}));
  assert.match(text(doc), /2 watched · 1 disabled/);
  const articles = all(doc, 'article');
  const enabled = present(articles[0]);
  const disabled = present(articles[1]);
  const toggle = (article: Element) => one(article, 'input[role="switch"][data-repo-toggle]');
  assert.equal(toggle(enabled).getAttribute('data-id'), 'on');
  assert.ok(toggle(enabled).hasAttribute('checked'));
  assert.equal(one(enabled, 'summary').getAttribute('aria-label'), 'Details for Orders');
  assert.equal(toggle(disabled).getAttribute('data-id'), 'off');
  assert.equal(all(disabled, '[checked]').length, 0);
  assert.equal(text(one(disabled, '.chip.name')), 'Disabled');
  assert.equal(one(disabled, '[data-action="remove-repo"]').getAttribute('data-id'), 'off');
  // A disabled repository offers only its switch and Remove watch: no details, checkout state, update check or sync.
  assert.deepEqual(
    all(disabled, 'button, input, select, summary, a, details').map(
      control => control.getAttribute('data-action') ?? control.getAttribute('role'),
    ),
    ['switch', 'remove-repo'],
  );
  assert.doesNotMatch(disabled.outerHTML, /Details for|checkout-state|Check for updates|Sync older/);
});

const view: Partial<FeedUi> = { repoIds: null, route: 'catchup', kind: '', search: '' };
/** The page state the feed and detail tests build on: the watched repositories and their stored events. */
type Fixture = State & { repos: Repository[]; events: ActivityEvent[] };
function fixture(): Fixture {
  const event = {
    repoId: 'r',
    kind: 'build',
    title: 'Orders CI',
    branch: 'main',
    actor: 'Developer',
    seen: false,
    imported: false,
    data: { buildId: 42, sourceVersion: 'abc123def456', reason: 'manual' },
  } satisfies Event;
  return {
    repos: [stub<Repository>({ id: 'r', name: 'Orders' })],
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

function activityPage(state: Fixture, ui: Partial<FeedUi>) {
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

const renderFeed = (state: Fixture, ui: Partial<FeedUi>) => renderPagedFeed({ ...state, activity: activityPage(state, ui) }, ui);
/** The event IDs of the rendered rows, in order. */
const rowIds = (markup: string) => all(parse(markup), '.row').map(element => element.getAttribute('data-event-id'));
/** An element's classes, sorted, so a test can state them exactly without depending on their order. */
const classes = (element: Element) => [...element.classList].sort();

test('one running build counts as one item and two updates; zero summary values stay neutral', () => {
  const state = fixture();
  const markup = renderFeed(state, view);
  const doc = parse(markup);
  assert.match(text(doc), /1 new item/);
  assert.match(text(doc), /2 updates/);
  assert.match(text(doc), /1 running/);
  assert.equal(all(doc, '.val.zero').length, 3);
  assert.equal(all(doc, '.row').length, 1);
  assert.equal(all(doc, '.bar').length, 0);
  assert.doesNotMatch(markup, /notStarted|inProgress|0 match your watch rules/);
});

test('search filtering never folds hidden raw updates into displayed acknowledgement IDs', () => {
  const state = fixture();
  assert.deepEqual(present(activityPage(state, { ...view, search: 'Running' }).items[0]).eventIds, ['running']);
  present(state.events[1]).seen = true;
  assert.equal(
    present(activityPage(state, view).items[0]).unseen,
    true,
    'older queued update stays visible even if newest update was seen',
  );
  assert.deepEqual(present(activityPage(state, view).items[0]).unseenIds, ['queued']);
});

test('detail has readable labels, exact group IDs and abbreviated copyable commit', () => {
  const state = fixture();
  const markup = renderDetail(present(state.events[1]), state, null, { returnRoute: 'activity', label: 'Back to Activity' });
  const doc = parse(markup);
  assert.match(text(doc), /Back to Activity/);
  assert.match(text(doc), /Triggered manually/);
  assert.equal(text(one(doc, 'code[title="abc123def456"]')), 'abc123de');
  assert.equal(text(one(doc, '[data-action="copy-commit"]')), 'Copy');
  assert.equal(one(doc, '[data-action="copy-commit"]').getAttribute('aria-label'), 'Copy full commit ID');
  assert.doesNotMatch(markup, /sourceVersion|inProgress/);
  assert.match(text(doc), /Update history/);
  // Marking the detail seen acts on exactly the grouped updates.
  assert.deepEqual(JSON.parse(present(one(doc, '[data-action="ack-item"]').getAttribute('data-event-ids'))).sort(), ['queued', 'running']);
});

test('a completed pull request detail offers a switch to the branch it merged into', () => {
  const state = fixture();
  const pr: ActivityEvent = {
    id: 'merged',
    repoId: 'on',
    kind: 'pr',
    title: 'PR 7 · Merge',
    branch: 'feature/topic',
    time: '2026-11-17T10:00:00Z',
    data: { pullRequestId: 7, status: 'completed', sourceRefName: 'refs/heads/feature/topic', targetRefName: 'refs/heads/main' },
  };
  state.events = [pr];
  state.repos = [stub<Repository>({ id: 'on', name: 'Orders', localPath: '/src/orders' })];
  assert.equal(text(one(parse(renderDetail(pr, state, null)), '[data-action="switch-activity-branch"]')), 'Switch to main…');
  const onMain = parse(renderDetail(pr, state, null, { checkouts: { on: stub<CheckoutSnapshot>({ branch: 'main' }) } }));
  assert.equal(text(one(onMain, '#activity-branch-action')), 'View in Repositories');
  assert.doesNotMatch(text(parse(renderDetail(pr, { ...state, demo: true }, null))), /Switch to/);
});

test('Activity shows ordinary pushes, hotfixes, and new branches in source-time order', () => {
  const state = fixture();
  const event = { repoId: 'r', kind: 'push', seen: false, imported: false, summary: 'Branch updated' } satisfies Event;
  state.events = [
    { ...event, id: 'ordinary', branch: 'feature/new', title: 'Ordinary push', time: '2026-11-17T10:02:00Z' },
    { ...event, id: 'priority', branch: 'hotfix/fix', title: 'Priority push', time: '2026-11-17T10:01:00Z' },
    { ...event, id: 'branch', kind: 'branch-created', branch: 'feature/newest', title: 'New branch', time: '2026-11-17T10:03:00Z' },
  ];
  assert.deepEqual(rowIds(renderFeed(state, view)), ['branch', 'ordinary', 'priority']);
  assert.deepEqual(rowIds(renderFeed(state, { ...view, route: 'activity' })), ['branch', 'ordinary', 'priority']);
  assert.doesNotMatch(text(parse(renderFeed(state, view))), /Prioritized|Muted|Show muted/);
});

test('a CI run shows its pipeline name in feed and detail, also for a stored row whose title still carries the build number', () => {
  const state = fixture();
  state.events = state.events.map(event => ({
    ...event,
    title: 'Orders CI · 20261117.6',
    data: { ...event.data, buildId: 700, definition: { name: 'Orders CI' } },
  }));
  const event = present(state.events[1]);
  assert.equal(activityTitle(event), 'Orders CI');
  assert.equal(activityTitle({ ...event, title: '' }), 'Orders CI');
  assert.equal(activityTitle({ ...event, title: 'Orders CI', data: { buildId: 700 } }), 'Orders CI');
  assert.equal(activityTitle({ ...event, title: '', data: { buildId: 700 } }), 'CI run');
  // The title is followed by the row's unread count.
  assert.match(text(one(parse(renderFeed(state, view)), '.title')), /^Orders CI 2 new$/);
  assert.equal(text(one(parse(renderDetail(event, state)), 'h1')), 'Orders CI');
  // Search still finds the row by its pipeline name.
  assert.equal(activityPage(state, { ...view, search: 'Orders CI' }).items.length, 1);
  assert.equal(activityPage(state, { ...view, search: 'Billing CI' }).items.length, 0);
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

test('row status washes are independent of unseen flags and failure classification', () => {
  const state = fixture();
  state.events = [
    stub<ActivityEvent>({
      id: 'deleted',
      repoId: 'r',
      kind: 'branch-deleted',
      title: 'Deleted',
      branch: 'hotfix/old',
      data: { evidence: 'push' },
    }),
    stub<ActivityEvent>({
      id: 'failed',
      repoId: 'r',
      kind: 'build',
      title: 'CI',
      data: { buildId: 42, status: 'completed', result: 'failed' },
    }),
  ];
  const doc = parse(renderFeed(state, view));
  const label = one(row(doc, 'deleted'), '.kind');
  assert.ok(label.classList.contains('crit'));
  assert.equal(text(label), 'Branch deleted');
  assert.deepEqual(classes(row(doc, 'deleted')), ['new', 'row', 'tone-crit']);
  assert.deepEqual(classes(row(doc, 'failed')), ['crit', 'new', 'row', 'tone-crit']);
  assert.equal(all(parse(renderDetail(present(state.events[0]), state)), '.status-chip.crit').length, 1);
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

test('a branch row from a push does not repeat its label in the event column; a listed branch keeps its caveat', () => {
  const state = fixture();
  const base = { repoId: 'r', seen: false, imported: false, time: '2026-11-17T10:00:00Z', actor: 'Ana' };
  state.events = [
    { ...base, id: 'created', kind: 'branch-created', branch: 'a', title: 'New branch · a', data: { evidence: 'push' } },
    { ...base, id: 'deleted', kind: 'branch-deleted', branch: 'b', title: 'Branch deleted', data: { evidence: 'push' } },
    { ...base, id: 'listed', kind: 'branch-created', branch: 'c', title: 'Branch first seen · c', data: { evidence: 'refs' } },
  ];
  const doc = parse(renderFeed(state, view));
  const first = (id: string) => present(one(row(doc, id), '.event').firstElementChild);
  for (const id of ['created', 'deleted']) {
    assert.ok(first(id).matches('.help.event-meta'), id);
    assert.match(text(first(id)), /^Pushed by Ana · /, id);
  }
  assert.ok(first('listed').classList.contains('event-main'));
  assert.equal(text(first('listed')), 'First seen remotely; creation time not supplied');
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
  const doc = parse(renderFeed(state, { ...view, route: 'activity' }));
  assert.equal(one(doc, 'ul.rows.with-tree').getAttribute('data-tree-lanes'), '2');
  const cells = all(doc, 'svg.tree');
  assert.equal(cells.length, 2);
  assert.ok(cells.every(cell => cell.getAttribute('aria-hidden') === 'true'));
  const assumed = one(doc, 'svg.tree path.assumed');
  assert.ok(classes(assumed).some(name => /^lane-\d$/.test(name)));
  assert.equal(assumed.getAttribute('d'), 'M5 18C5 9 15 9 15 0');
  const ring = one(doc, 'svg.tree circle.hole');
  assert.ok(classes(ring).some(name => /^lane-\d$/.test(name)));
  assert.deepEqual(
    ['cx', 'cy', 'r'].map(name => ring.getAttribute(name)),
    ['15', '0', '3.75'],
  );
  const origin = one(row(doc, 'branch'), '.event-origin');
  assert.equal(text(origin), 'PR 7 targets main, origin not checked');
  assert.equal(one(origin, 'svg').getAttribute('aria-hidden'), 'true');
  assert.match(text(one(doc, '.tree-legend')), /Lines can pass rows of other branches\./);
  const updates = parse(renderFeed(state, view));
  assert.equal(all(updates, '.row').length, 2);
  assert.equal(all(updates, '.with-tree, .tree, .tree-legend').length, 0);
  assert.doesNotMatch(text(updates), /origin not checked/);
});

test('a CI run on a pull request ref names the source branch and the pull request once the PR is known', () => {
  const state = fixture();
  const run = {
    repoId: 'r',
    kind: 'build',
    branch: 'refs/pull/7/merge',
    seen: false,
    imported: false,
    time: '2026-11-17T10:02:00Z',
  } satisfies Event;
  state.events = [
    {
      ...run,
      id: 'known',
      data: { buildId: 1, pullRequest: { id: 7, sourceRefName: 'refs/heads/feature/a', targetRefName: 'refs/heads/main' } },
    },
    { ...run, id: 'unknown', branch: 'refs/pull/8/merge', data: { buildId: 2 } },
  ];
  const doc = parse(renderFeed(state, view));
  /** The row's branch token: its full name on hover, a hidden icon, and a screen-reader label before the name. */
  const branch = (id: string, name: string) => {
    const token = one(row(doc, id), '.ref-branch');
    assert.equal(token.getAttribute('title'), name, id);
    assert.equal(one(token, 'svg').getAttribute('aria-hidden'), 'true', id);
    assert.equal(text(one(token, '.ref-name')), name, id);
    // The cue is for screen readers only, and comes before the name so it says what the name is first.
    assert.equal(text(token), name, id);
    assert.equal(srText(token), `· branch ${name}`, id);
    return token;
  };
  const token = branch('known', 'feature/a');
  const chip = one(row(doc, 'known'), '.chip.ref-pr');
  assert.equal(text(chip), 'PR 7');
  assert.equal(srText(chip), '· PR 7');
  // Branch and PR sit in one group that does not wrap, so the chip never ends up on a line of its own.
  const group = one(row(doc, 'known'), '.feed-title .ref-target');
  assert.deepEqual([group.firstElementChild, group.lastElementChild], [token, chip]);
  branch('unknown', 'refs/pull/8/merge');
  assert.equal(all(doc, '.ref-pr').length, 1);
  // No separators are drawn between tokens; spacing does that job.
  for (const line of all(doc, '.subref')) assert.ok(!text(line).includes(' / '), text(line));
});

test('a row names its repository only when more than one repository is shown', () => {
  const state = fixture();
  const subref = (out: unknown) => one(parse(out), '.feed-title .subref');
  assert.doesNotMatch(srText(subref(renderFeed(state, view))), /Orders/);
  state.repos.push(stub<Repository>({ id: 'other', name: 'Billing' }));
  const repo = one(subref(renderFeed(state, view)), '.ref-repo');
  assert.equal(text(repo), 'Orders');
  assert.equal(srText(repo), '· repository Orders');
  // The selected scope decides, not which repositories happen to have rows on the page.
  assert.doesNotMatch(srText(subref(renderFeed(state, { ...view, repoIds: ['r'] }))), /Orders/);
});

test('a branch row shows its branch as the token under a title that no longer names it or the actor', () => {
  const state = fixture();
  const base = { repoId: 'r', seen: false, imported: false, time: '2026-11-17T10:00:00Z', actor: 'Ana' };
  state.events = [
    { ...base, id: 'push', kind: 'push', branch: 'feature/a', title: 'Ana pushed to feature/a', data: {} },
    { ...base, id: 'counted', kind: 'push', branch: 'fix/b', title: '2 commits pushed to fix/b', data: {} },
    { ...base, id: 'created', kind: 'branch-created', branch: 'feature/b', title: 'New branch · feature/b', data: {} },
    { ...base, id: 'bare', kind: 'branch-created', branch: 'feature/e', title: 'feature/e', data: {} },
    { ...base, id: 'deleted', kind: 'branch-deleted', branch: 'feature/c', title: 'Branch deleted', data: {} },
    { ...base, id: 'old-push', kind: 'push', branch: 'feature/d', title: 'Ana pushed', data: {} },
    { ...base, id: 'other-ref', kind: 'push', branch: 'main', title: 'Ana pushed to main-old', data: {} },
    { ...base, id: 'pr', kind: 'pr', branch: 'main', title: 'PR 3 · Fix main menu', data: { id: 3 } },
    { ...base, id: 'build', kind: 'build', branch: 'main', title: 'main CI · 1', data: { buildId: 1 } },
  ];
  const doc = parse(renderFeed(state, view));
  for (const [id, title, name] of [
    ['push', 'Pushed', 'feature/a'],
    ['counted', '2 commits pushed', 'fix/b'],
    ['created', 'New branch', 'feature/b'],
    ['bare', 'New branch', 'feature/e'],
    ['deleted', 'Branch deleted', 'feature/c'],
    ['old-push', 'Pushed', 'feature/d'],
    ['other-ref', 'Pushed to main-old', 'main'],
    ['pr', 'PR 3 · Fix main menu', 'main'],
    ['build', 'main CI · 1', 'main'],
  ] satisfies [string, string, string][]) {
    assert.equal(text(one(row(doc, id), '.title')), title, id);
    assert.equal(text(one(row(doc, id), '.feed-title .ref-name')), name, id);
  }
  // The Seen button keeps the full title, so its accessible name still says which branch.
  assert.equal(one(row(doc, 'push'), '.seen-toggle').getAttribute('aria-label'), 'Seen: Ana pushed to feature/a');
});

test('a push that names several branches keeps its title and shows no single branch token', () => {
  const state = fixture();
  state.events = [
    {
      repoId: 'r',
      id: 'multi',
      kind: 'push',
      seen: false,
      imported: false,
      time: '2026-11-17T10:00:00Z',
      actor: 'Ana',
      branch: 'feature/a',
      title: 'Ana pushed to feature/a, feature/b',
      data: {},
    },
  ];
  const doc = parse(renderFeed(state, view));
  assert.equal(text(one(doc, '.title')), 'Pushed to feature/a, feature/b');
  assert.equal(all(doc, '.subref').length, 0);
  const meta = one(doc, '.help.event-meta');
  assert.match(text(meta), /^Pushed by Ana · /);
  assert.equal(text(one(meta, '.actor')), 'Ana');
  assert.equal(all(meta, 'time').length, 1);
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
  const doc = parse(renderFeed(state, view));
  /** The meta line says role, actor and a machine-readable time, in that order. */
  const meta = (id: string, role: string, actor: string) => {
    const line = one(row(doc, id), '.help.event-meta');
    assert.match(text(line), new RegExp(`^${role}${actor} · \\S`), id);
    assert.equal(text(one(line, '.actor')), actor, id);
    const time = one(line, 'time');
    assert.equal(time.getAttribute('datetime'), '2026-11-17T10:00:00Z', id);
    assert.match(time.getAttribute('title') ?? '', /2026/, id);
  };
  const event = one(row(doc, 'pr'), '.event');
  assert.equal(text(present(event.firstElementChild)), 'Target: main');
  assert.ok(present(event.firstElementChild).classList.contains('event-main'));
  assert.ok(present(present(event.firstElementChild).nextElementSibling).matches('.help.event-meta'));
  meta('pr', 'Created by ', 'Ana');
  meta('build', 'Requested by ', 'Bo');
  meta('created', 'Pushed by ', 'Cy');
  meta('linked', 'Pushed by ', 'Ed');
  // The row title drops the pusher's name, so the meta line names them like every other row.
  meta('named', 'Pushed by ', 'Di');
  // An unknown actor has no role to name.
  meta('unknown', '', 'Unknown');
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
  } satisfies Event;
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
  const doc = parse(renderFeed(state, view));
  const first = (id: string) => present(one(row(doc, id), '.event').firstElementChild);
  assert.ok(first('votes').classList.contains('event-main'));
  const votes = all(first('votes'), '.status-text');
  assert.deepEqual(
    votes.map(vote => [classes(vote).filter(name => name !== 'status-text'), text(vote)]),
    [
      [['ok'], 'Bo: approved'],
      [['warn'], 'Cy: waiting for author'],
      [['neutral'], 'Di: vote reset'],
    ],
  );
  assert.ok(votes.every(vote => one(vote, '.status-dot').getAttribute('aria-hidden') === 'true'));
  assert.ok(first('target').classList.contains('event-main'));
  assert.equal(text(first('target')), 'Target: main');
  for (const id of ['votes', 'target']) {
    const origin = one(row(doc, id), '.event-origin');
    assert.equal(text(origin), 'From fork One-fork in Q', id);
    assert.equal(all(origin, 'svg').length, 1, id);
  }
  // Search and the detail page keep the single summary sentence.
  assert.equal(activitySummary(present(state.events[1])), 'From fork One-fork in Q · Target: main');
});

test('each fork origin has its own row text, and only an unchecked PR target is dotted', () => {
  const base = 'd'.repeat(40);
  assert.deepEqual(
    (
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
      ] satisfies TreeFork[]
    ).map(forkText),
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
  assert.doesNotMatch(text(parse(treeLegend)), /assumed from the pull request target/);
  assert.match(text(parse(treeLegend)), /PR target, origin not checked/);
});

test('a grouped row counts its unread updates beside the title only when there is more than one', () => {
  const state = fixture();
  const ref = { name: 'refs/heads/topic', oldObjectId: 'a'.repeat(40), newObjectId: '0'.repeat(40) };
  const base = { repoId: 'r', branch: 'topic', time: '2026-11-17T10:00:00Z' };
  state.events = [
    { ...base, id: 'paired-push', kind: 'push', title: 'Cleanup push', data: { pushId: 10001, refUpdates: [ref], commits: [] } },
    { ...base, id: 'paired-deletion', kind: 'branch-deleted', title: 'Branch deleted', data: { pushId: 10001, ...ref } },
  ];
  const doc = parse(renderFeed(state, view));
  assert.equal(all(doc, '.row').length, 1);
  const count = one(one(doc, '.row'), '.title .new-count');
  assert.equal(text(count), '2 new');
  assert.deepEqual(classes(count), ['new-count', 'pill', 'u']);
  state.events = [present(state.events[0])];
  assert.equal(all(parse(renderFeed(state, view)), '.new-count').length, 0);
});

test('a CI row without a known trigger shows no summary line, and the detail page still names the gap', () => {
  const state = fixture();
  const base = { repoId: 'r', kind: 'build', title: 'CI', time: '2026-11-17T10:00:00Z' } satisfies Event;
  state.events = [
    { ...base, id: 'omitted', data: { buildId: 1, status: 'completed', result: 'succeeded' } },
    { ...base, id: 'none', data: { buildId: 2, status: 'completed', result: 'succeeded', reason: 'none' } },
    { ...base, id: 'manual', data: { buildId: 3, status: 'completed', result: 'succeeded', reason: 'manual' } },
  ];
  const markup = String(renderFeed(state, view));
  const doc = parse(markup);
  assert.doesNotMatch(markup, /Not supplied/);
  const first = (id: string) => present(one(row(doc, id), '.event').firstElementChild);
  assert.ok(first('manual').classList.contains('event-main'));
  assert.equal(text(first('manual')), 'Triggered manually');
  // With no summary, who and when is the column's first line.
  for (const id of ['omitted', 'none']) assert.ok(first(id).matches('.help.event-meta'), id);
  const trigger = present(all(parse(renderDetail(present(state.events[1]), state)), 'dt').find(term => text(term) === 'Trigger'));
  assert.equal(text(present(trigger.nextElementSibling)), 'Not supplied');
});

test('the summary counts every unread item in scope, not only the loaded rows', () => {
  const state = fixture();
  const at = (minute: number) => `2026-11-20T10:${String(minute).padStart(2, '0')}:00Z`;
  const extra: ActivityEvent[] = [
    ...[0, 1, 2, 3, 4].map((i): ActivityEvent => ({
      id: `p${i}`,
      repoId: 'r',
      kind: 'push',
      title: `Push ${i}`,
      branch: `f/${i}`,
      time: at(i),
    })),
    { id: 'b1', repoId: 'r', kind: 'branch-created', title: 'New branch', branch: 'f/new', time: at(5) },
  ];
  const store = createStore();
  try {
    for (const repo of state.repos) store.saveRepo(repo);
    store.insertEvents([...state.events, ...extra]);
    const activity = store.queryActivity({ view: 'all', limit: 2 });
    const markup = renderPagedFeed({ ...state, events: [...state.events, ...extra], activity }, { ...view, route: 'activity' });
    const summary = one(parse(markup), '[aria-label="Activity summary"]');
    const headline = one(summary, '.headline b');
    assert.equal(text(headline), '7 new items');
    assert.ok(!headline.classList.contains('zero'));
    assert.match(text(one(summary, '.headline')), /^7 new items · 8 updates/);
    assert.match(text(summary), /Showing 2 of 7 items/);
    /** A count cell's parts in reading order: label, value with its tone, and the line under it if any. */
    const cell = (kind: string) => [...one(summary, `[data-summary-kind="${kind}"]`).children].map(part => [classes(part), text(part)]);
    const label = (name: string) => [['label'], name];
    assert.deepEqual(cell('Pushes'), [label('Pushes'), [['t-info', 'val'], '5']]);
    assert.deepEqual(cell('Branches'), [label('Branches'), [['t-info', 'val'], '1'], [['sub'], '1 new']]);
    // The CI row is not loaded, so its status line would describe nothing on screen.
    assert.deepEqual(cell('CI runs'), [label('CI runs'), [['t-info', 'val'], '1']]);
  } finally {
    store.close();
  }
});

test('the scope reads 1 repository when only one exists, and All N repositories when there are more', () => {
  const repos = [stub<Repository>({ id: 'a' }), stub<Repository>({ id: 'b' })];
  assert.equal(scopeName({ repos: repos.slice(0, 1) }, { repoIds: null }), '1 repository');
  assert.equal(scopeName({ repos }, { repoIds: null }), 'All 2 repositories');
  assert.equal(scopeName({ repos }, { repoIds: ['a'] }), '1 repository shown');
});
