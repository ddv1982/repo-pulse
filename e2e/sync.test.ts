import test from 'node:test';
import assert from 'node:assert/strict';
import { capture, defer, listen, openPage } from './fixtures/app.ts';
import { expect } from '@playwright/test';
import { createApp } from '../server/runtime.ts';
import { TEST_KEY } from '../test/fixtures/access.ts';
import { createStore } from '../server/store.ts';
import { createSync } from '../server/sync.ts';
import { createBackfill } from '../server/backfill.ts';
import type { AzureProvider } from '../server/azure-client.ts';
import type { ConnectionStatus, Repository, SyncStatus, HistoryJob } from '../src/contract.ts';
import { present, stub } from '../test/fixtures/typed.ts';
import { setup, renderInBackground } from './fixtures/ui-app.ts';
import type { AppSync } from '../server/routes/context.ts';
import { historyJob } from '../test/fixtures/jobs.ts';
import { conflict } from '../server/errors.ts';
import { idleSyncStatus } from '../server/demo.ts';

declare global {
  interface Window {
    /** The sync live region's text node, kept between page.evaluate calls to check that a render reused it. */
    syncText?: ChildNode | null;
  }
}

test('the sync status pill reads Synced in the demo and follows a Problem or Delayed server status', async t => {
  const { page } = await setup(t);
  const pill = page.locator('#header .header-tools > .sync-pill');
  await expect(pill).toHaveText(/^Synced · \d{1,2}[:.]\d{2}/);
  await expect(page.locator('#page .banner')).toHaveCount(0);
  await page.getByRole('link', { name: 'Repositories', exact: true }).click();
  await expect(page.locator('.repo-entry .sync-pill')).toHaveText([/^Synced · /, /^Synced · /, /^Synced · /]);
  const cases: [SyncStatus, string, string][] = [
    [{ state: 'problem', reason: 'Sign in to Azure again.', stream: 'refs' }, 'Problem', 'crit'],
    [{ state: 'delayed', reason: 'about 9 minutes behind', stream: 'pushes' }, 'Delayed · about 9 minutes behind', 'warn'],
  ];
  // One handler for the whole test: replacing it while a poll is in flight would answer that request twice.
  let status = present(cases[0])[0];
  await page.route('**/api/state', async route => {
    const state = await (await route.fetch()).json();
    const repos = { ...state.syncStatus.repos, 'demo-orders': status };
    await route.fulfill({ json: { ...state, demo: false, syncStatus: { overall: { ...status, repoId: 'demo-orders' }, repos } } });
  });
  for (const [current, text, tone] of cases) {
    status = current;
    await page.goto(`${page.url().split('#')[0]}#activity/unread`);
    await expect(pill).toHaveText(text);
    await expect(pill).toHaveClass(new RegExp(`\\b${tone}\\b`));
    await expect(page.locator('#page .banner')).toHaveCount(1);
    await expect(page.locator('#page .banner strong')).toHaveText(present(text.split(' · ')[0]));
    await page.getByRole('link', { name: 'Repositories', exact: true }).click();
    await expect(page.locator('.repo-entry', { hasText: 'orders-api' }).locator('.sync-pill')).toHaveText(text);
  }
  await expect(pill).toHaveAccessibleName('Sync status: Delayed in orders-api: about 9 minutes behind');
  status = present(cases[0])[0];
  await page.reload();
  await expect(pill).toHaveAccessibleName('Sync status: Problem in orders-api: Sign in to Azure again.');
  await expect(pill).toHaveAttribute('title', 'Problem in orders-api: Sign in to Azure again.');
  await page.getByRole('link', { name: 'Settings', exact: true }).click();
  await page.locator('#troubleshooting-toggle').click();
  await expect(page.locator('.sync-sentence')).toHaveText('Problem in orders-api: Sign in to Azure again.');
  await expect(page.getByText('Azure calls')).toHaveCount(0);
});

test('Activity shows a sign-in failure on return and retries the blocked live streams and history after sign-in', async t => {
  const store = createStore();
  defer(t, () => store.close());
  const repo = stub<Repository>({ id: 'auth-repo', name: 'Orders' });
  store.saveRepo(repo);
  const at = Date.now();
  const iso = (ms: number) => new Date(ms).toISOString();
  const future = iso(at + 30 * 60000);
  const error = { code: 'AUTH_REQUIRED', message: 'Simulated sign-in failure' };
  let signedIn = false;
  const reads: string[] = [];
  const provider = stub<AzureProvider>({
    async read(_repo, stream) {
      reads.push(stream);
      if (!signedIn) throw Object.assign(new Error(error.message), { code: error.code });
      return { items: [], nextCursor: null };
    },
  });
  let backfill: ReturnType<typeof createBackfill>;
  const sync = createSync({ store, provider, now: () => at, background: { history: () => backfill.tick() } });
  backfill = createBackfill({ store, provider, normalize: sync.normalize, now: () => at });
  sync.refresh();
  for (const state of store.getStreams()) {
    store.saveStream({
      ...state,
      initialized: true,
      lastAttempt: iso(at - 46000),
      lastSuccess: iso(at - 46000),
      nextAt: future,
    });
  }
  let returning = true;
  const app = createApp({
    store,
    sync,
    provider,
    backfill,
    accessKey: TEST_KEY,
    onStateRead() {
      if (returning) sync.checkOnForeground();
      returning = false;
    },
  });
  const url = await listen(t, app);
  const page = await openPage(t, { viewport: { width: 390, height: 844 }, key: TEST_KEY });
  const initial = page.waitForResponse('**/api/state');
  await page.goto(`${url}/#activity`);
  await initial;
  await expect(page.getByRole('link', { name: 'Repo Pulse' })).toBeVisible();
  await sync.tick();
  assert.deepEqual(reads, ['pushes']);
  assert.equal(store.getStreams().find(state => state.stream === 'pushes')?.error?.code, 'AUTH_REQUIRED');
  await renderInBackground(page);
  const retry = page.getByRole('button', { name: 'Retry after signing in' });
  await expect(retry).toBeVisible();
  const banner = page.locator('#page .banner.crit');
  await page.setViewportSize({ width: 320, height: 844 });
  await expect(banner.locator('strong')).toHaveText('Azure sign-in required');
  await expect(banner).toContainText('to reconnect Orders.');
  await expect(banner.locator('code')).toHaveText('az login');
  const copy = banner.getByRole('button', { name: 'Copy az login' });
  await expect(copy.locator('svg')).toBeVisible();
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await copy.focus();
  await copy.press('Enter');
  await expect(page.locator('#toast')).toHaveText('Command copied.');
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), 'az login');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.evaluate(() => {
    Object.defineProperty(navigator.clipboard, 'writeText', { value: () => Promise.reject(new Error('Copy blocked')) });
  });
  await copy.click();
  await expect(page.locator('#toast')).toContainText('Select the command to copy it manually.');

  const builds = present(store.getStreams().find(state => state.stream === 'builds'));
  store.saveStream({ ...builds, error });
  const job = backfill.start(repo.id);
  store.saveJob({ ...job, status: 'retrying', error, nextAt: future });
  signedIn = true;
  const response = page.waitForResponse('**/api/refresh');
  await retry.click();
  assert.deepEqual((await response).request().postDataJSON(), { retrySignIn: true });
  for (let turn = 0; turn < 3; turn++) await sync.tick();
  assert.deepEqual(reads, ['pushes', 'builds', 'pushes', 'pushes']);
  assert.equal(store.listJobs({ type: 'backfill' })[0]?.error, null);
  assert.ok(store.getStreams().every(state => !state.error));
  assert.equal(store.getStreams().find(state => state.stream === 'refs')?.nextAt, future);
  await page.reload();
  await expect(retry).toHaveCount(0);
  await expect(banner).toHaveCount(0);
});

test('one persistent live region outside the header announces only changed sync sentences; pills are plain text', async t => {
  const { page } = await setup(t);
  let status: SyncStatus = { state: 'problem', reason: 'Sign in to Azure again.', stream: 'refs' };
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
  // A header render rewrites the pill from markup, which drops an attribute the markup never has.
  const refreshed = async () => {
    await page.evaluate(() => {
      const pill = document.querySelector('#header .sync-pill');
      if (!pill) throw new Error('The header has no sync pill.');
      pill.setAttribute('data-before-refresh', '');
    });
    await page.locator('#header-refresh-desktop').click();
    await expect(page.locator('#header [data-before-refresh]')).toHaveCount(0);
  };
  await page.evaluate(() => {
    const live = document.getElementById('sync-live');
    if (!live) throw new Error('#sync-live is missing.');
    window.syncText = live.firstChild;
  });
  await refreshed();
  assert.equal(
    await page.evaluate(() => {
      const live = document.getElementById('sync-live');
      if (!live) throw new Error('#sync-live is missing.');
      return live.firstChild === window.syncText;
    }),
    true,
    'same text node',
  );
  status = { state: 'delayed', reason: 'about 9 minutes behind', stream: 'pushes' };
  await refreshed();
  await expect(live).toHaveText('Delayed in orders-api');
  await page.evaluate(() => {
    const live = document.getElementById('sync-live');
    if (!live) throw new Error('#sync-live is missing.');
    window.syncText = live.firstChild;
  });
  status = { state: 'delayed', reason: 'about 10 minutes behind', stream: 'pushes' };
  await refreshed();
  assert.equal(
    await page.evaluate(() => {
      const live = document.getElementById('sync-live');
      if (!live) throw new Error('#sync-live is missing.');
      return live.firstChild === window.syncText;
    }),
    true,
    'a new minute count is not announced again',
  );
  await expect(page.locator('.sync-pill[role], .sync-pill[aria-live]')).toHaveCount(0);
  await page.getByRole('link', { name: 'Repositories', exact: true }).click();
  await expect(page.locator('.repo-entry .sync-pill')).toHaveCount(3);
  await expect(page.locator('.sync-pill[role], .sync-pill[aria-live]')).toHaveCount(0);
});

test('Start from scratch in Settings confirms, empties the feed and shows Syncing until the import is back', async t => {
  const store = createStore();
  defer(t, () => store.close());
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
    waiting: [] as (() => void)[],
    release() {
      gate.waiting.splice(0).forEach(resolve => resolve());
    },
  };
  const provider = stub<AzureProvider>({
    async checkConnection() {
      return stub<ConnectionStatus>({
        available: true,
        signedIn: true,
        account: { name: 'someone@example.test' },
        message: 'Signed in.',
      });
    },
    async read(_repo, stream) {
      if (gate.closed) {
        gate.held++;
        await new Promise<void>(resolve => gate.waiting.push(resolve));
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
  });
  const sync = createSync({ store, provider, pollMs: 20 });
  defer(t, () => sync.stop());
  const server = createApp({ store, provider, sync, accessKey: TEST_KEY });
  const url = await listen(t, server);
  defer(t, () => {
    gate.closed = false;
    gate.release();
  });
  sync.start();
  sync.refresh();
  for (let i = 0; i < 200 && !store.listEvents().length; i++) await new Promise(resolve => setTimeout(resolve, 10));
  const page = await openPage(t, { key: TEST_KEY });
  await page.goto(`${url}/#activity`);
  await expect(page.locator('[data-event-id="one:push:1"]')).toHaveCount(1);

  await page.getByRole('link', { name: 'Settings', exact: true }).click();
  const row = page.locator('.settings-row', { hasText: 'Start from scratch' });
  await expect(row).toContainText('Deletes stored activity and imports the last seven days again. Your repositories and settings stay.');
  await capture(row, 'settings-start-from-scratch.png');
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
  await capture(page, 'settings-start-from-scratch-dialog.png');
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

test('first sync shows imported activity while other checks continue and preserves the open state', async t => {
  const store = createStore();
  defer(t, () => store.close());
  const repo = stub<Repository>({ id: 'first-repo', azureId: 'first-repo', name: 'First repo', defaultBranch: 'refs/heads/main' });
  store.saveRepo(repo);
  const now = Date.now();
  const provider = stub<AzureProvider>({
    async read(_repo, stream) {
      return {
        items:
          stream === 'pushes'
            ? [
                {
                  pushId: 1,
                  date: new Date(now - 60000).toISOString(),
                  pushedBy: { displayName: 'Example Author' },
                  refUpdates: [{ name: 'refs/heads/main', oldObjectId: 'a'.repeat(40), newObjectId: 'b'.repeat(40) }],
                },
              ]
            : [],
        nextCursor: null,
      };
    },
  });
  const sync = createSync({ store, provider });
  sync.refresh();
  const app = createApp({ accessKey: TEST_KEY, store, provider, sync });
  const url = await listen(t, app);
  const page = await openPage(t, { colorScheme: 'light', key: TEST_KEY });
  await page.goto(`${url}/#activity`);
  const status = page.locator('#header .header-tools > .sync-pill');
  await expect(status).toHaveText('First sync · 0 of 6');
  await expect(page.locator('#sync-live')).toHaveText('First sync in First repo');
  await expect(page.getByText('Reading recent activity…')).toBeVisible();
  const started = performance.now();
  await sync.tick();
  const imported = page.locator('details[data-group="Imported history"]');
  const row = imported.locator('li[data-event-id="first-repo:push:1"]');
  await expect(row).toBeVisible({ timeout: 8000 });
  t.diagnostic(`First imported row visible after ${Math.round(performance.now() - started)} ms with a synthetic provider`);
  await expect(page.getByText('Recent activity available')).toBeVisible();
  await expect(status).toHaveText('First sync · 1 of 6');
  await expect(page.locator('#sync-live')).toHaveText('First sync in First repo');
  await capture(page, 'first-sync-activity-light.png');
  await page.setViewportSize({ width: 375, height: 812 });
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(row).toBeVisible();
  await expect(page.getByRole('region', { name: 'Activity summary' }).getByText('1 of 6 checks complete')).toBeVisible();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await capture(page, 'first-sync-activity-phone-dark.png');

  await imported.locator('summary').click();
  await expect(row).toBeHidden();
  await page.reload();
  await expect(row).toHaveCount(1);
  await expect(row).toBeHidden();
  await page.setViewportSize({ width: 1280, height: 900 });
  const search = page.getByRole('searchbox', { name: 'Search activity' });
  await search.fill('never matches');
  await expect(page.getByRole('region', { name: 'Repository activity' }).getByText('No activity matches these filters')).toBeVisible();
  await search.clear();
  await expect(row).toHaveCount(1);
  await expect(row).toBeHidden();
  for (let i = 0; i < 5; i++) await sync.tick();
  await expect(status).toHaveText(/^Synced/, { timeout: 8000 });
  await expect(row).toBeHidden();
  assert.equal(store.getEvent('first-repo:push:1')?.seen, true);
});

test('repository history import keeps the accepted request visible even if its follow-up fails', async t => {
  const store = createStore();
  for (const [id, name] of [
    ['orders', 'Orders'],
    ['billing', 'Billing'],
  ] satisfies [string, string][])
    store.saveRepo(stub<Repository>({ id, name }));
  defer(t, () => store.close());
  const calls: { repoId: string; days: HistoryJob['days'] | undefined }[] = [];
  let failOnce = true;
  const app = createApp({
    accessKey: TEST_KEY,
    store,
    provider: stub<AzureProvider>({ checkConnection: async () => stub<ConnectionStatus>({ available: true }) }),
    sync: stub<AppSync>({ status: () => idleSyncStatus() }),
    backfill: {
      start(repoId, days) {
        calls.push({ repoId, days });
        if (failOnce) {
          failOnce = false;
          throw conflict('Try this date range again.');
        }
        const job = historyJob(repoId, { days: days ?? 30 });
        store.saveJob(job);
        return job;
      },
    },
  });
  const base = await listen(t, app);
  const page = await openPage(t, { viewport: { width: 375, height: 812 }, colorScheme: 'dark', key: TEST_KEY });
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
  await capture(page, 'repo-history-import-dark.png');
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
  const job = present(store.listJobs({ type: 'backfill' })[0]);
  store.saveJob({ ...job, status: 'retrying', pages: 2, error: { code: 'FORBIDDEN', message: 'Read denied' } });
  await expect(orders.getByText('History sync retrying', { exact: true })).toBeVisible({ timeout: 8000 });
  await expect(orders.getByText('Read denied', { exact: true })).toBeVisible();
  store.saveJob({ ...job, status: 'completed', pages: 3 });
  await expect(orders.getByText('History sync finished', { exact: true })).toBeVisible({ timeout: 8000 });
  await expect(trigger).toBeEnabled();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await billing.getByRole('button', { name: 'Sync older activity…' }).click();
  await dialog.getByRole('radio', { name: 'All available since 2010' }).check();
  const pageErrors: string[] = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.evaluate(() => {
    // The wrapper forwards its original receiver for all other focus calls.
    // oxlint-disable-next-line typescript/unbound-method
    const focus = HTMLElement.prototype.focus;
    HTMLElement.prototype.focus = function (options) {
      if (this.id === 'history-billing') throw new Error('Synthetic history focus failure');
      focus.call(this, options);
    };
  });
  await dialog.getByRole('button', { name: 'Start sync' }).click();
  await expect(dialog).not.toBeVisible();
  await expect(billing.getByText('History sync queued', { exact: true })).toBeVisible();
  assert.deepEqual(calls.at(-1), { repoId: 'billing', days: 'all' });
  await expect(page.locator('#notice [role="alert"]')).toContainText('Synthetic history focus failure');
  await expect(page.locator('#toast')).toContainText('Older activity sync requested.');
  assert.deepEqual(pageErrors, []);
});
