import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { chromium, expect } from '@playwright/test';
import { startApp, createApp } from '../server.js';
import { createStore } from '../server/store.js';
import { createSync } from '../server/sync.js';

async function browserPath() {
  if (process.env.CHROME) return process.env.CHROME;
  if (existsSync(chromium.executablePath())) return chromium.executablePath();
  const cache = join(homedir(), '.cache', 'ms-playwright');
  for (const name of (await readdir(cache).catch(() => [])).filter(name => /^chromium-\d+$/.test(name)).sort().reverse()) {
    for (const relative of ['chrome-linux64/chrome', 'chrome-linux/chrome']) {
      const candidate = join(cache, name, relative);
      if (existsSync(candidate)) return candidate;
    }
  }
  throw new Error('Install Chromium with npx playwright install chromium, or set CHROME.');
}

async function selectActivityType(page, label) {
  await page.getByRole('button', { name: /^Activity type:/ }).click();
  await page.getByRole('option', { name: label, exact: true }).click();
}

async function setup(t, demo = true) {
  const directory = await mkdtemp(join(tmpdir(), 'repo-pulse-ui-'));
  let runtime = await startApp({ demo, port: 0, dataDir: directory });
  const browser = await chromium.launch({ executablePath: await browserPath(), headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, colorScheme: 'light' });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  t.after(async () => { await browser.close(); await runtime.close(); await rm(directory, { recursive: true, force: true }); assert.deepEqual(errors, []); });
  await page.goto(runtime.url);
  await expect(page.getByRole('link', { name: 'Repo Pulse', exact: true })).toBeVisible();
  await mkdir('test-results', { recursive: true });
  return { page, get runtime() { return runtime; }, async restart() { await runtime.close(); runtime = await startApp({ demo, port: 0, dataDir: directory }); await page.goto(runtime.url); } };
}

test('approved light/dark/System UI and responsive routes work without remote traffic', async t => {
  const { page } = await setup(t);
  await expect(page.getByText('Demo mode · fictional repositories and people')).toBeVisible();
  await expect(page.locator('[data-event-id="demo-branch-1"]')).toContainText('hotfix/2026.11-dose-rounding');
  const remoteReads = [];
  page.on('request', request => { if (/\/api\/(refresh|connection|repos)(\?|$)/.test(request.url())) remoteReads.push(request.url()); });
  await page.getByRole('button', { name: 'Light', exact: true }).click();
  await page.screenshot({ path: 'test-results/app-light.png', fullPage: true });
  await page.getByRole('button', { name: 'Dark', exact: true }).click();
  await expect(page.locator('html')).toHaveClass(/dark/);
  await page.reload();
  await expect(page.getByRole('button', { name: 'Dark', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await page.screenshot({ path: 'test-results/app-dark.png', fullPage: true });
  await page.getByRole('button', { name: 'System', exact: true }).click();
  await page.emulateMedia({ colorScheme: 'light' });
  await expect(page.locator('html')).not.toHaveClass(/dark/);
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(page.locator('html')).toHaveClass(/dark/);
  assert.deepEqual(remoteReads, []);
  for (const width of [360, 728, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    for (const route of ['activity/new', 'activity/all', 'repositories', 'settings']) {
      await page.goto(`${page.url().split('#')[0]}#${route}`);
      await expect(page.locator('main h1')).toHaveCount(1);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${route} overflow at ${width}`);
    }
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${page.url().split('#')[0]}#activity/new`);
  await page.screenshot({ path: 'test-results/app-phone-dark.png', fullPage: true });
  await page.getByRole('button', { name: 'Light', exact: true }).click();
  await page.screenshot({ path: 'test-results/app-phone-light.png', fullPage: true });
});

test('repo subset acknowledgement preserves hidden/incoming events and survives restart', async t => {
  const app = await setup(t);
  const { page } = app;
  await page.locator('#repo-toggle').click();
  await page.locator('[data-scope-repo="demo-orders"]').uncheck();
  await page.locator('[data-scope-repo="demo-shared"]').uncheck();
  await page.keyboard.press('Escape');
  await expect(page.locator('[data-event-id]')).toHaveCount(2);
  const before = await (await fetch(app.runtime.url + '/api/state')).json();
  let incoming;
  await page.route('**/api/ack', async route => {
    const response = await fetch(app.runtime.url + '/api/demo/event', { method: 'POST', headers: { 'content-type': 'application/json', 'x-repo-pulse-token': before.csrfToken }, body: '{}' });
    incoming = await response.json();
    await route.continue();
  }, { times: 1 });
  await page.getByRole('button', { name: 'Mark shown seen (2)', exact: true }).click();
  await expect(page.getByRole('dialog')).not.toBeVisible();
  await expect(page.getByRole('button', { name: 'Mark shown seen (0)', exact: true })).toBeDisabled();
  assert.ok(app.runtime.store.listEvents().filter(event => event.repoId === 'demo-billing').every(event => event.seen));
  assert.equal(app.runtime.store.getEvent(incoming.id).seen, false);
  assert.equal(app.runtime.store.getEvent('demo-branch-1').seen, false);
  await app.restart();
  assert.ok(app.runtime.store.listEvents().filter(event => event.repoId === 'demo-billing').every(event => event.seen));
  assert.equal(app.runtime.store.getEvent(incoming.id).seen, false);
  await page.locator('[data-event-id="demo-branch-1"] .feed-title').click();
  await expect(page.getByRole('heading', { name: 'hotfix/2026.11-dose-rounding' })).toBeVisible();
  assert.equal((await (await fetch(app.runtime.url + '/api/events/demo-branch-1')).json()).event.seen, false);
});

test('all branches remain visible without rules, with working settings', async t => {
  const app = await setup(t);
  const { page } = app;
  await page.reload();
  await expect(page.getByRole('link', { name: 'Rules', exact: true })).toHaveCount(0);
  await expect(page.getByRole('checkbox', { name: 'Show muted', exact: true })).toHaveCount(0);
  await expect(page.locator('[data-event-id="demo-branch-1"]')).toBeVisible();
  await page.goto(app.runtime.url + '/#rules');
  await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Watch and mute rules' })).toHaveCount(0);
  await page.getByRole('link', { name: 'Repositories', exact: true }).click();
  await page.getByRole('link', { name: 'Settings', exact: true }).click();
  await page.locator('#page').getByLabel('Automatic checks', { exact: true }).uncheck();
  await expect(page.locator('#page').getByRole('switch', { name: 'Automatic checks' })).not.toBeChecked();
  assert.equal((await (await fetch(app.runtime.url + '/api/state')).json()).settings.refreshEnabled, false);
});

test('disabling a repository hides it everywhere except Repositories until it is enabled again', async t => {
  const { page, runtime } = await setup(t);
  const billingRows = page.locator('#page .subref', { hasText: 'billing-web' });
  await page.getByRole('link', { name: 'All activity' }).click();
  await expect(billingRows.first()).toBeVisible();
  await page.locator('#repo-toggle').click();
  await page.locator('#repo-panel [data-scope-repo="demo-shared"]').uncheck();
  await page.locator('#repo-toggle').click();
  await expect(page.locator('#repo-toggle')).toHaveAccessibleName('2 repositories shown');
  await page.getByRole('link', { name: 'Repositories', exact: true }).click();
  const toggle = page.getByRole('switch', { name: 'Watch billing-web' });
  await expect(toggle).toBeChecked();
  await toggle.click();
  await expect(toggle).not.toBeChecked();
  await expect(page.getByText('3 watched · 1 disabled')).toBeVisible();
  const row = page.locator('.repo-entry', { has: toggle });
  await expect(row.getByText('Disabled', { exact: true })).toBeVisible();
  await expect(row.getByRole('button', { name: 'Remove watch' })).toBeVisible();
  await expect(row.locator('.repo-details')).toHaveCount(0);
  assert.equal((await (await fetch(runtime.url + '/api/state')).json()).repos.find(repo => repo.id === 'demo-billing').disabled, true);
  await expect(page.locator('#repo-toggle')).toHaveAccessibleName('1 repository shown');
  await page.locator('#repo-toggle').click();
  await expect(page.locator('#repo-panel [data-scope-repo]')).toHaveCount(2);
  await expect(page.locator('#repo-panel [data-scope-repo="demo-billing"]')).toHaveCount(0);
  await page.locator('#repo-toggle').click();
  await page.getByRole('link', { name: 'Activity', exact: true }).click();
  await page.getByRole('link', { name: 'All activity' }).click();
  await expect(page.locator('#page .subref').first()).toBeVisible();
  await expect(billingRows).toHaveCount(0);
  await page.getByRole('link', { name: 'Repositories', exact: true }).click();
  await page.getByRole('switch', { name: 'Watch billing-web' }).click();
  await expect(page.getByRole('switch', { name: 'Watch billing-web' })).toBeChecked();
  await expect(page.getByText('3 watched', { exact: true })).toBeVisible();
  await page.getByRole('link', { name: 'Activity', exact: true }).click();
  await page.getByRole('link', { name: 'All activity' }).click();
  await expect(billingRows.first()).toBeVisible();
  await expect(page.locator('#repo-toggle')).toHaveAccessibleName('2 repositories shown');
  await page.locator('#repo-toggle').click();
  await expect(page.locator('#repo-panel [data-scope-repo="demo-billing"]')).toBeChecked();
});

test('empty live startup detects existing CLI locally and prompts only local repo selection', async t => {
  const { page, runtime } = await setup(t, false);
  await expect(page.getByRole('heading', { name: 'Repositories', exact: true })).toBeVisible();
  await expect(page.getByText('No repositories watched yet.')).toBeVisible();
  await expect(page.locator('#connection-status').getByRole('button', { name: 'Check again' })).toBeVisible();
  await expect(page.locator('input[type="url"]')).toHaveCount(0);
  const state = await (await fetch(runtime.url + '/api/state')).json();
  assert.equal(state.demo, false);
  assert.ok(state.diagnostics.totalStarts > 0 && state.diagnostics.totalStarts <= 3, 'only cached local CLI/extension/account checks');
});

test('focused search keeps its value and selection while incoming matching activity renders', async t => {
  const { page, runtime } = await setup(t);
  const search = page.getByRole('searchbox', { name: 'Search activity' });
  await search.fill('hotfix/');
  await search.evaluate(input => input.setSelectionRange(2, 5));
  await expect(search).toBeFocused();
  const state = await (await fetch(runtime.url + '/api/state')).json();
  const incoming = await (await fetch(runtime.url + '/api/demo/event', { method: 'POST', headers: { 'content-type': 'application/json', 'x-repo-pulse-token': state.csrfToken }, body: '{}' })).json();
  await expect(page.locator(`[data-event-id="${incoming.id}"]`)).toBeVisible({ timeout: 12000 });
  await expect(search).toBeFocused();
  await expect(search).toHaveValue('hotfix/');
  assert.deepEqual(await search.evaluate(input => [input.selectionStart, input.selectionEnd]), [2, 5]);
});

async function setupPicker(t, { existing = true } = {}) {
  const store = createStore();
  const organization = 'https://dev.azure.com/example', project = 'Demo';
  if (existing) store.saveRepo({ id: 'existing', azureId: 'existing', name: 'existing', localPath: '/workspace/projects/existing', organization, project });
  const remote = (name, repoName) => ({ name, repoName, organization, project, url: `${organization}/${project}/_git/${repoName}` });
  const repositories = [
    { localPath: '/workspace/projects/alpha', remotes: [remote('origin', 'alpha-api'), remote('upstream', 'alpha-upstream')] },
    { localPath: '/workspace/projects/beta', remotes: [remote('origin', 'beta-web')] },
    { localPath: '/workspace/projects/existing', remotes: [remote('origin', 'existing')] },
  ];
  const calls = { browse: 0, resolve: 0 };
  const browse = async path => {
    calls.browse++;
    path ||= '/workspace/projects';
    if (path === '/missing') throw Object.assign(new Error('This folder cannot be opened. Choose another local folder.'), { status: 400 });
    return { path, parent: path === '/workspace' ? '/' : '/workspace', breadcrumbs: [{ name: '/', path: '/' }, { name: 'workspace', path: '/workspace' }, ...(path === '/workspace' ? [] : [{ name: path.split('/').at(-1), path }])],
      folders: [{ name: 'nested', path: '/workspace/projects/nested' }], repositories: path === '/workspace/projects' ? repositories : [], warnings: [] };
  };
  const provider = {
    async checkConnection() { return { available: true, signedIn: true, account: { name: 'existing@example.test' }, message: 'Existing Azure CLI sign-in detected.' }; },
    async resolveRepository(input) { calls.resolve++; return { id: input.name, azureId: input.name, name: input.name, organization, project }; },
  };
  const sync = createSync({ store, provider });
  const server = createApp({ store, provider, sync, browse, discover: async () => ({ repositories, warnings: [] }) });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ executablePath: await browserPath(), headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  t.after(async () => {
    if (!t.passed) {
      const picker = page.locator('#repository-picker');
      if (await picker.count()) t.diagnostic(await picker.innerText());
      t.diagnostic(JSON.stringify(calls));
    }
    await browser.close(); await new Promise(resolve => server.close(resolve)); store.close(); assert.deepEqual(errors, []);
  });
  await page.goto(`http://127.0.0.1:${server.address().port}/${existing ? '#repositories' : ''}`);
  if (existing) await page.locator('#add-repositories').click();
  return { page, store, calls };
}

test('first repository onboarding can reach Activity without a reload', async t => {
  const { page } = await setupPicker(t, { existing: false });
  await expect(page).toHaveURL(/#repositories$/);
  const search = page.getByRole('combobox', { name: 'Search local repositories' });
  await search.fill('beta');
  await page.getByRole('option').filter({ hasText: 'beta-web' }).click();
  await page.getByRole('button', { name: 'Watch 1 selected', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'beta-web', exact: true })).toBeVisible();
  await page.getByRole('link', { name: 'Activity', exact: true }).click();
  await expect(page.getByRole('searchbox', { name: 'Search activity' })).toBeVisible();
  await expect(page).toHaveURL(/#activity\/new$/);
});

test('searchable picker selects multiple checkouts, disambiguates remotes and only adds on commit', async t => {
  const { page, store, calls } = await setupPicker(t);
  const search = page.getByRole('combobox', { name: 'Search local repositories' });
  await expect(page.getByText('Using existing Azure CLI', { exact: false })).toBeVisible();
  await expect(page.getByText('existing@example.test', { exact: true })).toBeVisible();
  await expect(page.locator('input[type="url"]')).toHaveCount(0);
  await search.focus();
  await expect(page.getByRole('option')).toHaveCount(4);
  await expect(page.getByRole('option').filter({ hasText: 'existing' })).toHaveAttribute('aria-disabled', 'true');
  assert.equal(calls.resolve, 0);
  await search.fill('alpha');
  await expect(page.getByRole('option')).toHaveCount(2);
  await expect(page.getByRole('option').filter({ hasText: 'alpha-api' })).toContainText('origin');
  await page.getByRole('option').filter({ hasText: 'alpha-api' }).click();
  await search.fill('beta');
  await search.press('Enter');
  await expect(page.getByRole('button', { name: 'Watch 2 selected', exact: true })).toBeEnabled();
  assert.equal(calls.browse, 1, 'typing filters cached results without rescanning');
  assert.equal(calls.resolve, 0, 'selection alone must not make an Azure read');
  await page.getByRole('button', { name: 'Watch 2 selected', exact: true }).click();
  await expect(page.getByText('2 repositories watched. All their remote branches are watched.')).toBeVisible();
  assert.equal(calls.resolve, 2);
  assert.deepEqual(store.listRepos().map(repo => repo.name), ['existing', 'alpha-api', 'beta-web']);
  for (const repoId of ['alpha-api', 'beta-web']) {
    assert.deepEqual(store.getStreams().filter(stream => stream.repoId === repoId).map(stream => stream.stream).sort(), ['activeBuilds', 'builds', 'closedPrs', 'prs', 'pushes', 'refs']);
  }
  for (const theme of ['Light', 'Dark']) {
    await page.getByRole('button', { name: theme, exact: true }).click();
    await search.fill('');
    await page.screenshot({ path: `test-results/picker-${theme.toLowerCase()}.png`, fullPage: true });
    await page.setViewportSize({ width: 360, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: `test-results/picker-phone-${theme.toLowerCase()}.png`, fullPage: true });
    await page.setViewportSize({ width: 1280, height: 900 });
  }
});

test('folder picker supports keyboard close, browsing, parent navigation and safe failures', async t => {
  const { page, calls } = await setupPicker(t);
  let search = page.getByRole('combobox', { name: 'Search local repositories' });
  await search.focus();
  await expect(page.getByRole('option')).toHaveCount(4);
  await search.press('Escape');
  await expect(search).toHaveAttribute('aria-expanded', 'false');
  await page.getByRole('button', { name: 'Change folder', exact: true }).click();
  search = page.getByRole('combobox', { name: 'Find a folder' });
  await page.getByRole('option').filter({ hasText: 'nested' }).click();
  await expect(page.locator('.picker-crumbs [aria-current]')).toHaveText('nested');
  await search.fill('/missing');
  await search.press('Enter');
  await expect(page.getByRole('alert')).toContainText('cannot be opened');
  await search.fill('');
  await search.press('Backspace');
  await expect(page.locator('.picker-crumbs [aria-current]')).toHaveText('workspace');
  await page.getByRole('button', { name: 'Use this folder', exact: true }).click();
  await expect(page.getByRole('combobox', { name: 'Search local repositories' })).toBeFocused();
  await expect(page.getByRole('listbox')).toContainText('No Azure Git checkouts here');
  assert.equal(calls.resolve, 0);
});

test('picker keeps a search typed during initial loading and retains failed selections on partial add', async t => {
  const { page, store } = await setupPicker(t);
  let release;
  const reading = new Promise(resolve => { release = resolve; });
  await page.route('**/api/folders', async route => { await reading; await route.continue(); });
  const search = page.getByRole('combobox', { name: 'Search local repositories' });
  await search.focus();
  await search.fill('beta');
  release();
  await expect(page.getByRole('option')).toHaveCount(1);
  await expect(search).toHaveValue('beta');
  await search.press('Enter');
  await search.fill('alpha-api');
  await search.press('Enter');
  await page.route('**/api/repos', async route => {
    if (route.request().postDataJSON().path.endsWith('/beta')) await route.fulfill({ status: 502, contentType: 'application/json', body: JSON.stringify({ message: 'CLI read refused for this repository.' }) });
    else await route.continue();
  });
  await page.getByRole('button', { name: 'Watch 2 selected', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('beta-web');
  await expect(page.getByRole('alert')).toContainText('CLI read refused');
  await expect(page.getByRole('button', { name: 'Watch 1 selected', exact: true })).toBeEnabled();
  assert.deepEqual(store.listRepos().map(repo => repo.name), ['existing', 'alpha-api']);
});

async function groupedFixture(t) {
  const app = await setup(t);
  for (const repo of app.runtime.store.listRepos()) app.runtime.store.removeRepo(repo.id);
  app.runtime.store.saveRepo({ id: 'demo-orders', name: 'Orders', project: 'Demo', organization: 'https://dev.azure.com/example', azureId: 'orders' });
  const now = Date.now();
  const record = { repoId: 'demo-orders', kind: 'build', title: 'Orders CI · 20261117.6', branch: 'main', actor: 'Demo developer', seen: false, imported: false,
    data: { buildId: 700, sourceVersion: 'abcdef0123456789', definition: { name: 'Orders CI' }, reason: 'manual' } };
  const event = (id, status, offset) => ({ ...record, id, time: new Date(now + offset).toISOString(), observedAt: new Date(now + offset).toISOString(), data: { ...record.data, status } });
  app.runtime.store.insertEvents([event('build-queued', 'notStarted', -120000), event('build-running', 'inProgress', -60000)]);
  for (const stream of ['pushes', 'refs', 'prs', 'closedPrs', 'builds', 'activeBuilds']) app.runtime.store.saveStream({ repoId: 'demo-orders', stream, initialized: true, lastSuccess: new Date(now).toISOString() });
  // Exercise the normal healthy layout, using only the isolated fixture backend.
  await app.page.route('**/api/state', async route => { const response = await route.fetch(); await route.fulfill({ json: { ...await response.json(), demo: false } }); });
  await app.page.reload();
  await expect(app.page.locator('li[data-event-id]')).toHaveCount(1);
  return { ...app, event };
}

test('build transitions group into one item and exact acknowledgement leaves a later result new', async t => {
  const { page, runtime, event } = await groupedFixture(t);
  await expect(page.getByRole('region', { name: 'Activity summary' })).toContainText('1 new item shown · 2 updates');
  await expect(page.locator('[data-summary-kind="CI runs"]')).toContainText('1 running');
  await expect(page.locator('.cell .val.zero')).toHaveCount(3);
  await expect(page.locator('li.row .kind')).toHaveText('Running');
  await expect(page.locator('li.row .feed-title .title')).toHaveText('Orders CI · 20261117.6');
  await page.locator('.trail > summary').click();
  await expect(page.locator('.trail li')).toHaveCount(2);
  await page.route('**/api/ack', async route => {
    const result = event('build-succeeded', 'completed', 0);
    runtime.store.insertEvents([{ ...result, data: { ...result.data, result: 'succeeded' } }]);
    await route.continue();
  }, { times: 1 });
  await page.getByRole('button', { name: 'Mark shown seen (2)', exact: true }).click();
  await expect(page.locator('li.row .kind')).toHaveText('Succeeded');
  assert.equal(runtime.store.listEvents().find(item => item.id === 'build-queued').seen, true);
  assert.equal(runtime.store.listEvents().find(item => item.id === 'build-running').seen, true);
  assert.equal(runtime.store.listEvents().find(item => item.id === 'build-succeeded').seen, false);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Activity summary' })).toContainText('3 updates');
  assert.equal(runtime.store.listEvents({ unseen: true }).length, 3);
});

test('filtered group marks only shown matching updates while the hidden transition stays unseen', async t => {
  const { page, runtime } = await groupedFixture(t);
  await page.getByRole('searchbox', { name: 'Search activity' }).fill('Running');
  await page.getByRole('button', { name: 'Mark shown seen (1)', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Mark shown seen (0)', exact: true })).toBeDisabled();
  assert.equal(runtime.store.listEvents().find(item => item.id === 'build-running').seen, true);
  assert.equal(runtime.store.listEvents().find(item => item.id === 'build-queued').seen, false);
});

test('healthy phone catch-up shows first activity and theme icons before the fold', async t => {
  const { page } = await groupedFixture(t);
  for (const theme of ['Light', 'Dark']) {
    await page.getByRole('button', { name: theme, exact: true }).click();
    await page.setViewportSize({ width: 375, height: 812 });
    await expect(page.locator('details[data-filter-panel]')).not.toHaveAttribute('open', '');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    const top = await page.locator('li.row').first().evaluate(element => element.getBoundingClientRect().top);
    assert.ok(top < 600, `first activity starts at ${top}px`);
    for (const name of ['System', 'Light', 'Dark']) {
      const box = await page.getByRole('button', { name, exact: true }).boundingBox();
      assert.ok(box && box.x >= 0 && box.x + box.width <= 375 && box.y + box.height < 120);
    }
    await page.screenshot({ path: `test-results/improved-phone-${theme.toLowerCase()}.png`, fullPage: true });
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.screenshot({ path: `test-results/improved-desktop-${theme.toLowerCase()}.png`, fullPage: true });
  }
});

test('detail reload and back restore Activity filters, open trail and source row focus', async t => {
  const { page } = await groupedFixture(t);
  await page.getByRole('link', { name: 'Activity', exact: true }).click();
  await page.getByRole('link', { name: 'All activity', exact: true }).click();
  await page.getByRole('searchbox', { name: 'Search activity' }).fill('Orders');
  await selectActivityType(page, 'CI run');
  await page.locator('.trail > summary').click();
  await page.locator('li.row .feed-title').click();
  await expect(page.getByRole('link', { name: '← Back to All activity', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Update history' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Orders CI · 20261117.6', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Copy full commit ID' })).toBeVisible();
  await page.reload();
  await page.getByRole('link', { name: '← Back to All activity', exact: true }).click();
  await expect(page.getByRole('searchbox', { name: 'Search activity' })).toHaveValue('Orders');
  await expect(page.getByRole('button', { name: 'Activity type: CI run', exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'All activity', exact: true })).toHaveAttribute('aria-current', 'page');
  await expect(page.locator('.trail')).toHaveAttribute('open', '');
  await expect(page.locator('li.row .feed-title')).toBeFocused();
});

test('picker outside click closes without losing selection and health details are readable', async t => {
  const { page } = await setupPicker(t);
  const search = page.getByRole('combobox', { name: 'Search local repositories' });
  await search.fill('alpha-api');
  await page.getByRole('option').click();
  await page.getByRole('heading', { name: 'existing', exact: true }).click();
  await expect(search).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByRole('button', { name: 'Watch 1 selected', exact: true })).toBeEnabled();
  await search.click();
  await expect(page.getByRole('option')).toHaveAttribute('aria-selected', 'true');
  const crumbs = await page.locator('.picker-crumbs').innerText();
  assert.equal(crumbs.startsWith('/ /'), false);
});

test('activity hover uses color instead of underlining and retains keyboard focus in both themes', async t => {
  const { page } = await groupedFixture(t);
  const title = page.locator('li.row .feed-title');
  for (const theme of ['Light', 'Dark']) {
    await page.getByRole('button', { name: theme, exact: true }).click();
    await page.mouse.move(0, 0);
    const initial = await title.evaluate(element => getComputedStyle(element).color);
    await title.hover();
    const hovered = await title.evaluate(element => ({ color: getComputedStyle(element).color, decoration: getComputedStyle(element).textDecorationLine }));
    assert.equal(hovered.decoration, 'none');
    assert.notEqual(hovered.color, initial);
    await title.focus(); await page.keyboard.press('Tab'); await page.keyboard.press('Shift+Tab');
    await expect(title).toBeFocused();
    assert.deepEqual(await title.evaluate(element => ({ style: getComputedStyle(element).outlineStyle, width: getComputedStyle(element).outlineWidth })), { style: 'solid', width: '2px' });
    await page.screenshot({ path: `test-results/hover-${theme.toLowerCase()}.png`, fullPage: true });
  }
});

test('confirmed branch deletion wording replaces legacy missing titles in rows, filters and detail', async t => {
  const { page, runtime } = await groupedFixture(t);
  runtime.store.insertEvents([{ id: 'branch-deleted', repoId: 'demo-orders', kind: 'branch-deleted', title: 'Branch missing', branch: 'hotfix/finished', actor: 'Demo developer', time: new Date().toISOString(), observedAt: new Date().toISOString(), data: { evidence: 'push', pushId: 801 } }]);
  await page.reload();
  await selectActivityType(page, 'Branch deleted');
  await expect(page.locator('li.row .kind')).toHaveText('Branch deleted');
  await expect(page.locator('li.row .feed-title .title')).toHaveText('Branch deleted · hotfix/finished');
  await expect(page.getByRole('button', { name: 'Activity type: Branch deleted', exact: true })).toBeVisible();
  await page.locator('li.row .feed-title').click();
  await expect(page.getByRole('heading', { name: 'Branch deleted · hotfix/finished' })).toBeVisible();
  assert.equal(await page.getByText('Branch missing', { exact: false }).count(), 0);
});

test('one Activity group offers clearly distinct New updates and All activity without changing seen state', async t => {
  const { page, runtime } = await groupedFixture(t);
  const now = new Date().toISOString();
  runtime.store.insertEvents([
    { id: 'seen-push', repoId: 'demo-orders', kind: 'push', title: 'Orders previously seen', branch: 'main', time: now, observedAt: now, seen: true },
    { id: 'imported-push', repoId: 'demo-orders', kind: 'push', title: 'Orders imported history', branch: 'main', time: now, observedAt: now, imported: true },
  ]);
  await page.reload();
  const main = page.getByRole('navigation', { name: 'Main', exact: true });
  await expect(main.getByRole('link', { name: 'Activity', exact: true })).toHaveCount(1);
  await expect(page.getByRole('link', { name: 'Catch-up', exact: true })).toHaveCount(0);
  await expect(page.getByRole('checkbox', { name: 'Unseen only', exact: true })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'New updates', exact: true })).toHaveAttribute('aria-current', 'page');
  await expect(page.locator('li.row')).toHaveCount(1);
  const remoteReads = [];
  page.on('request', request => { if (/\/api\/(refresh|connection|repos)(\?|$)/.test(request.url())) remoteReads.push(request.url()); });
  await page.getByRole('searchbox', { name: 'Search activity' }).fill('Orders');
  await page.getByRole('link', { name: 'All activity', exact: true }).click();
  await expect(page).toHaveURL(/#activity\/all$/);
  await expect(page.getByRole('searchbox', { name: 'Search activity' })).toHaveValue('Orders');
  await expect(page.locator('li.row')).toHaveCount(3);
  await expect(page.locator('[data-event-id="seen-push"]')).toBeVisible();
  const importedHistory = page.locator('details[data-group="Imported history"]');
  if (await importedHistory.getAttribute('open') === null) await importedHistory.locator('summary').click();
  await expect(page.locator('[data-event-id="imported-push"]')).toBeVisible();
  await expect(page.getByRole('region', { name: 'Activity summary' })).toContainText('1 new item');
  await expect(page.getByRole('region', { name: 'Activity summary' })).toContainText('Showing 3 of 3 items');
  await page.getByRole('link', { name: 'New updates', exact: true }).click();
  await expect(page).toHaveURL(/#activity\/new$/);
  await expect(page.locator('li.row')).toHaveCount(1);
  assert.equal(runtime.store.listEvents({ unseen: true }).length, 2);
  assert.deepEqual(remoteReads, []);
  await page.getByRole('link', { name: 'Repositories', exact: true }).click();
  await main.getByRole('link', { name: 'Activity', exact: true }).click();
  await expect(page.getByRole('link', { name: 'New updates', exact: true })).toHaveAttribute('aria-current', 'page');
});

test('legacy activity links normalize and detail returns to the correct New updates view', async t => {
  const { page } = await groupedFixture(t);
  const base = page.url().split('#')[0];
  await page.goto(base + '#activity');
  await expect(page).toHaveURL(/#activity\/all$/);
  await expect(page.getByRole('link', { name: 'All activity', exact: true })).toHaveAttribute('aria-current', 'page');
  await page.goto(base + '#catchup');
  await expect(page).toHaveURL(/#activity\/new$/);
  await page.locator('li.row .feed-title').click();
  await expect(page.getByRole('link', { name: '← Back to New updates', exact: true })).toBeVisible();
  await page.reload();
  await page.getByRole('link', { name: '← Back to New updates', exact: true }).click();
  await expect(page).toHaveURL(/#activity\/new$/);
  await expect(page.getByRole('link', { name: 'New updates', exact: true })).toHaveAttribute('aria-current', 'page');
});

test('semantic status colors match rows, imported history, details and trails in both themes', async t => {
  const { page, runtime, event } = await groupedFixture(t);
  const cases = [
    ['deleted', 'branch-deleted', { evidence: 'push' }, 'crit', 'Branch deleted'],
    ['failed', 'build', { status: 'completed', result: 'failed' }, 'crit', 'Failed'],
    ['canceled', 'build', { status: 'completed', result: 'canceled' }, 'warn', 'Canceled'],
    ['abandoned', 'pr', { status: 'abandoned' }, 'warn', 'PR abandoned'],
    ['partial', 'build', { status: 'completed', result: 'partiallySucceeded' }, 'warn', 'Partially succeeded'],
    ['completed', 'pr', { status: 'completed' }, 'ok', 'Merged'],
    ['succeeded', 'build', { status: 'completed', result: 'succeeded' }, 'ok', 'Succeeded'],
    ['open', 'pr', { status: 'active' }, 'info', 'Open PR'],
    ['queued', 'build', { status: 'notStarted' }, 'info', 'Queued'],
    ['created', 'branch-created', {}, 'info', 'New branch'],
    ['push', 'push', {}, 'info', 'Push'],
    ['draft', 'pr', { status: 'active', isDraft: true }, 'neutral', 'Draft PR'],
    ['skipped', 'build', { status: 'completed', result: 'skipped' }, 'neutral', 'Skipped'],
    ['uncertain', 'branch-deleted', { evidence: 'snapshot' }, 'warn', 'No longer listed'],
  ];
  runtime.store.insertEvents(cases.map(([id, kind, data], index) => ({ id: `color-${id}`, repoId: 'demo-orders', kind, branch: 'feature/example', title: id,
    time: new Date(Date.now() - 600000 - index * 1000).toISOString(), observedAt: new Date(Date.now() - 600000).toISOString(), imported: true, seen: true, data: { ...data, ...(kind === 'build' ? { buildId: 800 + index } : {}) } })));
  runtime.store.insertEvents([{ ...event('canceled-transition', 'completed', 0), data: { ...event('', '', 0).data, status: 'completed', result: 'canceled' } }]);
  await page.goto(page.url().split('#')[0] + '#activity/all');
  for (const theme of ['Light', 'Dark']) {
    await page.getByRole('button', { name: theme, exact: true }).click();
    const history = page.locator('details[data-group="Imported history"]');
    if (!await history.evaluate(element => element.open)) await history.locator('summary').first().click();
    for (const [id, , , tone, label] of cases) {
      const row = page.locator(`li[data-event-id="color-${id}"]`);
      await expect(row.locator('.kind')).toHaveText(label);
      await expect(row.locator('.kind')).toHaveClass(new RegExp(`\\b${tone}\\b`));
      await expect(row).toHaveClass(new RegExp(`\\btone-${tone}\\b`));
    }
    await expect(page.locator('[data-event-id="color-deleted"]')).not.toHaveClass(/(?:^|\s)crit(?:\s|$)/);
    await expect(page.locator('[data-event-id="color-failed"]')).toHaveClass(/(?:^|\s)crit(?:\s|$)/);
    const contrast = await page.evaluate(() => {
      const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
      const context = canvas.getContext('2d');
      const rgba = color => { context.clearRect(0, 0, 1, 1); context.fillStyle = color; context.fillRect(0, 0, 1, 1); return [...context.getImageData(0, 0, 1, 1).data]; };
      const luminance = color => color.slice(0, 3).map(value => { const c = value / 255; return c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4; }).reduce((sum, value, index) => sum + value * [.2126, .7152, .0722][index], 0);
      const tokens = getComputedStyle(document.documentElement);
      const names = { crit: '--critical', warn: '--warning', ok: '--ok', info: '--info', neutral: '--muted-foreground' };
      const washes = { crit: '--critical-wash', warn: '--warning-wash', ok: '--ok-wash', info: '--primary-wash' };
      return [...document.querySelectorAll('li[data-event-id^="color-"]')].map(row => {
        const kind = row.querySelector('.kind');
        const tone = Object.keys(names).find(name => kind.classList.contains(name));
        const foreground = rgba(getComputedStyle(kind).color);
        let background = rgba(getComputedStyle(row.closest('.card')).backgroundColor);
        if (washes[tone]) {
          const wash = rgba(tokens.getPropertyValue(washes[tone]));
          background = background.map((value, index) => index === 3 ? 255 : wash[index] * wash[3] / 255 + value * (1 - wash[3] / 255));
        }
        const first = luminance(foreground), second = luminance(background);
        return { id: row.dataset.eventId, tone, hasWash: getComputedStyle(row).backgroundImage !== 'none', ratio: (Math.max(first, second) + .05) / (Math.min(first, second) + .05), matchesToken: JSON.stringify(foreground) === JSON.stringify(rgba(tokens.getPropertyValue(names[tone]))) };
      });
    });
    for (const result of contrast) { assert.equal(result.matchesToken, true, `${theme} ${result.id} token`); assert.equal(result.hasWash, result.tone !== 'neutral'); assert.ok(result.ratio >= 4.5, `${theme} ${result.id} contrast ${result.ratio}`); }
    const trail = page.locator('[data-event-id="canceled-transition"] .trail');
    if (!await trail.evaluate(element => element.open)) await trail.locator('summary').click();
    await expect(trail.locator('.status-text.warn')).toHaveText('Canceled');
    await expect(trail.locator('.status-text.info')).toHaveCount(2);
    await page.screenshot({ path: `test-results/status-colors-${theme.toLowerCase()}.png`, fullPage: true });
  }
  await page.locator('[data-event-id="color-completed"] .feed-title').click();
  await expect(page.locator('.status-chip')).toHaveClass(/\bok\b/);
  await expect(page.locator('.status-chip')).toHaveText('Merged');
});

test('the app-owned type dropdown is themed, keyboard accessible and stable during local polling', async t => {
  const { page, runtime } = await groupedFixture(t);
  runtime.store.insertEvents([{ id: 'type-branch', repoId: 'demo-orders', kind: 'branch-created', title: 'New feature branch', branch: 'feature/type', time: new Date().toISOString(), observedAt: new Date().toISOString() }]);
  await page.reload();
  await expect(page.locator('select#kind-filter')).toHaveCount(0);
  for (const theme of ['Light', 'Dark']) {
    await page.getByRole('button', { name: theme, exact: true }).click();
    const toggle = page.getByRole('button', { name: /^Activity type:/ });
    await toggle.click();
    const panel = page.getByRole('listbox', { name: 'Activity type', exact: true });
    await expect(panel).toBeVisible();
    await expect(panel.getByRole('option', { name: theme === 'Light' ? 'Running' : 'Succeeded', exact: true })).toBeVisible();
    await expect(panel.getByRole('option', { name: 'Pull request', exact: true })).toHaveCount(0);
    assert.deepEqual(await page.evaluate(() => ({ panel: getComputedStyle(document.querySelector('#kind-panel')).backgroundColor, card: getComputedStyle(document.querySelector('.summary')).backgroundColor, option: getComputedStyle(document.querySelector('.type-option')).color, body: getComputedStyle(document.body).color })),
      await page.evaluate(() => ({ panel: getComputedStyle(document.querySelector('.summary')).backgroundColor, card: getComputedStyle(document.querySelector('.summary')).backgroundColor, option: getComputedStyle(document.body).color, body: getComputedStyle(document.body).color })));
    if (theme === 'Light') {
      const polling = page.waitForResponse(response => new URL(response.url()).pathname === '/api/state', { timeout: 8000 });
      runtime.store.insertEvents([{ id: 'type-incoming', repoId: 'demo-orders', kind: 'push', title: 'Incoming push', branch: 'feature/type', time: new Date().toISOString(), observedAt: new Date().toISOString() }]);
      await polling;
      await expect(panel).toBeVisible();
    }
    await page.screenshot({ path: `test-results/type-filter-${theme.toLowerCase()}.png` });
    await page.keyboard.press('End');
    await expect(panel.getByRole('option').last()).toBeFocused();
    await panel.getByRole('option', { name: 'CI run', exact: true }).focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('button', { name: 'Activity type: CI run', exact: true })).toBeFocused();
    await expect(panel).not.toBeVisible();
    await expect(page.locator('li.row')).toHaveCount(1);
    if (theme === 'Light') {
      runtime.store.insertEvents([{ id: 'type-build-result', repoId: 'demo-orders', kind: 'build', title: 'Orders CI', branch: 'main', time: new Date().toISOString(), observedAt: new Date().toISOString(), data: { buildId: 700, status: 'completed', result: 'succeeded' } }]);
      await expect(page.locator('li.row .kind')).toHaveText('Succeeded', { timeout: 8000 });
      await expect(toggle).toBeFocused();
    }
    await toggle.press('ArrowDown');
    await expect(panel.getByRole('option', { name: 'CI run', exact: true })).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('Shift+Tab');
    await expect(toggle).toBeFocused();
    await expect(panel).not.toBeVisible();
    await toggle.press('ArrowDown');
    await page.keyboard.press('Escape');
    await expect(toggle).toBeFocused();
    await selectActivityType(page, 'All types');
    await expect(page.locator('li.row')).toHaveCount(3);
  }
  await page.setViewportSize({ width: 375, height: 812 });
  await page.locator('details[data-filter-panel] > summary').click();
  await page.getByRole('button', { name: /^Activity type:/ }).click();
  const box = await page.locator('#kind-panel').boundingBox();
  assert.ok(box.x >= 0 && box.x + box.width <= 375);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.locator('.summary').click();
  await expect(page.locator('#kind-panel')).not.toBeVisible();
});

test('completed PRs clearly show a merge into the target and optional source/result revisions', async t => {
  const { page, runtime } = await groupedFixture(t);
  runtime.store.insertEvents([{ id: 'merged-pr', repoId: 'demo-orders', kind: 'pr', title: 'PR 45 · Fix export', branch: 'feature/export', actor: 'PR creator', time: new Date().toISOString(), observedAt: new Date().toISOString(), data: { pullRequestId: 45, status: 'completed', sourceRefName: 'refs/heads/feature/export', targetRefName: 'refs/heads/main', sourceCommit: 'a'.repeat(40), mergeCommit: 'b'.repeat(40), mergeStrategy: 'squash' } }]);
  await page.reload();
  await selectActivityType(page, 'Pull request');
  await expect(page.locator('li.row .kind')).toHaveText('Merged');
  await expect(page.locator('li.row')).toContainText('Merged into main');
  await expect(page.locator('li.row')).toHaveClass(/tone-ok/);
  await page.locator('li.row .feed-title').click();
  await expect(page.locator('.status-chip')).toHaveText('Merged');
  for (const label of ['Source branch', 'Target branch', 'Source commit', 'Merge commit', 'Created by']) await expect(page.getByText(label, { exact: true })).toBeVisible();
  await expect(page.getByText('Merged by', { exact: true })).toHaveCount(0);
  await expect(page.getByText('Squash', { exact: true })).toBeVisible();
});
