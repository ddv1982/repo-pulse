import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { chromium, expect } from '@playwright/test';
import type { Response } from '@playwright/test';
import { startApp, createApp } from '../server.ts';
import { createStore } from '../server/store.ts';
import { TEST_KEY, rememberKey, portOf } from '../test/fixtures/access.ts';
import type { AppSync } from '../server.ts';
import type { AzureProvider } from '../server/azure-client.ts';
import { stub } from '../test/fixtures/typed.ts';
import type {
  ActivityEvent,
  ConnectionStatus,
  DemoSyncStatus,
  HistoryJob,
  Repository,
  SavedActivityFilter,
  StreamState,
} from '../src/contract.ts';

type Store = ReturnType<typeof createStore>;

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

async function demo(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'repo-pulse-history-ui-'));
  const runtime = await startApp({ demo: true, port: 0, dataDir: directory });
  const browser = await chromium.launch({ executablePath: await executable(), headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  let stopping: Promise<void> | undefined;
  const stop = () => (stopping ??= runtime.close());
  const errors: string[] = [];
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

/** Whether a stored event is marked seen; fails when the event is not stored. */
function isSeen(store: Store, id: string) {
  const event = store.getEvent(id);
  assert.ok(event, `Event ${id} is not stored.`);
  return event.seen;
}

function seedHistory(store: Store) {
  const now = Date.now();
  const records: ActivityEvent[] = Array.from({ length: 1050 }, (_, index) => ({
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
  await expect(page.getByRole('region', { name: 'Activity summary' })).toContainText('Showing 100 of 1063 items');
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
  assert.equal(isSeen(runtime.store, 'old-unseen'), false);
});

test('mark all matching clears the confirmed unread snapshot across pages and undo restores only its changes', async t => {
  const { runtime, page } = await demo(t);
  const make = (id: string, repoId = 'demo-orders', title = 'Snapshot test push'): ActivityEvent => ({
    id,
    repoId,
    kind: 'push',
    title,
    time: new Date().toISOString(),
  });
  const matching = Array.from({ length: 60 }, (_, i) => make(`snapshot-${i}`));
  runtime.store.insertEvents([...matching, make('other-repo', 'demo-billing'), make('other-search', 'demo-orders', 'Different push')]);
  await page.goto(runtime.url + '/#activity/new');
  await page.locator('#repo-toggle').click();
  await page.locator('[data-scope-repo="demo-billing"]').uncheck();
  await page.locator('[data-scope-repo="demo-shared"]').uncheck();
  await page.keyboard.press('Escape');
  await page.getByRole('searchbox', { name: 'Search activity' }).fill('Snapshot test');
  await page.getByRole('button', { name: 'Mark all matching seen (60)', exact: true }).click();
  const confirm = page.getByRole('dialog', { name: 'Mark 60 updates as seen?' });
  await expect(confirm).toContainText('10 are below the rows shown.');
  await expect(confirm).toContainText('1 repository shown');
  await expect(confirm).toContainText('Search “Snapshot test”');
  runtime.store.insertEvents([make('later-matching')]);
  runtime.store.acknowledge(['snapshot-0']);
  await confirm.getByRole('button', { name: 'Mark as seen', exact: true }).click();
  await expect(page.locator('li.row')).toHaveCount(1);
  await expect(page.locator('li[data-event-id="later-matching"]')).toBeVisible();
  await expect(page.getByText('59 updates marked seen.')).toBeVisible();
  for (const event of matching) assert.equal(isSeen(runtime.store, event.id), true);
  for (const id of ['other-repo', 'other-search', 'later-matching']) assert.equal(isSeen(runtime.store, id), false);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(page.getByText('59 updates marked unseen.')).toBeVisible();
  assert.equal(isSeen(runtime.store, 'snapshot-0'), true);
  assert.equal(isSeen(runtime.store, 'snapshot-59'), false);
});

test('mark all matching uses the rendered repository scope when another repository is enabled', async t => {
  const { runtime, page } = await demo(t);
  const shared = runtime.store.listRepos().find(repo => repo.id === 'demo-shared');
  assert.ok(shared);
  runtime.store.saveRepo({ ...shared, disabled: true });
  await page.goto(runtime.url + '/#activity/new');
  await expect(page.getByRole('button', { name: 'All 2 repositories' })).toBeVisible();
  await page.locator('details[data-group="New updates"] > summary').click();
  const ids = runtime.store.queryActivity.unseenIds({ repoIds: ['demo-orders', 'demo-billing'] });
  runtime.store.saveRepo({ ...shared, disabled: false });
  const sharedIds = runtime.store.queryActivity.unseenIds({ repoIds: ['demo-shared'] });
  assert.ok(sharedIds.length > 0);
  await page.getByRole('button', { name: `Mark all seen (${ids.length})`, exact: true }).click();
  const confirm = page.getByRole('dialog', { name: `Mark ${ids.length} updates as seen?` });
  await expect(confirm).toContainText('All 2 repositories');
  await confirm.getByRole('button', { name: 'Mark as seen', exact: true }).click();
  await expect(page.getByText(`${ids.length} updates marked seen.`)).toBeVisible();
  assert.ok(ids.every(id => isSeen(runtime.store, id)));
  assert.ok(sharedIds.every(id => !isSeen(runtime.store, id)));
});

test('detail opened from a type filter only acknowledges the matching member', async t => {
  const { runtime, page } = await demo(t);
  const ref = { name: 'refs/heads/topic', oldObjectId: 'a'.repeat(40), newObjectId: '0'.repeat(40) };
  const base = { repoId: 'demo-orders', branch: 'topic', time: new Date().toISOString() };
  runtime.store.insertEvents([
    { ...base, id: 'paired-push', kind: 'push', title: 'Cleanup push', data: { pushId: 10001, refUpdates: [ref], commits: [] } },
    { ...base, id: 'paired-deletion', kind: 'branch-deleted', title: 'Branch deleted', data: { pushId: 10001, ...ref } },
  ]);
  assert.equal(runtime.store.getEventGroup('paired-push').length, 2);
  await page.goto(runtime.url + '/#activity/new');
  await page.getByRole('button', { name: /^Activity type:/ }).click();
  await page.getByRole('option', { name: 'Push', exact: true }).click();
  await page.getByRole('button', { name: /^Cleanup push/ }).click();
  const mark = page.getByRole('button', { name: 'Mark seen', exact: true });
  await expect(mark).toHaveAttribute('data-event-ids', JSON.stringify(['paired-push']));
  await mark.click();
  await expect(page.getByText('1 update marked seen.')).toBeVisible();
  assert.equal(isSeen(runtime.store, 'paired-push'), true);
  assert.equal(isSeen(runtime.store, 'paired-deletion'), false);
});

test('undo tracks the successful seen write even if the following refresh fails', async t => {
  const { runtime, page } = await demo(t);
  const base = { repoId: 'demo-orders', kind: 'push', time: new Date().toISOString() } satisfies Partial<ActivityEvent>;
  runtime.store.insertEvents([
    { ...base, id: 'seen-earlier', title: 'Earlier push' },
    { ...base, id: 'seen-later', title: 'Later push' },
  ]);
  await page.goto(runtime.url + '/#activity/new');
  const rowAction = (id: string) => page.locator(`li[data-event-id="${id}"] [data-action="ack-item"]`);
  await rowAction('seen-earlier').click();
  await expect(page.locator('#toast')).toContainText('1 update marked seen.');
  await page.route('**/api/state', route => route.fulfill({ status: 500, json: { message: 'Synthetic refresh failure' } }));
  await rowAction('seen-later').click();
  await expect(page.getByText(/Could not refresh seen status/)).toBeVisible();
  const undo = page.getByRole('button', { name: 'Undo', exact: true });
  await expect(undo).toBeVisible();
  await page.unroute('**/api/state');
  await undo.click();
  await expect(page.locator('#toast')).toContainText('1 update marked unseen.');
  assert.equal(isSeen(runtime.store, 'seen-earlier'), true);
  assert.equal(isSeen(runtime.store, 'seen-later'), false);
});

for (const undo of [false, true]) {
  test(`a partial ${undo ? 'undo remains retryable' : 'seen write reports both write and refresh errors'}`, async t => {
    const { runtime, page } = await demo(t);
    runtime.store.acknowledge(runtime.store.listEvents().map(event => event.id));
    const events: ActivityEvent[] = Array.from({ length: 251 }, (_, index) => ({
      id: `partial-${index}`,
      repoId: 'demo-orders',
      kind: 'build',
      title: 'Batch test build',
      time: new Date(Date.now() + index).toISOString(),
      data: { buildId: 87651, status: 'inProgress' },
    }));
    runtime.store.insertEvents(events);
    await page.goto(runtime.url + '/#activity/new');
    const mark = page.getByRole('button', { name: 'Mark all seen (251)', exact: true });
    const undoButton = page.getByRole('button', { name: 'Undo', exact: true });
    if (undo) {
      await mark.click();
      await expect(page.getByText('251 updates marked seen.')).toBeVisible();
    }
    let batches = 0;
    await page.route('**/api/ack', route => {
      if (++batches === 2) return route.fulfill({ status: 500, json: { message: 'Synthetic batch failure' } });
      return route.continue();
    });
    if (!undo) await page.route('**/api/state', route => route.fulfill({ status: 500, json: { message: 'Synthetic refresh failure' } }));
    await (undo ? undoButton : mark).click();
    const notice = page.locator('#notice');
    await expect(notice).toContainText('Stopped after processing 250 of 251 updates.');
    await expect(notice).toContainText('Synthetic batch failure');
    if (!undo) {
      await expect(notice).toContainText('Synthetic refresh failure');
      await expect(page.locator('#toast')).toContainText('250 updates marked seen.');
    } else {
      await expect(page.locator('#toast')).toContainText('Retry Undo for 1 remaining update.');
    }
    await page.unroute('**/api/ack');
    await page.unroute('**/api/state');
    await undoButton.click();
    await expect(page.locator('#toast')).toContainText(undo ? '1 update marked unseen.' : '250 updates marked unseen.');
    assert.ok(events.every(event => !isSeen(runtime.store, event.id)));
  });
}

test('paged query reset follows type and repository scope without acknowledging hidden history', async t => {
  const { runtime, page } = await demo(t);
  seedHistory(runtime.store);
  await page.goto(runtime.url + '/#activity/all');
  await expect(page.locator('li.row')).toHaveCount(50);
  await page.getByRole('button', { name: 'Load more', exact: true }).click();
  await expect(page.locator('li.row')).toHaveCount(100);
  await page.getByRole('button', { name: /^Activity type:/ }).click();
  await page.getByRole('option', { name: 'Pull request', exact: true }).click();
  await expect(page.locator('li.row')).toHaveCount(2);
  await page.locator('#repo-toggle').click();
  await page.locator('[data-scope-repo="demo-billing"]').uncheck();
  await page.locator('[data-scope-repo="demo-shared"]').uncheck();
  await page.keyboard.press('Escape');
  await expect(page.locator('li.row')).toHaveCount(0);
  await expect(page.locator('.feed .empty .big')).toHaveText('No activity matches these filters');
  await expect(page.locator('.summary .headline b')).toHaveText('No activity matches these filters');
  assert.equal(isSeen(runtime.store, 'old-unseen'), false);
});

test('one long build history keeps every constituent and acknowledges explicit batches without consuming a late update', async t => {
  const { runtime, page } = await demo(t);
  runtime.store.acknowledge(runtime.store.listEvents().map(event => event.id));
  const beginning = Date.now() - 60000;
  const event = (index: number | string, time: number): ActivityEvent => ({
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
  const batches: { ids: string[] }[] = [];
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
  await page.getByRole('button', { name: 'Mark all seen (1050)', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Mark all seen (1)', exact: true })).toBeVisible();
  assert.deepEqual(
    batches.map(batch => batch.ids.length),
    [250, 250, 250, 250, 50],
  );
  assert.equal(new Set(batches.flatMap(batch => batch.ids)).size, 1050);
  assert.equal(
    batches.some(batch => batch.ids.includes('long-build-late')),
    false,
  );
  assert.equal(isSeen(runtime.store, 'long-build-0'), true);
  assert.equal(isSeen(runtime.store, 'long-build-late'), false);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Mark all seen (1051)', exact: true })).toBeVisible();
});

test('repository history import scopes the confirmed range and keeps progress visible through polls', async t => {
  const store = createStore();
  for (const [id, name] of [
    ['orders', 'Orders'],
    ['billing', 'Billing'],
  ])
    store.saveRepo(stub<Repository>({ id, name }));
  const calls: { repoId: string; days: HistoryJob['days'] | undefined }[] = [];
  let failOnce = true;
  const app = createApp({
    accessKey: TEST_KEY,
    store,
    provider: stub<AzureProvider>({ checkConnection: async () => stub<ConnectionStatus>({ available: true }) }),
    sync: stub<AppSync>({ status: () => stub<DemoSyncStatus>({}) }),
    backfill: {
      start(repoId, days) {
        calls.push({ repoId, days });
        if (failOnce) {
          failOnce = false;
          throw Object.assign(new Error('Try this date range again.'), { status: 409 });
        }
        const job = stub<HistoryJob>({ id: `backfill:${repoId}`, type: 'backfill', repoId, status: 'pending', days, pages: 0 });
        store.saveJob(job);
        return job;
      },
    },
  });
  await new Promise<void>(resolve => app.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ executablePath: await executable(), headless: true });
  const page = await browser.newPage({ viewport: { width: 375, height: 812 }, colorScheme: 'dark' });
  await rememberKey(page);
  t.after(async () => {
    await browser.close();
    await new Promise(resolve => app.close(resolve));
    store.close();
  });
  const base = `http://127.0.0.1:${portOf(app)}`;
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
  ] as const) {
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
  const metadata = (response: Response) => new URL(response.url()).pathname === '/api/state';
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
      branch: 'main',
      actor: 'Microsoft.VisualStudio.Services.TFS',
      time: new Date().toISOString(),
      data: { pushId: 18000, refUpdates: [{ name: 'refs/heads/main', oldObjectId: 'b'.repeat(40), newObjectId: result }] },
    },
  ]);
  await page.goto(runtime.url + '/#activity/all');
  const row = page.locator('li[data-event-id="revision-test"]');
  await expect(row).toHaveClass(/\bnew\b/);
  await expect(row.getByRole('button', { name: /^Pushed · .*branch main$/ })).toBeVisible();
  await expect(row.getByText('Pushed by Azure DevOps service')).toBeVisible();

  const other = await page.context().newPage();
  await other.goto(runtime.url + '/#activity/new');
  await other
    .locator('li[data-event-id="revision-test"]')
    .getByRole('button', { name: 'Seen: Azure DevOps service pushed to main' })
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
  const title = 'Merge of PR 12 pushed to main';
  await expect(row.getByText('Completed PR linked')).toBeVisible({ timeout: 8000 });
  await expect(row.getByText('Pushed by Azure DevOps service')).toBeVisible();
  // The row title leaves the branch to the ref line; the detail heading keeps the whole title.
  await row.getByRole('button', { name: /^Merge of PR 12 pushed · .*branch main$/ }).click();
  await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible();
  await expect(page.getByText('Pushed by', { exact: true })).toBeVisible();
  await expect(page.getByText(/PR closed by Alice Morgan/)).toBeVisible();
  await expect(page.getByRole('link', { name: 'PR #12' })).toBeVisible();
});

test('opening Activity before the first state load arrives stays on Activity', async t => {
  const { runtime, page } = await demo(t);
  const release = Promise.withResolvers<void>();
  const held = Promise.withResolvers<void>();
  await page.route('**/api/state', async route => {
    held.resolve();
    await release.promise;
    await route.continue();
  });
  await page.reload();
  await held.promise;
  // The page has not seen its repositories yet, so it must not judge that none are watched.
  await page.goto(runtime.url + '/#activity/new');
  release.resolve();
  await expect(page.getByRole('button', { name: /^Mark all seen/ })).toBeVisible();
  assert.match(page.url(), /#activity\/new$/);
});

test('seen feedback waits for its refresh when a background poll is in flight', async t => {
  const { runtime, page } = await demo(t);
  await page.goto(runtime.url + '/#activity/new');
  // Hold the poll only once the page shows what it will mark.
  await expect(page.getByRole('button', { name: /^Mark all seen/ })).toBeVisible();
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
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
    await page.getByRole('button', { name: /^Mark all seen/ }).click();
    await ack;
    await expect(page.getByRole('dialog')).not.toBeVisible();
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await expect(page.locator('#toast')).not.toBeVisible({ timeout: 500 });
  } finally {
    release.resolve();
  }
  await expect(page.locator('#toast')).toContainText('marked seen');
  await expect(page.locator('.feed-actions button')).toHaveCount(0);
});

test('Repositories shows the checkout, checks on demand, and pulls only after confirmation', async t => {
  const { checkoutFixture, git } = await import('../test/fixtures/checkout.ts');
  const fixture = checkoutFixture(t);
  const store = createStore();
  store.saveRepo(stub<Repository>(fixture.repo));
  store.setSetting('refreshEnabled', false);
  store.saveStream(
    stub<StreamState>({
      repoId: 'repo',
      stream: 'pushes',
      initialized: true,
      lastSuccess: new Date(Date.now() - 60 * 60_000).toISOString(),
    }),
  );
  const app = createApp({
    accessKey: TEST_KEY,
    store,
    checkoutGit: fixture.checkoutGit,
    provider: stub<AzureProvider>({ checkConnection: async () => stub<ConnectionStatus>({ available: true }) }),
    sync: stub<AppSync>({ status: () => stub<DemoSyncStatus>({}) }),
  });
  await new Promise<void>(resolve => app.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ executablePath: await executable(), headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await rememberKey(page);
  const pageErrors: string[] = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  t.after(async () => {
    await browser.close();
    await new Promise(resolve => app.close(resolve));
    store.close();
    assert.deepEqual(pageErrors, []);
  });
  const base = `http://127.0.0.1:${portOf(app)}`;
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
  assert.ok(Number.isFinite(Date.parse(firstCheckTime ?? '')));
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
  assert.ok(beforeRecheck !== null);
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
  assert.ok(lastSuccessfulTime !== null);
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
  await page.getByRole('button', { name: 'Mark all matching seen (1)', exact: true }).click();
  await expect(page.locator('li.row')).toHaveCount(0);
  assert.equal(isSeen(runtime.store, 'scope-running'), true);
  assert.equal(isSeen(runtime.store, 'demo-branch-1'), false);
});

test('verified PR follow-up switches, reviews and removes the old branch from Repositories', async t => {
  const { squashFixture, git } = await import('../test/fixtures/checkout.ts');
  const { repo, pr, local, remote } = squashFixture(t);
  const { createCheckoutGit } = await import('../server/checkout-git.ts');
  const oldBranch = 'feature/poc_while_rewriting_delphi_sql_and_testing_the_updated_checkout';
  git(local, 'branch', '-m', oldBranch);
  git(local, 'fetch', 'origin', 'release');
  git(local, 'branch', '--track', 'release', 'origin/release');
  const store = createStore();
  store.saveRepo(stub<Repository>(repo));
  store.setSetting('refreshEnabled', false);
  let clock = Date.now();
  const checkoutGit = createCheckoutGit({ matchesRemote: url => url === remote, findPulls: async () => [pr], now: () => clock });
  const app = createApp({
    accessKey: TEST_KEY,
    store,
    checkoutGit,
    provider: stub<AzureProvider>({ checkConnection: async () => stub<ConnectionStatus>({ available: true }) }),
    sync: stub<AppSync>({ status: () => stub<DemoSyncStatus>({}) }),
  });
  await new Promise<void>(resolve => app.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ executablePath: await executable(), headless: true });
  const page = await browser.newPage({ viewport: { width: 375, height: 812 }, colorScheme: 'dark' });
  await rememberKey(page);
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  t.after(async () => {
    await browser.close();
    await new Promise(resolve => app.close(resolve));
    store.close();
    assert.deepEqual(errors, []);
  });
  await page.goto(`http://127.0.0.1:${portOf(app)}/#repositories`);
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
  assert.ok(layout);
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
  ] as const) {
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
  for (const id of ['orders', 'billing']) store.saveRepo(stub<Repository>({ id, name: id, project: 'QA' }));
  store.saveStream(
    stub<StreamState>({
      repoId: 'orders',
      stream: 'pushes',
      initialized: true,
      lastSuccess: new Date(Date.now() - 3600000).toISOString(),
    }),
  );
  const probes: string[] = [];
  let manual = 0;
  const app = createApp({
    accessKey: TEST_KEY,
    store,
    provider: stub<AzureProvider>({
      // The server passes the watched repository the check is for.
      async checkConnection(_org?: string, repo?: Repository) {
        if (!repo) return stub<ConnectionStatus>({ available: true, version: '2.93.0', extension: '1.0.2' });
        probes.push(repo.id);
        return stub<ConnectionStatus>({
          available: true,
          version: '2.93.0',
          extension: '1.0.2',
          access: {
            status: repo.id === 'billing' ? 'failed' : 'ok',
            checkedAt: new Date().toISOString(),
            ...(repo.id === 'billing' ? { code: 'FORBIDDEN', message: 'Check repository permissions.' } : {}),
          },
        });
      },
    }),
    sync: stub<AppSync>({
      status: () => stub<DemoSyncStatus>({}),
      // Returns no status, which the page does not read.
      refresh: (() => {
        manual++;
      }) as AppSync['refresh'],
    }),
  });
  await new Promise<void>(resolve => app.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ executablePath: await executable(), headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 850 } });
  await rememberKey(page);
  t.after(async () => {
    await browser.close();
    await new Promise(resolve => app.close(resolve));
    store.close();
  });
  await page.goto(`http://127.0.0.1:${portOf(app)}/#settings`);
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
  for (let id = 1; id <= 10; id++) store.saveRepo(stub<Repository>({ id: `extra-${id}`, name: `Extra ${id}` }));
  await page.setViewportSize({ width: 320, height: 812 });
  await page.reload();
  await expect(header.getByText('12 repos', { exact: true })).toBeVisible();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await header.getByLabel('Checks: automatic off', { exact: true }).click();
  const panel = await header.locator('.header-monitoring-menu').boundingBox();
  assert.ok(panel);
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
    { id: 'bob-person', repoId: 'demo-orders', kind: 'push', title: 'Bob result', actor: 'Bób Example', time: new Date().toISOString() },
    {
      id: 'unrelated-search',
      repoId: 'demo-orders',
      kind: 'push',
      title: 'Unrelated change',
      actor: 'Chris',
      time: new Date().toISOString(),
    },
    { id: 'text-only', repoId: 'demo-orders', kind: 'push', title: 'Alice Example branch', actor: 'Chris', time: new Date().toISOString() },
  ]);
  await page.goto(runtime.url + '/#activity/all');
  const people = page.getByRole('searchbox', { name: 'Search activity' });
  const presets = page.locator('#saved-filter-toggle');
  const choosePreset = async (name: string) => {
    await presets.click();
    await page.getByRole('option', { name: new RegExp(`^${name} `) }).click();
  };
  const more = async (name: string) => {
    await page.getByRole('button', { name: 'More saved filter actions' }).click();
    await page.getByRole('menuitem', { name }).click();
  };
  await expect(page.getByRole('searchbox')).toHaveCount(1);
  await expect(page.locator('li[data-event-id="unrelated-search"]')).toBeVisible();
  await people.fill('Ali, Bo');
  await expect(page.locator('li[data-event-id="unrelated-search"]')).toHaveCount(0);
  await expect(page.locator('li[data-event-id="text-only"]')).toBeVisible();
  await expect(page.locator('li[data-event-id="bob-person"]')).toBeVisible();
  await people.fill('people:Ali Ex, Bo');
  await expect(page.locator('li[data-event-id="alice-person"]')).toBeVisible();
  await expect(page.locator('li[data-event-id="bob-person"]')).toBeVisible();
  await expect(page.locator('li[data-event-id="text-only"]')).toHaveCount(0);
  await page.locator('#repo-toggle').click();
  await page.locator('[data-scope-repo="demo-billing"]').uncheck();
  await page.locator('[data-scope-repo="demo-shared"]').uncheck();
  await page.locator('#repo-toggle').click();
  await page.getByRole('button', { name: 'Save filter…' }).click();
  await page.getByRole('textbox', { name: 'Filter name' }).fill('My team');
  await page.getByRole('dialog').getByRole('button', { name: 'Save', exact: true }).click();
  await expect(presets).toHaveAccessibleName('Saved filter: My team');
  await page.getByRole('button', { name: 'Clear search and type' }).click();
  await expect(page.locator('li[data-event-id="text-only"]')).toBeVisible();
  await choosePreset('My team');
  await expect(people).toHaveValue('people:Ali Ex, Bo');
  const mixedSearch = 'result | people:Ali Ex, Bo';
  await people.fill(mixedSearch);
  await page.getByRole('button', { name: /^Alice result/ }).click();
  await expect(page).toHaveURL(/#event\/alice-person$/);
  await page.reload();
  await page.getByRole('link', { name: /Back to All activity/ }).click();
  await expect(people).toHaveValue(mixedSearch);
  await expect(presets).toHaveAccessibleName('Saved filter: My team, modified');
  await expect(page.locator('li[data-event-id="alice-person"]')).toBeVisible();
  await expect(page.locator('li[data-event-id="bob-person"]')).toBeVisible();

  await stop();
  const restarted = await startApp({ demo: true, port: 0, dataDir: directory });
  try {
    assert.notEqual(restarted.url, runtime.url);
    await Promise.all([
      page.waitForResponse(response => response.url() === restarted.url + '/api/state' && response.ok()),
      page.goto(restarted.launchUrl),
    ]);
    await page.goto(restarted.url + '/#activity/new');
    await choosePreset('My team');
    await expect(page).toHaveURL(/#activity\/all$/);
    await expect(presets).toBeFocused();
    await expect(people).toHaveValue('people:Ali Ex, Bo');
    await expect(page.locator('li[data-event-id="bob-person"]')).toBeVisible();
    await expect(page.locator('li[data-event-id="text-only"]')).toHaveCount(0);
    await people.fill('people:' + Array.from({ length: 13 }, (_, index) => `Person ${index}`).join(','));
    await expect(page.getByRole('region', { name: 'Repository activity' }).getByText('Activity could not load')).toBeVisible();
    await more('Rename…');
    await page.getByRole('textbox', { name: 'Filter name' }).fill('Testing team');
    await page.getByRole('dialog').getByRole('button', { name: 'Save', exact: true }).click();
    await expect(presets).toHaveAccessibleName('Saved filter: Testing team, modified');
    await people.fill('people:Alice Example');
    await page.getByRole('button', { name: 'Update “Testing team”' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Saved filter updated.' })).toBeVisible();
    await expect(presets).toHaveAccessibleName('Saved filter: Testing team');
    await expect(page.locator('li[data-event-id="bob-person"]')).toHaveCount(0);
    const repo = restarted.store.listRepos().find(item => item.id === 'demo-orders');
    assert.ok(repo);
    restarted.store.saveRepo({ ...repo, disabled: true });
    const billing = restarted.store.listRepos().find(item => item.id === 'demo-billing');
    assert.ok(billing);
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
    await choosePreset('Testing team');
    await expect(page.getByText(/saved repositories are unavailable/)).toBeVisible();
    await expect(page.getByRole('region', { name: 'Repository activity' }).getByText('No activity matches these filters')).toBeVisible();
    await expect(page.locator('li[data-event-id="other-repo-alice"]')).toHaveCount(0);
    await more('Delete…');
    await page.getByRole('button', { name: 'Delete filter', exact: true }).click();
    await expect(presets).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Save filter…' })).toBeFocused();
    await expect(people).toHaveValue('people:Alice Example');
  } finally {
    await restarted.close();
  }
});

test('saved filters stay available on mobile, apply on keyboard selection, and save variations explicitly', async t => {
  const { runtime, page } = await demo(t);
  const filter = (view: string) => ({ search: '', people: '', kind: '', repoIds: null, view });
  const longName = 'A'.repeat(80);
  runtime.store.setSetting('savedActivityFilters', [
    { id: 'new', name: 'New changes', filters: filter('new') },
    { id: 'all', name: longName, filters: filter('all') },
  ]);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(runtime.url + '/#activity/new');
  const toggle = page.locator('#saved-filter-toggle');
  const drawer = page.locator('#activity-filters');
  const picker = page.getByRole('listbox', { name: 'Saved filters' });
  const option = picker.getByRole('option', { name: new RegExp(longName) });
  await expect(drawer).toBeHidden();
  await toggle.press('ArrowDown');
  await page.keyboard.press('End');
  await expect(option).toBeFocused();
  await expect(page).toHaveURL(/#activity\/new$/);
  await page.keyboard.press('Escape');
  await expect(toggle).toBeFocused();
  await expect(picker).toBeHidden();
  await toggle.press('ArrowDown');
  await page.setViewportSize({ width: 900, height: 844 });
  await expect(picker).toBeHidden();
  await expect(toggle).toBeFocused();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(drawer).toBeHidden();
  await toggle.press('Space');
  await page.keyboard.press('End');
  const polled = page.waitForResponse(response => response.url().endsWith('/api/state') && response.ok());
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await polled;
  await expect(option).toBeFocused();
  const popup = await picker.boundingBox();
  assert.ok(popup);
  assert.ok(popup.x >= 0 && popup.x + popup.width <= 390);
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/#activity\/all$/);
  await expect(toggle).toBeFocused();
  await expect(toggle).toHaveAccessibleName(`Saved filter: ${longName}`);
  await expect(drawer).toBeHidden();

  const search = page.getByRole('searchbox', { name: 'Search activity' });
  await page.keyboard.press('/');
  await expect(search).toBeFocused();
  await search.fill('Orders');
  await expect(toggle).toHaveAccessibleName(`Saved filter: ${longName}, modified`);
  await expect(page.getByRole('button', { name: `Update “${longName}”` })).toBeVisible();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.getByRole('button', { name: 'More saved filter actions' }).click();
  const actions = await page.getByRole('menu', { name: 'Saved filter actions' }).boundingBox();
  assert.ok(actions);
  assert.ok(actions.x >= 0 && actions.x + actions.width <= 390);
  await page.getByRole('menuitem', { name: 'Restore saved version' }).click();
  await expect(search).toHaveValue('');
  await search.fill('Orders');
  await page.getByRole('button', { name: 'More saved filter actions' }).click();
  await page.getByRole('menuitem', { name: 'Save as new…' }).click();
  await expect(page.getByRole('dialog')).toContainText('Includes All activity');
  await expect(page.getByRole('dialog')).toContainText('Search “Orders”');
  await page.getByRole('textbox', { name: 'Filter name' }).fill('Orders variation');
  await page.getByRole('dialog').getByRole('button', { name: 'Save', exact: true }).click();
  await expect(toggle).toHaveAccessibleName('Saved filter: Orders variation');
  assert.equal(
    (runtime.store.getSetting('savedActivityFilters') as SavedActivityFilter[]).find(item => item.id === 'all')?.filters.search,
    '',
  );
  await page.getByRole('button', { name: 'More saved filter actions' }).click();
  await page.getByRole('menuitem', { name: 'Stop using filter' }).click();
  await expect(toggle).toHaveAccessibleName('Saved filters');
  await expect(search).toHaveValue('Orders');
  await toggle.click();
  await picker.getByRole('option', { name: /Orders variation/ }).click();
  const existing = runtime.store.getSetting('savedActivityFilters') as SavedActivityFilter[];
  runtime.store.setSetting(
    'savedActivityFilters',
    existing.filter(item => item.name !== 'Orders variation'),
  );
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(toggle).toHaveAccessibleName('Saved filters');
  await expect(search).toHaveValue('Orders');
});

test('saving selects the new filter after an older state response arrives', async t => {
  const { runtime, page } = await demo(t);
  await page.goto(runtime.url + '/#activity/new');
  await page.getByRole('button', { name: 'Save filter…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Save Activity filter' });
  await dialog.getByRole('textbox', { name: 'Filter name' }).fill('Fresh preset');
  const captured = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  await page.route(
    '**/api/state',
    async route => {
      const response = await route.fetch();
      captured.resolve();
      await release.promise;
      await route.fulfill({ response });
    },
    { times: 1 },
  );
  try {
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await captured.promise;
    const saved = page.waitForResponse(
      response => response.request().method() === 'POST' && response.url().endsWith('/api/activity-filters'),
    );
    await dialog.getByRole('button', { name: 'Save', exact: true }).click();
    assert.ok((await saved).ok());
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    release.resolve();
    await expect(page.locator('#saved-filter-toggle')).toHaveAccessibleName('Saved filter: Fresh preset');
    await expect(page.getByRole('button', { name: 'More saved filter actions' })).toBeVisible();
  } finally {
    release.resolve();
  }
});

test('an Activity response renders while a saved-filter menu stays open, and deletes keep newer selections', async t => {
  const { runtime, page } = await demo(t);
  const filters = (search: string) => ({ search, people: '', kind: '', repoIds: null, view: 'new' });
  runtime.store.setSetting('savedActivityFilters', [
    { id: 'first', name: 'First preset', filters: filters('first') },
    { id: 'second', name: 'Second preset', filters: filters('second') },
  ]);
  await page.goto(runtime.url + '/#activity/new');
  await page.reload();
  const toggle = page.locator('#saved-filter-toggle');
  const search = page.getByRole('searchbox', { name: 'Search activity' });
  const activity = page.getByRole('region', { name: 'Repository activity' });
  await expect(toggle).toBeVisible();
  let delayed: { term: string; release: PromiseWithResolvers<void> } | undefined;
  await page.route(/\/api\/activity\?/, async route => {
    if (new URL(route.request().url()).searchParams.get('search') === delayed?.term) await delayed.release.promise;
    await route.continue();
  });
  async function respondWithMenuOpen(term: string, menu = toggle) {
    const release = Promise.withResolvers<void>();
    delayed = { term, release };
    const matches = (url: string) => new URL(url).searchParams.get('search') === term;
    try {
      const started = page.waitForRequest(request => matches(request.url()), { timeout: 5000 });
      await search.fill(term);
      await started;
      await menu.press('ArrowDown');
      const completed = page.waitForResponse(response => matches(response.url()), { timeout: 5000 });
      release.resolve();
      await completed;
      // The response renders at once; the menu stays open with focus inside it.
      await expect(emptyFeed).toBeVisible();
      await expect(menu).toHaveAttribute('aria-expanded', 'true');
      await expect(page.locator(`#${await menu.getAttribute('aria-controls')}`)).toBeVisible();
      assert.equal(await menu.evaluate(element => element.closest('.menu')?.contains(document.activeElement)), true);
    } finally {
      release.resolve();
      delayed = undefined;
    }
  }
  const save = page.getByRole('button', { name: 'Save filter…' });
  const options = page.getByRole('listbox', { name: 'Saved filters' });
  const emptyFeed = activity.getByText('No unread updates match these filters');
  await respondWithMenuOpen('missing keyboard term');
  await page.keyboard.press('Tab');
  await expect(save).toBeFocused();
  await expect(emptyFeed).toBeVisible();

  await respondWithMenuOpen('missing repository term');
  const scope = page.locator('#repo-toggle');
  await scope.click();
  await expect(emptyFeed).toBeVisible();
  await expect(scope).toHaveAttribute('aria-expanded', 'true');
  await scope.click();

  await respondWithMenuOpen('missing held click term');
  const bounds = await save.boundingBox();
  assert.ok(bounds);
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  await page.mouse.down();
  try {
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await expect(options).toBeVisible();
  } finally {
    await page.mouse.up();
  }
  const saveDialog = page.getByRole('dialog', { name: 'Save Activity filter' });
  await expect(saveDialog).toBeVisible();
  await expect(emptyFeed).toBeVisible();
  await saveDialog.getByRole('button', { name: 'Cancel' }).click();

  await toggle.click();
  await page.getByRole('option', { name: /First preset/ }).click();
  const more = page.getByRole('button', { name: 'More saved filter actions' });
  const deleteDialog = page.getByRole('dialog', { name: 'Delete saved filter?' });
  for (const method of ['Cancel', 'Escape']) {
    await respondWithMenuOpen(`missing ${method} term`, more);
    await page.keyboard.press('End');
    await page.keyboard.press('Enter');
    await expect(deleteDialog).toBeVisible();
    await expect(emptyFeed).toBeVisible();
    if (method === 'Escape') await page.keyboard.press('Escape');
    else await deleteDialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(more).toBeFocused();
  }
  const finishDelete = Promise.withResolvers<void>();
  await page.route('**/api/activity-filters/first', async route => {
    await finishDelete.promise;
    await route.continue();
  });
  try {
    await page.getByRole('button', { name: 'More saved filter actions' }).click();
    await page.getByRole('menuitem', { name: 'Delete…' }).click();
    const deleting = page.waitForRequest(request => request.method() === 'DELETE', { timeout: 5000 });
    await page.getByRole('button', { name: 'Delete filter', exact: true }).click();
    await deleting;
    await toggle.click();
    await page.getByRole('option', { name: /Second preset/ }).click();
    finishDelete.resolve();
    await expect(page.getByRole('status').filter({ hasText: 'Saved filter deleted.' })).toBeVisible();
    await expect(toggle).toHaveAccessibleName('Saved filter: Second preset');
    await expect(search).toHaveValue('second');
  } finally {
    finishDelete.resolve();
  }
});

test('People detail only acknowledges the updates that matched the originating row', async t => {
  const { runtime, page } = await demo(t);
  const common = { repoId: 'demo-orders', kind: 'build', time: new Date().toISOString() } satisfies Partial<ActivityEvent>;
  runtime.store.insertEvents([
    { ...common, id: 'alice-build', actor: 'Alice Example', title: 'Alice run', data: { buildId: 18001, status: 'queued' } },
    { ...common, id: 'other-build', actor: 'Chris Example', title: 'Chris run', data: { buildId: 18001, status: 'completed' } },
  ]);
  await page.goto(runtime.url + '/#activity/all');
  await page.getByRole('searchbox', { name: 'Search activity' }).fill('people:Alice Example');
  await page.locator('[data-event-id="alice-build"] button.feed-title').click();
  await expect(page).toHaveURL(/#event\/alice-build$/);
  await page.reload();
  const mark = page.getByRole('button', { name: 'Mark seen', exact: true });
  await expect(mark).toHaveAttribute('data-event-ids', JSON.stringify(['alice-build']));
  await mark.click();
  await expect(page.getByRole('button', { name: 'Mark unseen', exact: true })).toBeVisible();
  assert.equal(isSeen(runtime.store, 'alice-build'), true);
  assert.equal(isSeen(runtime.store, 'other-build'), false);
});

test('a New updates backlog beyond the shown rows is confirmed with its count below and then reads zero', async t => {
  const { runtime, page } = await demo(t);
  runtime.store.acknowledge(runtime.store.listEvents().map(event => event.id));
  runtime.store.insertEvents(
    Array.from({ length: 150 }, (_, index) => ({
      id: `backlog-${index}`,
      repoId: 'demo-orders',
      kind: 'push',
      title: `Backlog push ${index}`,
      branch: `feature/backlog-${index}`,
      time: new Date(Date.now() - index * 60000).toISOString(),
    })),
  );
  await page.goto(runtime.url + '/#activity/new');
  const summary = page.getByRole('region', { name: 'Activity summary' });
  await expect(summary.locator('.headline b')).toHaveText('150 new items');
  await expect(page.locator('[data-summary-kind="Pushes"] .val')).toHaveText('150');
  await page.getByRole('button', { name: 'Mark all seen (150)', exact: true }).click();
  const confirm = page.getByRole('dialog', { name: 'Mark 150 updates as seen?' });
  await expect(confirm).toContainText('100 are below the rows shown.');
  await confirm.getByRole('button', { name: 'Mark as seen', exact: true }).click();
  await expect(page.getByText('150 updates marked seen.')).toBeVisible();
  await expect(summary.locator('.headline b')).toHaveText('No new updates');
  await expect(page.locator('[data-summary-kind="Pushes"] .val')).toHaveText('0');
});

test('after the newest rows are marked seen, one catch-up action clears the older backlog and stops at what the page showed', async t => {
  const { runtime, page } = await demo(t);
  runtime.store.acknowledge(runtime.store.listEvents().map(event => event.id));
  const now = Date.now();
  const push = (id: string, minutesAgo: number): ActivityEvent => ({
    id,
    repoId: 'demo-orders',
    kind: 'push',
    title: id,
    branch: `feature/${id}`,
    time: new Date(now - minutesAgo * 60000).toISOString(),
  });
  const newer = Array.from({ length: 53 }, (_, i) => push(`newer-${i}`, i));
  const older = Array.from({ length: 235 }, (_, i) => push(`older-${i}`, 60 + i));
  runtime.store.insertEvents([...newer, ...older]);
  runtime.store.acknowledge(newer.map(event => event.id));
  // Freeze the 5 second poll so the page keeps the snapshot it was read at.
  await page.clock.install();
  await page.goto(runtime.url + '/#activity/all');
  const headline = page.getByRole('region', { name: 'Activity summary' }).locator('.headline b');
  const catchUp = page.getByRole('button', { name: 'Mark all seen (235)', exact: true });
  await expect(headline).toHaveText('235 new items');
  await expect(catchUp).toBeVisible();
  await expect(page.getByRole('button', { name: /^Mark shown seen/ })).toHaveCount(0);
  await page.getByRole('button', { name: 'Load more', exact: true }).click();
  await expect(page.locator('li[data-event-id]')).toHaveCount(100);
  await expect(headline).toHaveText('235 new items');
  await expect(catchUp).toBeVisible();
  // Recorded after the page loaded, with a source time older than every row.
  runtime.store.insertEvents([push('late', 600)]);
  await catchUp.click();
  const confirm = page.getByRole('dialog', { name: 'Mark 235 updates as seen?' });
  const below = 235 - (await page.locator('li[data-event-id^="older-"]').count());
  assert.ok(below > 0 && below < 235);
  await expect(confirm).toContainText(`${below} are below the rows shown. Updates recorded after this page loaded stay unread.`);
  await confirm.getByRole('button', { name: 'Mark as seen', exact: true }).click();
  await expect(page.getByText('235 updates marked seen.')).toBeVisible();
  await expect(headline).toHaveText('1 new item');
  assert.ok(older.every(event => isSeen(runtime.store, event.id)));
  assert.equal(isSeen(runtime.store, 'late'), false);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(page.getByText('235 updates marked unseen.')).toBeVisible();
  await expect(headline).toHaveText('236 new items');
});

test('New updates offers one bulk action that clears a fully shown list without a dialog', async t => {
  const { runtime, page } = await demo(t);
  const total = runtime.store.queryActivity({ view: 'new' }).newUpdates;
  assert.ok(total > 0 && total < 50);
  runtime.store.setSetting('savedActivityFilters', [
    { id: 'pushes', name: 'Pushes', filters: { view: 'new', search: '', kind: 'push', repoIds: null, people: '' } },
  ]);
  await page.goto(runtime.url + '/#activity/new');
  const bar = page.locator('.feed-actions button');
  await expect(bar).toHaveCount(1);
  await expect(bar).toHaveText(`Mark all seen (${total})`);
  // The saved-filter picker defers redraws while open; the write's refresh must still land.
  const release = Promise.withResolvers<void>();
  await page.route(
    '**/api/ack',
    async route => {
      const response = await route.fetch();
      await release.promise;
      await route.fulfill({ response });
    },
    { times: 1 },
  );
  await bar.click();
  await page.getByRole('button', { name: 'Saved filters', exact: true }).click();
  await expect(page.getByRole('listbox', { name: 'Saved filters' })).toBeVisible();
  release.resolve();
  await expect(page.getByText(`${total} updates marked seen.`)).toBeVisible();
  await expect(page.getByRole('dialog')).not.toBeVisible();
  await expect(page.locator('li[data-event-id]')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('region', { name: 'Activity summary' }).locator('.headline b')).toHaveText('No new updates');
  // With nothing to mark there is no empty action bar.
  await expect(page.locator('.feed-actions')).toHaveCount(0);
  assert.equal(runtime.store.queryActivity({ view: 'new' }).newUpdates, 0);
});
