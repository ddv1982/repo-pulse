import test from 'node:test';
import assert from 'node:assert/strict';
import { activityTitle as activityTitleOf, activitySummary as activitySummaryOf } from '../../src/ui/format.ts';
import { renderRepositories as renderRepositoriesHtml } from '../../src/ui/repositories.ts';
import { renderFeed as renderPagedFeedHtml, renderDetail as renderDetailHtml } from '../../src/ui/feed.ts';
import { forkText, treeLegend } from '../../src/ui/activity-tree.ts';
import type { TreeFork } from '../../src/activity-tree.ts';
import { createStore } from '../../server/store.ts';
import type { ActivityEvent } from '../../src/activity.ts';
import type { Repository, StreamError, StreamState } from '../../src/contract.d.ts';
import type { CheckoutSnapshot } from '../../src/ui/checkout.ts';
import type { PageState } from '../../src/ui/refresh.ts';
import { parse, one, all, row, text, srText, type DomNode } from '../fixtures/dom.ts';
import { present, stub } from '../../test/fixtures/typed.ts';

// The tests give the views and labels only the fields they read: an event of a kind with its data, a page state
// without the parts a view leaves alone.
type Event = Partial<ActivityEvent>;
type State = Partial<PageState>;
type FeedUi = Parameters<typeof renderPagedFeedHtml>[1];
type DetailOptions = Parameters<typeof renderDetailHtml>[3];
/** A stream whose error is a plain string, a shape streamError() also reads. */
const stringError = (stream: Partial<StreamState>, error: string) =>
  stub<StreamState>({ ...stream, error: error as unknown as StreamError });
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

test('a disabled repository row offers only enabling or removing it', async () => {
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
  assert.match(await text(doc), /2 watched · 1 disabled/);
  const articles = await all(doc, 'article');
  const enabled = present(articles[0]);
  const disabled = present(articles[1]);
  const toggle = (article: DomNode) => one(article, 'input[role="switch"][data-repo-toggle]');
  assert.equal(await toggle(enabled).getAttribute('data-id'), 'on');
  assert.ok(await toggle(enabled).hasAttribute('checked'));
  assert.equal(await one(enabled, 'summary').getAttribute('aria-label'), 'Details for Orders');
  assert.equal(await toggle(disabled).getAttribute('data-id'), 'off');
  assert.equal((await all(disabled, '[checked]')).length, 0);
  assert.equal(await text(one(disabled, '.chip.name')), 'Disabled');
  assert.equal(await one(disabled, '[data-action="remove-repo"]').getAttribute('data-id'), 'off');
  // A disabled repository offers only its switch and Remove watch: no details, checkout state, update check or sync.
  assert.deepEqual(
    await Promise.all(
      (await all(disabled, 'button, input, select, summary, a, details')).map(
        async control => (await control.getAttribute('data-action')) ?? (await control.getAttribute('role')),
      ),
    ),
    ['switch', 'remove-repo'],
  );
  assert.doesNotMatch(await disabled.outerHtml(), /Details for|checkout-state|Check for updates|Sync older/);
});

const view: Partial<FeedUi> = { repoIds: null, unreadOnly: true, kind: '', search: '' };
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
      view: ui.unreadOnly ? 'new' : 'all',
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
const rowIds = async (markup: string) =>
  Promise.all((await all(parse(markup), '.row')).map(element => element.getAttribute('data-event-id')));
/** An element's classes, sorted, so a test can state them exactly without depending on their order. */
const classes = async (element: DomNode) => (await element.classes()).sort();

test('one running build counts as one item and two updates; zero summary values stay neutral', async () => {
  const state = fixture();
  const markup = renderFeed(state, view);
  const doc = parse(markup);
  assert.match(await text(doc), /1 new item/);
  assert.match(await text(doc), /2 updates/);
  assert.match(await text(doc), /1 running/);
  assert.equal((await all(doc, '.val.zero')).length, 3);
  assert.equal((await all(doc, '.row')).length, 1);
  assert.equal((await all(doc, '.bar')).length, 0);
  assert.doesNotMatch(markup, /notStarted|inProgress|0 match your watch rules/);
});

test('detail has readable labels, exact group IDs and abbreviated copyable commit', async () => {
  const state = fixture();
  const markup = renderDetail(present(state.events[1]), state, null);
  const doc = parse(markup);
  assert.match(await text(doc), /Back to Activity/);
  assert.match(await text(doc), /Triggered manually/);
  assert.equal(await text(one(doc, 'code[title="abc123def456"]')), 'abc123de');
  assert.equal(await text(one(doc, '[data-action="copy-commit"]')), 'Copy');
  assert.equal(await one(doc, '[data-action="copy-commit"]').getAttribute('aria-label'), 'Copy full commit ID');
  assert.doesNotMatch(markup, /sourceVersion|inProgress/);
  assert.match(await text(doc), /Update history/);
  // Marking the detail seen acts on exactly the grouped updates.
  assert.deepEqual(JSON.parse(present(await one(doc, '[data-action="ack-item"]').getAttribute('data-event-ids'))).sort(), [
    'queued',
    'running',
  ]);
});

test('a completed pull request detail offers a switch to the branch it merged into', async () => {
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
  assert.equal(await text(one(parse(renderDetail(pr, state, null)), '[data-action="switch-activity-branch"]')), 'Switch to main…');
  const onMain = parse(renderDetail(pr, state, null, { checkouts: { on: stub<CheckoutSnapshot>({ branch: 'main' }) } }));
  assert.equal(await text(one(onMain, '#activity-branch-action')), 'View in Repositories');
  assert.doesNotMatch(await text(parse(renderDetail(pr, { ...state, demo: true }, null))), /Switch to/);
});

test('Activity shows ordinary pushes, hotfixes, and new branches in source-time order', async () => {
  const state = fixture();
  const event = { repoId: 'r', kind: 'push', seen: false, imported: false, summary: 'Branch updated' } satisfies Event;
  state.events = [
    { ...event, id: 'ordinary', branch: 'feature/new', title: 'Ordinary push', time: '2026-11-17T10:02:00Z' },
    { ...event, id: 'priority', branch: 'hotfix/fix', title: 'Priority push', time: '2026-11-17T10:01:00Z' },
    { ...event, id: 'branch', kind: 'branch-created', branch: 'feature/newest', title: 'New branch', time: '2026-11-17T10:00:00Z' },
  ];
  assert.deepEqual(await rowIds(renderFeed(state, view)), ['ordinary', 'priority', 'branch']);
  assert.deepEqual(await rowIds(renderFeed(state, { ...view, unreadOnly: false })), ['ordinary', 'priority', 'branch']);
  assert.doesNotMatch(await text(parse(renderFeed(state, view))), /Prioritized|Muted|Show muted/);
});

test('a CI run shows its pipeline name in feed and detail, also for a stored row whose title still carries the build number', async () => {
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
  assert.match(await text(one(parse(renderFeed(state, view)), '.title')), /^Orders CI 2 new$/);
  assert.equal(await text(one(parse(renderDetail(event, state)), 'h1')), 'Orders CI');
  // Search still finds the row by its pipeline name.
  assert.equal(activityPage(state, { ...view, search: 'Orders CI' }).items.length, 1);
  assert.equal(activityPage(state, { ...view, search: 'Billing CI' }).items.length, 0);
});

test('row status washes are independent of unseen flags and failure classification', async () => {
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
  assert.ok(await label.hasClass('crit'));
  assert.equal(await text(label), 'Branch deleted');
  assert.deepEqual(await classes(row(doc, 'deleted')), ['new', 'row', 'tone-crit']);
  assert.deepEqual(await classes(row(doc, 'failed')), ['crit', 'new', 'row', 'tone-crit']);
  assert.equal((await all(parse(renderDetail(present(state.events[0]), state)), '.status-chip.crit')).length, 1);
});

test('a branch row from a push does not repeat its label in the event column; a listed branch keeps its caveat', async () => {
  const state = fixture();
  const base = { repoId: 'r', seen: false, imported: false, time: '2026-11-17T10:00:00Z', actor: 'Ana' };
  state.events = [
    { ...base, id: 'created', kind: 'branch-created', branch: 'a', title: 'New branch · a', data: { evidence: 'push' } },
    { ...base, id: 'deleted', kind: 'branch-deleted', branch: 'b', title: 'Branch deleted', data: { evidence: 'push' } },
    { ...base, id: 'listed', kind: 'branch-created', branch: 'c', title: 'Branch first seen · c', data: { evidence: 'refs' } },
  ];
  const doc = parse(renderFeed(state, view));
  const first = (id: string) => one(row(doc, id), '.event > :first-child');
  for (const id of ['created', 'deleted']) {
    assert.ok(await first(id).matches('.help.event-meta'), id);
    assert.match(await text(first(id)), /^Pushed by Ana · /, id);
  }
  assert.ok(await first('listed').hasClass('event-main'));
  assert.equal(await text(first('listed')), 'First seen remotely; creation time not supplied');
});

test('both activity views draw a branch tree with the fork evidence in the row text', async () => {
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
  const doc = parse(renderFeed(state, { ...view, unreadOnly: false }));
  assert.equal(await one(doc, 'ul.rows.with-tree').getAttribute('data-tree-lanes'), '2');
  const cells = await all(doc, 'svg.tree');
  assert.equal(cells.length, 2);
  assert.ok((await Promise.all(cells.map(cell => cell.getAttribute('aria-hidden')))).every(value => value === 'true'));
  const assumed = one(doc, 'svg.tree path.assumed');
  assert.ok((await classes(assumed)).some(name => /^lane-\d$/.test(name)));
  assert.equal(await assumed.getAttribute('d'), 'M15 18C15 9 5 9 5 0');
  const ring = one(doc, 'svg.tree circle.hole');
  assert.ok((await classes(ring)).some(name => /^lane-\d$/.test(name)));
  assert.deepEqual(await Promise.all(['cx', 'cy', 'r'].map(name => ring.getAttribute(name))), ['5', '0', '3.75']);
  const origin = one(row(doc, 'branch'), '.event-origin');
  assert.equal(await text(origin), 'PR 7 targets main, origin not checked');
  assert.equal(await one(origin, 'svg').getAttribute('aria-hidden'), 'true');
  assert.match(await text(one(doc, '.tree-legend')), /Lines can pass rows of other branches\./);
  const updates = parse(renderFeed(state, view));
  assert.equal((await all(updates, '.row')).length, 2);
  assert.equal((await all(updates, 'svg.tree')).length, 2);
  assert.equal(await text(one(row(updates, 'branch'), '.event-origin')), 'PR 7 targets main, origin not checked');
});

test('a CI run on a pull request ref names the source branch and the pull request once the PR is known', async () => {
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
  const branch = async (id: string, name: string) => {
    const token = one(row(doc, id), '.ref-branch');
    assert.equal(await token.getAttribute('title'), name, id);
    assert.equal(await one(token, 'svg').getAttribute('aria-hidden'), 'true', id);
    assert.equal(await text(one(token, '.ref-name')), name, id);
    // The cue is for screen readers only, and comes before the name so it says what the name is first.
    assert.equal(await text(token), name, id);
    assert.equal(await srText(token), `· branch ${name}`, id);
    return token;
  };
  await branch('known', 'feature/a');
  const chip = one(row(doc, 'known'), '.chip.ref-pr');
  assert.equal(await text(chip), 'PR 7');
  assert.equal(await srText(chip), '· PR 7');
  // Branch and PR sit in one group that does not wrap, so the chip never ends up on a line of its own.
  const group = one(row(doc, 'known'), '.feed-title .ref-target');
  assert.equal((await all(group, ':scope > *')).length, 2);
  await one(group, ':scope > .ref-branch:first-child').handle();
  await one(group, ':scope > .ref-pr:last-child').handle();
  await branch('unknown', 'refs/pull/8/merge');
  assert.equal((await all(doc, '.ref-pr')).length, 1);
  // No separators are drawn between tokens; spacing does that job.
  for (const line of await all(doc, '.subref')) assert.ok(!(await text(line)).includes(' / '), await text(line));
});

test('a row names its repository only when more than one repository is shown', async () => {
  const state = fixture();
  const subref = (out: unknown) => one(parse(out), '.feed-title .subref');
  assert.doesNotMatch(await srText(subref(renderFeed(state, view))), /Orders/);
  state.repos.push(stub<Repository>({ id: 'other', name: 'Billing' }));
  const repo = one(subref(renderFeed(state, view)), '.ref-repo');
  assert.equal(await text(repo), 'Orders');
  assert.equal(await srText(repo), '· repository Orders');
  // The selected scope decides, not which repositories happen to have rows on the page.
  assert.doesNotMatch(await srText(subref(renderFeed(state, { ...view, repoIds: ['r'] }))), /Orders/);
});

test('a branch row shows its branch as the token under a title that no longer names it or the actor', async () => {
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
    assert.equal(await text(one(row(doc, id), '.title')), title, id);
    assert.equal(await text(one(row(doc, id), '.feed-title .ref-name')), name, id);
  }
  // The Seen button keeps the full title, so its accessible name still says which branch.
  assert.equal(await one(row(doc, 'push'), '.seen-toggle').getAttribute('aria-label'), 'Seen: Ana pushed to feature/a');
});

test('a push that names several branches keeps its title and shows no single branch token', async () => {
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
  assert.equal(await text(one(doc, '.title')), 'Pushed to feature/a, feature/b');
  assert.equal((await all(doc, '.subref')).length, 0);
  const meta = one(doc, '.help.event-meta');
  assert.match(await text(meta), /^Pushed by Ana · /);
  assert.equal(await text(one(meta, '.actor')), 'Ana');
  assert.equal((await all(meta, 'time')).length, 1);
});

test('the event column puts what happened first, then who and when, each actor with its role', async () => {
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
  const meta = async (id: string, role: string, actor: string) => {
    const line = one(row(doc, id), '.help.event-meta');
    assert.match(await text(line), new RegExp(`^${role}${actor} · \\S`), id);
    assert.equal(await text(one(line, '.actor')), actor, id);
    const time = one(line, 'time');
    assert.equal(await time.getAttribute('datetime'), '2026-11-17T10:00:00Z', id);
    assert.match((await time.getAttribute('title')) ?? '', /2026/, id);
  };
  const event = one(row(doc, 'pr'), '.event');
  assert.equal(await text(one(event, ':scope > :first-child')), 'Target: main');
  assert.ok(await one(event, ':scope > :first-child').hasClass('event-main'));
  assert.ok(await one(event, ':scope > :first-child + .help.event-meta').handle());
  await meta('pr', 'Created by ', 'Ana');
  await meta('build', 'Requested by ', 'Bo');
  await meta('created', 'Pushed by ', 'Cy');
  await meta('linked', 'Pushed by ', 'Ed');
  // The row title drops the pusher's name, so the meta line names them like every other row.
  await meta('named', 'Pushed by ', 'Di');
  // An unknown actor has no role to name.
  await meta('unknown', '', 'Unknown');
});

test('a PR row lists each vote change on its own and names a fork source on the origin line', async () => {
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
  const first = (id: string) => one(row(doc, id), '.event > :first-child');
  assert.ok(await first('votes').hasClass('event-main'));
  const votes = await all(first('votes'), '.status-text');
  assert.deepEqual(
    await Promise.all(votes.map(async vote => [(await classes(vote)).filter(name => name !== 'status-text'), await text(vote)])),
    [
      [['ok'], 'Bo: approved'],
      [['warn'], 'Cy: waiting for author'],
      [['neutral'], 'Di: vote reset'],
    ],
  );
  assert.ok((await Promise.all(votes.map(vote => one(vote, '.status-dot').getAttribute('aria-hidden')))).every(value => value === 'true'));
  assert.ok(await first('target').hasClass('event-main'));
  assert.equal(await text(first('target')), 'Target: main');
  for (const id of ['votes', 'target']) {
    const origin = one(row(doc, id), '.event-origin');
    assert.equal(await text(origin), 'From fork One-fork in Q', id);
    assert.equal((await all(origin, 'svg')).length, 1, id);
  }
  // Search and the detail page keep the single summary sentence.
  assert.equal(activitySummary(present(state.events[1])), 'From fork One-fork in Q · Target: main');
});

test('each fork origin has its own row text, and only an unchecked PR target is dotted', async () => {
  const base = 'd'.repeat(40);
  assert.deepEqual(
    (
      [
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
  assert.doesNotMatch(await text(parse(treeLegend)), /assumed from the pull request target/);
  assert.match(await text(parse(treeLegend)), /PR target, origin not checked/);
});

test('a grouped row counts its unread updates beside the title only when there is more than one', async () => {
  const state = fixture();
  const ref = { name: 'refs/heads/topic', oldObjectId: 'a'.repeat(40), newObjectId: '0'.repeat(40) };
  const base = { repoId: 'r', branch: 'topic', time: '2026-11-17T10:00:00Z' };
  state.events = [
    { ...base, id: 'paired-push', kind: 'push', title: 'Cleanup push', data: { pushId: 10001, refUpdates: [ref], commits: [] } },
    { ...base, id: 'paired-deletion', kind: 'branch-deleted', title: 'Branch deleted', data: { pushId: 10001, ...ref } },
  ];
  const doc = parse(renderFeed(state, view));
  assert.equal((await all(doc, '.row')).length, 1);
  const count = one(one(doc, '.row'), '.title .new-count');
  assert.equal(await text(count), '2 new');
  assert.deepEqual(await classes(count), ['new-count', 'pill', 'u']);
  state.events = [present(state.events[0])];
  assert.equal((await all(parse(renderFeed(state, view)), '.new-count')).length, 0);
});

test('a CI row without a known trigger shows no summary line, and the detail page still names the gap', async () => {
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
  const first = (id: string) => one(row(doc, id), '.event > :first-child');
  assert.ok(await first('manual').hasClass('event-main'));
  assert.equal(await text(first('manual')), 'Triggered manually');
  // With no summary, who and when is the column's first line.
  for (const id of ['omitted', 'none']) assert.ok(await first(id).matches('.help.event-meta'), id);
  const detail = parse(renderDetail(present(state.events[1]), state));
  const trigger = await (
    await detail.handle()
  ).evaluate(root => [...root.querySelectorAll('dt')].find(term => term.textContent === 'Trigger')?.nextElementSibling?.textContent);
  assert.equal(trigger, 'Not supplied');
});

test('the summary counts every unread item in scope, not only the loaded rows', async () => {
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
    const markup = renderPagedFeed({ ...state, events: [...state.events, ...extra], activity }, { ...view, unreadOnly: false });
    const summary = one(parse(markup), '[aria-label="Activity summary"]');
    const headline = one(summary, '.headline b');
    assert.equal(await text(headline), '7 new items');
    assert.ok(!(await headline.hasClass('zero')));
    assert.match(await text(one(summary, '.headline')), /^7 new items · 8 updates/);
    assert.match(await text(summary), /Showing 2 of 7 items/);
    /** A count cell's parts in reading order: label, value with its tone, and the line under it if any. */
    const cell = async (kind: string) =>
      Promise.all((await all(summary, `[data-summary-kind="${kind}"] > *`)).map(async part => [await classes(part), await text(part)]));
    const label = (name: string) => [['label'], name];
    assert.deepEqual(await cell('Pushes'), [label('Pushes'), [['t-info', 'val'], '5']]);
    assert.deepEqual(await cell('Branches'), [label('Branches'), [['t-info', 'val'], '1'], [['sub'], '1 new']]);
    const ci = one(summary, '[data-summary-kind="CI runs"]');
    assert.equal(await text(one(ci, 'button .label')), 'CI runs');
    assert.equal(await text(one(ci, 'button .val.t-info')), '1');
    assert.equal(await text(one(ci, '.sub')), '1 running');
  } finally {
    store.close();
  }
});

test('only the failed CI count uses the failure color in both summary layouts', async () => {
  const state = fixture();
  const base = { repoId: 'r', kind: 'build', title: 'CI', time: '2026-11-17T10:00:00Z' } satisfies Event;
  state.events = [
    { ...base, id: 'success', data: { buildId: 1, status: 'completed', result: 'succeeded' } },
    { ...base, id: 'failed', data: { buildId: 2, status: 'completed', result: 'failed' } },
    { ...base, id: 'running', data: { buildId: 3, status: 'inProgress' } },
    { ...base, id: 'queued', data: { buildId: 4, status: 'notStarted' } },
  ];

  const summary = one(parse(renderFeed(state, view)), '[aria-label="Activity summary"]');
  const cell = one(summary, '[data-summary-kind="CI runs"]');
  assert.equal(await text(one(cell, '.val.t-info')), '4');
  assert.equal(await text(one(cell, '.sub')), '1 running · 1 queued · 1 failed');
  assert.equal(await text(one(cell, 'button.t-crit[data-kind="status:failed"]')), '1 failed');
  assert.equal(await text(one(cell, 'button.t-info[data-kind="build"]')), 'CI runs 4');
  const chip = one(summary, '.summary-chips .chip');
  assert.deepEqual(await classes(chip), ['chip']);
  assert.equal(await text(chip), 'CI runs 4 · 1 running · 1 queued · 1 failed');
  assert.equal(await text(one(chip, 'button.t-crit[data-kind="status:failed"]')), '1 failed');
  assert.equal(await text(one(chip, 'button.t-info[data-kind="build"]')), 'CI runs 4');
});

test('the failed CI summary offers all CI runs even when no failures are unread', async () => {
  const state = fixture();
  const failure = {
    ...present(state.events[0]),
    data: { buildId: 42, status: 'completed', result: 'failed' },
  };
  for (const seen of [false, true]) {
    state.events = [{ ...failure, seen }];
    const page = parse(renderFeed(state, { ...view, unreadOnly: false, kind: 'status:failed' }));
    const count = seen ? '0' : '1';
    const cell = one(page, '[data-summary-kind="CI runs"]');
    const chip = one(page, '.summary-chips .chip');
    assert.equal(await text(one(cell, '.label')), 'Failed CI runs');
    assert.equal(await text(one(cell, '.val')), count);
    assert.equal(await text(chip), `Failed CI runs ${count} · Show all CI runs`);
    for (const layout of [cell, chip]) {
      assert.equal(await text(one(layout, 'button[data-kind="build"]')), 'Show all CI runs');
    }
    assert.equal(await one(page, '#kind-toggle').getAttribute('data-active'), 'true');
  }
});
