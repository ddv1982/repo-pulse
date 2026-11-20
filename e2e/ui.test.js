import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, readdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { chromium, expect } from '@playwright/test';
import { startApp, createApp } from '../server.js';
import { TEST_KEY, fetchWithKey, rememberKey, rememberRuntime } from '../test/fixtures/access.js';
import { checkoutFixture, git } from '../test/fixtures/checkout.js';

const fetch = fetchWithKey;
import { createStore } from '../server/store.js';
import { createSync } from '../server/sync.js';
import { createAzureCli } from '../server/azure-cli.js';
import { createAzureClient } from '../server/azure-client.js';

async function browserPath() {
  if (process.env.CHROME) return process.env.CHROME;
  if (existsSync(chromium.executablePath())) return chromium.executablePath();
  const cache = join(homedir(), '.cache', 'ms-playwright');
  for (const name of (await readdir(cache).catch(() => []))
    .filter(name => /^chromium-\d+$/.test(name))
    .sort()
    .reverse()) {
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
  let runtime = rememberRuntime(await startApp({ demo, port: 0, dataDir: directory }));
  const browser = await chromium.launch({ executablePath: await browserPath(), headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, colorScheme: 'light' });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => {
    if (message.type() === 'error') errors.push(message.text());
  });
  t.after(async () => {
    await browser.close();
    await runtime.close();
    await rm(directory, { recursive: true, force: true });
    assert.deepEqual(errors, []);
  });
  await page.goto(runtime.launchUrl);
  await expect(page.getByRole('link', { name: 'Repo Pulse', exact: true })).toBeVisible();
  await mkdir('test-results', { recursive: true });
  return {
    page,
    get runtime() {
      return runtime;
    },
    async restart() {
      await runtime.close();
      runtime = rememberRuntime(await startApp({ demo, port: 0, dataDir: directory }));
      // A new port is a new origin, so the browser needs the launch link again.
      await page.goto(runtime.launchUrl);
    },
  };
}

test('the row Seen toggle keeps keyboard focus and shows state without a status column', async t => {
  const { page, runtime } = await setup(t);
  await page.goto(`${page.url().split('#')[0]}#activity/new`);
  const rows = page.locator('li[data-event-id]');
  const [first, second] = await rows.evaluateAll(elements => elements.slice(0, 2).map(element => element.getAttribute('data-event-id')));
  await expect(page.locator('.counts')).toHaveCount(0);
  const toggle = page.locator(`li[data-event-id="${first}"] .seen-toggle`);
  await expect(toggle).toHaveText('Seen');
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator(`li[data-event-id="${first}"]`)).toHaveClass(/\bnew\b/);
  await toggle.focus();
  await page.keyboard.press('Enter');
  await expect(page.locator(`li[data-event-id="${first}"]`)).toHaveCount(0);
  // The row left New updates, so focus moves to the next row's toggle rather than the page body.
  await expect(page.locator(`li[data-event-id="${second}"] .seen-toggle`)).toBeFocused();

  await page.goto(`${page.url().split('#')[0]}#activity/all`);
  const seen = page.locator(`li[data-event-id="${first}"] .seen-toggle`);
  await expect(seen).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator(`li[data-event-id="${first}"]`)).not.toHaveClass(/\bnew\b/);
  await seen.focus();
  await page.keyboard.press('Enter');
  await expect(seen).toHaveAttribute('aria-pressed', 'false');
  await expect(seen).toBeFocused();

  // A kind without its own tint (a draft PR) still gets the unread wash, and loses it once seen.
  runtime.store.insertEvents([
    {
      id: 'live-draft',
      repoId: 'demo-orders',
      kind: 'pr',
      branch: 'feature/draft',
      title: 'Draft work',
      time: new Date().toISOString(),
      data: { status: 'active', isDraft: true },
    },
  ]);
  await page.reload();
  const draft = page.locator('li[data-event-id="live-draft"]');
  await expect(draft).toHaveClass(/\btone-neutral\b/);
  const wash = () => draft.evaluate(element => getComputedStyle(element).backgroundImage);
  assert.notEqual(await wash(), 'none');
  await draft.locator('.seen-toggle').click();
  await expect(draft.locator('.seen-toggle')).toHaveAttribute('aria-pressed', 'true');
  assert.equal(await wash(), 'none');
});

test('approved light/dark/System UI and responsive routes work without remote traffic', async t => {
  const { page } = await setup(t);
  await expect(page.getByText('Demo mode · fictional repositories and people')).toBeVisible();
  await expect(page.locator('[data-event-id="demo-branch-1"]')).toContainText('hotfix/2026.11-dose-rounding');
  const remoteReads = [];
  page.on('request', request => {
    if (/\/api\/(refresh|connection|repos)(\?|$)/.test(request.url())) remoteReads.push(request.url());
  });
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
  let incoming;
  await page.route(
    '**/api/ack',
    async route => {
      const response = await fetch(app.runtime.url + '/api/demo/event', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      incoming = await response.json();
      await route.continue();
    },
    { times: 1 },
  );
  await page.getByRole('button', { name: 'Mark all matching seen (2)', exact: true }).click();
  await expect(page.getByRole('dialog')).not.toBeVisible();
  await expect(page.locator('.feed-actions button')).toHaveCount(0);
  assert.ok(
    app.runtime.store
      .listEvents()
      .filter(event => event.repoId === 'demo-billing')
      .every(event => event.seen),
  );
  assert.equal(app.runtime.store.getEvent(incoming.id).seen, false);
  assert.equal(app.runtime.store.getEvent('demo-branch-1').seen, false);
  await app.restart();
  assert.ok(
    app.runtime.store
      .listEvents()
      .filter(event => event.repoId === 'demo-billing')
      .every(event => event.seen),
  );
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
  await expect(page.locator('.repo-entry', { has: toggle }).locator('.repo-overview .sync-pill')).toHaveText(/^Synced · /);
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
  await page.locator('#repo-panel [data-scope-repo="demo-shared"]').check();
  await expect(page.locator('#repo-toggle')).toHaveAccessibleName('2 repositories shown');
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
  await expect(page.locator('#repo-toggle')).toHaveAccessibleName('3 repositories shown');
  await page.locator('#repo-toggle').click();
  await expect(page.locator('#repo-panel [data-scope-repo="demo-billing"]')).toBeChecked();
});

test('empty live startup detects existing CLI locally and prompts only local repo selection', async t => {
  const store = createStore();
  const commands = [];
  const cli = createAzureCli({
    executor: async args => {
      commands.push(args.slice(0, 2).join(' '));
      if (args[0] === 'version') return { 'azure-cli': '2.93.0' };
      if (args[0] === 'extension') return { version: '1.0.2' };
      if (args[0] === 'account') return { user: { name: 'tester@example.test' } };
      throw new Error(`Unexpected Azure CLI call: ${args.join(' ')}`);
    },
  });
  const provider = createAzureClient({ cli });
  const sync = createSync({ store, provider });
  const server = createApp({ store, provider, sync, cli, accessKey: TEST_KEY });
  let browser;
  const errors = [];
  t.after(async () => {
    await browser?.close().catch(() => {});
    await sync.stop();
    if (server.listening) await new Promise(resolve => server.close(resolve));
    cli.close();
    store.close();
    assert.deepEqual(errors, []);
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  sync.start();
  browser = await chromium.launch({ executablePath: await browserPath(), headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.on('pageerror', error => errors.push(error.message));
  await rememberKey(page);
  const url = `http://127.0.0.1:${server.address().port}`;
  await page.goto(url);
  await expect(page.getByRole('heading', { name: 'Repositories', exact: true })).toBeVisible();
  await expect(page.getByText('No repositories watched yet.')).toBeVisible();
  await expect(page.locator('#connection-status').getByRole('button', { name: 'Check again' })).toBeVisible();
  await expect(page.locator('#connection-status')).toContainText('Using existing Azure CLI');
  await expect(page.locator('input[type="url"]')).toHaveCount(0);
  await sync.tick();
  const state = await (await fetch(url + '/api/state')).json();
  assert.equal(state.demo, false);
  assert.ok(state.diagnostics.totalStarts > 0 && state.diagnostics.totalStarts <= 3, 'only cached local CLI/extension/account checks');
  assert.deepEqual(
    [...new Set(commands)].sort(),
    ['account show', 'extension show', 'version'],
    'no Azure reads before a repository is watched',
  );
});

test('focused search keeps its value and selection while incoming matching activity renders', async t => {
  const { page, runtime } = await setup(t);
  const search = page.getByRole('searchbox', { name: 'Search activity' });
  await search.fill('hotfix/');
  await search.evaluate(input => input.setSelectionRange(2, 5));
  await expect(search).toBeFocused();
  const incoming = await (
    await fetch(runtime.url + '/api/demo/event', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })
  ).json();
  await expect(page.locator(`[data-event-id="${incoming.id}"]`)).toBeVisible({ timeout: 12000 });
  await expect(search).toBeFocused();
  await expect(search).toHaveValue('hotfix/');
  assert.deepEqual(await search.evaluate(input => [input.selectionStart, input.selectionEnd]), [2, 5]);
});

async function setupPicker(t, { existing = true } = {}) {
  const store = createStore();
  const organization = 'https://dev.azure.com/example',
    project = 'Demo';
  if (existing)
    store.saveRepo({
      id: 'existing',
      azureId: 'existing',
      name: 'existing',
      localPath: '/workspace/projects/existing',
      organization,
      project,
    });
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
    return {
      path,
      parent: path === '/workspace' ? '/' : '/workspace',
      breadcrumbs: [
        { name: '/', path: '/' },
        { name: 'workspace', path: '/workspace' },
        ...(path === '/workspace' ? [] : [{ name: path.split('/').at(-1), path }]),
      ],
      folders: [{ name: 'nested', path: '/workspace/projects/nested' }],
      repositories: path === '/workspace/projects' ? repositories : [],
      warnings: [],
    };
  };
  const provider = {
    async checkConnection() {
      return {
        available: true,
        signedIn: true,
        account: { name: 'existing@example.test' },
        message: 'Existing Azure CLI sign-in detected.',
      };
    },
    async resolveRepository(input) {
      calls.resolve++;
      return { id: input.name, azureId: input.name, name: input.name, organization, project };
    },
  };
  const sync = createSync({ store, provider });
  const server = createApp({ store, provider, sync, browse, discover: async () => ({ repositories, warnings: [] }), accessKey: TEST_KEY });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ executablePath: await browserPath(), headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await rememberKey(page);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  t.after(async () => {
    if (!t.passed) {
      const picker = page.locator('#repository-picker');
      if (await picker.count()) t.diagnostic(await picker.innerText());
      t.diagnostic(JSON.stringify(calls));
    }
    await browser.close();
    await new Promise(resolve => server.close(resolve));
    store.close();
    assert.deepEqual(errors, []);
  });
  await page.goto(`http://127.0.0.1:${server.address().port}/${existing ? '#repositories' : ''}`);
  if (existing) await page.locator('#add-repositories').click();
  return { page, store, calls };
}

test('a New branch detail reviews a rewritten tracking ref before switching, then opens the checkout for pull', async t => {
  const { source, local, repo, checkoutGit, commit, original } = checkoutFixture(t);
  const branch = 'feature/checkout-from-activity';
  git(source, 'switch', '-c', branch);
  const previousTip = commit(source, 'topic.txt', 'previous topic commit');
  git(source, 'push', 'origin', branch);
  git(local, 'fetch', 'origin', branch);
  git(source, 'reset', '--hard', original);
  const firstTip = commit(source, 'topic.txt', 'first topic commit');
  git(source, 'push', '--force-with-lease', 'origin', branch);
  const localFile = join(local, 'feature.txt');
  await writeFile(localFile, 'uncommitted local edit');
  const store = createStore();
  store.saveRepo({ ...repo, id: 'other', name: 'Another watched repository', localPath: undefined });
  store.saveRepo(repo);
  store.insertEvents([
    {
      id: 'new-topic',
      repoId: repo.id,
      kind: 'branch-created',
      title: `New branch · ${branch}`,
      branch,
      actor: 'Test',
      time: new Date().toISOString(),
      data: { name: `refs/heads/${branch}`, objectId: firstTip, evidence: 'snapshot' },
    },
  ]);
  const provider = { checkConnection: async () => ({ available: true }) };
  const sync = { status: () => ({ running: false, repos: {} }) };
  const app = createApp({ store, provider, sync, checkoutGit, accessKey: TEST_KEY });
  await new Promise(resolve => app.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ executablePath: await browserPath(), headless: true });
  t.after(async () => {
    await browser.close();
    await new Promise(resolve => app.close(resolve));
    store.close();
  });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  page.setDefaultTimeout(5000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await rememberKey(page);
  await page.goto(`http://127.0.0.1:${app.address().port}/#activity/all`);
  await page.locator('#activity-filters-toggle').click();
  const search = page.getByRole('searchbox', { name: 'Search activity' });
  await search.fill('checkout-from-activity');
  await page.getByRole('button', { name: new RegExp(`^New branch · .*branch ${branch}$`) }).click();
  await page.getByRole('button', { name: `Switch to ${branch}…` }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText(`Switch to ${branch}?`);
  await expect(dialog).toContainText(local);
  await expect(dialog).toContainText('from main');
  await expect(dialog).toContainText('Git will stop if switching would overwrite local changes.');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.equal(git(local, 'rev-parse', 'HEAD'), original);
  await dialog.getByRole('button', { name: 'Switch branch', exact: true }).click();
  await expect(dialog).toContainText(`changed from ${previousTip.slice(0, 12)} to ${firstTip.slice(0, 12)}`);
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  assert.equal(git(local, 'rev-parse', 'HEAD'), original);
  assert.equal(git(local, 'rev-parse', `origin/${branch}`), previousTip);
  await page.getByRole('button', { name: `Switch to ${branch}…` }).click();
  await dialog.getByRole('button', { name: 'Switch branch', exact: true }).click();
  await dialog.getByRole('button', { name: 'Confirm switch', exact: true }).click();

  await expect(page).toHaveURL(/#repositories\/repo$/);
  const checkout = page.locator('#checkout-state-repo');
  await expect(checkout).toContainText(branch);
  await expect(checkout).toContainText('Local changes');
  await expect(checkout).toBeFocused();
  assert.equal(git(local, 'rev-parse', 'HEAD'), firstTip);
  assert.equal(git(local, 'config', `branch.${branch}.remote`), 'origin');
  assert.equal(git(local, 'config', `branch.${branch}.merge`), `refs/heads/${branch}`);
  assert.equal(git(local, 'rev-list', '--left-right', '--count', 'HEAD...@{upstream}'), '0\t0');
  const newerTip = commit(source, 'topic.txt', 'next topic commit');
  git(source, 'push', 'origin', branch);
  await checkout.getByRole('button', { name: 'Check for updates' }).click();
  await expect(checkout).toContainText('1 commit behind');
  assert.equal(git(local, 'rev-parse', 'HEAD'), firstTip);
  await checkout.getByRole('button', { name: 'Pull', exact: true }).click();
  await dialog.getByRole('button', { name: 'Pull', exact: true }).click();
  await expect(checkout).toContainText('Up to date');
  assert.equal(git(local, 'rev-parse', 'HEAD'), newerTip);
  assert.equal(await readFile(localFile, 'utf8'), 'uncommitted local edit');

  await page.goBack();
  await expect(page.getByRole('link', { name: 'View in Repositories' })).toBeVisible();
  git(local, 'switch', 'main');
  await expect(page.getByRole('button', { name: `Switch to ${branch}…` })).toBeVisible({ timeout: 12000 });
  await page.getByRole('link', { name: /Back to All activity/ }).click();
  await expect(page.locator('#feed-search')).toHaveValue('checkout-from-activity');
  assert.deepEqual(errors, []);
});

test('Repositories switches between watched branches, and a merged pull request switches back to main', async t => {
  const { source, local, repo, checkoutGit, commit, original } = checkoutFixture(t);
  git(source, 'switch', '-c', 'topic');
  commit(source, 'topic.txt', 'topic work');
  git(source, 'push', 'origin', 'topic');
  const store = createStore();
  store.saveRepo(repo);
  const ref = (name, lastPushId) => ({
    type: 'ref',
    id: `refs/heads/${name}`,
    data: { name: `refs/heads/${name}`, active: true, lastPushId },
  });
  store.commitPage({ repoId: repo.id, entities: [ref('main', 1), ref('topic', 2), ref('release/old', 0)] });
  store.insertEvents([
    {
      id: 'merged-topic',
      repoId: repo.id,
      kind: 'pr',
      title: 'PR 7 · Topic work',
      branch: 'topic',
      actor: 'Test',
      time: new Date().toISOString(),
      data: { pullRequestId: 7, status: 'completed', sourceRefName: 'refs/heads/topic', targetRefName: 'refs/heads/main' },
    },
  ]);
  const provider = { checkConnection: async () => ({ available: true }) };
  const sync = { status: () => ({ running: false, repos: {} }) };
  const app = createApp({ store, provider, sync, checkoutGit, accessKey: TEST_KEY });
  await new Promise(resolve => app.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ executablePath: await browserPath(), headless: true });
  t.after(async () => {
    await browser.close();
    await new Promise(resolve => app.close(resolve));
    store.close();
  });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  page.setDefaultTimeout(5000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await rememberKey(page);
  await page.goto(`http://127.0.0.1:${app.address().port}/#repositories`);
  const checkout = page.locator('#checkout-state-repo');
  const open = checkout.getByRole('button', { name: 'Switch branch…' });
  const picker = page.locator('#branch-dialog');
  const confirmDialog = page.locator('#confirm-dialog');

  await open.click();
  await expect(picker).toContainText('Orders');
  await expect(picker).toContainText(local);
  const options = picker.locator('.branch-option');
  await expect(options).toHaveText([/^main\s*Checked out$/, /^topic\s*Remote only$/, /^release\/old\s*Remote only$/]);
  await expect(options.first()).toBeDisabled();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.keyboard.press('Escape');
  await expect(picker).toBeHidden();
  await expect(open).toBeFocused();
  // Checkout polling can replace the button that opened the picker; focus still returns to the checkout's button.
  await open.click();
  await open.evaluate(button => button.replaceWith(button.cloneNode(true)));
  await picker.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(picker).toBeHidden();
  await expect(open).toBeFocused();
  // Leaving Repositories closes the picker, so it cannot switch the checkout from another page.
  await open.click();
  await page.evaluate(() => {
    location.hash = '#settings';
  });
  await expect(picker).toBeHidden();
  await page.goBack();
  await expect(open).toBeVisible();

  await open.click();
  await page.getByRole('searchbox', { name: 'Filter branches' }).fill('top');
  await expect(options).toHaveCount(1);
  await page.keyboard.press('Enter');
  await expect(picker).toBeHidden();
  await expect(confirmDialog).toContainText('Switch to topic?');
  await expect(confirmDialog).toContainText('from main');
  await confirmDialog.getByRole('button', { name: 'Switch branch', exact: true }).click();
  await expect(checkout).toContainText('topic');
  await expect(checkout).toBeFocused();
  assert.equal(git(local, 'branch', '--show-current'), 'topic');

  // A local commit and a newer remote commit make the next switch to topic ask for a second review.
  const localTip = commit(local, 'local.txt', 'local topic work');
  git(local, 'switch', 'main');
  commit(source, 'topic.txt', 'remote topic work');
  git(source, 'push', 'origin', 'topic');
  await page.reload();
  await expect(checkout).toContainText('main');
  await open.click();
  await picker.getByRole('button', { name: /^topic/ }).click();
  await confirmDialog.getByRole('button', { name: 'Switch branch', exact: true }).click();
  await expect(confirmDialog).toContainText('Review switch to topic');
  await expect(confirmDialog).toContainText('1 ahead and 1 behind');
  await confirmDialog.getByRole('button', { name: 'Confirm switch', exact: true }).click();
  await expect(checkout).toContainText('topic');
  assert.equal(git(local, 'rev-parse', 'HEAD'), localTip);

  await page.goto(`http://127.0.0.1:${app.address().port}/#event/merged-topic`);
  await page.getByRole('button', { name: 'Switch to main…' }).click();
  await confirmDialog.getByRole('button', { name: 'Switch branch', exact: true }).click();
  await expect(page).toHaveURL(/#repositories\/repo$/);
  await expect(checkout).toContainText('main');
  assert.equal(git(local, 'branch', '--show-current'), 'main');
  assert.equal(git(local, 'rev-parse', 'HEAD'), original);
  assert.deepEqual(errors, []);
});

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
  assert.deepEqual(
    store.listRepos().map(repo => repo.name),
    ['existing', 'alpha-api', 'beta-web'],
  );
  for (const repoId of ['alpha-api', 'beta-web']) {
    assert.deepEqual(
      store
        .getStreams()
        .filter(stream => stream.repoId === repoId)
        .map(stream => stream.stream)
        .sort(),
      ['activeBuilds', 'builds', 'closedPrs', 'prs', 'pushes', 'refs'],
    );
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
  const reading = new Promise(resolve => {
    release = resolve;
  });
  await page.route('**/api/folders', async route => {
    await reading;
    await route.continue();
  });
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
    if (route.request().postDataJSON().path.endsWith('/beta'))
      await route.fulfill({
        status: 502,
        contentType: 'application/json',
        body: JSON.stringify({ message: 'CLI read refused for this repository.' }),
      });
    else await route.continue();
  });
  await page.getByRole('button', { name: 'Watch 2 selected', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('beta-web');
  await expect(page.getByRole('alert')).toContainText('CLI read refused');
  await expect(page.getByRole('button', { name: 'Watch 1 selected', exact: true })).toBeEnabled();
  assert.deepEqual(
    store.listRepos().map(repo => repo.name),
    ['existing', 'alpha-api'],
  );
});

async function groupedFixture(t) {
  const app = await setup(t);
  for (const repo of app.runtime.store.listRepos()) app.runtime.store.removeRepo(repo.id);
  app.runtime.store.saveRepo({
    id: 'demo-orders',
    name: 'Orders',
    project: 'Demo',
    organization: 'https://dev.azure.com/example',
    azureId: 'orders',
  });
  const now = Date.now();
  const record = {
    repoId: 'demo-orders',
    kind: 'build',
    title: 'Orders CI · 20261117.6',
    branch: 'main',
    actor: 'Demo developer',
    seen: false,
    imported: false,
    data: { buildId: 700, sourceVersion: 'abcdef0123456789', definition: { name: 'Orders CI' }, reason: 'manual' },
  };
  const event = (id, status, offset) => ({
    ...record,
    id,
    time: new Date(now + offset).toISOString(),
    observedAt: new Date(now + offset).toISOString(),
    data: { ...record.data, status },
  });
  app.runtime.store.insertEvents([event('build-queued', 'notStarted', -120000), event('build-running', 'inProgress', -60000)]);
  for (const stream of ['pushes', 'refs', 'prs', 'closedPrs', 'builds', 'activeBuilds'])
    app.runtime.store.saveStream({ repoId: 'demo-orders', stream, initialized: true, lastSuccess: new Date(now).toISOString() });
  // Exercise the normal healthy layout, using only the isolated fixture backend.
  await app.page.route('**/api/state', async route => {
    const response = await route.fetch();
    await route.fulfill({ json: { ...(await response.json()), demo: false } });
  });
  await app.page.reload();
  await expect(app.page.locator('li[data-event-id]')).toHaveCount(1);
  return { ...app, event };
}

test('build transitions group into one item and exact acknowledgement leaves a later result new', async t => {
  const { page, runtime, event } = await groupedFixture(t);
  await expect(page.getByRole('region', { name: 'Activity summary' })).toContainText('1 new item · 2 updates');
  await expect(page.locator('[data-summary-kind="CI runs"]')).toContainText('1 running');
  await expect(page.locator('.cell .val.zero')).toHaveCount(3);
  await expect(page.locator('li.row .kind')).toHaveText('Running');
  await expect(page.locator('li.row .feed-title .title')).toHaveText('Orders CI · 20261117.6 2 new');
  await page.locator('.trail > summary').click();
  await expect(page.locator('.trail li')).toHaveCount(2);
  await page.route(
    '**/api/ack',
    async route => {
      const result = event('build-succeeded', 'completed', 0);
      runtime.store.insertEvents([{ ...result, data: { ...result.data, result: 'succeeded' } }]);
      await route.continue();
    },
    { times: 1 },
  );
  await page.getByRole('button', { name: 'Mark all seen (2)', exact: true }).click();
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
  await page.getByRole('button', { name: 'Mark all matching seen (1)', exact: true }).click();
  await expect(page.locator('.feed-actions button')).toHaveCount(0);
  assert.equal(runtime.store.listEvents().find(item => item.id === 'build-running').seen, true);
  assert.equal(runtime.store.listEvents().find(item => item.id === 'build-queued').seen, false);
});

test('mixed control rows use one height per size on desktop and phone', async t => {
  const { page, runtime } = await groupedFixture(t);
  runtime.store.setSetting('savedActivityFilters', [
    { id: 'team', name: 'Orders team', filters: { search: '', people: '', kind: '', repoIds: null, view: 'new' } },
  ]);
  await page.reload();
  const height = (selector, expected) => expect(page.locator(selector)).toHaveCSS('height', `${expected}px`);

  for (const [width, standard, compact] of [
    [1280, 36, 28],
    [390, 44, 36],
  ]) {
    await page.setViewportSize({ width, height: 900 });
    if (width < 640) await expect(page.locator('#activity-filters')).toBeHidden();
    await page.locator('#saved-filter-toggle').click();
    await page.getByRole('option', { name: /Orders team/ }).click();
    if (width < 640) await page.locator('#activity-filters-toggle').click();
    await page.locator('#feed-search').fill(' ');
    for (const theme of ['Light', 'Dark']) {
      await page.getByRole('button', { name: theme, exact: true }).click();
      for (const selector of ['#feed-search', '#kind-toggle', '#clear-filters', '#saved-filter-toggle', '#saved-filter-actions-toggle'])
        await height(selector, standard);
      await height('.rowact [data-action="ack-item"]', compact);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    }
  }

  await page.getByRole('link', { name: 'Settings', exact: true }).click();
  await page.locator('#azure-connection-toggle').click();
  for (const [width, compact] of [
    [390, 36],
    [1280, 28],
  ]) {
    await page.setViewportSize({ width, height: 900 });
    await height('#connection-repo', compact);
    await height('#check-settings-connection', compact);
  }
});

test('healthy phone catch-up shows first activity and theme icons before the fold', async t => {
  const { page } = await groupedFixture(t);
  for (const theme of ['Light', 'Dark']) {
    await page.getByRole('button', { name: theme, exact: true }).click();
    await page.setViewportSize({ width: 375, height: 812 });
    await expect(page.locator('#activity-filters')).toBeHidden();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    const top = await page
      .locator('li.row')
      .first()
      .evaluate(element => element.getBoundingClientRect().top);
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
    const hovered = await title.evaluate(element => ({
      color: getComputedStyle(element).color,
      decoration: getComputedStyle(element).textDecorationLine,
    }));
    assert.equal(hovered.decoration, 'none');
    assert.notEqual(hovered.color, initial);
    await title.focus();
    await page.keyboard.press('Tab');
    await page.keyboard.press('Shift+Tab');
    await expect(title).toBeFocused();
    assert.deepEqual(
      await title.evaluate(element => ({ style: getComputedStyle(element).outlineStyle, width: getComputedStyle(element).outlineWidth })),
      { style: 'solid', width: '2px' },
    );
    await page.screenshot({ path: `test-results/hover-${theme.toLowerCase()}.png`, fullPage: true });
  }
});

test('confirmed branch deletion wording replaces legacy missing titles in rows, filters and detail', async t => {
  const { page, runtime } = await groupedFixture(t);
  runtime.store.insertEvents([
    {
      id: 'branch-deleted',
      repoId: 'demo-orders',
      kind: 'branch-deleted',
      title: 'Branch missing',
      branch: 'hotfix/finished',
      actor: 'Demo developer',
      time: new Date().toISOString(),
      observedAt: new Date().toISOString(),
      data: { evidence: 'push', pushId: 801 },
    },
  ]);
  await page.reload();
  await selectActivityType(page, 'Branch deleted');
  await expect(page.locator('li.row .kind')).toHaveText('Branch deleted');
  await expect(page.locator('li.row .feed-title .title')).toHaveText('Branch deleted');
  await expect(page.locator('li.row .feed-title .ref-name')).toHaveText('hotfix/finished');
  await expect(page.getByRole('button', { name: 'Activity type: Branch deleted', exact: true })).toBeVisible();
  await page.locator('li.row .feed-title').click();
  await expect(page.getByRole('heading', { name: 'Branch deleted · hotfix/finished' })).toBeVisible();
  assert.equal(await page.getByText('Branch missing', { exact: false }).count(), 0);
});

test('one Activity group offers clearly distinct New updates and All activity without changing seen state', async t => {
  const { page, runtime } = await groupedFixture(t);
  const now = new Date().toISOString();
  runtime.store.insertEvents([
    {
      id: 'seen-push',
      repoId: 'demo-orders',
      kind: 'push',
      title: 'Orders previously seen',
      branch: 'main',
      time: now,
      observedAt: now,
      seen: true,
    },
    {
      id: 'imported-push',
      repoId: 'demo-orders',
      kind: 'push',
      title: 'Orders imported history',
      branch: 'main',
      time: now,
      observedAt: now,
      imported: true,
    },
  ]);
  await page.reload();
  const main = page.getByRole('navigation', { name: 'Main', exact: true });
  await expect(main.getByRole('link', { name: 'Activity', exact: true })).toHaveCount(1);
  await expect(page.getByRole('link', { name: 'Catch-up', exact: true })).toHaveCount(0);
  await expect(page.getByRole('checkbox', { name: 'Unseen only', exact: true })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'New updates', exact: true })).toHaveAttribute('aria-current', 'page');
  await expect(page.locator('li.row')).toHaveCount(1);
  const remoteReads = [];
  page.on('request', request => {
    if (/\/api\/(refresh|connection|repos)(\?|$)/.test(request.url())) remoteReads.push(request.url());
  });
  await page.getByRole('searchbox', { name: 'Search activity' }).fill('Orders');
  await page.getByRole('link', { name: 'All activity', exact: true }).click();
  await expect(page).toHaveURL(/#activity\/all$/);
  await expect(page.getByRole('searchbox', { name: 'Search activity' })).toHaveValue('Orders');
  await expect(page.locator('li.row')).toHaveCount(3);
  await expect(page.locator('[data-event-id="seen-push"]')).toBeVisible();
  const importedHistory = page.locator('details[data-group="Imported history"]');
  if ((await importedHistory.getAttribute('open')) === null) await importedHistory.locator('summary').click();
  await expect(page.locator('[data-event-id="imported-push"]')).toBeVisible();
  await expect(page.getByRole('region', { name: 'Activity summary' })).toContainText('1 new item');
  // Every matching item is loaded, so the summary does not repeat the count.
  await expect(page.getByRole('region', { name: 'Activity summary' })).not.toContainText('Showing');
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
  runtime.store.insertEvents(
    cases.map(([id, kind, data], index) => ({
      id: `color-${id}`,
      repoId: 'demo-orders',
      kind,
      branch: 'feature/example',
      title: id,
      time: new Date(Date.now() - 600000 - index * 1000).toISOString(),
      observedAt: new Date(Date.now() - 600000).toISOString(),
      imported: true,
      seen: true,
      data: { ...data, ...(kind === 'build' ? { buildId: 800 + index } : {}) },
    })),
  );
  runtime.store.insertEvents([
    { ...event('canceled-transition', 'completed', 0), data: { ...event('', '', 0).data, status: 'completed', result: 'canceled' } },
  ]);
  await page.goto(page.url().split('#')[0] + '#activity/all');
  for (const theme of ['Light', 'Dark']) {
    await page.getByRole('button', { name: theme, exact: true }).click();
    const history = page.locator('details[data-group="Imported history"]');
    if (!(await history.evaluate(element => element.open))) await history.locator('summary').first().click();
    for (const [id, , , tone, label] of cases) {
      const row = page.locator(`li[data-event-id="color-${id}"]`);
      await expect(row.locator('.kind')).toHaveText(label);
      await expect(row.locator('.kind')).toHaveClass(new RegExp(`\\b${tone}\\b`));
      await expect(row).toHaveClass(new RegExp(`\\btone-${tone}\\b`));
    }
    await expect(page.locator('[data-event-id="color-deleted"]')).not.toHaveClass(/(?:^|\s)crit(?:\s|$)/);
    await expect(page.locator('[data-event-id="color-failed"]')).toHaveClass(/(?:^|\s)crit(?:\s|$)/);
    const contrast = await page.evaluate(() => {
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 1;
      const context = canvas.getContext('2d');
      const rgba = color => {
        context.clearRect(0, 0, 1, 1);
        context.fillStyle = color;
        context.fillRect(0, 0, 1, 1);
        return [...context.getImageData(0, 0, 1, 1).data];
      };
      const luminance = color =>
        color
          .slice(0, 3)
          .map(value => {
            const c = value / 255;
            return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
          })
          .reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0);
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
          background = background.map((value, index) => (index === 3 ? 255 : (wash[index] * wash[3]) / 255 + value * (1 - wash[3] / 255)));
        }
        const first = luminance(foreground),
          second = luminance(background);
        return {
          id: row.dataset.eventId,
          tone,
          hasWash: getComputedStyle(row).backgroundImage !== 'none',
          washed: row.classList.contains('new') || row.classList.contains('crit'),
          ratio: (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05),
          matchesToken: JSON.stringify(foreground) === JSON.stringify(rgba(tokens.getPropertyValue(names[tone]))),
        };
      });
    });
    for (const result of contrast) {
      assert.equal(result.matchesToken, true, `${theme} ${result.id} token`);
      // The wash marks unread rows and failed runs; seen rows stay plain.
      assert.equal(result.hasWash, result.washed, `${theme} ${result.id} wash`);
      assert.ok(result.ratio >= 4.5, `${theme} ${result.id} contrast ${result.ratio}`);
    }
    const trail = page.locator('[data-event-id="canceled-transition"] .trail');
    if (!(await trail.evaluate(element => element.open))) await trail.locator('summary').click();
    await expect(trail.locator('.status-text.warn')).toHaveText('Canceled');
    await expect(trail.locator('.status-text.info')).toHaveCount(2);
    await page.screenshot({ path: `test-results/status-colors-${theme.toLowerCase()}.png`, fullPage: true });
  }
  await page.locator('[data-event-id="color-completed"] .feed-title').click();
  await expect(page.locator('#page .status-chip')).toHaveClass(/\bok\b/);
  await expect(page.locator('#page .status-chip')).toHaveText('Merged');
});

test('the app-owned type dropdown is themed, keyboard accessible and stable during local polling', async t => {
  const { page, runtime } = await groupedFixture(t);
  runtime.store.insertEvents([
    {
      id: 'type-branch',
      repoId: 'demo-orders',
      kind: 'branch-created',
      title: 'New feature branch',
      branch: 'feature/type',
      time: new Date().toISOString(),
      observedAt: new Date().toISOString(),
    },
  ]);
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
    assert.deepEqual(
      await page.evaluate(() => ({
        panel: getComputedStyle(document.querySelector('#kind-panel')).backgroundColor,
        card: getComputedStyle(document.querySelector('.summary')).backgroundColor,
        option: getComputedStyle(document.querySelector('.type-option')).color,
        body: getComputedStyle(document.body).color,
      })),
      await page.evaluate(() => ({
        panel: getComputedStyle(document.querySelector('.summary')).backgroundColor,
        card: getComputedStyle(document.querySelector('.summary')).backgroundColor,
        option: getComputedStyle(document.body).color,
        body: getComputedStyle(document.body).color,
      })),
    );
    if (theme === 'Light') {
      const polling = page.waitForResponse(response => new URL(response.url()).pathname === '/api/state', { timeout: 8000 });
      runtime.store.insertEvents([
        {
          id: 'type-incoming',
          repoId: 'demo-orders',
          kind: 'push',
          title: 'Incoming push',
          branch: 'feature/type',
          time: new Date().toISOString(),
          observedAt: new Date().toISOString(),
        },
      ]);
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
      runtime.store.insertEvents([
        {
          id: 'type-build-result',
          repoId: 'demo-orders',
          kind: 'build',
          title: 'Orders CI',
          branch: 'main',
          time: new Date().toISOString(),
          observedAt: new Date().toISOString(),
          data: { buildId: 700, status: 'completed', result: 'succeeded' },
        },
      ]);
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
  await page.locator('#activity-filters-toggle').click();
  await page.getByRole('button', { name: /^Activity type:/ }).click();
  await expect(page.locator('#kind-panel')).toHaveCSS('top', '44px');
  const box = await page.locator('#kind-panel').boundingBox();
  assert.ok(box.x >= 0 && box.x + box.width <= 375);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.locator('.summary').click();
  await expect(page.locator('#kind-panel')).not.toBeVisible();
});

test('completed PRs clearly show a merge into the target and optional source/result revisions', async t => {
  const { page, runtime } = await groupedFixture(t);
  runtime.store.insertEvents([
    {
      id: 'merged-pr',
      repoId: 'demo-orders',
      kind: 'pr',
      title: 'PR 45 · Fix export',
      branch: 'feature/export',
      actor: 'PR creator',
      time: new Date().toISOString(),
      observedAt: new Date().toISOString(),
      data: {
        pullRequestId: 45,
        status: 'completed',
        sourceRefName: 'refs/heads/feature/export',
        targetRefName: 'refs/heads/main',
        sourceCommit: 'a'.repeat(40),
        mergeCommit: 'b'.repeat(40),
        mergeStrategy: 'squash',
      },
    },
  ]);
  await page.reload();
  await selectActivityType(page, 'Pull request');
  await expect(page.locator('li.row .kind')).toHaveText('Merged');
  await expect(page.locator('li.row')).toContainText('Merged into main');
  await expect(page.locator('li.row')).toHaveClass(/tone-ok/);
  await page.locator('li.row .feed-title').click();
  await expect(page.locator('#page .status-chip')).toHaveText('Merged');
  for (const label of ['Source branch', 'Target branch', 'Source commit', 'Merge commit', 'Created by'])
    await expect(page.getByText(label, { exact: true })).toBeVisible();
  await expect(page.getByText('Merged by', { exact: true })).toHaveCount(0);
  await expect(page.getByText('Squash', { exact: true })).toBeVisible();
});

test('the sync status pill reads Synced in the demo and follows a Problem or Delayed server status', async t => {
  const { page } = await setup(t);
  const pill = page.locator('#header .header-tools > .sync-pill');
  await expect(pill).toHaveText(/^Synced · \d{1,2}[:.]\d{2}/);
  await expect(page.locator('#page .banner')).toHaveCount(0);
  await page.getByRole('link', { name: 'Repositories', exact: true }).click();
  await expect(page.locator('.repo-entry .sync-pill')).toHaveText([/^Synced · /, /^Synced · /, /^Synced · /]);
  const cases = [
    [{ state: 'problem', reason: 'Sign in to Azure again.', stream: 'refs' }, 'Problem', 'crit'],
    [{ state: 'delayed', reason: 'about 9 minutes behind', stream: 'pushes' }, 'Delayed · about 9 minutes behind', 'warn'],
  ];
  // One handler for the whole test: replacing it while a poll is in flight would answer that request twice.
  let status = cases[0][0];
  await page.route('**/api/state', async route => {
    const state = await (await route.fetch()).json();
    const repos = { ...state.syncStatus.repos, 'demo-orders': status };
    await route.fulfill({ json: { ...state, demo: false, syncStatus: { overall: { ...status, repoId: 'demo-orders' }, repos } } });
  });
  for (const [current, text, tone] of cases) {
    status = current;
    await page.goto(`${page.url().split('#')[0]}#activity/new`);
    await expect(pill).toHaveText(text);
    await expect(pill).toHaveClass(new RegExp(`\\b${tone}\\b`));
    await expect(page.locator('#page .banner')).toHaveCount(1);
    await expect(page.locator('#page .banner strong')).toHaveText(text.split(' · ')[0]);
    await page.getByRole('link', { name: 'Repositories', exact: true }).click();
    await expect(page.locator('.repo-entry', { hasText: 'orders-api' }).locator('.sync-pill')).toHaveText(text);
  }
  await expect(pill).toHaveAccessibleName('Sync status: Delayed in orders-api: about 9 minutes behind');
  status = cases[0][0];
  await page.reload();
  await expect(pill).toHaveAccessibleName('Sync status: Problem in orders-api: Sign in to Azure again.');
  await expect(pill).toHaveAttribute('title', 'Problem in orders-api: Sign in to Azure again.');
  await page.getByRole('link', { name: 'Settings', exact: true }).click();
  await page.locator('#troubleshooting-toggle').click();
  await expect(page.locator('.sync-sentence')).toHaveText('Problem in orders-api: Sign in to Azure again.');
  await expect(page.getByText('Azure calls')).toHaveCount(0);
});

test('at 640px a long repository status pill wraps inside its column instead of covering the checkout status', async t => {
  const { page } = await setup(t);
  const delayed = { state: 'delayed', reason: 'Checks are behind schedule', stream: 'pushes' };
  await page.route('**/api/state', async route => {
    const state = await (await route.fetch()).json();
    const repos = Object.fromEntries(Object.keys(state.syncStatus.repos).map(id => [id, delayed]));
    await route.fulfill({ json: { ...state, demo: false, syncStatus: { overall: { ...delayed, repoId: 'demo-orders' }, repos } } });
  });
  await page.setViewportSize({ width: 640, height: 900 });
  await page.goto(`${page.url().split('#')[0]}#repositories`);
  const entries = page.locator('.repo-entry:not(.repo-disabled)');
  await expect(entries.first().locator('.sync-pill')).toHaveText('Delayed · checks are behind schedule');
  for (const entry of await entries.all()) {
    const [pill, column, checkout] = await Promise.all(
      ['.repo-overview .sync-pill', '.repo-overview', '.repo-checkout-line'].map(selector => entry.locator(selector).boundingBox()),
    );
    assert.ok(
      pill.x + pill.width <= column.x + column.width + 0.5,
      `pill ends at ${pill.x + pill.width}, its column at ${column.x + column.width}`,
    );
    const overlaps =
      pill.x < checkout.x + checkout.width &&
      checkout.x < pill.x + pill.width &&
      pill.y < checkout.y + checkout.height &&
      checkout.y < pill.y + pill.height;
    assert.equal(overlaps, false, 'pill and checkout status overlap');
  }
});

test('one persistent live region outside the header announces only changed sync sentences; pills are plain text', async t => {
  const { page } = await setup(t);
  let status = { state: 'problem', reason: 'Sign in to Azure again.', stream: 'refs' };
  await page.route('**/api/state', async route => {
    const state = await (await route.fetch()).json();
    const repos = { ...state.syncStatus.repos, 'demo-orders': status };
    await route.fulfill({ json: { ...state, demo: false, syncStatus: { overall: { ...status, repoId: 'demo-orders' }, repos } } });
  });
  await page.reload();
  const live = page.locator('#sync-live');
  await expect(live).toHaveText('Problem in orders-api: Sign in to Azure again.');
  await expect(live).toHaveAttribute('role', 'status');
  await expect(live).toHaveAttribute('aria-live', 'polite');
  await expect(page.locator('#header #sync-live')).toHaveCount(0);
  const refreshed = async () => {
    await page.evaluate(() => (window.oldPill = document.querySelector('#header .sync-pill')));
    await page.locator('#header-refresh-desktop').click();
    await expect.poll(() => page.evaluate(() => !document.contains(window.oldPill))).toBe(true);
  };
  await page.evaluate(() => (window.syncText = document.getElementById('sync-live').firstChild));
  await refreshed();
  assert.equal(await page.evaluate(() => document.getElementById('sync-live').firstChild === window.syncText), true, 'same text node');
  status = { state: 'delayed', reason: 'about 9 minutes behind', stream: 'pushes' };
  await refreshed();
  await expect(live).toHaveText('Delayed in orders-api');
  await page.evaluate(() => (window.syncText = document.getElementById('sync-live').firstChild));
  status = { state: 'delayed', reason: 'about 10 minutes behind', stream: 'pushes' };
  await refreshed();
  assert.equal(
    await page.evaluate(() => document.getElementById('sync-live').firstChild === window.syncText),
    true,
    'a new minute count is not announced again',
  );
  await expect(page.locator('.sync-pill[role], .sync-pill[aria-live]')).toHaveCount(0);
  await page.getByRole('link', { name: 'Repositories', exact: true }).click();
  await expect(page.locator('.repo-entry .sync-pill')).toHaveCount(3);
  await expect(page.locator('.sync-pill[role], .sync-pill[aria-live]')).toHaveCount(0);
});

test('Escape before the first state load does not throw', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'repo-pulse-ui-'));
  const runtime = await startApp({ demo: true, port: 0, dataDir: directory });
  const browser = await chromium.launch({ executablePath: await browserPath(), headless: true });
  t.after(async () => {
    await browser.close();
    await runtime.close();
    await rm(directory, { recursive: true, force: true });
  });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  let releaseState;
  const stateHeld = new Promise(resolve => (releaseState = resolve));
  await page.route('**/api/state', async route => {
    await stateHeld;
    await route.continue();
  });
  await page.goto(runtime.launchUrl, { waitUntil: 'domcontentloaded' });
  await page.keyboard.press('Escape');
  releaseState();
  await expect(page.locator('#repo-toggle')).toBeVisible();
  assert.deepEqual(errors, []);
});

test('tag activity has its own type filter and a detail that names the tag and what it points at', async t => {
  const { page } = await setup(t);
  await page.getByRole('link', { name: 'All activity' }).click();
  await page.getByRole('button', { name: /^Activity type:/ }).click();
  await page.getByRole('option', { name: 'Tag', exact: true }).click();
  const rows = page.locator('#page li.row');
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText('Tag moved');
  await expect(rows.first()).toContainText('3f9a2c1 → 8d41e07');
  await rows.first().locator('.feed-title').click();
  const facts = page.locator('.detail-facts');
  await expect(facts).toContainText('Tagrelease/2026.11');
  await expect(facts).toContainText('Points at');
  await expect(facts).not.toContainText('Tagged commit');
});

test('a push that rewrote history says so on its row and in how it was merged, and a fast-forward push does not', async t => {
  const { page } = await setup(t);
  await page.getByRole('link', { name: 'All activity' }).click();
  await page.locator('details[data-group="Imported history"] > summary').click();
  const rewritten = page.locator('[data-event-id="demo-history"]');
  await expect(rewritten).toContainText('History rewritten · 2 commits dropped');
  await expect(page.locator('[data-event-id="demo-push-1"]')).not.toContainText('History rewritten');
  await rewritten.locator('.feed-title').click();
  await expect(page.getByRole('region', { name: 'Push evidence' })).toContainText(
    'main · history rewritten, 2 commits dropped from the old tip',
  );
});

test('a pull request detail lists its reviewers and their votes in words', async t => {
  const { page } = await setup(t);
  await page.locator('[data-event-id="demo-pr-1"] .feed-title').click();
  const facts = page.locator('.detail-facts');
  await expect(facts).toContainText('Redacted 3 (required): approved');
  await expect(facts).toContainText('Redacted 1: waiting for author');
  await expect(facts).toContainText('Billing reviewers (required): no vote');
});

test('a pull request detail loads its discussion and policy results only when asked', async t => {
  const { page } = await setup(t);
  await page.locator('[data-event-id="demo-pr-1"] .feed-title').click();
  const detail = page.locator('.detail-data');
  await expect(detail).not.toContainText('Discussion:');
  await detail.getByRole('button', { name: 'Load discussion and policies' }).click();
  await expect(detail).toContainText('Discussion: 2 open, 3 resolved threads');
  await expect(detail).toContainText('Minimum number of reviewers (required): waiting');
  await expect(detail).toContainText('Build (required): failed');
  await expect(detail).toContainText('Comment requirements: passed');
  await expect(detail.getByRole('button', { name: 'Reload discussion and policies' })).toBeVisible();
});

test('the launch link works once, hides its token, and a stale or forged link cannot replace a working key', async t => {
  const app = await setup(t);
  const { page, runtime } = app;
  assert.equal(new URL(page.url()).hash.includes('launch='), false);
  // A forged link in a fresh document tries the exchange, fails, and keeps the working key. A separate tab with this run's
  // key stored keeps its expected 401 responses out of the setup's console check.
  const context = await page.context().browser().newContext();
  t.after(() => context.close());
  const tab = await context.newPage();
  await rememberKey(tab, runtime.accessKey);
  const forged = tab.waitForResponse(response => new URL(response.url()).pathname === '/api/session');
  await tab.goto(`${runtime.url}/#launch=forged-token`);
  assert.equal((await forged).status(), 401);
  await tab.goto(runtime.url + '/#repositories');
  // The watched demo repositories load only if the state request was authorized.
  await expect(tab.getByRole('article').first()).toBeVisible();
  // A launch link opened in the tab that already shows the app reloads it, so the exchange runs again.
  const again = tab.waitForResponse(response => new URL(response.url()).pathname === '/api/session');
  await tab.evaluate(() => {
    location.hash = '#launch=another-forged-token';
  });
  assert.equal((await again).status(), 401);
  await expect(tab.getByRole('link', { name: 'Repo Pulse', exact: true })).toBeVisible();
  const stranger = await page.context().browser().newPage();
  t.after(() => stranger.close());
  // The same launch link in a browser without the key is already spent.
  await stranger.goto(runtime.launchUrl);
  await expect(
    stranger
      .getByText(
        'Open the newest link printed in the terminal where Repo Pulse runs. Each link works once; restart Repo Pulse for a new one.',
      )
      .first(),
  ).toBeVisible();
});

test('Start from scratch in Settings confirms, empties the feed and shows Syncing until the import is back', async t => {
  const store = createStore();
  const repo = {
    id: 'one',
    name: 'orders-api',
    azureId: 'a',
    organization: 'https://dev.azure.com/org',
    project: 'P',
    webUrl: 'https://dev.azure.com/org/P/_git/orders-api',
  };
  store.saveRepo(repo);
  const gate = {
    closed: false,
    held: 0,
    /** @type {(() => void)[]} */
    waiting: [],
    release() {
      gate.waiting.splice(0).forEach(resolve => resolve());
    },
  };
  const provider = {
    async checkConnection() {
      return { available: true, signedIn: true, account: { name: 'someone@example.test' }, message: 'Signed in.' };
    },
    async read(_repo, stream) {
      if (gate.closed) {
        gate.held++;
        await new Promise(resolve => gate.waiting.push(resolve));
      }
      const items =
        stream === 'pushes'
          ? [
              {
                pushId: 1,
                date: '2026-11-18T10:00:00Z',
                pushedBy: { displayName: 'Ana' },
                refUpdates: [{ name: 'refs/heads/main', oldObjectId: 'a'.repeat(40), newObjectId: 'b'.repeat(40) }],
              },
            ]
          : [];
      return { items, nextCursor: null };
    },
  };
  const sync = createSync({ store, provider, pollMs: 20 });
  const server = createApp({ store, provider, sync, accessKey: TEST_KEY });
  let browser;
  const errors = [];
  t.after(async () => {
    gate.closed = false;
    gate.release();
    await browser?.close().catch(() => {});
    await sync.stop();
    if (server.listening) await new Promise(resolve => server.close(resolve));
    store.close();
    assert.deepEqual(errors, []);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  sync.start();
  sync.refresh();
  for (let i = 0; i < 200 && !store.listEvents().length; i++) await new Promise(resolve => setTimeout(resolve, 10));
  browser = await chromium.launch({ executablePath: await browserPath(), headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.on('pageerror', error => errors.push(error.message));
  await rememberKey(page);
  const url = `http://127.0.0.1:${server.address().port}`;
  await page.goto(`${url}/#activity/all`);
  await expect(page.locator('[data-event-id="one:push:1"]')).toHaveCount(1);

  await page.getByRole('link', { name: 'Settings', exact: true }).click();
  const row = page.locator('.settings-row', { hasText: 'Start from scratch' });
  await expect(row).toContainText('Deletes stored activity and imports the last seven days again. Your repositories and settings stay.');
  await row.screenshot({ path: 'test-results/settings-start-from-scratch.png' });
  gate.closed = true;
  for (const state of store.getStreams()) store.saveStream({ ...state, nextAt: new Date(0).toISOString() });
  for (let i = 0; i < 200 && !gate.held; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(gate.held, 1, 'a page is waiting on Azure when the reset is asked for');
  await row.getByRole('button', { name: 'Start from scratch' }).click();
  const dialog = page.locator('#confirm-dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('#confirm-title')).toHaveText('Start from scratch?');
  const confirmButton = dialog.getByRole('button', { name: 'Delete and import again' });
  await expect(confirmButton).toHaveClass(/danger/);
  await page.screenshot({ path: 'test-results/settings-start-from-scratch-dialog.png' });
  await confirmButton.click();
  await expect(page.locator('#toast')).toHaveText(
    'Starting from scratch. Stored activity is being deleted, then the last seven days are imported.',
  );
  await expect(page.locator('#header .header-tools > .sync-pill')).toHaveText('Syncing…');
  assert.equal(store.listEvents().length, 1, 'the reset waits for the page in flight');
  gate.release();

  await page.getByRole('link', { name: 'Activity', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Activity', exact: true })).toBeVisible();
  await expect(page.locator('[data-event-id]')).toHaveCount(0);
  await expect(page.locator('.feed .empty .big')).toHaveText('No activity loaded yet');
  assert.equal(store.listRepos().length, 1);

  gate.closed = false;
  gate.release();
  await expect(page.locator('[data-event-id="one:push:1"]')).toHaveCount(1, { timeout: 15000 });
});

test('All activity shows the branch tree beside the type label, and narrow screens and New updates keep the dot', async t => {
  const { page } = await setup(t);
  await page.getByRole('link', { name: 'All activity', exact: true }).click();
  const rows = page.locator('.with-tree .row');
  await expect(rows.first()).toBeVisible();
  await expect(page.locator('.with-tree svg.tree')).toHaveCount(await rows.count());
  const hotfix = page.locator('[data-event-id="demo-branch-1"]');
  // A new branch has nothing else to say first, so where it started is its top line, above who and when.
  await expect(hotfix.locator('.event-main')).toHaveText('Started at 3f9a2c1, the tip of main');
  await expect(hotfix.locator('.event-origin')).toHaveCount(0);
  await expect(hotfix.locator('svg.tree path')).toHaveCount(1);
  await expect(hotfix.locator('svg.tree path.assumed')).toHaveCount(0);
  await expect(page.locator('[data-event-id="demo-branch-3"]')).toContainText('PR 1175 targets main, origin not checked');
  await expect(page.locator('[data-event-id="demo-branch-3"] svg.tree path.assumed')).toHaveCount(1);
  await expect(page.locator('[data-event-id="demo-pr-2"] svg.tree path')).toHaveCount(1);
  // A CI run on a pull request ref takes the branch of the stored PR and joins its lane.
  const ciRef = page.locator('[data-event-id="demo-build-2"] .subref');
  await expect(ciRef.locator('.ref-repo')).toHaveText(' · repository shared-components');
  await expect(ciRef.locator('.ref-name')).toHaveText('feature/date-range');
  await expect(ciRef.locator('.ref-pr')).toHaveText(' · PR 412');
  await expect(ciRef.locator('.ref-pr')).toBeVisible();
  await expect(page.locator('[data-event-id="demo-build-2"] svg.tree circle.dot:not(.lane-none)')).toHaveCount(1);
  // A lane must run unbroken through a row, so each cell covers its row from border to border.
  const [cell, row] = await Promise.all([hotfix.locator('svg.tree').boundingBox(), hotfix.boundingBox()]);
  assert.ok(Math.abs(cell.y - row.y) <= 1 && Math.abs(cell.y + cell.height - (row.y + row.height)) <= 1, 'tree cell spans the row');
  await expect(hotfix.locator('.kind > svg')).toBeHidden();

  await page.setViewportSize({ width: 420, height: 900 });
  await expect(hotfix.locator('svg.tree')).toBeHidden();
  await expect(hotfix.locator('.kind > svg')).toBeVisible();
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.getByRole('link', { name: 'New updates', exact: true }).click();
  await expect(page.locator('[data-event-id="demo-branch-1"]')).toBeVisible();
  await expect(page.locator('svg.tree')).toHaveCount(0);
});

test('on desktop a row lines up its ref line with its meta line, and its summary with its title', async t => {
  const { page } = await setup(t);
  await page.getByRole('link', { name: 'All activity', exact: true }).click();
  await expect(page.locator('.with-tree .row').first()).toBeVisible();
  const rows = await page.locator('.with-tree .row').evaluateAll(items =>
    items.map(row => {
      // The baseline of an element's first visible text: a zero-size inline box placed before that text sits on it.
      const baseline = selector => {
        const element = row.querySelector(selector);
        if (!element) return undefined;
        const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT, {
          acceptNode: node =>
            node.textContent.trim() && !node.parentElement.closest('.sr') ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP,
        });
        const text = walker.nextNode();
        const wrap = document.createElement('span');
        const probe = document.createElement('span');
        probe.style.cssText = 'display: inline-block; width: 0; height: 0';
        text.replaceWith(wrap);
        wrap.append(probe, text);
        const y = probe.getBoundingClientRect().top;
        wrap.replaceWith(text);
        return y;
      };
      const oneLine = element => !element || element.getBoundingClientRect().height <= parseFloat(getComputedStyle(element).lineHeight) + 1;
      return {
        id: row.dataset.eventId,
        oneLine: oneLine(row.querySelector('.feed-title .title')) && oneLine(row.querySelector('.event-main')),
        title: baseline('.feed-title .title'),
        summary: baseline('.event-main'),
        refs: ['.ref-repo', '.ref-name', '.ref-pr'].map(baseline).filter(y => y !== undefined),
        meta: baseline('.event-meta'),
      };
    }),
  );
  const checked = rows.filter(row => row.oneLine && row.summary !== undefined && row.refs.length);
  assert.ok(checked.length >= 5, `enough rows to measure: ${checked.length}`);
  const off = checked.filter(row => Math.abs(row.title - row.summary) > 1 || row.refs.some(y => Math.abs(y - row.meta) > 1));
  assert.deepEqual(
    off.map(
      row =>
        `${row.id}: title-summary ${(row.title - row.summary).toFixed(1)}, ref-meta ${row.refs.map(y => (y - row.meta).toFixed(1)).join(' ')}`,
    ),
    [],
  );
});
