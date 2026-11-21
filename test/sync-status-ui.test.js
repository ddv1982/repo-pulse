import test from 'node:test';
import assert from 'node:assert/strict';
import { renderHeader as renderHeaderHtml } from '../src/ui/header.js';
import { renderRepositories as renderRepositoriesHtml } from '../src/ui/repositories.js';
import { renderFeed as renderFeedHtml } from '../src/ui/feed.js';
import { renderSettings as renderSettingsHtml } from '../src/ui/settings.js';
import { syncLabel } from '../src/ui/health.js';
import { parse, one, all, text } from './fixtures/dom.js';

const renderHeader = (...args) => String(renderHeaderHtml(...args));
const renderRepositories = (...args) => String(renderRepositoriesHtml(...args));
const renderFeed = (...args) => String(renderFeedHtml(...args));
const renderSettings = (...args) => String(renderSettingsHtml(...args));

// themeSwitch() in the header reads the theme that web/theme.js puts on window.
Object.assign(globalThis, { window: globalThis });

const today = new Date();
today.setHours(12, 8, 0, 0);
const since = today.toISOString();
const earlier = new Date(today.valueOf() - 45 * 60000).toISOString();
const repo = { id: 'r', name: 'orders-api', project: 'Shop' };
/** Each server state with the pill text and tone it shows. */
const states = [
  [{ state: 'synced', since: earlier, lastCheck: since }, /^Synced · 12:08\b/, 'ok'],
  [{ state: 'syncing' }, /^Syncing…$/, 'info'],
  [{ state: 'delayed', reason: 'about 7 minutes behind', stream: 'pushes' }, /^Delayed · about 7 minutes behind$/, 'warn'],
  [{ state: 'problem', reason: 'Sign in to Azure again.', stream: 'refs' }, /^Problem$/, 'crit'],
  [{ state: 'paused' }, /^Paused$/, 'neutral'],
];
const tones = ['ok', 'info', 'warn', 'crit', 'neutral'];
/** A sync pill's tone, text and element: the first pill in the markup or element. */
const pill = from => {
  const element = (typeof from === 'string' ? parse(from) : from).querySelector('.sync-pill');
  return element ? { element, tone: tones.find(tone => element.classList.contains(tone)), text: text(element) } : undefined;
};
/** The status banners of a page: tone, bold title and the text after it. */
const banners = markup =>
  all(parse(markup), '.banner').map(element => {
    const title = text(one(element, 'strong'));
    return { element, tone: tones.find(tone => element.classList.contains(tone)), title, text: text(element).slice(title.length).trim() };
  });
/** The summary headline when nothing is new. */
const zero = markup => text(one(parse(markup), 'b.zero'));
/** The feed's empty-state message. */
const bigMessage = markup => text(one(parse(markup), 'p.big'));
const page = (overall, repos = {}) => ({
  repos: [repo],
  watched: [repo],
  streams: [{ repoId: 'r', stream: 'pushes', initialized: true, lastSuccess: since, error: { code: 'FAILED', message: 'Read failed' } }],
  settings: { refreshEnabled: false },
  diagnostics: {
    startsLastMinute: 3,
    limitPerMinute: 60,
    running: 0,
    concurrency: 2,
    sync: { lag: { overdueStreams: 4, maxDelayMs: 9 * 60000 } },
  },
  activity: { items: [], total: 0, newItems: 0, newUpdates: 0 },
  events: [],
  syncStatus: { overall, repos },
});
const headerView = { repoIds: null, route: 'activity', activityRoute: 'catchup' };

test('the header shows one sync status pill per state in place of the last Azure check', () => {
  for (const [status, label, tone] of states) {
    const doc = parse(renderHeader(page({ ...status, repoId: 'r' }), headerView));
    const shown = pill(doc);
    assert.match(shown?.text ?? '', label, status.state);
    assert.equal(shown?.tone, tone, status.state);
    assert.doesNotMatch(text(doc), /Last Azure check|No Azure check/);
    assert.ok(all(doc, '[role="switch"][aria-label="Automatic checks"]').length, 'the automatic checks switch');
    assert.ok(all(doc, '[data-action="refresh"]').length, 'the refresh button');
    if (status.state === 'problem') {
      assert.equal(shown.element.getAttribute('title'), 'Problem in orders-api: Sign in to Azure again.');
      assert.equal(shown.element.getAttribute('aria-label'), 'Sync status: Problem in orders-api: Sign in to Azure again.');
    }
  }
  assert.equal(pill(renderHeader(page({ state: 'empty' }), headerView))?.text, 'No repositories');
});

test('each repository shows its own sync status pill with the same wording', () => {
  for (const [status, label, tone] of states) {
    const doc = parse(renderRepositories(page({ state: 'synced', since, lastCheck: since, repoId: 'r' }, { r: status }), {}));
    const shown = pill(one(doc, '.repo-overview'));
    assert.match(shown?.text ?? '', label, status.state);
    assert.equal(shown?.tone, tone, status.state);
    if (status.state === 'problem') assert.equal(shown.element.getAttribute('title'), 'Problem: Sign in to Azure again.');
    assert.doesNotMatch(text(doc), /Check failed|Check overdue|Catching up|Up to date|Checks off/);
  }
});

test('Activity shows at most one status banner, and only for Problem, Delayed or Paused', () => {
  const view = { route: 'catchup', repoIds: null, search: '', kind: '', filtersOpen: false };
  const expected = { problem: ['crit', 'Problem'], delayed: ['warn', 'Delayed'], paused: ['info', 'Paused'] };
  for (const [status] of states) {
    const found = banners(renderFeed(page({ ...status, repoId: 'r' }, { r: status }), view));
    assert.ok(found.length <= 1, `${status.state}: ${found.length} banners`);
    assert.deepEqual(
      found.map(({ tone, title }) => [tone, title]),
      expected[status.state] ? [expected[status.state]] : [],
      status.state,
    );
  }
  const [problem] = banners(renderFeed(page({ ...states[3][0], repoId: 'r' }, { r: states[3][0] }), view));
  assert.equal(problem.text, 'orders-api: Sign in to Azure again. See Repositories');
  assert.equal(one(problem.element, 'a').getAttribute('href'), '#repositories');
  const [delayed] = banners(renderFeed(page({ ...states[2][0], repoId: 'r' }, { r: states[2][0] }), view));
  assert.equal(delayed.text, 'orders-api: about 7 minutes behind. Showing the activity stored so far.');
  const [paused] = banners(renderFeed(page({ ...states[4][0], repoId: 'r' }, { r: states[4][0] }), view));
  assert.equal(paused.text, 'Automatic checks are off. Turn them on or refresh manually.');
  const problemDoc = parse(renderFeed(page({ ...states[3][0], repoId: 'r' }, { r: states[3][0] }), view));
  assert.doesNotMatch(text(problemDoc), /checks need attention/);
  assert.equal(all(problemDoc, '.cell.sync').length, 0);
});

test('Settings states the sync status in one sentence without the Azure calls counters', () => {
  const connection = { results: new Map(), local: null, pending: null, repoId: 'r' };
  const doc = parse(renderSettings(page({ ...states[3][0], repoId: 'r' }), connection));
  assert.doesNotMatch(text(doc), /Azure calls|Checks behind|in the last minute|checks waiting/);
  assert.equal(text(one(doc, '.sync-sentence')), 'Problem in orders-api: Sign in to Azure again.');
  assert.equal(text(one(doc, '#copy-diagnostics')), 'Copy diagnostics');
  const synced = parse(renderSettings(page({ state: 'synced', since, lastCheck: since, repoId: 'r' }), connection));
  assert.match(text(one(synced, '.sync-sentence')), /^Synced, last check 12:08\b/);
});

const feedView = { route: 'catchup', repoIds: null, search: '', kind: '', filtersOpen: false };

test('the Activity banner and partial wording follow the repositories in the Activity scope, the header the overall status', () => {
  const other = { id: 's', name: 'billing-web', project: 'Shop' };
  const problem = { state: 'problem', reason: 'Sign in to Azure again.', stream: 'refs' };
  const delayed = { state: 'delayed', reason: 'about 7 minutes behind', stream: 'pushes' };
  const synced = { state: 'synced', since, lastCheck: since };
  const twoRepos = repos => ({ ...page({ ...problem, repoId: 'r' }, repos), repos: [repo, other], watched: [repo, other] });

  const syncedScope = renderFeed(twoRepos({ r: problem, s: synced }), { ...feedView, repoIds: ['s'] });
  assert.deepEqual(banners(syncedScope), []);
  assert.equal(bigMessage(syncedScope), 'No unread updates match these filters');
  assert.equal(pill(renderHeader(twoRepos({ r: problem, s: synced }), { ...headerView, repoIds: ['s'] }))?.text, 'Problem');

  const delayedScope = banners(renderFeed(twoRepos({ r: problem, s: delayed }), { ...feedView, repoIds: ['s'] }));
  assert.deepEqual(
    delayedScope.map(({ tone, title, text }) => [tone, title, text.startsWith('billing-web: about 7 minutes behind')]),
    [['warn', 'Delayed', true]],
  );

  const everything = renderFeed(twoRepos({ r: problem, s: delayed }), feedView);
  assert.deepEqual(
    banners(everything).map(({ title, text }) => [title, text.startsWith('orders-api: Sign in to Azure again.')]),
    [['Problem', true]],
  );
  assert.equal(bigMessage(everything), 'No activity loaded yet');
});

test('a state without a sync status reads as unavailable, not as no repositories', async () => {
  const { createRefreshController } = await import('../src/ui/refresh.js');
  const refresh = createRefreshController({
    request: async () => ({ repos: [repo], settings: { refreshEnabled: true } }),
    getView: () => ({ route: 'settings', repoIds: null, eventId: null, search: '', kind: '', generation: 0 }),
    reconcileRepositories: () => {},
    onUpdate: () => {},
    onError: assert.fail,
  });
  await refresh.load();
  const shown = pill(renderHeader(refresh.state, headerView));
  assert.equal(shown?.text, 'Sync status unavailable');
  assert.equal(shown?.tone, 'neutral');
  const connection = { results: new Map(), local: null, pending: null, repoId: 'r' };
  assert.equal(text(one(parse(renderSettings(refresh.state, connection)), '.sync-sentence')), 'Sync status unavailable');
  assert.equal(pill(renderHeader(page({ state: 'empty' }), headerView))?.text, 'No repositories');
});

test('with nothing loaded and a status other than Synced the summary does not claim there are no new updates', () => {
  for (const [status] of states.slice(1)) {
    assert.equal(zero(renderFeed(page({ ...status, repoId: 'r' }, { r: status }), feedView)), 'No activity loaded yet', status.state);
  }
  const synced = { state: 'synced', since, lastCheck: since };
  assert.equal(zero(renderFeed(page({ ...synced, repoId: 'r' }, { r: synced }), feedView)), 'No new updates');
});

test('the Activity banner is plain text, not a second live region for sync changes', () => {
  for (const status of [states[2][0], states[3][0]]) {
    const state = page({ ...status, repoId: 'r' }, { r: status });
    const [banner] = banners(renderFeed(state, feedView));
    assert.ok(banner, status.state);
    for (const element of [banner.element, ...all(banner.element, '*')]) {
      assert.ok(!element.hasAttribute('role') && !element.hasAttribute('aria-live'), status.state);
    }
  }
});

test('with filters active and nothing found, the summary uses the same filter wording as the feed', () => {
  const status = states[2][0];
  for (const filters of [{ search: 'hotfix' }, { kind: 'build' }, { repoIds: [] }, { repoIds: ['r'] }]) {
    const markup = renderFeed(page({ ...status, repoId: 'r' }, { r: status }), { ...feedView, ...filters });
    assert.equal(zero(markup), 'No unread updates match these filters', JSON.stringify(filters));
    assert.equal(bigMessage(markup), 'No unread updates match these filters');
  }
});

test('sync pills are plain text with their name and title; none is a live region', () => {
  for (const [status] of states) {
    const state = page({ ...status, repoId: 'r' }, { r: status });
    const pills = [renderHeader(state, headerView), renderRepositories(state, {})].flatMap(markup => all(parse(markup), '.sync-pill'));
    assert.ok(pills.length >= 3, status.state);
    for (const element of pills) {
      assert.ok(!element.hasAttribute('role') && !element.hasAttribute('aria-live'), status.state);
      assert.match(element.getAttribute('aria-label') ?? '', /^Sync status: .+/, status.state);
      assert.ok(element.getAttribute('title'), status.state);
    }
  }
});

test('a failed filtered load reads as a load failure in the summary, as in the feed', () => {
  const status = states[2][0];
  for (const filters of [{ search: 'hotfix' }, { kind: 'build' }, {}]) {
    const state = page({ ...status, repoId: 'r' }, { r: status });
    state.activity = { items: [], loading: false, error: 'Network down' };
    const markup = renderFeed(state, { ...feedView, ...filters });
    assert.equal(zero(markup), 'Activity could not load', JSON.stringify(filters));
    assert.equal(bigMessage(markup), 'Activity could not load');
  }
});

test('a throttling delay keeps the Azure DevOps name capitalised in the pill', () => {
  assert.equal(
    syncLabel({ state: 'delayed', reason: 'Azure DevOps asked us to slow down' }),
    'Delayed · Azure DevOps asked us to slow down',
  );
  assert.equal(syncLabel({ state: 'delayed', reason: 'Checks are behind schedule' }), 'Delayed · checks are behind schedule');
});

test('a problem that belongs to no repository still shows the Activity banner', () => {
  const failed = { state: 'problem', reason: 'Starting from scratch failed. Try again.' };
  const markup = renderFeed({ ...page(failed, {}), repos: [], watched: [] }, { repoIds: null, route: 'catchup', search: '', kind: '' });
  assert.deepEqual(
    banners(markup).map(({ tone, title, text }) => [tone, title, text.startsWith('Starting from scratch failed. Try again.')]),
    [['crit', 'Problem', true]],
  );
});
