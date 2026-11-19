import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { chromium, expect } from '@playwright/test';
import { startApp, createApp } from '../server.js';
import { createStore } from '../server/store.js';
import { TEST_KEY, rememberKey } from '../test/fixtures/access.js';

async function executable() {
  if (process.env.CHROME) return process.env.CHROME;
  if (existsSync(chromium.executablePath())) return chromium.executablePath();
  const cache = join(homedir(), '.cache', 'ms-playwright');
  for (const name of (await readdir(cache).catch(() => []))
    .filter(name => /^chromium-\d+$/.test(name))
    .sort()
    .reverse()) {
    for (const relative of ['chrome-linux64/chrome', 'chrome-linux/chrome'])
      if (existsSync(join(cache, name, relative))) return join(cache, name, relative);
  }
  throw new Error('Install Chromium or set CHROME.');
}

async function demo(t) {
  const directory = await mkdtemp(join(tmpdir(), 'repo-pulse-history-ui-'));
  const runtime = await startApp({ demo: true, port: 0, dataDir: directory });
  const browser = await chromium.launch({ executablePath: await executable(), headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  let stopping;
  const stop = () => (stopping ??= runtime.close());
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  t.after(async () => {
    await browser.close();
    await stop();
    await rm(directory, { recursive: true, force: true });
    assert.deepEqual(errors, []);
  });
  // Open the launch link once on a page that shows no activity; later visits to this origin reuse the stored key.
  await page.goto(runtime.launchUrl);
  await page.goto(`${runtime.url}/#settings`);
  await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible();
  return { runtime, page, directory, stop };
}

function seedHistory(store) {
  const now = Date.now();
  const records = Array.from({ length: 1050 }, (_, index) => ({
    id: `archive-${index}`,
    repoId: 'demo-orders',
    kind: 'push',
    title: `Archive entry ${index}`,
    branch: `feature/archive-${index}`,
    time: new Date(now - (index + 100) * 60000).toISOString(),
    observedAt: new Date(now - (index + 100) * 60000).toISOString(),
    imported: true,
    seen: true,
    data: { pushId: 10000 + index },
  }));
  records.push({
    id: 'old-unseen',
    repoId: 'demo-orders',
    kind: 'push',
    title: 'Very old unseen update',
    branch: 'hotfix/old-unseen',
    time: new Date(now - 100 * 86400000).toISOString(),
    observedAt: new Date(now - 100 * 86400000).toISOString(),
    seen: false,
    imported: false,
    data: { pushId: 90000 },
  });
  store.insertEvents(records);
}

test('new updates, paged history, filters and deep links reach events beyond the old 1000 window', async t => {
  const { runtime, page } = await demo(t);
  seedHistory(runtime.store);
  await page.goto(runtime.url + '/#activity/new');
  await expect(page.locator('li[data-event-id="old-unseen"]')).toBeVisible();
  await page.getByRole('link', { name: 'All activity', exact: true }).click();
  await expect(page.locator('li.row')).toHaveCount(50);
  await page.getByRole('button', { name: 'Load more', exact: true }).click();
  await expect(page.locator('li.row')).toHaveCount(100);
  await expect(page.getByRole('region', { name: 'Activity summary' })).toContainText('Showing 100 of 1058 items');
  await page.locator('details[data-group="Imported history"] > summary').click();
  const last = page.locator('li.row').last();
  const id = await last.getAttribute('data-event-id');
  await last.locator('.feed-title').click();
  await expect(page.getByRole('link', { name: '← Back to All activity', exact: true })).toBeVisible();
  await page.reload();
  await page.getByRole('link', { name: '← Back to All activity', exact: true }).click();
  await expect(page.locator('li.row')).toHaveCount(100);
  await expect(page.locator(`li[data-event-id="${id}"] .feed-title`)).toBeFocused();
  await page.getByRole('searchbox', { name: 'Search activity' }).fill('Archive entry 1049');
  await expect(page.locator('li.row')).toHaveCount(1);
  await expect(page.locator('li[data-event-id="archive-1049"]')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Load more', exact: true })).toHaveCount(0);
  await page.goto(runtime.url + '/#event/archive-1049');
  await expect(page.getByRole('heading', { name: 'Archive entry 1049', exact: true })).toBeVisible();
  assert.equal(runtime.store.getEvent('old-unseen').seen, false);
});

test('paged query reset follows type and repository scope without acknowledging hidden history', async t => {
  const { runtime, page } = await demo(t);
  seedHistory(runtime.store);
  await page.goto(runtime.url + '/#activity/all');
  await expect(page.locator('li.row')).toHaveCount(50);
  await page.getByRole('button', { name: 'Load more', exact: true }).click();
  await expect(page.locator('li.row')).toHaveCount(100);
  await page.getByRole('button', { name: /^Activity type:/ }).click();
  await page.getByRole('option', { name: 'Pull request', exact: true }).click();
  await expect(page.locator('li.row')).toHaveCount(1);
  await page.locator('#repo-toggle').click();
  await page.locator('[data-scope-repo="demo-billing"]').uncheck();
  await page.locator('[data-scope-repo="demo-shared"]').uncheck();
  await page.keyboard.press('Escape');
  await expect(page.locator('li.row')).toHaveCount(0);
  await expect(page.locator('.feed .empty .big')).toHaveText('No activity matches these filters');
  await expect(page.locator('.summary .headline b')).toHaveText('No activity matches these filters');
  assert.equal(runtime.store.getEvent('old-unseen').seen, false);
});

test('one long build history keeps every constituent and acknowledges explicit batches without consuming a late update', async t => {
  const { runtime, page } = await demo(t);
  runtime.store.acknowledge(runtime.store.listEvents().map(event => event.id));
  const beginning = Date.now() - 60000;
  const event = (index, time) => ({
    id: `long-build-${index}`,
    repoId: 'demo-orders',
    kind: 'build',
    title: 'Long running build',
    branch: 'main',
    time: new Date(time).toISOString(),
    observedAt: new Date(time).toISOString(),
    seen: false,
    imported: false,
    data: { buildId: 7000, status: 'inProgress', sourceVersion: 'abcdef123456' },
  });
  runtime.store.insertEvents(Array.from({ length: 1050 }, (_, index) => event(index, beginning + index)));
  const batches = [];
  page.on('request', request => {
    if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/ack') batches.push(request.postDataJSON());
  });
  await page.goto(runtime.url + '/#activity/new');
  await expect(page.locator('li.row')).toHaveCount(1);
  await page.route(
    '**/api/ack',
    async route => {
      runtime.store.insertEvents([event('late', Date.now())]);
      await route.continue();
    },
    { times: 1 },
  );
  await page.getByRole('button', { name: 'Mark shown seen (1050)', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Mark shown seen (1)', exact: true })).toBeVisible();
  assert.deepEqual(
    batches.map(batch => batch.ids.length),
    [250, 250, 250, 250, 50],
  );
  assert.equal(new Set(batches.flatMap(batch => batch.ids)).size, 1050);
  assert.equal(
    batches.some(batch => batch.ids.includes('long-build-late')),
    false,
  );
  assert.equal(runtime.store.getEvent('long-build-0').seen, true);
  assert.equal(runtime.store.getEvent('long-build-late').seen, false);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Mark shown seen (1051)', exact: true })).toBeVisible();
});

test('repository history import scopes the confirmed range and keeps progress visible through polls', async t => {
  const store = createStore();
  for (const [id, name] of [
    ['orders', 'Orders'],
    ['billing', 'Billing'],
  ])
    store.saveRepo({ id, name });
  const calls = [];
  let failOnce = true;
  const app = createApp({
    accessKey: TEST_KEY,
    store,
    provider: { checkConnection: async () => ({ available: true }) },
    sync: { status: () => ({}) },
    backfill: {
      start(repoId, days) {
        calls.push({ repoId, days });
        if (failOnce) {
          failOnce = false;
          throw Object.assign(new Error('Try this date range again.'), { status: 409 });
        }
        const job = { id: `backfill:${repoId}`, type: 'backfill', repoId, status: 'pending', days, pages: 0 };
        store.saveJob(job);
        return job;
      },
    },
  });
  await new Promise(resolve => app.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ executablePath: await executable(), headless: true });
  const page = await browser.newPage({ viewport: { width: 375, height: 812 }, colorScheme: 'dark' });
  await rememberKey(page);
  t.after(async () => {
    await browser.close();
    await new Promise(resolve => app.close(resolve));
    store.close();
  });
  const base = `http://127.0.0.1:${app.address().port}`;
  await page.goto(base + '/#settings');
  await expect(page.getByRole('button', { name: 'Sync older activity…' })).toHaveCount(0);
  await page.getByRole('link', { name: 'Repositories', exact: true }).click();
  const orders = page.locator('article').filter({ has: page.getByRole('heading', { name: /^Orders/ }) });
  const billing = page.locator('article').filter({ has: page.getByRole('heading', { name: /^Billing/ }) });
  await orders.locator('summary').click();
  const trigger = orders.getByRole('button', { name: 'Sync older activity…' });
  await trigger.click();
  const dialog = page.getByRole('dialog', { name: 'Sync older activity' });
  await expect(dialog.getByText('Orders', { exact: true })).toBeVisible();
  await expect(dialog.getByRole('radio', { name: '30 days', exact: true })).toBeChecked();
  assert.equal(await dialog.evaluate(element => element.scrollWidth > element.clientWidth), false);
  await mkdir('test-results', { recursive: true });
  await page.screenshot({ path: 'test-results/repo-history-import-dark.png', animations: 'disabled' });
  await page.keyboard.press('Escape');
  await expect(dialog).not.toBeVisible();
  await expect(trigger).toBeFocused();
  assert.deepEqual(calls, []);
  await trigger.click();
  await dialog.getByRole('radio', { name: '90 days', exact: true }).check();
  await dialog.getByRole('button', { name: 'Start sync' }).click();
  await expect(dialog.getByRole('alert')).toHaveText('Try this date range again.');
  await expect(dialog.getByRole('radio', { name: '90 days', exact: true })).toBeChecked();
  await dialog.getByRole('button', { name: 'Start sync' }).click();
  await expect(dialog).not.toBeVisible();
  await expect(orders.getByText('History sync queued', { exact: true })).toBeVisible();
  await expect(orders.locator('.history-progress')).toBeFocused();
  await expect(trigger).toBeDisabled();
  await billing.locator('summary').click();
  await expect(billing.getByRole('button', { name: 'Sync older activity…' })).toBeEnabled();
  assert.deepEqual(calls, [
    { repoId: 'orders', days: 90 },
    { repoId: 'orders', days: 90 },
  ]);
  const job = store.listJobs({ type: 'backfill' })[0];
  store.saveJob({ ...job, status: 'retrying', pages: 2, error: { message: 'Read denied' } });
  await expect(orders.getByText('History sync retrying', { exact: true })).toBeVisible({ timeout: 8000 });
  await expect(orders.getByText('Read denied', { exact: true })).toBeVisible();
  store.saveJob({ ...job, status: 'completed', pages: 3 });
  await expect(orders.getByText('History sync finished', { exact: true })).toBeVisible({ timeout: 8000 });
  await expect(trigger).toBeEnabled();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await billing.getByRole('button', { name: 'Sync older activity…' }).click();
  await dialog.getByRole('radio', { name: 'All available since 2010' }).check();
  await dialog.getByRole('button', { name: 'Start sync' }).click();
  await expect(billing.getByText('History sync queued', { exact: true })).toBeVisible();
  assert.deepEqual(calls.at(-1), { repoId: 'billing', days: 'all' });
});

test('compact Settings keeps diagnostics closed until needed and copies the diagnostics alone', async t => {
  const { runtime, page } = await demo(t);
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.goto(runtime.url + '/#settings');
  await mkdir('test-results', { recursive: true });
  for (const [colorScheme, width] of [
    ['light', 1280],
    ['dark', 375],
  ]) {
    await page.emulateMedia({ colorScheme });
    await page.setViewportSize({ width, height: 812 });
    await expect(page.locator('#page').getByRole('switch', { name: 'Automatic checks' })).toBeVisible();
    await expect(page.getByText('Troubleshooting', { exact: true })).toBeInViewport();
    await expect(page.getByRole('button', { name: 'Copy diagnostics' })).not.toBeVisible();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.screenshot({ path: `test-results/settings-redesign-${colorScheme}.png`, animations: 'disabled' });
  }
  await page.getByText('Troubleshooting', { exact: true }).click();
  await expect(page.locator('.sync-sentence')).toHaveText(/^Synced, last check /);
  await page.getByRole('button', { name: 'Copy diagnostics' }).click();
  await expect(page.getByRole('status').last()).toHaveText('Diagnostics copied.');
  const copied = JSON.parse(await page.evaluate(() => navigator.clipboard.readText()));
  assert.deepEqual(copied, { sync: { demo: true, running: false } });
  await page.getByText('What Repo Pulse tracks', { exact: true }).click();
  await expect(page.getByText('A successful build or merged pull request does not confirm deployment.')).toBeVisible();
});

test('idle Activity polling skips history queries at one page and after loading 250 items', async t => {
  const { runtime, page } = await demo(t);
  seedHistory(runtime.store);
  let reads = 0;
  page.on('request', request => {
    if (new URL(request.url()).pathname === '/api/activity') reads++;
  });
  const metadata = response => new URL(response.url()).pathname === '/api/state';
  async function readsBetweenPolls() {
    // Sample between metadata responses so the previous poll's Activity work has settled.
    await page.waitForResponse(metadata);
    await page.waitForResponse(metadata);
    return reads;
  }
  await page.goto(runtime.url + '/#activity/all');
  await expect(page.locator('li.row')).toHaveCount(50);
  const initial = reads;
  const one = (await readsBetweenPolls()) - initial;
  for (let count = 100; count <= 250; count += 50) {
    await page.getByRole('button', { name: 'Load more', exact: true }).click();
    await expect(page.locator('li.row')).toHaveCount(count);
  }
  const loaded = reads;
  const several = (await readsBetweenPolls()) - loaded;
  assert.deepEqual({ one, several }, { one: 0, several: 0 });
});

test('an open Activity view picks up a seen action in another tab and later merge evidence', async t => {
  const { runtime, page } = await demo(t);
  const id = 'revision-test';
  const result = 'a'.repeat(40);
  runtime.store.insertEvents([
    {
      id,
      repoId: 'demo-orders',
      kind: 'push',
      title: 'Microsoft.VisualStudio.Services.TFS pushed to main',
      actor: 'Microsoft.VisualStudio.Services.TFS',
      time: new Date().toISOString(),
      data: { pushId: 18000, refUpdates: [{ name: 'refs/heads/main', oldObjectId: 'b'.repeat(40), newObjectId: result }] },
    },
  ]);
  await page.goto(runtime.url + '/#activity/all');
  const row = page.locator('li[data-event-id="revision-test"]');
  await expect(row).toHaveClass(/\bnew\b/);
  await expect(row.getByRole('button', { name: /^Azure DevOps service pushed to main/ })).toBeVisible();

  const other = await page.context().newPage();
  await other.goto(runtime.url + '/#activity/new');
  await other
    .locator('li[data-event-id="revision-test"]')
    .getByRole('button', { name: 'Mark Azure DevOps service pushed to main seen' })
    .click();
  await expect(other.locator('li[data-event-id="revision-test"]')).toHaveCount(0);
  await other.close();
  await expect(row).not.toHaveClass(/\bnew\b/, { timeout: 8000 });

  runtime.store.enrichEvent(id, {
    mergeEvidence: {
      status: 'complete',
      prs: [
        {
          pullRequestId: 12,
          relationship: 'result-introduced',
          targetRefName: 'refs/heads/main',
          mergeCommit: result,
          closedBy: 'Alice Morgan',
          url: 'https://dev.azure.com/example/project/_git/orders/pullrequest/12',
        },
      ],
    },
  });
  const title = 'Push to main · Linked PR #12';
  await expect(row.getByText('Completed PR linked')).toBeVisible({ timeout: 8000 });
  await expect(row.getByText('Pushed by Azure DevOps service')).toBeVisible();
  await row.getByRole('button', { name: new RegExp(`^${title}`) }).click();
  await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible();
  await expect(page.getByText('Pushed by', { exact: true })).toBeVisible();
  await expect(page.getByText(/PR closed by Alice Morgan/)).toBeVisible();
  await expect(page.getByRole('link', { name: 'PR #12' })).toBeVisible();
});

test('seen feedback waits for its refresh when a background poll is in flight', async t => {
  const { runtime, page } = await demo(t);
  await page.goto(runtime.url + '/#activity/new');
  const started = Promise.withResolvers();
  const release = Promise.withResolvers();
  let holdFirst = true;
  await page.route('**/api/state', async route => {
    const response = await route.fetch();
    if (holdFirst) {
      holdFirst = false;
      started.resolve();
      await release.promise;
    }
    await route.fulfill({ response });
  });
  try {
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await started.promise;
    const ack = page.waitForResponse(response => response.url().endsWith('/api/ack'));
    await page.getByRole('button', { name: /^Mark shown seen/ }).click();
    await ack;
    await expect(page.getByRole('dialog')).not.toBeVisible();
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await expect(page.locator('#toast')).not.toBeVisible({ timeout: 500 });
  } finally {
    release.resolve();
  }
  await expect(page.locator('#toast')).toContainText('marked seen');
  await expect(page.getByRole('button', { name: 'Mark shown seen (0)' })).toBeDisabled();
});

test('Repositories shows the checkout, checks on demand, and pulls only after confirmation', async t => {
  const { checkoutFixture, git } = await import('../test/fixtures/checkout.js');
  const fixture = checkoutFixture(t);
  const store = createStore();
  store.saveRepo(fixture.repo);
  store.setSetting('refreshEnabled', false);
  store.saveStream({ repoId: 'repo', stream: 'pushes', initialized: true, lastSuccess: new Date(Date.now() - 60 * 60_000).toISOString() });
  const app = createApp({
    accessKey: TEST_KEY,
    store,
    checkoutGit: fixture.checkoutGit,
    provider: { checkConnection: async () => ({ available: true }) },
    sync: { status: () => ({}) },
  });
  await new Promise(resolve => app.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ executablePath: await executable(), headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await rememberKey(page);
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  t.after(async () => {
    await browser.close();
    await new Promise(resolve => app.close(resolve));
    store.close();
    assert.deepEqual(pageErrors, []);
  });
  const base = `http://127.0.0.1:${app.address().port}`;
  const updatePath = base + '/api/repos/repo/checkout';
  const payload = { operation: 'pull', expected: { branch: 'main', upstream: 'origin/main', head: fixture.original } };
  assert.equal(
    (await fetch(updatePath, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) })).status,
    401,
  );
  await page.goto(base + '/#repositories');
  const row = page.getByRole('article');
  await expect(row.locator('code')).toHaveText('main');
  await expect(row.getByText('Not checked yet')).toBeVisible();
  await expect(row.getByText(/Needs attention|Check overdue|Check failed/)).toHaveCount(0);
  await expect(page.getByRole('combobox', { name: 'Search local repositories' })).toBeHidden();
  await expect(row.getByRole('button', { name: 'Remove watch' })).toBeHidden();
  assert.equal(git(fixture.local, 'rev-parse', 'origin/main'), fixture.original);
  await row.getByLabel('Details for Orders').click();
  await expect(row.getByText('Last successful Azure check', { exact: false })).toBeVisible();
  await expect(row.getByText(/Pushes ·|Next check/)).toHaveCount(0);
  const check = row.getByRole('button', { name: 'Check for updates' });
  await check.click();
  await expect(row.getByText('Up to date', { exact: true })).toBeVisible();
  await expect(row.getByText('Checked just now')).toBeVisible();
  await mkdir('test-results', { recursive: true });
  await page.screenshot({ path: 'test-results/repository-branch-up-to-date-light.png', animations: 'disabled' });
  const lastGitCheck = row.locator('.checkout-last-check time');
  const firstCheckTime = await lastGitCheck.getAttribute('datetime');
  assert.ok(Number.isFinite(Date.parse(firstCheckTime)));
  assert.equal(await row.locator('[data-branch-check-time]').getAttribute('datetime'), firstCheckTime);
  const { readFile, writeFile } = await import('node:fs/promises');
  await writeFile(join(fixture.local, 'notes.txt'), 'uncommitted notes');
  await check.click();
  await expect(row.getByText('Local changes', { exact: true })).toBeVisible();
  await expect(row.getByText('Up to date', { exact: true })).toBeVisible();
  const tip = fixture.advance();
  await check.click();
  await expect(row.getByText('1 commit behind', { exact: true })).toBeVisible();
  await expect(row.getByText('Git will check that Pull can keep your local changes.')).toBeVisible();
  await expect(row.getByRole('button', { name: 'Pull', exact: true })).toBeVisible();
  const options = row.getByLabel('Update options', { exact: true });
  await options.focus();
  await page.keyboard.press('Enter');
  await expect(row.getByText(/Try Pull first/)).toBeVisible();
  assert.equal(await readFile(join(fixture.local, 'notes.txt'), 'utf8'), 'uncommitted notes');
  await page.setViewportSize({ width: 375, height: 812 });
  await page.emulateMedia({ colorScheme: 'dark' });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: 'test-results/repository-update-options-dark.png', animations: 'disabled' });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.emulateMedia({ colorScheme: 'light' });
  const beforeRecheck = await lastGitCheck.getAttribute('datetime');
  await check.click();
  await expect(lastGitCheck).not.toHaveAttribute('datetime', beforeRecheck);
  await expect(row.getByText(/Try Pull first/)).toBeVisible();
  assert.equal(git(fixture.local, 'rev-parse', 'HEAD'), fixture.original);
  await row.getByLabel('Details for Orders').click();
  await mkdir('test-results', { recursive: true });
  await page.screenshot({ path: 'test-results/repository-checkout-light.png', animations: 'disabled' });
  await page.setViewportSize({ width: 375, height: 812 });
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.screenshot({ path: 'test-results/repository-checkout-dark.png', animations: 'disabled' });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await row.getByRole('button', { name: 'Pull', exact: true }).click();
  const confirmation = page.getByRole('dialog', { name: 'Update main?' });
  await expect(confirmation.getByText(/origin\/main/)).toBeVisible();
  await confirmation.getByRole('button', { name: 'Cancel', exact: true }).click();
  assert.equal(git(fixture.local, 'rev-parse', 'HEAD'), fixture.original);
  await row.getByRole('button', { name: 'Pull', exact: true }).click();
  await writeFile(join(fixture.local, 'feature.txt'), 'overlapping local edit');
  await confirmation.getByRole('button', { name: 'Pull', exact: true }).click();
  const blocked = page.getByRole('alert').filter({ hasText: 'Git could not preserve the local checkout' });
  await expect(blocked).toBeVisible();
  assert.equal(git(fixture.local, 'rev-parse', 'HEAD'), fixture.original);
  assert.equal(await readFile(join(fixture.local, 'feature.txt'), 'utf8'), 'overlapping local edit');
  await blocked.getByRole('button', { name: 'Dismiss' }).click();
  await writeFile(join(fixture.local, 'feature.txt'), 'initial');
  await row.getByRole('button', { name: 'Pull', exact: true }).click();
  await confirmation.getByRole('button', { name: 'Pull', exact: true }).click();
  await expect(row.getByText('Up to date')).toBeVisible();
  await expect(row.getByText('Local changes', { exact: true })).toBeVisible();
  assert.equal(await readFile(join(fixture.local, 'notes.txt'), 'utf8'), 'uncommitted notes');
  await expect(page.getByText('Updated main.', { exact: true })).toBeVisible();
  await check.click();
  await expect(page.getByText('main is up to date.', { exact: true })).toBeVisible();
  await rm(join(fixture.local, 'notes.txt'));
  await page.screenshot({ path: 'test-results/repository-branch-up-to-date-dark.png', animations: 'disabled' });
  await expect(row.getByRole('button', { name: 'Pull', exact: true })).toHaveCount(0);
  assert.equal(git(fixture.local, 'rev-parse', 'HEAD'), tip);
  git(fixture.remote, 'update-ref', 'refs/heads/main', fixture.original);
  await row.getByLabel('Details for Orders').click();
  await row.getByRole('button', { name: 'Check for updates' }).click();
  await expect(row.getByText('Upstream history changed', { exact: true })).toBeVisible();
  await row.getByText('Compare fetched history', { exact: true }).click();
  await expect(row.getByText(/Previous only/)).toBeVisible();
  await expect(row.getByRole('button', { name: 'Pull', exact: true })).toHaveCount(0);
  const lastSuccessfulTime = await lastGitCheck.getAttribute('datetime');
  git(fixture.remote, 'update-ref', '-d', 'refs/heads/main');
  await row.getByRole('button', { name: 'Check for updates' }).click();
  const upstreamError = row.getByText('Upstream branch not found', { exact: true });
  await expect(upstreamError).toBeVisible();
  await expect(upstreamError).toHaveClass(/\bcrit\b/);
  await expect(lastGitCheck).toHaveAttribute('datetime', lastSuccessfulTime);
  await expect(row.locator('[data-branch-check-time]')).toHaveCount(0);
  await expect(row.getByText(/Keep your local branch/)).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(row.getByRole('button', { name: 'Pull', exact: true })).toHaveCount(0);
  assert.equal(git(fixture.local, 'rev-parse', 'HEAD'), tip);
});

test('Activity offers statuses and evidence from matching history beyond the first page', async t => {
  const { runtime, page } = await demo(t);
  seedHistory(runtime.store);
  const time = '2022-01-01T00:00:00Z';
  runtime.store.insertEvents([
    {
      id: 'archived-canceled',
      repoId: 'demo-orders',
      kind: 'build',
      title: 'Archived pipeline',
      time,
      imported: true,
      data: { status: 'completed', result: 'canceled' },
    },
    {
      id: 'archived-merge',
      repoId: 'demo-orders',
      kind: 'pr',
      title: 'Archived merge',
      time,
      imported: true,
      data: { status: 'completed' },
    },
  ]);
  runtime.store.enrichEvent('archive-1049', { mergeEvidence: { prs: [{ pullRequestId: 5 }] } });
  await page.goto(runtime.url + '/#activity/all');
  await expect(page.locator('li.row')).toHaveCount(50);
  await expect(page.locator('[data-event-id="archived-canceled"]')).toHaveCount(0);
  const toggle = page.getByRole('button', { name: /^Activity type:/ });
  const panel = page.getByRole('listbox', { name: 'Activity type' });
  await toggle.click();
  await expect(panel.getByRole('option', { name: 'Merged', exact: true })).toBeVisible();
  await expect(panel.getByRole('option', { name: 'PR evidence', exact: true })).toBeVisible();
  await panel.getByRole('option', { name: 'Canceled', exact: true }).click();
  await expect(page.locator('[data-event-id="archived-canceled"] .kind')).toHaveText('Canceled');
  await expect(page.locator('li.row')).toHaveCount(1);
  await toggle.click();
  await expect(panel.getByRole('option', { name: 'Merged', exact: true })).toBeVisible();
  await panel.getByRole('option', { name: 'PR evidence', exact: true }).click();
  await expect(page.locator('[data-event-id="archive-1049"]')).toBeVisible();
});

test('New updates filters a grouped run by the status it shows and acknowledges only its unseen members', async t => {
  const { runtime, page } = await demo(t);
  const time = new Date(Date.now() + 1000).toISOString();
  runtime.store.insertEvents([
    {
      id: 'scope-running',
      repoId: 'demo-orders',
      kind: 'build',
      title: 'Status scope run',
      time,
      data: { buildId: 460, status: 'inProgress' },
    },
    {
      id: 'scope-succeeded',
      repoId: 'demo-orders',
      kind: 'build',
      title: 'Status scope run',
      time,
      seen: true,
      observedAt: new Date(Date.now() + 2000).toISOString(),
      data: { buildId: 460, status: 'completed', result: 'succeeded' },
    },
  ]);
  await page.goto(runtime.url + '/#activity/new');
  await expect(page.locator('[data-event-id="scope-succeeded"] .kind')).toHaveText('Succeeded');
  const toggle = page.getByRole('button', { name: /^Activity type:/ });
  await toggle.click();
  await page.getByRole('option', { name: 'Succeeded', exact: true }).click();
  await expect(page.locator('li.row')).toHaveCount(1);
  await page.getByRole('button', { name: 'Mark shown seen (1)' }).click();
  await expect(page.locator('li.row')).toHaveCount(0);
  assert.equal(runtime.store.getEvent('scope-running').seen, true);
  assert.equal(runtime.store.getEvent('demo-branch-1').seen, false);
});

test('verified PR follow-up switches, reviews and removes the old branch from Repositories', async t => {
  const { squashFixture, git } = await import('../test/fixtures/checkout.js');
  const { repo, pr, local, remote } = squashFixture(t);
  const { createCheckoutGit } = await import('../server/checkout-git.js');
  const oldBranch = 'feature/poc_while_rewriting_delphi_sql_and_testing_the_updated_checkout';
  git(local, 'branch', '-m', oldBranch);
  git(local, 'fetch', 'origin', 'release');
  git(local, 'branch', '--track', 'release', 'origin/release');
  const store = createStore();
  store.saveRepo(repo);
  store.setSetting('refreshEnabled', false);
  let clock = Date.now();
  const checkoutGit = createCheckoutGit({ matchesRemote: url => url === remote, findPulls: async () => [pr], now: () => clock });
  const app = createApp({
    accessKey: TEST_KEY,
    store,
    checkoutGit,
    provider: { checkConnection: async () => ({ available: true }) },
    sync: { status: () => ({}) },
  });
  await new Promise(resolve => app.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ executablePath: await executable(), headless: true });
  const page = await browser.newPage({ viewport: { width: 375, height: 812 }, colorScheme: 'dark' });
  await rememberKey(page);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  t.after(async () => {
    await browser.close();
    await new Promise(resolve => app.close(resolve));
    store.close();
    assert.deepEqual(errors, []);
  });
  await page.goto(`http://127.0.0.1:${app.address().port}/#repositories`);
  const row = page.getByRole('article');
  await expect(row.locator('code').first()).toHaveText(oldBranch);
  await row.locator('summary').click();
  await row.getByRole('button', { name: 'Check for updates' }).click();
  const switchButton = row.getByRole('button', { name: 'Switch to release and update' });
  await expect(switchButton).toBeVisible();
  await page.screenshot({ path: 'test-results/repo-checkout-follow-up-phone-dark.png', animations: 'disabled' });
  await page.setViewportSize({ width: 1280, height: 850 });
  await page.emulateMedia({ colorScheme: 'light' });
  const layout = await row.locator('.checkout-guidance').boundingBox();
  assert.ok(layout.width > 1000);
  await page.screenshot({ path: 'test-results/repo-checkout-follow-up-desktop-light.png', animations: 'disabled' });
  await switchButton.click();
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click();
  assert.equal(git(local, 'branch', '--show-current'), oldBranch);
  await switchButton.click();
  await page.getByRole('dialog').getByRole('button', { name: 'Switch and update' }).click();
  await row.getByRole('button', { name: 'Review old branch' }).click();
  await expect(row.getByText(/old branch matches the PR source/)).toBeVisible();
  await page.setViewportSize({ width: 375, height: 812 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.equal(git(local, 'branch', '--show-current'), 'release');
  await row.getByRole('button', { name: 'Remove old local branch…' }).click();
  const removal = page.getByRole('dialog', { name: 'Remove local branch?' });
  await expect(removal.locator('code')).toHaveText(oldBranch);
  await expect(removal).toHaveAccessibleDescription(new RegExp(oldBranch.replace('/', '\/')));
  for (const [width, colorScheme] of [
    [1280, 'dark'],
    [320, 'light'],
  ]) {
    await page.setViewportSize({ width, height: 812 });
    await page.emulateMedia({ colorScheme });
    await expect.poll(() => removal.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    await expect(removal.getByRole('button', { name: 'Cancel' })).toBeInViewport();
    await expect(removal.getByRole('button', { name: 'Remove local branch' })).toBeInViewport();
    await page.screenshot({ path: `test-results/confirm-remove-branch-${colorScheme}.png`, animations: 'disabled' });
  }
  await removal.getByRole('button', { name: 'Remove local branch' }).click();
  await expect(page.getByText(`Removed local branch ${oldBranch}.`, { exact: true })).toBeVisible();
  await expect(row.getByRole('button', { name: 'Remove old local branch…' })).toHaveCount(0);
  await expect(row.getByRole('button', { name: 'Review old branch' })).toHaveCount(0);
  assert.throws(() => git(local, 'show-ref', '--verify', `refs/heads/${oldBranch}`));
  clock += 6000;
  await page.reload();
  await expect(row.locator('code').first()).toHaveText('release');
  await expect(row.getByRole('button', { name: 'Review old branch' })).toHaveCount(0);
  await expect(row.getByRole('button', { name: 'Restore local branch' })).toHaveCount(0);
  assert.equal(git(local, 'branch', '--show-current'), 'release');
});

test('Settings shows scoped CLI access and header switches share the automatic check preference', async t => {
  const store = createStore();
  for (const id of ['orders', 'billing']) store.saveRepo({ id, name: id, project: 'QA' });
  store.saveStream({ repoId: 'orders', stream: 'pushes', initialized: true, lastSuccess: new Date(Date.now() - 3600000).toISOString() });
  const probes = [];
  let manual = 0;
  const app = createApp({
    accessKey: TEST_KEY,
    store,
    provider: {
      async checkConnection(_org, repo) {
        if (!repo) return { available: true, version: '2.93.0', extension: '1.0.2' };
        probes.push(repo.id);
        return {
          available: true,
          version: '2.93.0',
          extension: '1.0.2',
          access: {
            status: repo.id === 'billing' ? 'failed' : 'ok',
            checkedAt: new Date().toISOString(),
            ...(repo.id === 'billing' ? { code: 'FORBIDDEN', message: 'Check repository permissions.' } : {}),
          },
        };
      },
    },
    sync: {
      status: () => ({}),
      refresh() {
        manual++;
      },
    },
  });
  await new Promise(resolve => app.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ executablePath: await executable(), headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 850 } });
  await rememberKey(page);
  t.after(async () => {
    await browser.close();
    await new Promise(resolve => app.close(resolve));
    store.close();
  });
  await page.goto(`http://127.0.0.1:${app.address().port}/#settings`);
  const header = page.locator('#header');
  const settings = page.locator('#page');
  const headerToggle = header.getByRole('switch', { name: 'Automatic checks' });
  const settingsToggle = settings.getByRole('switch', { name: 'Automatic checks' });
  await expect(headerToggle).toBeChecked();
  await headerToggle.uncheck();
  await expect(settingsToggle).not.toBeChecked();
  await header.getByRole('button', { name: /^Refresh activity/ }).click();
  await expect.poll(() => manual).toBe(1);
  await page.reload();
  await expect(settingsToggle).not.toBeChecked();
  await settingsToggle.check();
  await expect(headerToggle).toBeChecked();
  await header.getByRole('link', { name: 'Repositories', exact: true }).click();
  await expect(page.getByRole('article').filter({ hasText: 'orders' }).locator('.sync-pill')).toHaveText('Syncing…');
  await expect(page.getByText('Check overdue')).toHaveCount(0);
  await header.getByRole('link', { name: 'Settings', exact: true }).click();
  assert.deepEqual(probes, []);
  await page.locator('#azure-connection-toggle').click();
  await settings.getByRole('button', { name: 'Check connection' }).click();
  await expect(settings.getByRole('status')).toContainText('Repository access verified');
  await settings.getByLabel('Repository').selectOption('billing');
  await settings.getByRole('button', { name: 'Check connection' }).click();
  await expect(settings.getByRole('status')).toHaveText('Repository access denied');
  await expect(settings.getByText('Azure CLI 2.93.0 · azure-devops 1.0.2')).toBeVisible();
  assert.deepEqual(probes, ['orders', 'billing']);
  await page.setViewportSize({ width: 375, height: 812 });
  await page.emulateMedia({ colorScheme: 'dark' });
  await header.getByLabel('Checks: automatic on', { exact: true }).click();
  await expect(headerToggle).toBeChecked();
  await headerToggle.uncheck();
  await expect(settingsToggle).not.toBeChecked();
  await header.getByRole('button', { name: /^Refresh activity/ }).click();
  await expect.poll(() => manual).toBe(2);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: 'test-results/settings-connection-phone-dark.png', animations: 'disabled' });
  for (let id = 1; id <= 10; id++) store.saveRepo({ id: `extra-${id}`, name: `Extra ${id}` });
  await page.setViewportSize({ width: 320, height: 812 });
  await page.reload();
  await expect(header.getByText('12 repos', { exact: true })).toBeVisible();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await header.getByLabel('Checks: automatic off', { exact: true }).click();
  const panel = await header.locator('.header-monitoring-menu').boundingBox();
  assert.ok(panel.x >= 0 && panel.x + panel.width <= 320);
  await page.keyboard.press('Escape');
  await expect(header.getByRole('switch', { name: 'Automatic checks' })).toHaveCount(0);
});

test('People and named filters restore a scoped Activity search after app restart', async t => {
  const { runtime, page, directory, stop } = await demo(t);
  runtime.store.insertEvents([
    {
      id: 'alice-person',
      repoId: 'demo-orders',
      kind: 'push',
      title: 'Alice result',
      actor: 'Alice Example',
      time: new Date().toISOString(),
    },
    { id: 'bob-person', repoId: 'demo-orders', kind: 'push', title: 'Bob result', actor: 'Bob Example', time: new Date().toISOString() },
    { id: 'text-only', repoId: 'demo-orders', kind: 'push', title: 'Alice Example branch', actor: 'Chris', time: new Date().toISOString() },
  ]);
  await page.goto(runtime.url + '/#activity/all');
  const people = page.getByRole('searchbox', { name: 'People' });
  await people.fill('Alice Example, Bob Example');
  await expect(page.locator('li[data-event-id="alice-person"]')).toBeVisible();
  await expect(page.locator('li[data-event-id="bob-person"]')).toBeVisible();
  await expect(page.locator('li[data-event-id="text-only"]')).toHaveCount(0);
  await page.locator('#repo-toggle').click();
  await page.locator('[data-scope-repo="demo-billing"]').uncheck();
  await page.locator('[data-scope-repo="demo-shared"]').uncheck();
  await page.locator('#repo-toggle').click();
  await page.getByRole('button', { name: 'Save filter' }).click();
  await page.getByRole('textbox', { name: 'Filter name' }).fill('My team');
  await page.getByRole('dialog').getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('combobox', { name: 'Saved filters' }).locator('option:checked')).toHaveText('My team');
  await page.getByRole('button', { name: 'Clear filters' }).click();
  await expect(page.locator('li[data-event-id="text-only"]')).toBeVisible();
  await page.getByRole('button', { name: 'Apply', exact: true }).click();
  await expect(people).toHaveValue('Alice Example, Bob Example');
  await page.getByRole('button', { name: /^Alice result/ }).click();
  await page.getByRole('link', { name: /Back to All activity/ }).click();
  await expect(people).toHaveValue('Alice Example, Bob Example');

  await stop();
  const restarted = await startApp({ demo: true, port: 0, dataDir: directory });
  try {
    assert.notEqual(restarted.url, runtime.url);
    await page.goto(restarted.launchUrl);
    await page.goto(restarted.url + '/#activity/new');
    const presets = page.getByRole('combobox', { name: 'Saved filters' });
    await presets.selectOption({ label: 'My team' });
    await page.getByRole('button', { name: 'Apply', exact: true }).click();
    await expect(page).toHaveURL(/#activity\/all$/);
    await expect(people).toHaveValue('Alice Example, Bob Example');
    await expect(page.locator('li[data-event-id="bob-person"]')).toBeVisible();
    await expect(page.locator('li[data-event-id="text-only"]')).toHaveCount(0);
    await people.fill(Array.from({ length: 13 }, (_, index) => `Person ${index}`).join(','));
    await expect(page.getByRole('region', { name: 'Repository activity' }).getByText('Activity could not load')).toBeVisible();
    await page.getByRole('button', { name: 'Rename', exact: true }).click();
    await page.getByRole('textbox', { name: 'Filter name' }).fill('Testing team');
    await page.getByRole('dialog').getByRole('button', { name: 'Save', exact: true }).click();
    await expect(presets.locator('option:checked')).toHaveText('Testing team');
    await people.fill('Alice Example');
    await page.getByRole('button', { name: 'Update from current' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Saved filter updated.' })).toBeVisible();
    await page.getByRole('button', { name: 'Apply', exact: true }).click();
    await expect(page.locator('li[data-event-id="bob-person"]')).toHaveCount(0);
    const repo = restarted.store.listRepos().find(item => item.id === 'demo-orders');
    restarted.store.saveRepo({ ...repo, disabled: true });
    const billing = restarted.store.listRepos().find(item => item.id === 'demo-billing');
    restarted.store.insertEvents([
      {
        id: 'other-repo-alice',
        repoId: billing.id,
        kind: 'push',
        title: 'Other Alice push',
        actor: 'Alice Example',
        time: new Date().toISOString(),
      },
    ]);
    await page.reload();
    await presets.selectOption({ label: 'Testing team' });
    await page.getByRole('button', { name: 'Apply', exact: true }).click();
    await expect(page.getByText(/saved repositories unavailable/)).toBeVisible();
    await expect(page.getByText('No activity matches these filters')).toBeVisible();
    await expect(page.locator('li[data-event-id="other-repo-alice"]')).toHaveCount(0);
    await page.getByRole('button', { name: 'Delete', exact: true }).click();
    await page.getByRole('button', { name: 'Delete filter', exact: true }).click();
    await expect(presets).toHaveCount(0);
  } finally {
    await restarted.close();
  }
});

test('People detail only acknowledges the updates that matched the originating row', async t => {
  const { runtime, page } = await demo(t);
  const common = { repoId: 'demo-orders', kind: 'build', time: new Date().toISOString() };
  runtime.store.insertEvents([
    { ...common, id: 'alice-build', actor: 'Alice Example', title: 'Alice run', data: { buildId: 18001, status: 'queued' } },
    { ...common, id: 'other-build', actor: 'Chris Example', title: 'Chris run', data: { buildId: 18001, status: 'completed' } },
  ]);
  await page.goto(runtime.url + '/#activity/all');
  await page.getByRole('searchbox', { name: 'People' }).fill('Alice Example');
  await page.locator('[data-event-id="alice-build"] button.feed-title').click();
  await expect(page).toHaveURL(/#event\/alice-build$/);
  await page.reload();
  const mark = page.getByRole('button', { name: 'Mark seen', exact: true });
  await expect(mark).toHaveAttribute('data-event-ids', JSON.stringify(['alice-build']));
  await mark.click();
  await expect(page.getByRole('button', { name: 'Mark unseen', exact: true })).toBeVisible();
  assert.equal(runtime.store.getEvent('alice-build').seen, true);
  assert.equal(runtime.store.getEvent('other-build').seen, false);
});
