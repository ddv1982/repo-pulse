import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { renderHeader as renderHeaderHtml } from '../../src/ui/header.ts';
import { renderRepositories as renderRepositoriesHtml } from '../../src/ui/repositories.ts';
import { renderFeed as renderFeedHtml } from '../../src/ui/feed.ts';
import { renderSettings as renderSettingsHtml } from '../../src/ui/settings.ts';
import type { Repository, StreamState, SyncEngineStatus, SyncStatus } from '../../src/contract.ts';
import type { ShownSyncStatus } from '../../src/ui/health.ts';
import type { PageState } from '../../src/ui/refresh.ts';
import { parse, one, all, text, textIncludingHidden, type DomElement, type DomRoot } from '../fixtures/dom.ts';
import { fakeRequest, present, stub } from '../../test/fixtures/typed.ts';

const renderHeader = (...args: Parameters<typeof renderHeaderHtml>) => String(renderHeaderHtml(...args));
const renderRepositories = (...args: Parameters<typeof renderRepositoriesHtml>) => String(renderRepositoriesHtml(...args));
/** The feed's view state; a test leaves out what it does not set, such as the selected saved filter. */
type FeedUi = Parameters<typeof renderFeedHtml>[1];
const renderFeed = (state: PageState, view: Partial<FeedUi>) => String(renderFeedHtml(state, stub<FeedUi>(view)));
const renderSettings = (...args: Parameters<typeof renderSettingsHtml>) => String(renderSettingsHtml(...args));

// themeSwitch() in the header reads the theme that web/theme.ts puts on window.
Object.assign(globalThis, { window: globalThis });

const today = new Date();
today.setHours(12, 8, 0, 0);
const since = today.toISOString();
const earlier = new Date(today.valueOf() - 45 * 60000).toISOString();
const repo = stub<Repository>({ id: 'r', name: 'orders-api', project: 'Shop' });
/** Each server state with the pill text and tone it shows. */
const states: [SyncStatus, RegExp, string][] = [
  [{ state: 'synced', since: earlier, lastCheck: since }, /^Synced · 12:08\b/, 'ok'],
  [{ state: 'syncing' }, /^Syncing…$/, 'info'],
  [{ state: 'delayed', reason: 'about 7 minutes behind', stream: 'pushes' }, /^Delayed · about 7 minutes behind$/, 'warn'],
  [{ state: 'problem', reason: 'Sign in to Azure again.', stream: 'refs' }, /^Problem$/, 'crit'],
  [{ state: 'paused' }, /^Paused$/, 'neutral'],
];
const tones = ['ok', 'info', 'warn', 'crit', 'neutral'];
/** The one tone an element carries; several read as their joined names, so a test comparing tones fails. */
const toneOf = async (element: DomElement) => {
  const classes = await element.classes();
  return tones.filter(tone => classes.includes(tone)).join('+');
};
/** The first sync pill in the markup or element, including its styling. */
async function pill(t: TestContext, from: string | DomRoot) {
  const [element] = await all(typeof from === 'string' ? parse(t, from) : from, '.sync-pill');
  if (!element) return undefined;
  assert.ok((await element.hasClass('chip')) && (await element.hasClass('status-chip')), 'the pill is styled as a status chip');
  return { element, tone: await toneOf(element), text: await text(element) };
}
async function banners(t: TestContext, markup: string) {
  return Promise.all(
    (await all(parse(t, markup), '.banner')).map(async element => {
      const title = await text(one(element, 'strong'));
      return { element, tone: await toneOf(element), title, text: (await text(element)).slice(title.length).trim() };
    }),
  );
}
const zero = (t: TestContext, markup: string) => text(one(parse(t, markup), 'b.zero'));
const bigMessage = (t: TestContext, markup: string) => text(one(parse(t, markup), 'p.big'));
const page = (overall: ShownSyncStatus, repos: Record<string, SyncStatus> = {}): PageState => ({
  repos: [repo],
  watched: [repo],
  streams: [
    stub<StreamState>({
      repoId: 'r',
      stream: 'pushes',
      initialized: true,
      lastSuccess: since,
      error: { code: 'FAILED', message: 'Read failed' },
    }),
  ],
  settings: { refreshEnabled: false },
  diagnostics: {
    startsLastMinute: 3,
    limitPerMinute: 60,
    running: 0,
    concurrency: 2,
    sync: stub<SyncEngineStatus>({ lag: { overdueStreams: 4, maxDelayMs: 9 * 60000 } }),
  },
  activity: { items: [], total: 0, newItems: 0, newUpdates: 0 },
  events: [],
  syncStatus: { overall, repos },
});
const headerView = { route: 'activity', unreadOnly: true };

test('the header shows one sync status pill per state in place of the last Azure check', async t => {
  for (const [status, label, tone] of states) {
    const doc = parse(t, renderHeader(page({ ...status, repoId: 'r' }), headerView));
    const shown = await pill(t, doc);
    assert.match(shown?.text ?? '', label, status.state);
    assert.equal(shown?.tone, tone, status.state);
    // Not in what is shown or read aloud, nor in any one label or tooltip, however the markup spells it.
    const said = [await textIncludingHidden(doc)];
    for (const element of await all(doc, '[aria-label], [title], [data-idle-title]')) {
      for (const name of ['aria-label', 'title', 'data-idle-title']) said.push((await element.getAttribute(name)) ?? '');
    }
    for (const value of said) assert.doesNotMatch(value.replace(/\s+/g, ' '), /Last Azure check|No Azure check/, value);
    assert.ok((await all(doc, '[role="switch"][aria-label="Automatic checks"]')).length, 'the automatic checks switch');
    assert.ok((await all(doc, '[data-action="refresh"]')).length, 'the refresh button');
    if (status.state === 'problem') {
      assert.equal(await shown.element.getAttribute('title'), 'Problem in orders-api: Sign in to Azure again.');
      assert.equal(await shown.element.getAttribute('aria-label'), 'Sync status: Problem in orders-api: Sign in to Azure again.');
    }
  }
  assert.equal((await pill(t, renderHeader(page({ state: 'empty' }), headerView)))?.text, 'No repositories');
});

test('each repository shows its own sync status pill with the same wording', async t => {
  for (const [status, label, tone] of states) {
    const doc = parse(t, renderRepositories(page({ state: 'synced', since, lastCheck: since, repoId: 'r' }, { r: status }), {}));
    const shown = await pill(t, one(doc, '.repo-overview'));
    assert.match(shown?.text ?? '', label, status.state);
    assert.equal(shown?.tone, tone, status.state);
    if (status.state === 'problem') assert.equal(await shown.element.getAttribute('title'), 'Problem: Sign in to Azure again.');
    assert.doesNotMatch(await text(doc), /Check failed|Check overdue|Catching up|Up to date|Checks off/);
  }
});

test('the Details of a repository list a stream warning the way they list a failed check', async t => {
  const message = 'Skipped 1 record in pushes that Azure returned without a readable value for pushId.';
  const problem: SyncStatus = { state: 'problem', reason: message, stream: 'pushes' };
  const state: PageState = {
    ...page({ ...problem, repoId: 'r' }, { r: problem }),
    streams: [
      stub<StreamState>({
        repoId: 'r',
        stream: 'pushes',
        initialized: true,
        lastSuccess: since,
        error: null,
        warning: { code: 'UNREADABLE_RECORDS', count: 1, fields: ['pushId'], message },
      }),
      stub<StreamState>({ repoId: 'r', stream: 'refs', initialized: true, error: { code: 'FAILED', message: 'Read failed' } }),
    ],
  };
  const doc = parse(t, renderRepositories(state, {}));
  assert.equal((await pill(t, one(doc, '.repo-overview')))?.text, 'Problem');
  assert.deepEqual(await Promise.all((await all(doc, '.repo-check-errors li')).map(text)), [`Pushes: ${message}`, 'Branches: Read failed']);
});

test('Activity shows at most one status banner, and only for Problem, Delayed or Paused', async t => {
  const view = { unreadOnly: true, repoIds: null, search: '', kind: '', filtersOpen: false };
  const expected: Record<string, [string, string]> = {
    problem: ['crit', 'Problem'],
    delayed: ['warn', 'Delayed'],
    paused: ['info', 'Paused'],
  };
  for (const [status] of states) {
    const found = await banners(t, renderFeed(page({ ...status, repoId: 'r' }, { r: status }), view));
    assert.ok(found.length <= 1, `${status.state}: ${found.length} banners`);
    assert.deepEqual(
      found.map(({ tone, title }) => [tone, title]),
      expected[status.state] ? [expected[status.state]] : [],
      status.state,
    );
  }
  const problem = present(
    (await banners(t, renderFeed(page({ ...present(states[3])[0], repoId: 'r' }, { r: present(states[3])[0] }), view)))[0],
  );
  assert.equal(problem.text, 'orders-api: Sign in to Azure again. See Repositories');
  assert.equal(await one(problem.element, 'a').getAttribute('href'), '#repositories');
  const delayed = present(
    (await banners(t, renderFeed(page({ ...present(states[2])[0], repoId: 'r' }, { r: present(states[2])[0] }), view)))[0],
  );
  assert.equal(delayed.text, 'orders-api: about 7 minutes behind. Showing the activity stored so far.');
  const paused = present(
    (await banners(t, renderFeed(page({ ...present(states[4])[0], repoId: 'r' }, { r: present(states[4])[0] }), view)))[0],
  );
  assert.equal(paused.text, 'Automatic checks are off. Turn them on or refresh manually.');
  const problemDoc = parse(t, renderFeed(page({ ...present(states[3])[0], repoId: 'r' }, { r: present(states[3])[0] }), view));
  assert.doesNotMatch(await text(problemDoc), /checks need attention/);
  assert.equal((await all(problemDoc, '.cell.sync')).length, 0);
});

test('Settings states the sync status in one sentence without the Azure calls counters', async t => {
  const connection = { results: new Map(), local: null, pending: null, repoId: 'r' };
  const doc = parse(t, renderSettings(page({ ...present(states[3])[0], repoId: 'r' }), connection));
  assert.doesNotMatch(await text(doc), /Azure calls|Checks behind|in the last minute|checks waiting/);
  assert.equal(await text(one(doc, '.sync-sentence')), 'Problem in orders-api: Sign in to Azure again.');
  assert.equal(await text(one(doc, '#copy-diagnostics')), 'Copy diagnostics');
  const synced = parse(t, renderSettings(page({ state: 'synced', since, lastCheck: since, repoId: 'r' }), connection));
  assert.match(await text(one(synced, '.sync-sentence')), /^Synced, last check 12:08\b/);
});

const feedView: Partial<FeedUi> = { unreadOnly: true, repoIds: null, search: '', kind: '', filtersOpen: false };

test('the Activity banner and partial wording follow the repositories in the Activity scope, the header the overall status', async t => {
  const other = stub<Repository>({ id: 's', name: 'billing-web', project: 'Shop' });
  const problem: SyncStatus = { state: 'problem', reason: 'Sign in to Azure again.', stream: 'refs' };
  const delayed: SyncStatus = { state: 'delayed', reason: 'about 7 minutes behind', stream: 'pushes' };
  const synced: SyncStatus = { state: 'synced', since, lastCheck: since };
  const twoRepos = (repos: Record<string, SyncStatus>) => ({
    ...page({ ...problem, repoId: 'r' }, repos),
    repos: [repo, other],
    watched: [repo, other],
  });

  const syncedScope = renderFeed(twoRepos({ r: problem, s: synced }), { ...feedView, repoIds: ['s'] });
  assert.deepEqual(await banners(t, syncedScope), []);
  assert.equal(await bigMessage(t, syncedScope), 'No unread updates match these filters');
  assert.equal((await pill(t, renderHeader(twoRepos({ r: problem, s: synced }), headerView)))?.text, 'Problem');

  const delayedScope = await banners(t, renderFeed(twoRepos({ r: problem, s: delayed }), { ...feedView, repoIds: ['s'] }));
  assert.deepEqual(
    delayedScope.map(({ tone, title, text }) => [tone, title, text.startsWith('billing-web: about 7 minutes behind')]),
    [['warn', 'Delayed', true]],
  );

  const everything = renderFeed(twoRepos({ r: problem, s: delayed }), feedView);
  assert.deepEqual(
    (await banners(t, everything)).map(({ title, text }) => [title, text.startsWith('orders-api: Sign in to Azure again.')]),
    [['Problem', true]],
  );
  assert.equal(await bigMessage(t, everything), 'No activity loaded yet');
});

test('a state without a sync status reads as unavailable, not as no repositories', async t => {
  const { createRefreshController } = await import('../../src/ui/refresh.ts');
  const refresh = createRefreshController({
    request: fakeRequest(async () => ({ repos: [repo], settings: { refreshEnabled: true } })),
    getView: () => ({ route: 'settings', repoIds: null, eventId: null, search: '', kind: '', generation: 0 }),
    reconcileRepositories: () => {},
    onUpdate: () => {},
    onError: assert.fail,
  });
  await refresh.load();
  const shown = await pill(t, renderHeader(refresh.state, headerView));
  assert.equal(shown?.text, 'Sync status unavailable');
  assert.equal(shown?.tone, 'neutral');
  const connection = { results: new Map(), local: null, pending: null, repoId: 'r' };
  assert.equal(await text(one(parse(t, renderSettings(refresh.state, connection)), '.sync-sentence')), 'Sync status unavailable');
  assert.equal((await pill(t, renderHeader(page({ state: 'empty' }), headerView)))?.text, 'No repositories');
});

test('with nothing loaded and a status other than Synced the summary does not claim there are no new updates', async t => {
  for (const [status] of states.slice(1)) {
    assert.equal(
      await zero(t, renderFeed(page({ ...status, repoId: 'r' }, { r: status }), feedView)),
      'No activity loaded yet',
      status.state,
    );
  }
  const synced: SyncStatus = { state: 'synced', since, lastCheck: since };
  assert.equal(await zero(t, renderFeed(page({ ...synced, repoId: 'r' }, { r: synced }), feedView)), 'No new updates');
});

test('the Activity banner is plain text, not a second live region for sync changes', async t => {
  for (const status of [present(states[2])[0], present(states[3])[0]]) {
    const state = page({ ...status, repoId: 'r' }, { r: status });
    const [banner] = await banners(t, renderFeed(state, feedView));
    assert.ok(banner, status.state);
    for (const element of [banner.element, ...(await all(banner.element, '*'))]) {
      assert.ok(!(await element.hasAttribute('role')) && !(await element.hasAttribute('aria-live')), status.state);
    }
  }
});

test('with filters active and nothing found, the summary uses the same filter wording as the feed', async t => {
  const status = present(states[2])[0];
  for (const filters of [{ search: 'hotfix' }, { kind: 'build' }, { repoIds: [] }, { repoIds: ['r'] }]) {
    const markup = renderFeed(page({ ...status, repoId: 'r' }, { r: status }), { ...feedView, ...filters });
    assert.equal(await zero(t, markup), 'No unread updates match these filters', JSON.stringify(filters));
    assert.equal(await bigMessage(t, markup), 'No unread updates match these filters');
  }
});

test('sync pills are plain text with their name and title; none is a live region', async t => {
  for (const [status] of states) {
    const state = page({ ...status, repoId: 'r' }, { r: status });
    const groups = await Promise.all(
      [renderHeader(state, headerView), renderRepositories(state, {})].map(markup => all(parse(t, markup), '.sync-pill')),
    );
    const pills = groups.flat();
    assert.ok(pills.length >= 3, status.state);
    for (const element of pills) {
      assert.ok(!(await element.hasAttribute('role')) && !(await element.hasAttribute('aria-live')), status.state);
      assert.match((await element.getAttribute('aria-label')) ?? '', /^Sync status: .+/, status.state);
      assert.ok(await element.getAttribute('title'), status.state);
    }
  }
});

test('a failed filtered load reads as a load failure in the summary, as in the feed', async t => {
  const status = present(states[2])[0];
  for (const filters of [{ search: 'hotfix' }, { kind: 'build' }, {}]) {
    const state = page({ ...status, repoId: 'r' }, { r: status });
    state.activity = { items: [], loading: false, error: 'Network down' };
    const markup = renderFeed(state, { ...feedView, ...filters });
    assert.equal(await zero(t, markup), 'Activity could not load', JSON.stringify(filters));
    assert.equal(await bigMessage(t, markup), 'Activity could not load');
  }
});

test('a problem that belongs to no repository still shows the Activity banner', async t => {
  const failed: ShownSyncStatus = { state: 'problem', reason: 'Starting from scratch failed. Try again.' };
  const markup = renderFeed({ ...page(failed, {}), repos: [], watched: [] }, { repoIds: null, unreadOnly: true, search: '', kind: '' });
  assert.deepEqual(
    (await banners(t, markup)).map(({ tone, title, text }) => [tone, title, text.startsWith('Starting from scratch failed. Try again.')]),
    [['crit', 'Problem', true]],
  );
});

test('a sync-wide problem shows on Activity while repository checks continue', async t => {
  const reason = 'The stored jobs row "backfill:r" cannot be read: days is missing or malformed.';
  const state = page({ state: 'problem', reason }, { r: { state: 'synced' } });
  const markup = renderFeed(state, { repoIds: null, unreadOnly: true, search: '', kind: '' });
  assert.match(present((await banners(t, markup))[0]).text, /The stored jobs row "backfill:r" cannot be read/);
});
