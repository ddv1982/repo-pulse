import test from 'node:test';
import assert from 'node:assert/strict';
import { renderHeader } from '../src/ui/header.js';
import { renderRepositories } from '../src/ui/repositories.js';
import { renderFeed } from '../src/ui/feed.js';
import { renderSettings } from '../src/ui/settings.js';

// themeSwitch() in the header reads the theme that web/theme.js puts on window.
Object.assign(globalThis, { window: globalThis });

const today = new Date();
today.setHours(12, 8, 0, 0);
const since = today.toISOString();
const repo = { id: 'r', name: 'orders-api', project: 'Shop' };
/** Each server state with the pill text and tone it shows. */
const states = [
  [{ state: 'synced', since }, /^Synced · 12:08\b/, 'ok'],
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
    const markup = renderRepositories(page({ state: 'synced', since, repoId: 'r' }, { r: status }), {});
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
    const found = banners(renderFeed(page({ ...status, repoId: 'r' }), view));
    assert.ok(found.length <= 1, `${status.state}: ${found.length} banners`);
    assert.deepEqual(
      found.map(([, tone, title]) => [tone, title]),
      expected[status.state] ? [expected[status.state]] : [],
      status.state,
    );
  }
  const [problem] = banners(renderFeed(page({ ...states[3][0], repoId: 'r' }), view));
  assert.match(problem[3], /orders-api: Sign in to Azure again\./);
  assert.match(problem[3], /href="#repositories"/);
  const [delayed] = banners(renderFeed(page({ ...states[2][0], repoId: 'r' }), view));
  assert.match(delayed[3], /orders-api: about 7 minutes behind/);
  assert.doesNotMatch(renderFeed(page({ ...states[3][0], repoId: 'r' }), view), /checks need attention|class="cell sync"/);
});

test('Settings states the sync status in one sentence without the Azure calls counters', () => {
  const connection = { results: new Map(), local: null, pending: null, repoId: 'r' };
  const markup = renderSettings(page({ ...states[3][0], repoId: 'r' }), connection);
  assert.doesNotMatch(markup, /Azure calls|Checks behind|in the last minute|checks waiting/);
  assert.match(markup, /<p class="sync-sentence">Problem in orders-api: Sign in to Azure again\.<\/p>/);
  assert.match(markup, /id="copy-diagnostics"/);
  assert.match(
    renderSettings(page({ state: 'synced', since, repoId: 'r' }), connection),
    /<p class="sync-sentence">Synced, last check 12:08\b/,
  );
});
