import test from 'node:test';
import assert from 'node:assert/strict';
import { renderHeader } from '../src/ui/header.js';
import { renderRepositories } from '../src/ui/repositories.js';
import { renderFeed } from '../src/ui/feed.js';
import { renderSettings } from '../src/ui/settings.js';
import { syncLabel } from '../src/ui/health.js';

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
const pill = markup => markup.match(/<span class="chip status-chip sync-pill (\w+)"([^>]*)>([^<]*)<\/span>/);
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
  for (const [status, text, tone] of states) {
    const markup = renderHeader(page({ ...status, repoId: 'r' }), headerView);
    const [, shownTone, attributes, shown] = pill(markup) ?? [];
    assert.match(shown ?? '', text, status.state);
    assert.equal(shownTone, tone, status.state);
    assert.doesNotMatch(markup, /Last Azure check|No Azure check/);
    assert.match(markup, /role="switch"[^>]*aria-label="Automatic checks"/);
    assert.match(markup, /data-action="refresh"/);
    if (status.state === 'problem') {
      assert.match(attributes, /title="Problem in orders-api: Sign in to Azure again\."/);
      assert.match(attributes, /aria-label="Sync status: Problem in orders-api: Sign in to Azure again\."/);
    }
  }
  assert.match(pill(renderHeader(page({ state: 'empty' }), headerView))?.[3] ?? '', /^No repositories$/);
});

test('each repository shows its own sync status pill with the same wording', () => {
  for (const [status, text, tone] of states) {
    const markup = renderRepositories(page({ state: 'synced', since, lastCheck: since, repoId: 'r' }, { r: status }), {});
    const overview = markup.match(/<div class="repo-overview">([\s\S]*?)<\/div>/)?.[1] ?? '';
    const [, shownTone, attributes, shown] = pill(overview) ?? [];
    assert.match(shown ?? '', text, status.state);
    assert.equal(shownTone, tone, status.state);
    if (status.state === 'problem') assert.match(attributes, /title="Problem: Sign in to Azure again\."/);
    assert.doesNotMatch(markup, /Check failed|Check overdue|Catching up|Up to date|Checks off/);
  }
});

test('Activity shows at most one status banner, and only for Problem, Delayed or Paused', () => {
  const banners = markup => [...markup.matchAll(/<div class="banner (\w+)"[^>]*><div><strong>([^<]*)<\/strong>([\s\S]*?)<\/div><\/div>/g)];
  const view = { route: 'catchup', repoIds: null, search: '', kind: '', filtersOpen: false };
  const expected = { problem: ['crit', 'Problem'], delayed: ['warn', 'Delayed'], paused: ['info', 'Paused'] };
  for (const [status] of states) {
    const found = banners(renderFeed(page({ ...status, repoId: 'r' }, { r: status }), view));
    assert.ok(found.length <= 1, `${status.state}: ${found.length} banners`);
    assert.deepEqual(
      found.map(([, tone, title]) => [tone, title]),
      expected[status.state] ? [expected[status.state]] : [],
      status.state,
    );
  }
  const [problem] = banners(renderFeed(page({ ...states[3][0], repoId: 'r' }, { r: states[3][0] }), view));
  assert.match(problem[3], /orders-api: Sign in to Azure again\./);
  assert.match(problem[3], /href="#repositories"/);
  const [delayed] = banners(renderFeed(page({ ...states[2][0], repoId: 'r' }, { r: states[2][0] }), view));
  assert.match(delayed[3], /orders-api: about 7 minutes behind/);
  assert.doesNotMatch(
    renderFeed(page({ ...states[3][0], repoId: 'r' }, { r: states[3][0] }), view),
    /checks need attention|class="cell sync"/,
  );
});

test('Settings states the sync status in one sentence without the Azure calls counters', () => {
  const connection = { results: new Map(), local: null, pending: null, repoId: 'r' };
  const markup = renderSettings(page({ ...states[3][0], repoId: 'r' }), connection);
  assert.doesNotMatch(markup, /Azure calls|Checks behind|in the last minute|checks waiting/);
  assert.match(markup, /<p class="sync-sentence">Problem in orders-api: Sign in to Azure again\.<\/p>/);
  assert.match(markup, /id="copy-diagnostics"/);
  assert.match(
    renderSettings(page({ state: 'synced', since, lastCheck: since, repoId: 'r' }), connection),
    /<p class="sync-sentence">Synced, last check 12:08\b/,
  );
});

const feedView = { route: 'catchup', repoIds: null, search: '', kind: '', filtersOpen: false };
const banners = markup => [...markup.matchAll(/<div class="banner (\w+)"([^>]*)><div><strong>([^<]*)<\/strong>([\s\S]*?)<\/div><\/div>/g)];

test('the Activity banner and partial wording follow the repositories in the Activity scope, the header the overall status', () => {
  const other = { id: 's', name: 'billing-web', project: 'Shop' };
  const problem = { state: 'problem', reason: 'Sign in to Azure again.', stream: 'refs' };
  const delayed = { state: 'delayed', reason: 'about 7 minutes behind', stream: 'pushes' };
  const synced = { state: 'synced', since, lastCheck: since };
  const twoRepos = repos => ({ ...page({ ...problem, repoId: 'r' }, repos), repos: [repo, other], watched: [repo, other] });

  const syncedScope = renderFeed(twoRepos({ r: problem, s: synced }), { ...feedView, repoIds: ['s'] });
  assert.deepEqual(banners(syncedScope), []);
  assert.match(syncedScope, /<p class="big">No new updates<\/p>/);
  assert.match(pill(renderHeader(twoRepos({ r: problem, s: synced }), { ...headerView, repoIds: ['s'] }))?.[3] ?? '', /^Problem$/);

  const delayedScope = banners(renderFeed(twoRepos({ r: problem, s: delayed }), { ...feedView, repoIds: ['s'] }));
  assert.deepEqual(
    delayedScope.map(([, tone, , title, text]) => [tone, title, text.startsWith('billing-web: about 7 minutes behind')]),
    [['warn', 'Delayed', true]],
  );

  const all = renderFeed(twoRepos({ r: problem, s: delayed }), feedView);
  assert.deepEqual(
    banners(all).map(([, , , title, text]) => [title, text.startsWith('orders-api: Sign in to Azure again.')]),
    [['Problem', true]],
  );
  assert.match(all, /<p class="big">No activity loaded yet<\/p>/);
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
  const [, tone, , shown] = pill(renderHeader(refresh.state, headerView)) ?? [];
  assert.equal(shown, 'Sync status unavailable');
  assert.equal(tone, 'neutral');
  const connection = { results: new Map(), local: null, pending: null, repoId: 'r' };
  assert.match(renderSettings(refresh.state, connection), /<p class="sync-sentence">Sync status unavailable<\/p>/);
  assert.match(pill(renderHeader(page({ state: 'empty' }), headerView))?.[3] ?? '', /^No repositories$/);
});

test('with nothing loaded and a status other than Synced the summary does not claim there are no new updates', () => {
  for (const [status] of states.slice(1)) {
    const summary = renderFeed(page({ ...status, repoId: 'r' }, { r: status }), feedView).match(/<b class="zero">([^<]*)<\/b>/)?.[1];
    assert.equal(summary, 'No activity loaded yet', status.state);
  }
  const synced = { state: 'synced', since, lastCheck: since };
  assert.equal(
    renderFeed(page({ ...synced, repoId: 'r' }, { r: synced }), feedView).match(/<b class="zero">([^<]*)<\/b>/)?.[1],
    'No new updates',
  );
});

test('the Activity banner is plain text, not a second live region for sync changes', () => {
  for (const status of [states[2][0], states[3][0]]) {
    const state = page({ ...status, repoId: 'r' }, { r: status });
    const [banner] = banners(renderFeed(state, feedView));
    assert.ok(banner, status.state);
    assert.doesNotMatch(banner[0], /role=|aria-live/, status.state);
  }
});

test('with filters active and nothing found, the summary uses the same filter wording as the feed', () => {
  const status = states[2][0];
  for (const filters of [{ search: 'hotfix' }, { kind: 'build' }, { repoIds: [] }]) {
    const markup = renderFeed(page({ ...status, repoId: 'r' }, { r: status }), { ...feedView, ...filters });
    assert.equal(markup.match(/<b class="zero">([^<]*)<\/b>/)?.[1], 'No activity matches these filters', JSON.stringify(filters));
    assert.match(markup, /<p class="big">No activity matches these filters<\/p>/);
  }
});

test('sync pills are plain text with their name and title; none is a live region', () => {
  for (const [status] of states) {
    const state = page({ ...status, repoId: 'r' }, { r: status });
    const pills = [renderHeader(state, headerView), renderRepositories(state, {})].flatMap(markup => [
      ...markup.matchAll(/<span class="chip status-chip sync-pill[^>]*>/g),
    ]);
    assert.ok(pills.length >= 3, status.state);
    for (const [tag] of pills) {
      assert.doesNotMatch(tag, /role=|aria-live/, status.state);
      assert.match(tag, /aria-label="Sync status: [^"]+" title="[^"]+"/, status.state);
    }
  }
});

test('a failed filtered load reads as a load failure in the summary, as in the feed', () => {
  const status = states[2][0];
  for (const filters of [{ search: 'hotfix' }, { kind: 'build' }, {}]) {
    const state = page({ ...status, repoId: 'r' }, { r: status });
    state.activity = { items: [], loading: false, error: 'Network down' };
    const markup = renderFeed(state, { ...feedView, ...filters });
    assert.equal(markup.match(/<b class="zero">([^<]*)<\/b>/)?.[1], 'Activity could not load', JSON.stringify(filters));
    assert.match(markup, /<p class="big">Activity could not load<\/p>/);
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
  assert.match(markup, /<div class="banner crit"><div><strong>Problem<\/strong>Starting from scratch failed\. Try again\./);
});
