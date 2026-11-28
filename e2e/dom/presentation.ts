import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import {
  activityTitle as activityTitleOf,
  activitySummary as activitySummaryOf,
  ciTime,
  dateTime,
  type SafeHtml,
} from '../../src/ui/format.ts';
import { renderTrail } from '../../src/ui/activity-trail.ts';
import { renderRepositories as renderRepositoriesHtml } from '../../src/ui/repositories.ts';
import { renderFeed as renderPagedFeedHtml, renderDetail as renderDetailHtml } from '../../src/ui/feed.ts';
import { detailView } from '../../src/ui/activity-detail.ts';
import { forkText, renderTreePassThrough, treeLegend } from '../../src/ui/activity-tree.ts';
import { buildActivityTree, type TreeFork, type TreeLine, type TreeRow } from '../../src/activity-tree.ts';
import { createStore } from '../../server/store.ts';
import type { ActivityEvent, ActivityItem, CiResult, RelatedCi } from '../../src/activity.ts';
import type { GitHistoryActivity, GitHistoryPage, Repository, StreamError, StreamState } from '../../src/contract.ts';
import type { CheckoutSnapshot } from '../../src/ui/checkout.ts';
import type { PageState } from '../../src/ui/refresh.ts';
import { renderGitGraph } from '../../src/ui/git-graph.ts';
import { parse, one, all, row, text, textIncludingHidden, type DomElement, type DomRoot } from '../fixtures/dom.ts';
import { present, stub } from '../../test/fixtures/typed.ts';

/** Line 2 of a row as `class: text` per token, without screen-reader text, so a test reads its order and wording. */
const facts = async (doc: DomRoot, id: string) =>
  (await one(row(doc, id), '.row-head .subref').handle()).evaluate(line =>
    [...line.children]
      .filter(child => !child.matches('.sr'))
      .map(child => {
        const copy = child.cloneNode(true);
        if (copy instanceof Element) for (const hidden of copy.querySelectorAll('.sr')) hidden.remove();
        return `${child.classList[0]}: ${(copy.textContent ?? '').replace(/\s+/g, ' ').trim()}`;
      }),
  );

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
// Every feed renders the saved filter menu, so a state without saved filters has none.
const renderPagedFeed = (state: State, ui: Partial<FeedUi>) =>
  String(renderPagedFeedHtml(stub<PageState>({ savedFilters: [], ...state }), stub<FeedUi>({ groups: new Map(), ...ui })));
// The detail only tests commits for truthiness, so a test's null stands for "not loaded" as undefined does.
const renderDetail = (
  event: Event,
  state: State,
  commits?: Parameters<typeof renderDetailHtml>[2] | null,
  options?: Partial<DetailOptions>,
) =>
  String(
    renderDetailHtml(
      // The server answers a detail with the event's group; the test state's events stand for it.
      detailView({ detail: { event: stub<ActivityEvent>(event), events: state.events ?? [] }, activity: { items: [] } }, event.id ?? null),
      stub<PageState>(state),
      commits ?? undefined,
      options && stub<DetailOptions>(options),
    ),
  );

test('a disabled repository row offers only enabling or removing it', async t => {
  const state: State = {
    allRepos: [
      stub<Repository>({ id: 'on', name: 'Orders', project: 'Shop', localPath: '/src/orders' }),
      stub<Repository>({ id: 'off', name: 'Billing', project: 'Shop', localPath: '/src/billing', disabled: true }),
    ],
    jobs: [],
    settings: { refreshEnabled: true, refreshResumedAt: null },
    syncStatus: { overall: { state: 'syncing', repoId: 'on' }, repos: { on: { state: 'syncing' } } },
    streams: [stringError({ repoId: 'on', stream: 'refs', initialized: true }, 'Read refused')],
  };
  const doc = parse(t, renderRepositories(state, {}));
  assert.match(await text(doc), /2 watched · 1 disabled/);
  const articles = await all(doc, 'article');
  const enabled = present(articles[0]);
  const disabled = present(articles[1]);
  const toggle = (article: DomRoot) => one(article, 'input[role="switch"][data-action="toggle-repo"]');
  assert.equal(await toggle(enabled).getAttribute('data-repo-id'), 'on');
  assert.ok(await toggle(enabled).hasAttribute('checked'));
  assert.equal(await one(enabled, 'summary').getAttribute('aria-label'), 'Details for Orders');
  assert.equal(await toggle(disabled).getAttribute('data-repo-id'), 'off');
  assert.equal((await all(disabled, '[checked]')).length, 0);
  assert.equal(await text(one(disabled, '.chip.name')), 'Disabled');
  assert.equal(await one(disabled, '[data-action="remove-repo"]').getAttribute('data-repo-id'), 'off');
  // A disabled repository offers only its switch and Remove watch: no details, checkout state, update check or sync.
  assert.deepEqual(
    await Promise.all(
      (await all(disabled, 'button, input, select, summary, a, details')).map(
        async control => (await control.getAttribute('role')) ?? (await control.getAttribute('data-action')),
      ),
    ),
    ['switch', 'remove-repo'],
  );
  assert.doesNotMatch(await disabled.outerHtml(), /Details for|checkout-state|Check for updates|Sync older/);
});

const view: Partial<FeedUi> = { repoIds: null, unseenOnly: true, activityFilter: '', search: '' };
/** The page state the feed and detail tests build on: the watched repositories and their stored events. */
type Fixture = State & { enabledRepos: Repository[]; events: ActivityEvent[] };
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
    enabledRepos: [stub<Repository>({ id: 'r', name: 'Orders' })],
    settings: { refreshEnabled: true, refreshResumedAt: null },
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
    for (const repo of state.enabledRepos) store.saveRepo(repo);
    store.insertEvents(state.events);
    return store.queryActivity({
      view: ui.unseenOnly ? 'new' : 'all',
      repoIds: ui.repoIds ?? undefined,
      activityFilter: ui.activityFilter,
      search: ui.search,
    });
  } finally {
    store.close();
  }
}

const renderFeed = (state: Fixture, ui: Partial<FeedUi>) => renderPagedFeed({ ...state, activity: activityPage(state, ui) }, ui);
/** The event IDs of the rendered rows, in order. */
const rowIds = async (t: TestContext, markup: string) =>
  Promise.all((await all(parse(t, markup), '.row')).map(element => element.getAttribute('data-event-id')));
/** An element's classes, sorted, so a test can state them exactly without depending on their order. */
const classes = async (element: DomElement) => (await element.classes()).sort();

test('one running build counts as one item and two updates; zero summary values stay neutral', async t => {
  const state = fixture();
  const markup = renderFeed(state, view);
  const doc = parse(t, markup);
  assert.match(await text(doc), /1 new item/);
  assert.match(await text(doc), /2 updates/);
  assert.match(await text(doc), /1 running/);
  assert.equal((await all(doc, '.val.zero')).length, 3);
  assert.equal((await all(doc, '.row')).length, 1);
  assert.equal((await all(doc, '.bar')).length, 0);
  assert.doesNotMatch(markup, /notStarted|inProgress|0 match your watch rules/);
});

test('detail has readable labels, exact group IDs and abbreviated copyable commit', async t => {
  const state = fixture();
  const markup = renderDetail(present(state.events[1]), state, null);
  const doc = parse(t, markup);
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

test('PR details render reviewer names from older activity records safely', async t => {
  const state = fixture();
  const pr: Event = {
    id: 'older-pr',
    kind: 'pr',
    title: 'PR 7 · Review names',
    time: '2026-11-20T10:00:00Z',
    data: {
      reviewers: [
        { name: '[Team]\\Reviewers', vote: 10 },
        { name: 42 as unknown as string, vote: 0 },
        { name: {} as unknown as string, vote: 0 },
      ],
    },
  };
  const doc = parse(t, renderDetail(pr, state));
  const names = await all(doc, '.detail-list li > span[title]');
  assert.deepEqual(await Promise.all(names.map(text)), ['Reviewers', '42', 'Unknown reviewer']);
  assert.equal(await present(names[0]).getAttribute('title'), '[Team]\\Reviewers');
});

test('a completed pull request detail offers a switch to the branch it merged into', async t => {
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
  state.enabledRepos = [stub<Repository>({ id: 'on', name: 'Orders', localPath: '/src/orders' })];
  assert.equal(
    await text(
      one(
        parse(
          t,
          renderDetail(pr, state, null, {
            checkouts: {
              on: stub<CheckoutSnapshot>({ state: 'current', branch: 'topic', head: 'id', identity: 'id', switchIdentity: 'git' }),
            },
          }),
        ),
        '[data-action="switch-activity-branch"]',
      ),
    ),
    'Switch to main…',
  );
  const onMain = parse(t, renderDetail(pr, state, null, { checkouts: { on: stub<CheckoutSnapshot>({ branch: 'main' }) } }));
  assert.equal(await text(one(onMain, '.checkout-bar a')), 'View in Repositories');
  assert.doesNotMatch(await text(parse(t, renderDetail(pr, { ...state, demo: true }, null))), /Switch to/);
});

test('Activity shows ordinary pushes, hotfixes, and new branches in source-time order', async t => {
  const state = fixture();
  const event = { repoId: 'r', kind: 'push', seen: false, imported: false, summary: 'Branch updated' } satisfies Event;
  state.events = [
    { ...event, id: 'ordinary', branch: 'feature/new', title: 'Ordinary push', time: '2026-11-17T10:02:00Z' },
    { ...event, id: 'priority', branch: 'hotfix/fix', title: 'Priority push', time: '2026-11-17T10:01:00Z' },
    { ...event, id: 'branch', kind: 'branch-created', branch: 'feature/newest', title: 'New branch', time: '2026-11-17T10:00:00Z' },
  ];
  assert.deepEqual(await rowIds(t, renderFeed(state, view)), ['ordinary', 'priority', 'branch']);
  assert.deepEqual(await rowIds(t, renderFeed(state, { ...view, unseenOnly: false })), ['ordinary', 'priority', 'branch']);
  assert.doesNotMatch(await text(parse(t, renderFeed(state, view))), /Prioritized|Muted|Show muted/);
});

test('a CI run shows its pipeline name in feed and detail, also for a stored row whose title still carries the build number', async t => {
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
  assert.match(await text(one(parse(t, renderFeed(state, view)), '.title')), /^Orders CI 2 new$/);
  assert.equal(await text(one(parse(t, renderDetail(event, state)), 'h1')), 'Orders CI');
  // Search still finds the row by its pipeline name.
  assert.equal(activityPage(state, { ...view, search: 'Orders CI' }).items.length, 1);
  assert.equal(activityPage(state, { ...view, search: 'Billing CI' }).items.length, 0);
});

test('row status washes are independent of unseen flags and failure classification', async t => {
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
  const doc = parse(t, renderFeed(state, view));
  const label = one(row(doc, 'deleted'), '.kind');
  assert.ok(await label.hasClass('crit'));
  assert.equal(await text(label), 'Branch deleted');
  assert.deepEqual(await classes(row(doc, 'deleted')), ['new', 'row', 'tone-crit']);
  assert.deepEqual(await classes(row(doc, 'failed')), ['crit', 'new', 'row', 'tone-crit']);
  assert.equal((await all(parse(t, renderDetail(present(state.events[0]), state)), '.status-chip.crit')).length, 1);
});

test('a branch row from a push does not repeat its label on line 2; a listed branch keeps its caveat', async t => {
  const state = fixture();
  const base = { repoId: 'r', seen: false, imported: false, time: '2026-11-17T10:00:00Z', actor: 'Ana' };
  state.events = [
    { ...base, id: 'created', kind: 'branch-created', branch: 'a', title: 'New branch · a', data: { evidence: 'push' } },
    { ...base, id: 'deleted', kind: 'branch-deleted', branch: 'b', title: 'Branch deleted', data: { evidence: 'push' } },
    { ...base, id: 'listed', kind: 'branch-created', branch: 'c', title: 'Branch first seen · c', data: { evidence: 'refs' } },
  ];
  const doc = parse(t, renderFeed(state, view));
  for (const id of ['created', 'deleted']) assert.deepEqual(await facts(doc, id), ['ref-actor: pushed by Ana'], id);
  assert.deepEqual(await facts(doc, 'listed'), [
    'ref-target: c',
    'ref-actor: pushed by Ana',
    'ref-summary: First seen remotely; creation time not supplied',
  ]);
});

test('both activity views draw a branch tree with the fork evidence in the row text', async t => {
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
      id: 'standalone-pr',
      kind: 'pr',
      title: 'PR 8 · Add b',
      branch: 'feature/b',
      time: '2026-11-17T10:01:30Z',
      observedAt: '2026-11-17T10:01:30Z',
      data: { pullRequestId: 8, status: 'active', targetRefName: 'refs/heads/main' },
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
  const doc = parse(t, renderFeed(state, { ...view, unseenOnly: false }));
  assert.equal(await one(doc, 'ul.rows.with-tree').getAttribute('data-tree-lanes'), '2');
  const cells = await all(doc, 'svg.tree');
  assert.equal(cells.length, 3);
  assert.ok((await Promise.all(cells.map(cell => cell.getAttribute('aria-hidden')))).every(value => value === 'true'));
  const assumed = one(doc, 'svg.tree path.assumed');
  assert.ok((await classes(assumed)).some(name => /^lane-\d$/.test(name)));
  assert.equal(await assumed.getAttribute('d'), 'M15 18C15 9 5 9 5 0');
  const ring = one(doc, 'svg.tree circle.hole');
  assert.ok((await classes(ring)).some(name => /^lane-\d$/.test(name)));
  assert.deepEqual(await Promise.all(['cx', 'cy', 'r'].map(name => ring.getAttribute(name))), ['5', '0', '3.75']);
  const standalone = row(doc, 'standalone-pr');
  assert.equal((await all(standalone, 'svg.tree line')).length, 1, 'the unrelated lane still passes the row');
  assert.equal((await all(standalone, 'svg.tree circle.hole')).length, 0);
  assert.equal((await all(standalone, '.kind > .standalone-pr-ring')).length, 0);
  assert.equal(await text(one(standalone, '.kind')), 'Open PR');
  const origin = one(row(doc, 'branch'), '.event-origin');
  assert.equal(await text(origin), 'PR 7 targets main, origin not checked');
  assert.equal(await one(origin, 'svg').getAttribute('aria-hidden'), 'true');
  const guide = one(doc, '.activity-graph-guide');
  assert.equal(await text(one(guide, 'summary')), 'Activity lane key');
  assert.equal(await one(guide, 'a').getAttribute('href'), '#graph');
  assert.match(await text(one(doc, '.tree-legend')), /Lines can pass rows of other branches\./);
  const updates = parse(t, renderFeed(state, view));
  assert.equal((await all(updates, '.row')).length, 3);
  assert.equal((await all(updates, 'svg.tree')).length, 3);
  assert.equal(await text(one(row(updates, 'branch'), '.event-origin')), 'PR 7 targets main, origin not checked');
  state.events = state.events.filter(event => event.id === 'standalone-pr');
  const detachedOnly = parse(t, renderFeed(state, view));
  assert.equal((await all(detachedOnly, '.activity-graph-guide')).length, 0);
  assert.equal(await text(one(row(detachedOnly, 'standalone-pr'), '.kind')), 'Open PR');
});

test('a CI run on a pull request ref names the source branch and the pull request once the PR is known', async t => {
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
  const doc = parse(t, renderFeed(state, view));
  /** The row's branch token: its full name on hover, a hidden icon, and a screen-reader label before the name. */
  const branch = async (id: string, name: string) => {
    const token = one(row(doc, id), '.ref-branch');
    assert.equal(await token.getAttribute('title'), name, id);
    assert.equal(await one(token, 'svg').getAttribute('aria-hidden'), 'true', id);
    assert.equal(await text(one(token, '.ref-name')), name, id);
    // The cue is for screen readers only, and comes before the name so it says what the name is first.
    assert.equal(await text(token), name, id);
    assert.equal(await textIncludingHidden(token), `branch ${name}`, id);
    return token;
  };
  await branch('known', 'feature/a');
  const chip = one(row(doc, 'known'), '.chip.ref-pr');
  assert.equal(await text(chip), 'PR 7');
  assert.equal(await textIncludingHidden(chip), '· PR 7');
  // Branch and PR sit in one group that does not wrap, so the chip never ends up on a line of its own.
  const group = one(row(doc, 'known'), '.row-head .ref-target');
  assert.equal((await all(group, ':scope > *')).length, 2);
  await one(group, ':scope > .ref-branch:first-child').handle();
  await one(group, ':scope > .ref-pr:last-child').handle();
  await branch('unknown', 'refs/pull/8/merge');
  assert.equal((await all(doc, '.ref-pr')).length, 1);
  // No separators are drawn between tokens; spacing does that job.
  for (const line of await all(doc, '.subref')) assert.ok(!(await text(line)).includes(' / '), await text(line));
});

test('a row names its repository only when more than one repository is shown', async t => {
  const state = fixture();
  const subref = (out: SafeHtml | string) => one(parse(t, out), '.row-head .subref');
  assert.doesNotMatch(await textIncludingHidden(subref(renderFeed(state, view))), /Orders/);
  state.enabledRepos.push(stub<Repository>({ id: 'other', name: 'Billing' }));
  const repo = one(subref(renderFeed(state, view)), '.ref-repo');
  assert.equal(await text(repo), 'Orders');
  assert.equal(await textIncludingHidden(repo), 'repository Orders');
  // The selected scope decides, not which repositories happen to have rows on the page.
  assert.doesNotMatch(await textIncludingHidden(subref(renderFeed(state, { ...view, repoIds: ['r'] }))), /Orders/);
});

test('a generic branch row leads with its ref and a descriptive title keeps the ref below', async t => {
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
  const doc = parse(t, renderFeed(state, view));
  for (const [id, title, name] of [
    ['push', 'feature/a', ''],
    ['counted', '2 commits pushed', 'fix/b'],
    ['created', 'feature/b', ''],
    ['bare', 'feature/e', ''],
    ['deleted', 'feature/c', ''],
    ['old-push', 'feature/d', ''],
    ['other-ref', 'Pushed to main-old', 'main'],
    ['pr', 'PR 3 · Fix main menu', 'main'],
    ['build', 'main CI · 1', 'main'],
  ] satisfies [string, string, string][]) {
    assert.equal(await text(one(row(doc, id), '.title')), title, id);
    if (name) assert.equal(await text(one(row(doc, id), '.row-head .ref-name')), name, id);
    else assert.equal((await all(row(doc, id), '.row-head .ref-name')).length, 0, id);
  }
  // The Seen button keeps the full title, so its accessible name still says which branch.
  assert.equal(await one(row(doc, 'push'), '.seen-toggle').getAttribute('aria-label'), 'Seen: Ana pushed to feature/a');
});

test('a push that names several branches keeps its title and shows no single branch token', async t => {
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
  const doc = parse(t, renderFeed(state, view));
  assert.equal(await text(one(doc, '.title')), 'Pushed to feature/a, feature/b');
  assert.deepEqual(await facts(doc, 'multi'), ['ref-actor: pushed by Ana']);
  assert.equal(await text(one(doc, '.ref-actor .actor')), 'Ana');
  assert.equal((await all(doc, '.row time')).length, 1);
});

test('line 2 says where, who with their role, then the summary, and the right cell holds the time', async t => {
  const state = fixture();
  const base = { repoId: 'r', seen: false, imported: false, time: '2026-11-17T10:00:00Z', actor: 'Ana' };
  const pr = { ...base, kind: 'pr', branch: 'feature/a', title: 'PR 3 · Fix' } satisfies Event;
  const route = { pullRequestId: 3, sourceRefName: 'refs/heads/feature/a', targetRefName: 'refs/heads/main' };
  const merge = 'f'.repeat(40);
  state.events = [
    { ...pr, id: 'pr-open', data: { ...route, status: 'active' } },
    { ...pr, id: 'pr-merged', data: { ...route, status: 'completed', mergeCommit: merge } },
    { ...pr, id: 'pr-abandoned', data: { ...route, status: 'abandoned' } },
    // Azure can leave out the target of a completed PR; the merge commit still shows.
    {
      ...pr,
      id: 'pr-merged-untargeted',
      data: { pullRequestId: 3, sourceRefName: 'refs/heads/feature/a', status: 'completed', mergeCommit: merge },
    },
    // A fork's main into the upstream main names both, because they are branches of different repositories.
    {
      ...pr,
      id: 'pr-fork-main',
      branch: 'main',
      data: {
        pullRequestId: 3,
        sourceRefName: 'refs/heads/main',
        targetRefName: 'refs/heads/main',
        status: 'active',
        fork: { repository: 'Up-fork' },
      },
    },
    { ...base, id: 'push', kind: 'push', branch: 'feature/c', title: 'Ana pushed to feature/c', summary: 'Tidy up', data: {} },
    { ...base, id: 'linked', kind: 'push', branch: 'main', title: 'Cleanup push', actor: 'Ed', summary: 'Merge', data: {} },
    {
      ...base,
      id: 'tag',
      kind: 'tag',
      branch: 'v1',
      title: 'New tag · v1',
      data: { evidence: 'push', change: 'created', newObjectId: 'a'.repeat(40) },
    },
    {
      ...base,
      id: 'moved',
      kind: 'tag',
      branch: 'v2',
      title: 'Tag moved · v2',
      actor: 'Unknown',
      data: { evidence: 'push', change: 'moved', oldObjectId: '3f9a2c1', newObjectId: '8d41e07' },
    },
    { ...base, id: 'created', kind: 'branch-created', branch: 'feature/b', title: 'New branch · feature/b', data: { evidence: 'push' } },
    { ...base, id: 'deleted', kind: 'branch-deleted', branch: 'feature/d', title: 'Branch deleted', data: { evidence: 'push' } },
    { ...base, id: 'build', kind: 'build', branch: 'main', title: 'CI · 1', actor: 'Bo', data: { buildId: 1, reason: 'manual' } },
  ];
  const doc = parse(t, renderFeed(state, { ...view, unseenOnly: false }));
  const expected: [string, string[]][] = [
    ['pr-open', ['ref-target: feature/a→main', 'ref-actor: author Ana']],
    // A merged PR names its target and merge commit; no sentence says where it landed.
    ['pr-merged', ['ref-target: feature/a→main fffffffff', 'ref-actor: author Ana']],
    // Only open and merged PRs carry the target on line 2; an abandoned one keeps it in its summary.
    ['pr-abandoned', ['ref-target: feature/a', 'ref-actor: author Ana', 'ref-summary: Target: main']],
    ['pr-merged-untargeted', ['ref-target: feature/a fffffffff', 'ref-actor: author Ana']],
    ['pr-fork-main', ['ref-target: main→main', 'ref-actor: author Ana']],
    // A push title that names its branch leaves the branch out of line 2.
    ['push', ['ref-actor: pushed by Ana', 'ref-summary: Tidy up']],
    ['linked', ['ref-target: main', 'ref-actor: pushed by Ed', 'ref-summary: Merge']],
    ['tag', ['ref-actor: pushed by Ana', 'ref-summary: Points at aaaaaaa']],
    // An unknown actor has no role to name, so line 2 says Unknown without one.
    ['moved', ['ref-actor: Unknown', 'ref-summary: 3f9a2c1 → 8d41e07']],
    ['created', ['ref-actor: pushed by Ana']],
    ['deleted', ['ref-actor: pushed by Ana']],
    ['build', ['ref-target: main', 'ref-actor: requested by Bo', 'ref-summary: Triggered manually']],
  ];
  for (const [id, line] of expected) assert.deepEqual(await facts(doc, id), line, id);
  const sha = one(row(doc, 'pr-merged'), '.ref-sha');
  assert.equal(await sha.getAttribute('title'), merge);
  assert.doesNotMatch(await text(row(doc, 'pr-merged')), /Merged into|Landed on/);
  assert.match(
    await textIncludingHidden(one(row(doc, 'pr-open'), '.subref')),
    /source branch feature\/a→ targeting branch main · author Ana$/,
  );
  assert.equal(await one(row(doc, 'pr-open'), '.ref-route > [aria-hidden]').getAttribute('aria-hidden'), 'true');
  // Each row has one time, in its right cell, with the full date in its title.
  for (const [id] of expected) {
    const times = await all(row(doc, id), 'time');
    assert.equal(times.length, 1, id);
    assert.ok(await present(times[0]).matches('.rowact > time'), id);
    assert.equal(await present(times[0]).getAttribute('datetime'), '2026-11-17T10:00:00Z', id);
    assert.match((await present(times[0]).getAttribute('title')) ?? '', /2026/, id);
  }
});

test('a PR row lists each vote change on its own and names a fork source on the origin line', async t => {
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
    { ...base, id: 'target', data: { id: 4, status: 'active', isDraft: true, targetRefName: 'refs/heads/main', fork } },
  ];
  const doc = parse(t, renderFeed(state, view));
  // Line 2 counts the votes; the count opens the named votes under line 2, and the names appear nowhere else.
  const tally = one(row(doc, 'votes'), '.subref .ref-summary button.vote-tally');
  assert.equal(await text(tally), '1 approval, 1 waiting for author, 1 vote reset ›');
  assert.ok(await tally.hasClass('warn'), 'the tally takes the colour of its worst vote');
  assert.equal(await tally.getAttribute('data-action'), 'toggle-group');
  assert.equal(await tally.getAttribute('aria-expanded'), 'false');
  const list = one(row(doc, 'votes'), `[id='${await tally.getAttribute('aria-controls')}']`);
  assert.ok(await list.matches('details.vote-list:not([open])'));
  assert.deepEqual(await Promise.all((await all(list, 'li')).map(item => text(item))), [
    'Bo approved',
    'Cy waiting for author',
    'Di vote reset',
  ]);
  assert.ok(await one(list, ':scope li:nth-child(2) .status-text').hasClass('warn'));
  assert.doesNotMatch(await text(one(row(doc, 'votes'), '.subref')), /Bo|Cy|Di/);
  // Line 2 is no longer inside the title button, so the tally is not nested interactive content. The button names
  // the title and is described by line 2.
  assert.equal((await all(row(doc, 'votes'), '.feed-title :is(button, a, .subref)')).length, 0);
  const title = one(row(doc, 'votes'), '.feed-title');
  assert.equal(await title.getAttribute('aria-describedby'), await one(row(doc, 'votes'), '.subref').getAttribute('id'));
  assert.equal((await all(row(doc, 'target'), '.ref-summary')).length, 0);
  for (const id of ['votes', 'target']) {
    assert.match(
      await textIncludingHidden(one(row(doc, id), '.subref')),
      /source branch feature\/a→ targeting branch main · author Ana/,
      id,
    );
    const origin = one(row(doc, id), '.event-origin');
    assert.equal(await text(origin), 'From fork One-fork in Q', id);
    assert.equal((await all(origin, 'svg')).length, 1, id);
  }
  // Search and the detail page keep the single summary sentence.
  assert.equal(activitySummary(present(state.events[1])), 'From fork One-fork in Q · Target: main');
});

test('each fork origin has its own row text, and only an unchecked PR target is dotted', async t => {
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
  assert.doesNotMatch(await text(parse(t, treeLegend(new Map()))), /assumed from the pull request target/);
  assert.match(await text(parse(t, treeLegend(new Map()))), /PR target, origin not checked/);
});

test('a day header draws every lane that crosses into the row below it once, in its colour', async t => {
  const event = (kind: ActivityEvent['kind'], branch: string, data: ActivityEvent['data'] = {}): ActivityEvent => ({
    id: `${kind}-${branch}-${Math.random()}`,
    repoId: 'r',
    kind,
    branch,
    time: '',
    data,
  });
  const push = (branch: string) =>
    event('push', branch, { refUpdates: [{ name: `refs/heads/${branch}`, oldObjectId: 'a'.repeat(40), newObjectId: 'b'.repeat(40) }] });
  const pr = (id: number, source: string, status: string) =>
    event('pr', source, { pullRequestId: id, status, sourceRefName: `refs/heads/${source}`, targetRefName: 'refs/heads/main' });
  const created = (branch: string) =>
    event('branch-created', branch, {
      name: `refs/heads/${branch}`,
      oldObjectId: '0'.repeat(40),
      newObjectId: 'c'.repeat(40),
      evidence: 'push',
    });
  const { rows } = buildActivityTree([
    push('main'),
    push('feature/a'),
    // A merge whose source lane runs on above it.
    pr(7, 'feature/a', 'completed'),
    pr(8, 'feature/b', 'active'),
    push('feature/a'),
    push('main'),
    // A fork whose parent lane runs on above it.
    created('feature/b'),
    push('main'),
  ]);
  const lines = (row: TreeRow) => [row.node, row.forkFrom, row.mergeFrom].filter((line): line is TreeLine => Boolean(line));
  assert.ok(rows.some(row => row.mergeFrom?.up) && rows.some(row => row.forkFrom?.up) && rows.some(row => row.through.length));
  const key = ({ slot, color, isDefault }: { slot: number; color: number; isDefault?: boolean }) =>
    `${5 + slot * 10} ${color < 0 ? 'lane-none' : `lane-${color + 1}`}${isDefault ? ' default-lane' : ''}`;
  for (const [index, row] of rows.entries()) {
    const entering = [...row.through, ...lines(row).filter(line => line.up)].map(key).sort();
    const above = rows[index - 1];
    const leaving = above ? [...above.through, ...lines(above).filter(line => line.down)].map(key).sort() : [];
    assert.deepEqual(entering, leaving, `row ${index}: what enters from above is what left the row above`);
    const drawn = await all(parse(t, renderTreePassThrough(row)), 'svg line');
    const shown = await Promise.all(
      drawn.map(async line => {
        assert.equal(await line.getAttribute('x1'), await line.getAttribute('x2'));
        assert.deepEqual([await line.getAttribute('y1'), await line.getAttribute('y2')], ['0', '100%']);
        return `${await line.getAttribute('x1')} ${await line.getAttribute('class')}`;
      }),
    );
    assert.deepEqual(shown.sort(), entering, `row ${index}`);
  }
  const crossing = present(rows.find(row => row.mergeFrom?.up));
  const svg = one(parse(t, renderTreePassThrough(crossing)), 'svg');
  assert.ok(await svg.hasClass('tree-pass'));
  assert.ok(!(await svg.hasClass('tree')), 'a row cell selector does not count the header');
  assert.equal(await svg.getAttribute('aria-hidden'), 'true');
  assert.equal((await all(parse(t, renderTreePassThrough(present(rows[0]))), 'svg')).length, 0, 'nothing enters the first row');
});

test("a CI run time shows only the clock on its row's day and keeps its date across midnight", async t => {
  const clock = (date: Date) => new Intl.DateTimeFormat([], { hour: '2-digit', minute: '2-digit' }).format(date);
  const row = new Date(2026, 10, 27, 23, 50).toISOString();
  const sameDay = new Date(2026, 10, 27, 16, 44);
  const nextDay = new Date(2026, 10, 28, 0, 10);
  const label = async (markup: SafeHtml) => text(parse(t, markup));
  assert.equal(await label(ciTime(sameDay.toISOString(), true, row)), clock(sameDay));
  const across = await label(ciTime(nextDay.toISOString(), true, row));
  assert.notEqual(across, clock(nextDay));
  assert.equal(across, await label(ciTime(nextDay.toISOString(), true)), 'another day reads as it did');
  assert.match(across, /\b28\b/);
  const time = one(parse(t, ciTime(sameDay.toISOString(), true, row)), 'time');
  assert.match((await time.getAttribute('title')) ?? '', /2026/, 'the full date stays in the title');
  assert.equal(String(ciTime('not a time', true, row)), '');
});

test("a row's update trail shows only the clock for updates on the row's day, and the detail keeps full dates", async t => {
  const clock = (date: Date) => new Intl.DateTimeFormat([], { hour: '2-digit', minute: '2-digit' }).format(date);
  const latest = new Date(2026, 10, 27, 9, 15).toISOString();
  const earlier = new Date(2026, 10, 26, 23, 55).toISOString();
  const update = { repoId: 'r', kind: 'pr', seen: false, imported: false } satisfies Event;
  const record = stub<ActivityItem>({
    groupKey: 'pr:7',
    time: latest,
    events: [stub<ActivityEvent>({ ...update, id: 'b', time: latest }), stub<ActivityEvent>({ ...update, id: 'a', time: earlier })],
  });
  const times = async (markup: SafeHtml) => Promise.all((await all(parse(t, markup), 'time')).map(text));
  assert.deepEqual(await times(renderTrail(record)), [clock(new Date(latest)), dateTime(earlier)]);
  assert.deepEqual(await times(renderTrail(record, { expanded: true })), [dateTime(latest), dateTime(earlier)]);
});

test('Activity distinguishes tag events and tag builds from branch activity', async t => {
  const state = fixture();
  const time = '2026-11-17T10:00:00Z';
  const ref = 'refs/tags/v1';
  state.events = [
    { id: 'tag-build', kind: 'build', repoId: 'r', title: 'Release CI', branch: ref, time, data: { sourceBranch: ref } },
    {
      id: 'tag',
      kind: 'tag',
      repoId: 'r',
      title: 'New tag · v1',
      branch: 'v1',
      time,
      data: { evidence: 'push', change: 'created', newObjectId: 'a'.repeat(40) },
    },
    { id: 'push', kind: 'push', repoId: 'r', title: 'Pushed to hotfix/v1', branch: 'hotfix/v1', time },
    { id: 'main-1', kind: 'push', repoId: 'r', title: 'Pushed to main', branch: 'main', time },
    { id: 'main-2', kind: 'push', repoId: 'r', title: 'Pushed to main', branch: 'main', time },
  ];
  const doc = parse(t, renderFeed(state, view));
  assert.equal((await all(row(doc, 'tag'), '.tree .tag-mark')).length, 1);
  assert.equal((await all(row(doc, 'tag'), '.kind svg')).length, 1);
  assert.match(await text(row(doc, 'tag')), /Points at aaaaaaa/);
  assert.equal(await text(one(row(doc, 'tag'), '.title')), 'v1');
  assert.equal(await textIncludingHidden(one(row(doc, 'tag-build'), '.ref-branch')), 'tag v1');
  assert.equal(
    await one(row(doc, 'tag-build'), '.ref-branch svg path').getAttribute('d'),
    await one(row(doc, 'tag'), '.kind svg path').getAttribute('d'),
  );
  assert.equal((await all(row(doc, 'push'), '.tree .lane-none.dot')).length, 1);
  assert.match(await text(one(doc, '.tree-legend')), /No branch line shown/);
});

test('a grouped row counts its unread updates beside the title only when there is more than one', async t => {
  const state = fixture();
  const ref = { name: 'refs/heads/topic', oldObjectId: 'a'.repeat(40), newObjectId: '0'.repeat(40) };
  const base = { repoId: 'r', branch: 'topic', time: '2026-11-17T10:00:00Z' };
  state.events = [
    { ...base, id: 'paired-push', kind: 'push', title: 'Cleanup push', data: { pushId: 10001, refUpdates: [ref], commits: [] } },
    { ...base, id: 'paired-deletion', kind: 'branch-deleted', title: 'Branch deleted', data: { pushId: 10001, ...ref } },
  ];
  const doc = parse(t, renderFeed(state, view));
  assert.equal((await all(doc, '.row')).length, 1);
  const count = one(one(doc, '.row'), '.title .new-count');
  assert.equal(await text(count), '2 new');
  assert.deepEqual(await classes(count), ['new-count', 'pill', 'u']);
  state.events = [present(state.events[0])];
  assert.equal((await all(parse(t, renderFeed(state, view)), '.new-count')).length, 0);
});

/** A feed whose rows carry the CI summaries a test gives them, keyed by row ID, in place of what the store found. */
function feedWithCi(state: Fixture, summaries: Record<string, { results: CiResult[]; historyCount?: number }>) {
  const activity = activityPage(state, view);
  for (const [id, { results, historyCount = 0 }] of Object.entries(summaries)) {
    const item = present(activity.items.find(candidate => candidate.id === id));
    item.ciSummary = { results, historyCount };
    item.relatedCi = results.map(result => result.run);
  }
  return renderPagedFeed({ ...state, activity }, view);
}
const ciRun = (id: string, title: string, outcome: RelatedCi['outcome'], fields: Partial<RelatedCi> = {}): RelatedCi => ({
  id,
  time: '2026-11-17T10:05:00Z',
  title,
  validation: false,
  postMerge: true,
  outcome,
  ...fields,
});
const mergedPr = (id: string, number: number): ActivityEvent => ({
  id,
  repoId: 'r',
  kind: 'pr',
  title: `PR ${number} · Change ${number}`,
  branch: `feature/${id}`,
  actor: 'Ana',
  seen: false,
  imported: false,
  time: '2026-11-17T10:00:00Z',
  observedAt: '2026-11-17T10:00:00Z',
  data: {
    pullRequestId: number,
    status: 'completed',
    sourceRefName: `refs/heads/feature/${id}`,
    targetRefName: 'refs/heads/main',
    mergeCommit: String(number).repeat(40).slice(0, 40),
  },
});

test('a CI result with a problem gets one trouble line under line 2 that names every pipeline in a mixed state', async t => {
  const state = fixture();
  state.events = ['mixed', 'retry', 'noted', 'stale', 'recovered'].map((id, index) => mergedPr(id, index + 1));
  const doc = parse(
    t,
    feedWithCi(state, {
      mixed: {
        results: [
          { run: ciRun('b1', 'dbt-build', 'failed'), tone: 'crit' },
          { run: ciRun('b2', 'adf-deploy', 'passed'), tone: 'ok' },
        ],
        historyCount: 1,
      },
      // A pending retry stays next to its last failure.
      retry: {
        results: [
          { run: ciRun('c1', 'dbt-build', 'failed'), tone: 'crit' },
          { run: ciRun('c2', 'dbt-build', 'running'), tone: 'neutral' },
        ],
      },
      noted: { results: [{ run: ciRun('d1', 'Billing CI', 'failed'), tone: 'warn', note: 'retry order unknown' }] },
      stale: {
        results: [
          { run: ciRun('e1', 'Billing CI', 'partially succeeded', { stale: true, validation: true, postMerge: false }), tone: 'warn' },
        ],
      },
      recovered: {
        results: [{ run: ciRun('f1', 'Billing CI', 'passing again', { validation: true, postMerge: false }), tone: 'ok' }],
        historyCount: 1,
      },
    }),
  );
  const trouble = (id: string) => one(row(doc, id), '.subject > .ci-trouble');
  const parts = async (id: string) =>
    Promise.all(
      (await all(trouble(id), 'button.ci-run')).map(async part => ({
        text: await text(part),
        tone: (await classes(part)).filter(name => ['crit', 'warn', 'muted'].includes(name)).join(),
        id: await part.getAttribute('data-event-id'),
        action: await part.getAttribute('data-action'),
      })),
    );
  assert.equal(await text(trouble('mixed')), '✕ dbt-build failed · ✓ adf-deploy passed');
  assert.deepEqual(await parts('mixed'), [
    { text: '✕ dbt-build failed', tone: 'crit', id: 'b1', action: 'detail' },
    { text: '✓ adf-deploy passed', tone: 'muted', id: 'b2', action: 'detail' },
  ]);
  assert.deepEqual(
    (await parts('retry')).map(({ text, tone }) => [text, tone]),
    [
      ['✕ dbt-build failed', 'crit'],
      ['○ dbt-build running', 'warn'],
    ],
  );
  assert.equal(await text(trouble('noted')), '✕ Post-merge CI failed · Billing CI · retry order unknown');
  assert.equal(await text(one(trouble('noted'), '.ci-note')), '· retry order unknown');
  assert.equal(await text(trouble('stale')), '! PR validation partially succeeded on earlier revision · Billing CI');
  assert.equal((await parts('stale'))[0]?.tone, 'warn');
  // The left cell keeps the kind and the count; the trouble stays out of it.
  for (const id of ['mixed', 'retry', 'noted', 'stale']) assert.equal((await all(row(doc, id), '.status .ci-run')).length, 0, id);
  assert.equal(await text(one(row(doc, 'mixed'), '.status')), 'PR merged CI · 3 runs ›');
  // A recovered run has no trouble: the left cell says it passed again, muted.
  assert.equal((await all(row(doc, 'recovered'), '.ci-trouble')).length, 0);
  assert.equal(await text(one(row(doc, 'recovered'), '.status')), 'PR merged ✓ passed again CI · 2 runs ›');
  assert.equal(await text(one(row(doc, 'recovered'), '.status .ci-again')), '✓ passed again');
});

test('a CI row without a known trigger shows no summary line, and the detail page still names the gap', async t => {
  const state = fixture();
  const base = { repoId: 'r', kind: 'build', title: 'CI', time: '2026-11-17T10:00:00Z' } satisfies Event;
  state.events = [
    { ...base, id: 'omitted', data: { buildId: 1, status: 'completed', result: 'succeeded' } },
    { ...base, id: 'none', data: { buildId: 2, status: 'completed', result: 'succeeded', reason: 'none' } },
    { ...base, id: 'manual', data: { buildId: 3, status: 'completed', result: 'succeeded', reason: 'manual' } },
  ];
  const markup = String(renderFeed(state, view));
  const doc = parse(t, markup);
  assert.doesNotMatch(markup, /Not supplied/);
  assert.equal(await text(one(row(doc, 'manual'), '.ref-summary')), 'Triggered manually');
  // With no summary, line 2 ends with where the run happened.
  for (const id of ['omitted', 'none']) assert.equal((await all(row(doc, id), '.ref-summary')).length, 0, id);
  const detail = parse(t, renderDetail(present(state.events[1]), state));
  const trigger = await (
    await detail.handle()
  ).evaluate(root => [...root.querySelectorAll('dt')].find(term => term.textContent === 'Trigger')?.nextElementSibling?.textContent);
  assert.equal(trigger, 'Not supplied');
});

test('the summary counts every unread item in scope, not only the loaded rows', async t => {
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
    for (const repo of state.enabledRepos) store.saveRepo(repo);
    store.insertEvents([...state.events, ...extra]);
    const activity = store.queryActivity({ view: 'all', limit: 2 });
    const markup = renderPagedFeed({ ...state, events: [...state.events, ...extra], activity }, { ...view, unseenOnly: false });
    const summary = one(parse(t, markup), '[aria-label="Activity summary"]');
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

test('only the failed CI count uses the failure color in both summary layouts', async t => {
  const state = fixture();
  const base = { repoId: 'r', kind: 'build', title: 'CI', time: '2026-11-17T10:00:00Z' } satisfies Event;
  state.events = [
    { ...base, id: 'success', data: { buildId: 1, status: 'completed', result: 'succeeded' } },
    { ...base, id: 'failed', data: { buildId: 2, status: 'completed', result: 'failed' } },
    { ...base, id: 'running', data: { buildId: 3, status: 'inProgress' } },
    { ...base, id: 'queued', data: { buildId: 4, status: 'notStarted' } },
  ];

  const summary = one(parse(t, renderFeed(state, view)), '[aria-label="Activity summary"]');
  const cell = one(summary, '[data-summary-kind="CI runs"]');
  assert.equal(await text(one(cell, '.val.t-info')), '4');
  assert.equal(await text(one(cell, '.sub')), '1 running · 1 queued · 1 failed');
  assert.equal(await text(one(cell, 'button.t-crit[data-activity-filter="status:failed"]')), '1 failed');
  assert.equal(await text(one(cell, 'button.t-info[data-activity-filter="build"]')), 'CI runs 4');
  const chip = one(summary, '.summary-chips .chip');
  assert.deepEqual(await classes(chip), ['chip']);
  assert.equal(await text(chip), 'CI runs 4 · 1 running · 1 queued · 1 failed');
  assert.equal(await text(one(chip, 'button.t-crit[data-activity-filter="status:failed"]')), '1 failed');
  assert.equal(await text(one(chip, 'button.t-info[data-activity-filter="build"]')), 'CI runs 4');
});

test('the failed CI summary offers all CI runs even when no failures are unread', async t => {
  const state = fixture();
  const failure = {
    ...present(state.events[0]),
    data: { buildId: 42, status: 'completed', result: 'failed' },
  };
  for (const seen of [false, true]) {
    state.events = [{ ...failure, seen }];
    const page = parse(t, renderFeed(state, { ...view, unseenOnly: false, activityFilter: 'status:failed' }));
    const count = seen ? '0' : '1';
    const cell = one(page, '[data-summary-kind="CI runs"]');
    const chip = one(page, '.summary-chips .chip');
    assert.equal(await text(one(cell, '.label')), 'Failed CI runs');
    assert.equal(await text(one(cell, '.val')), count);
    assert.equal(await text(chip), `Failed CI runs ${count} · Show all CI runs`);
    for (const layout of [cell, chip]) {
      assert.equal(await text(one(layout, 'button[data-activity-filter="build"]')), 'Show all CI runs');
    }
    assert.equal(await one(page, '#kind-toggle').getAttribute('data-active'), 'true');
  }
});

test('Git Graph chips name each status from its ID and take the Activity tone', async t => {
  const activity = (id: string, kind: GitHistoryActivity['kind'], status: GitHistoryActivity['status']): GitHistoryActivity => ({
    id,
    kind,
    status,
    title: id,
    time: '2026-11-27T10:00:00.000Z',
  });
  const items = [
    activity('merged-pr', 'pr', 'merged'),
    activity('abandoned-pr', 'pr', 'pr-abandoned'),
    activity('open-pr', 'pr', 'open-pr'),
    activity('passed', 'build', 'succeeded'),
    activity('failed', 'build', 'failed'),
    activity('partial', 'build', 'partially-succeeded'),
    activity('running', 'build', 'running'),
    activity('skipped', 'build', 'skipped'),
  ];
  const repo = stub<Repository>({ id: 'orders', name: 'Orders', project: 'Demo', localPath: '/work/orders' });
  const page = stub<GitHistoryPage>({
    snapshot: 's',
    head: 'a'.repeat(40),
    branch: 'main',
    upstream: null,
    shallow: false,
    nextCursor: null,
    commits: [{ id: 'a'.repeat(40), parents: [], author: 'Ann', subject: 'Release', refs: [], activity: items }],
  });
  const doc = parse(t, renderGitGraph([repo], repo, { repoId: 'orders', path: '/work/orders', page, loading: false, error: '' }, '', ''));
  const chip = (id: string) => one(doc, `.graph-link[href="#event/${id}"]`);
  const expected: [string, string, string[]][] = [
    ['merged-pr', 'PR · Merged', ['merged', 'ok']],
    // Activity shows an abandoned pull request as a warning, so the graph does too.
    ['abandoned-pr', 'PR · PR abandoned', ['warn']],
    ['open-pr', 'PR · Open PR', ['info']],
    ['passed', 'CI · Succeeded', ['ok']],
    ['failed', 'CI · Failed', ['crit']],
    ['partial', 'CI · Partially succeeded', ['warn']],
    ['running', 'CI · Running', ['info']],
    ['skipped', 'CI · Skipped', ['neutral']],
  ];
  for (const [id, label, tone] of expected) {
    const shown = await text(chip(id));
    assert.ok(shown === label || shown.startsWith(`${label} · `), `${id}: ${shown}`);
    assert.deepEqual(await classes(chip(id)), ['chip', 'graph-link', 'status-chip', ...tone].sort(), id);
  }
});

test('two sections of the same day in a feed out of time order get distinct day header ids', async t => {
  const { groupActivity } = await import('../../src/activity.ts');
  const repo = stub<Repository>({ id: 'r1', name: 'orders-api' });
  const at = (day: number) => new Date(2026, 10, day, 12, 0).toISOString();
  const push = (id: string, day: number) =>
    stub<ActivityEvent>({ id, repoId: 'r1', kind: 'push', time: at(day), title: `Pushed ${id}`, branch: `refs/heads/${id}`, data: {} });
  const byId = new Map(groupActivity([push('a', 27), push('b', 26), push('c', 27)]).map(item => [item.id, item]));
  // A CI group can sort by a newer time than the one it shows, so a day can start twice in one list.
  const items = ['a', 'b', 'c'].map(id => present(byId.get(id)));
  const state = stub<PageState>({
    enabledRepos: [repo],
    allRepos: [repo],
    savedFilters: [],
    syncStatus: { overall: { state: 'empty' }, repos: {} },
    activity: { items, total: 3, newItems: 0, newUpdates: 0, nextCursor: null, filterOptions: [] },
  });
  const view = stub<import('../../src/ui/feed.ts').FeedView & { savedFilterId: string }>({
    unseenOnly: false,
    repoIds: null,
    search: '',
    activityFilter: '',
    filtersOpen: false,
    groups: new Map(),
    savedFilterId: '',
  });
  const headers = await all(parse(t, renderPagedFeedHtml(state, view)), 'li.day');
  const ids = await Promise.all(headers.map(header => header.getAttribute('id')));
  assert.equal(ids.length, 3);
  assert.equal(new Set(ids).size, 3, `duplicate day header ids: ${ids.join(', ')}`);
});
