import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { browserPath } from './fixtures/browser.ts';
import { mkdtemp, mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, expect } from '@playwright/test';
import type { Browser, Page } from '@playwright/test';
import { startApp, createApp } from '../server.ts';
import { TEST_KEY, fetchWithKey, rememberKey, rememberRuntime, portOf } from '../test/fixtures/access.ts';
import { checkoutFixture, git } from '../test/fixtures/checkout.ts';

const fetch = fetchWithKey;
import { createStore } from '../server/store.ts';
import { createSync } from '../server/sync.ts';
import { createBackfill } from '../server/backfill.ts';
import { createAzureCli } from '../server/azure-cli.ts';
import { createAzureClient } from '../server/azure-client.ts';
import type { AppSync } from '../server.ts';
import type { AzureProvider, RepositoryInput, ResolvedRepository } from '../server/azure-client.ts';
import type { ActivityKind } from '../src/activity.ts';
import type { ActivityEvent, ConnectionStatus, EventData, Repository, SyncEngineStatus, SyncStatus } from '../src/contract.d.ts';
import { present, stub } from '../test/fixtures/typed.ts';

type Runtime = Awaited<ReturnType<typeof startApp>>;
/** An element a test tags in the page, to tell afterwards whether a render kept the same node. */
type Marked = HTMLElement & { marker?: string };

declare global {
  interface Window {
    /** The sync live region's text node, kept between page.evaluate calls to check that a render reused it. */
    syncText?: ChildNode | null;
  }
}

async function selectActivityType(page: Page, label: string) {
  await page.getByRole('button', { name: /^Activity type:/ }).click();
  await page.getByRole('option', { name: label, exact: true }).click();
}

async function setup(t: TestContext, demo = true, { highlights = false, ...options }: { hasTouch?: boolean; highlights?: boolean } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'repo-pulse-ui-'));
  let runtime: Runtime = rememberRuntime(await startApp({ demo, highlights, port: 0, dataDir: directory }));
  const browser = await chromium.launch({ executablePath: await browserPath(), headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, colorScheme: 'light', ...options });
  const errors: string[] = [];
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
      runtime = rememberRuntime(await startApp({ demo, highlights, port: 0, dataDir: directory }));
      // A new port is a new origin, so the browser needs the launch link again.
      await page.goto(runtime.launchUrl);
    },
  };
}

test('the row Seen toggle keeps keyboard focus and shows state without a status column', async t => {
  const { page, runtime } = await setup(t);
  await page.goto(`${page.url().split('#')[0]}#activity/unread`);
  const rows = page.locator('li[data-event-id]');
  await expect(rows.nth(1)).toBeVisible();
  const [first, second] = await rows.evaluateAll(elements => elements.slice(0, 2).map(element => element.getAttribute('data-event-id')));
  await expect(page.locator('.counts')).toHaveCount(0);
  const toggle = page.locator(`li[data-event-id="${first}"] .seen-toggle`);
  await expect(toggle).toHaveText('Seen');
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator(`li[data-event-id="${first}"]`)).toHaveClass(/\bnew\b/);
  await toggle.focus();
  await page.keyboard.press('Enter');
  await expect(page.locator(`li[data-event-id="${first}"]`)).toHaveCount(0);
  // The row left the unread results, so focus moves to the next row's toggle rather than the page body.
  await expect(page.locator(`li[data-event-id="${second}"] .seen-toggle`)).toBeFocused();

  await page.goto(`${page.url().split('#')[0]}#activity`);
  const seen = page.locator(`li[data-event-id="${first}"] .seen-toggle`);
  await expect(seen).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator(`li[data-event-id="${first}"]`)).not.toHaveClass(/\bnew\b/);
  await seen.focus();
  await page.keyboard.press('Enter');
  await expect(seen).toHaveAttribute('aria-pressed', 'false');
  await expect(seen).toBeFocused();

  // A draft PR gets the unread marker and loses it once seen.
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
  await expect(draft).toHaveCSS('box-shadow', /inset/);
  await expect(draft).toHaveCSS('background-image', 'none');
  await draft.locator('.seen-toggle').click();
  await expect(draft.locator('.seen-toggle')).toHaveAttribute('aria-pressed', 'true');
  await expect(draft).toHaveCSS('box-shadow', 'none');
});

test('approved light/dark/System UI and responsive routes work without remote traffic', async t => {
  const { page } = await setup(t);
  await expect(page.getByText('Demo mode · fictional repositories and people')).toBeVisible();
  await expect(page.locator('[data-event-id="demo-branch-1"]')).toContainText('hotfix/2026.11-dose-rounding');
  const remoteReads: string[] = [];
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
    for (const route of ['activity/unread', 'activity', 'repositories', 'settings']) {
      await page.goto(`${page.url().split('#')[0]}#${route}`);
      await expect(page.locator('main h1')).toHaveCount(1);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${route} overflow at ${width}`);
    }
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${page.url().split('#')[0]}#activity/unread`);
  await page.screenshot({ path: 'test-results/app-phone-dark.png', fullPage: true });
  await page.getByRole('button', { name: 'Light', exact: true }).click();
  await page.screenshot({ path: 'test-results/app-phone-light.png', fullPage: true });
});

test('Ember Orbs keeps glass on the chrome and leaves the Activity feed opaque', async t => {
  const { page } = await setup(t);
  await page.getByRole('button', { name: 'Save filter…' }).click();
  const save = page.getByRole('dialog').getByRole('button', { name: 'Save', exact: true });
  await save.hover();
  const primaryHover = await save.evaluate(async element => {
    await Promise.all(element.getAnimations().map(animation => animation.finished));
    const { backgroundColor, color } = getComputedStyle(element);
    const context = document.createElement('canvas').getContext('2d');
    if (!context) throw new Error('2D canvas is unavailable');
    const luminance = (value: string) => {
      context.fillStyle = value;
      context.fillRect(0, 0, 1, 1);
      const [red = 0, green = 0, blue = 0] = context.getImageData(0, 0, 1, 1).data;
      const linear = (channel: number) => (channel <= 10 ? channel / 3294.6 : ((channel / 255 + 0.055) / 1.055) ** 2.4);
      return 0.2126 * linear(red) + 0.7152 * linear(green) + 0.0722 * linear(blue);
    };
    const levels = [luminance(backgroundColor), luminance(color)];
    return (Math.max(...levels) + 0.05) / (Math.min(...levels) + 0.05);
  });
  assert.ok(primaryHover >= 4.5, `Primary action hover contrast is ${primaryHover}`);
  await page.keyboard.press('Escape');
  const summary = page.getByRole('region', { name: 'Activity summary' });
  const headline = await summary.locator('.headline').boundingBox();
  const counts = await summary.locator('.cells').boundingBox();
  assert.ok(headline && counts && counts.y >= headline.y + headline.height, 'Counts sit below the headline on desktop');
  const backdrop = await page.locator('body').evaluate(body => getComputedStyle(body, '::before').backgroundImage);
  assert.match(backdrop, /255, 77, 157/);
  assert.match(backdrop, /76% 105%/);
  await expect(summary).toHaveCSS('backdrop-filter', /blur/);
  await expect(summary).toHaveCSS('border-top-color', 'rgb(255, 255, 255)');
  await expect(page.locator('.feed')).toHaveCSS('backdrop-filter', 'none');
  await expect(page.locator('.feed')).toHaveCSS('background-color', 'rgb(255, 255, 255)');
  await expect(page.locator('#demo .banner')).toHaveCSS('background-color', 'rgb(255, 255, 255)');
  const unread = page.getByRole('button', { name: 'Unread only', exact: true });
  await unread.click();
  await expect(unread).toHaveAttribute('aria-pressed', 'true');
  await expect(unread).toHaveCSS('background-image', /radial-gradient/);
  const filterOpacity = () =>
    unread.evaluate(element => {
      const context = document.createElement('canvas').getContext('2d');
      if (!context) throw new Error('2D canvas is unavailable');
      context.fillStyle = getComputedStyle(element).backgroundColor;
      context.fillRect(0, 0, 1, 1);
      return context.getImageData(0, 0, 1, 1).data[3] ?? 0;
    });
  assert.ok((await filterOpacity()) > 127, 'Active filter keeps a glass backing');
  const session = await page.context().newCDPSession(page);
  await session.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-transparency', value: 'reduce' }] });
  await expect(summary).toHaveCSS('backdrop-filter', 'none');
  await expect(summary).toHaveCSS('background-color', 'rgb(255, 255, 255)');
  await expect(unread).toHaveCSS('background-image', 'none');
  await expect.poll(filterOpacity).toBe(255);
  await session.send('Emulation.setEmulatedMedia', { features: [] });
  await session.detach();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(summary.locator('.headline')).toBeVisible();
  await expect(summary.locator('.cells')).toBeHidden();

  // An unknown media feature is unmatched even when negated.
  await page.route('**/web/styles/tokens.css', async route => {
    const response = await route.fetch();
    const body = (await response.text()).replaceAll('prefers-reduced-transparency', 'repo-pulse-unknown-preference');
    await route.fulfill({ response, body });
  });
  await page.reload();
  await expect(summary).toHaveCSS('backdrop-filter', /blur/);
});

test('repo subset acknowledgement preserves hidden/incoming events and survives restart', async t => {
  const app = await setup(t);
  const { page } = app;
  await page.locator('#repo-toggle').click();
  await page.locator('[data-scope-repo="demo-orders"]').uncheck();
  await page.locator('[data-scope-repo="demo-shared"]').uncheck();
  await page.keyboard.press('Escape');
  await expect(page.locator('[data-event-id].new')).toHaveCount(2);
  let incoming: { id: string } | undefined;
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
  assert.ok(incoming);
  assert.equal(app.runtime.store.getEvent(incoming.id)?.seen, false);
  assert.equal(app.runtime.store.getEvent('demo-branch-1')?.seen, false);
  await app.restart();
  assert.ok(
    app.runtime.store
      .listEvents()
      .filter(event => event.repoId === 'demo-billing')
      .every(event => event.seen),
  );
  assert.equal(app.runtime.store.getEvent(incoming.id)?.seen, false);
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
  assert.equal(
    (await (await fetch(runtime.url + '/api/state')).json()).repos.find((repo: Repository) => repo.id === 'demo-billing').disabled,
    true,
  );
  await expect(page.locator('#repo-toggle')).toHaveAccessibleName('1 repository shown');
  await page.locator('#repo-toggle').click();
  await expect(page.locator('#repo-panel [data-scope-repo]')).toHaveCount(2);
  await expect(page.locator('#repo-panel [data-scope-repo="demo-billing"]')).toHaveCount(0);
  await page.locator('#repo-panel [data-scope-repo="demo-shared"]').check();
  await expect(page.locator('#repo-toggle')).toHaveAccessibleName('2 repositories shown');
  await page.locator('#repo-toggle').click();
  await page.getByRole('link', { name: 'Activity', exact: true }).click();
  await expect(page.locator('#page .subref').first()).toBeVisible();
  await expect(billingRows).toHaveCount(0);
  await page.getByRole('link', { name: 'Repositories', exact: true }).click();
  await page.getByRole('switch', { name: 'Watch billing-web' }).click();
  await expect(page.getByRole('switch', { name: 'Watch billing-web' })).toBeChecked();
  await expect(page.getByText('3 watched', { exact: true })).toBeVisible();
  await page.getByRole('link', { name: 'Activity', exact: true }).click();
  await expect(billingRows.first()).toBeVisible();
  await expect(page.locator('#repo-toggle')).toHaveAccessibleName('3 repositories shown');
  await page.locator('#repo-toggle').click();
  await expect(page.locator('#repo-panel [data-scope-repo="demo-billing"]')).toBeChecked();
});

test('empty live startup detects existing CLI locally and prompts only local repo selection', async t => {
  const store = createStore();
  const commands: string[] = [];
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
  let browser: Browser | undefined;
  const errors: string[] = [];
  t.after(async () => {
    await browser?.close().catch(() => {});
    await sync.stop();
    if (server.listening) await new Promise(resolve => server.close(resolve));
    cli.close();
    store.close();
    assert.deepEqual(errors, []);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  sync.start();
  browser = await chromium.launch({ executablePath: await browserPath(), headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.on('pageerror', error => errors.push(error.message));
  await rememberKey(page);
  const url = `http://127.0.0.1:${portOf(server)}`;
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
  await search.evaluate((input: HTMLInputElement) => input.setSelectionRange(2, 5));
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
  assert.deepEqual(await search.evaluate((input: HTMLInputElement) => [input.selectionStart, input.selectionEnd]), [2, 5]);
});

async function postDemoEvent(runtime: Runtime) {
  const response = await fetch(runtime.url + '/api/demo/event', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
  return response.json();
}

for (const [name, selector] of [
  ['title', '.feed-title'],
  ['Seen toggle', '.seen-toggle'],
] satisfies [string, string][]) {
  test(`incoming activity renders while a row's ${name} has keyboard focus, and focus stays on it`, async t => {
    const { page, runtime } = await setup(t);
    const row = page.locator('li[data-event-id]').nth(1);
    const id = await row.getAttribute('data-event-id');
    await row.locator(selector).focus();
    const incoming = await postDemoEvent(runtime);
    await expect(page.locator(`[data-event-id="${incoming.id}"]`)).toBeVisible({ timeout: 12000 });
    await expect(page.locator(`li[data-event-id="${id}"] ${selector}`)).toBeFocused();
  });
}

test('incoming activity updates the feed in place: the search box and an existing row stay the same nodes', async t => {
  const { page, runtime } = await setup(t);
  const id = await page.locator('li[data-event-id]').first().getAttribute('data-event-id');
  await page.evaluate(id => {
    const search = document.getElementById('feed-search');
    const row = document.querySelector(`li[data-event-id="${id}"]`);
    if (!search || !row) throw new Error('The search box or the row is missing.');
    Object.assign(search, { marker: 'search' });
    Object.assign(row, { marker: 'row' });
  }, id);
  const incoming = await postDemoEvent(runtime);
  await expect(page.locator(`[data-event-id="${incoming.id}"]`)).toBeVisible({ timeout: 12000 });
  assert.deepEqual(
    await page.evaluate(
      id => [document.querySelector<Marked>('#feed-search')?.marker, document.querySelector<Marked>(`li[data-event-id="${id}"]`)?.marker],
      id,
    ),
    ['search', 'row'],
  );
});

test('a header control keeps keyboard focus while incoming activity renders the whole view', async t => {
  const { page, runtime } = await setup(t);
  const refresh = page.locator('#header-refresh-desktop');
  await refresh.focus();
  await refresh.evaluate((element: Marked) => (element.marker = 'header'));
  const incoming = await postDemoEvent(runtime);
  await expect(page.locator(`[data-event-id="${incoming.id}"]`)).toBeVisible({ timeout: 12000 });
  await expect(refresh).toBeFocused();
  assert.equal(await refresh.evaluate((element: Marked) => element.marker), 'header');
});

test('incoming activity renders while the Activity type menu is open, and the menu stays open with focus inside', async t => {
  const { page, runtime } = await setup(t);
  const toggle = page.getByRole('button', { name: /^Activity type:/ });
  await toggle.press('ArrowDown');
  const panel = page.getByRole('listbox', { name: 'Activity type' });
  const all = panel.getByRole('option', { name: 'All types', exact: true });
  await expect(all).toBeFocused();
  const incoming = await postDemoEvent(runtime);
  await expect(page.locator(`[data-event-id="${incoming.id}"]`)).toBeVisible({ timeout: 12000 });
  await expect(panel).toBeVisible();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await expect(all).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(panel).toBeHidden();
  await expect(toggle).toBeFocused();
});

test('incoming activity renders while the repository scope panel is open, and the panel stays open with focus inside', async t => {
  const { page, runtime } = await setup(t);
  const toggle = page.locator('#repo-toggle');
  await toggle.click();
  const panel = page.getByRole('group', { name: 'Repositories shown' });
  await expect(panel).toBeVisible();
  const orders = page.locator('[data-scope-repo="demo-orders"]');
  await orders.focus();
  const incoming = await postDemoEvent(runtime);
  await expect(page.locator(`[data-event-id="${incoming.id}"]`)).toBeVisible({ timeout: 12000 });
  await expect(panel).toBeVisible();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await expect(orders).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(panel).toBeHidden();
  await expect(toggle).toBeFocused();
});

// A background render keeps focus on the same item, never on a neighbour that took its place in the markup.
async function renderInBackground(page: Page) {
  const polled = page.waitForResponse(response => response.url().includes('/api/state') && response.ok());
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await polled;
}

test('a focused saved-filter option keeps focus while incoming activity renders', async t => {
  const { page, runtime } = await setup(t);
  const filters = (search: string): import('../src/contract.d.ts').ActivityFilters => ({
    search,
    people: '',
    kind: '',
    repoIds: null,
    view: 'new',
  });
  runtime.store.setSetting('savedActivityFilters', [
    { id: 'first', name: 'First preset', filters: filters('first') },
    { id: 'second', name: 'Second preset', filters: filters('second') },
  ]);
  await page.reload();
  await page.locator('#saved-filter-toggle').press('ArrowDown');
  await page.keyboard.press('End');
  const second = page.getByRole('option', { name: /Second preset/ });
  await expect(second).toBeFocused();
  const incoming = await postDemoEvent(runtime);
  await expect(page.locator(`[data-event-id="${incoming.id}"]`)).toBeVisible({ timeout: 12000 });
  await expect(second).toBeFocused();
});

test('a focused saved-filter option stays on its preset when another preset is deleted, and falls back to the toggle', async t => {
  const { page, runtime } = await setup(t);
  const filters = (search: string): import('../src/contract.d.ts').ActivityFilters => ({
    search,
    people: '',
    kind: '',
    repoIds: null,
    view: 'new',
  });
  const preset = (id: string, name: string) => ({ id, name, filters: filters(id) });
  runtime.store.setSetting('savedActivityFilters', [
    preset('first', 'First preset'),
    preset('second', 'Second preset'),
    preset('third', 'Third preset'),
  ]);
  await page.reload();
  const toggle = page.locator('#saved-filter-toggle');
  await toggle.press('ArrowDown');
  const second = page.getByRole('option', { name: /Second preset/ });
  await second.focus();
  runtime.store.setSetting('savedActivityFilters', [preset('second', 'Second preset'), preset('third', 'Third preset')]);
  await renderInBackground(page);
  await expect(page.getByRole('option', { name: /First preset/ })).toHaveCount(0);
  await expect(second).toBeFocused();
  runtime.store.setSetting('savedActivityFilters', [preset('third', 'Third preset')]);
  await renderInBackground(page);
  await expect(second).toHaveCount(0);
  await expect(toggle).toBeFocused();
  await toggle.press('ArrowDown');
  await page.getByRole('option', { name: /Third preset/ }).focus();
  runtime.store.setSetting('savedActivityFilters', []);
  await renderInBackground(page);
  await expect(page.getByRole('button', { name: 'Save filter…' })).toBeFocused();
});

test('a focused CI row keeps focus when a status update changes which event represents it', async t => {
  const { page, runtime } = await setup(t);
  const build = (id: string, status: string, minutesAgo: number): ActivityEvent => ({
    id,
    repoId: 'demo-orders',
    kind: 'build',
    title: 'Orders CI',
    branch: 'main',
    time: new Date(Date.now() - minutesAgo * 60000).toISOString(),
    data: { buildId: 9100, status },
  });
  runtime.store.insertEvents([build('ci-queued', 'notStarted', 1)]);
  await renderInBackground(page);
  const row = page.locator('li[data-event-id="ci-queued"]');
  const group = await row.getAttribute('data-group-key');
  await row.locator('.feed-title').focus();
  runtime.store.insertEvents([build('ci-running', 'inProgress', 0)]);
  await renderInBackground(page);
  await expect(page.locator('li[data-event-id="ci-running"]')).toHaveCount(1);
  assert.equal(await page.evaluate(() => document.activeElement?.closest('li')?.dataset.groupKey), group);
  await page.locator('li[data-event-id="ci-running"] .seen-toggle').focus();
  runtime.store.insertEvents([build('ci-done', 'completed', -1)]);
  await renderInBackground(page);
  await expect(page.locator('li[data-event-id="ci-done"]')).toHaveCount(1);
  assert.deepEqual(
    await page.evaluate(() => [document.activeElement?.closest('li')?.dataset.groupKey, document.activeElement?.matches('.seen-toggle')]),
    [group, true],
  );
});

test('a focused Activity type option keeps its type when a new type appears ahead of it', async t => {
  const { page, runtime } = await setup(t);
  await page.goto(`${runtime.url}/#activity/unread`);
  await expect(page.locator('[data-event-id="demo-push-1"]')).toBeVisible();
  await page.getByRole('button', { name: /^Activity type:/ }).press('ArrowDown');
  const panel = page.getByRole('listbox', { name: 'Activity type' });
  const push = panel.getByRole('option', { name: 'Push', exact: true });
  await push.focus();
  runtime.store.insertEvents([
    {
      id: 'live-tag',
      repoId: 'demo-orders',
      kind: 'tag',
      title: 'Tag moved · v9',
      branch: 'v9',
      time: new Date().toISOString(),
      data: { change: 'moved', name: 'refs/tags/v9' },
    },
  ]);
  await renderInBackground(page);
  await expect(panel.getByRole('option', { name: 'Tag', exact: true })).toBeVisible();
  await expect(push).toBeFocused();
  // When the focused type leaves the list, focus goes back to the menu toggle.
  await panel.getByRole('option', { name: 'Tag', exact: true }).focus();
  runtime.store.acknowledge(['live-tag']);
  await renderInBackground(page);
  await expect(panel.getByRole('option', { name: 'Tag', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^Activity type:/ })).toBeFocused();
});

test('a focused imported row keeps focus when a newer imported row renders above it', async t => {
  const { page, runtime } = await setup(t);
  await page.goto(`${page.url().split('#')[0]}#activity`);
  await page.locator('summary', { hasText: 'Imported history' }).click();
  const title = page
    .locator('li[data-event-id] .feed-title')
    .filter({ has: page.locator('xpath=ancestor::details[@data-group="Imported history"]') })
    .first();
  const id = await title.getAttribute('data-id');
  await title.focus();
  runtime.store.insertEvents([
    {
      id: 'imported-newer',
      repoId: 'demo-orders',
      kind: 'push',
      title: 'Newer import',
      branch: 'feature/newer-import',
      time: new Date().toISOString(),
      imported: true,
      seen: true,
      data: { pushId: 77001 },
    },
  ]);
  await renderInBackground(page);
  await expect(page.locator('[data-event-id="imported-newer"]')).toBeVisible();
  await expect(page.locator(`.feed-title[data-id="${id}"]`)).toBeFocused();
});

test('a focused scope checkbox stays on its repository when an earlier repository leaves the list', async t => {
  const { page, runtime } = await setup(t);
  await page.locator('#repo-toggle').click();
  const billing = page.locator('[data-scope-repo="demo-billing"]');
  await billing.focus();
  const first = present(runtime.store.listRepos()[0]);
  assert.notEqual(first.id, 'demo-billing');
  runtime.store.saveRepo({ ...first, disabled: true });
  await renderInBackground(page);
  await expect(page.locator(`[data-scope-repo="${first.id}"]`)).toHaveCount(0);
  await expect(billing).toBeFocused();
});

test('opening a toolbar menu closes the scope panel, and the scope panel survives a breakpoint change', async t => {
  const { page } = await setup(t);
  const scope = page.getByRole('group', { name: 'Repositories shown' });
  await page.locator('#repo-toggle').click();
  await expect(scope).toBeVisible();
  await page.getByRole('button', { name: /^Activity type:/ }).click();
  await expect(page.getByRole('listbox', { name: 'Activity type' })).toBeVisible();
  await expect(scope).toBeHidden();
  await page.keyboard.press('Escape');
  await page.locator('#repo-toggle').click();
  await page.getByRole('button', { name: /^Activity type:/ }).press('ArrowDown');
  await expect(scope).toBeHidden();
  await page.keyboard.press('Escape');
  await page.locator('#repo-toggle').click();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(scope).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(scope).toBeHidden();
});

test('ticked commits survive incoming activity while focus is elsewhere on the page', async t => {
  const { page, runtime } = await setup(t);
  // The carry fieldset needs a rewritten Git checkout; a copy of its markup is enough to exercise the refresh guard.
  await page.evaluate(() => {
    const fieldset = Object.assign(document.createElement('fieldset'), { className: 'checkout-commits' });
    fieldset.innerHTML =
      '<input type="checkbox" name="checkout-commit" value="a" checked><button type="button">Carry selected commits</button>';
    const other = Object.assign(document.createElement('button'), { type: 'button', textContent: 'Remove old local branch…' });
    const main = document.getElementById('page');
    if (!main) throw new Error('The page has no #page element.');
    main.append(fieldset, other);
    other.focus();
  });
  await postDemoEvent(runtime);
  await renderInBackground(page);
  await expect(page.locator('.checkout-commits input')).toBeChecked();
  await expect(page.getByRole('button', { name: 'Remove old local branch…' })).toBeFocused();
});

test('a backward selection in the focused search box survives incoming activity', async t => {
  const { page, runtime } = await setup(t);
  const search = page.getByRole('searchbox', { name: 'Search activity' });
  await search.fill('hotfix/');
  await search.evaluate((input: HTMLInputElement) => input.setSelectionRange(2, 5, 'backward'));
  const incoming = await postDemoEvent(runtime);
  await expect(page.locator(`[data-event-id="${incoming.id}"]`)).toBeVisible({ timeout: 12000 });
  await expect(search).toBeFocused();
  await expect(search).toHaveValue('hotfix/');
  assert.deepEqual(
    await search.evaluate((input: HTMLInputElement) => [input.selectionStart, input.selectionEnd, input.selectionDirection]),
    [2, 5, 'backward'],
  );
});

test('text selected inside a row stays selected while incoming activity renders', async t => {
  const { page, runtime } = await setup(t);
  const title = page.locator('li[data-event-id] .feed-title .title').first();
  const selected = await title.evaluate(element => {
    const range = document.createRange();
    range.selectNodeContents(element);
    const selection = getSelection();
    if (!selection) throw new Error('The document has no selection.');
    selection.removeAllRanges();
    selection.addRange(range);
    return selection.toString();
  });
  assert.ok(selected.length > 0);
  const incoming = await postDemoEvent(runtime);
  await expect(page.locator(`[data-event-id="${incoming.id}"]`)).toBeVisible({ timeout: 12000 });
  assert.equal(await page.evaluate(() => getSelection()?.toString()), selected);
});

async function setupPicker(t: TestContext, { existing = true } = {}) {
  const store = createStore();
  const organization = 'https://dev.azure.com/example',
    project = 'Demo';
  if (existing)
    store.saveRepo(
      stub<Repository>({
        id: 'existing',
        azureId: 'existing',
        name: 'existing',
        localPath: '/workspace/projects/existing',
        organization,
        project,
      }),
    );
  const remote = (name: string, repoName: string) => ({
    name,
    repoName,
    organization,
    project,
    url: `${organization}/${project}/_git/${repoName}`,
  });
  const repositories = [
    { localPath: '/workspace/projects/alpha', remotes: [remote('origin', 'alpha-api'), remote('upstream', 'alpha-upstream')] },
    { localPath: '/workspace/projects/beta', remotes: [remote('origin', 'beta-web')] },
    { localPath: '/workspace/projects/existing', remotes: [remote('origin', 'existing')] },
  ];
  const calls = { browse: 0, resolve: 0 };
  const browse = async (input: unknown) => {
    calls.browse++;
    const path = input || '/workspace/projects';
    // The handler passes the request's path through; anything but a string is a regression this fake must not hide.
    if (typeof path !== 'string') throw new TypeError('browse expects a folder path string');
    if (path === '/missing') throw Object.assign(new Error('This folder cannot be opened. Choose another local folder.'), { status: 400 });
    return {
      path,
      parent: path === '/workspace' ? '/' : '/workspace',
      breadcrumbs: [
        { name: '/', path: '/' },
        { name: 'workspace', path: '/workspace' },
        ...(path === '/workspace' ? [] : [{ name: path.split('/').at(-1) ?? '', path }]),
      ],
      folders: [{ name: 'nested', path: '/workspace/projects/nested' }],
      repositories: path === '/workspace/projects' ? repositories : [],
      warnings: [],
    };
  };
  const provider = stub<AzureProvider>({
    async checkConnection() {
      return stub<ConnectionStatus>({
        available: true,
        signedIn: true,
        account: { name: 'existing@example.test' },
        message: 'Existing Azure CLI sign-in detected.',
      });
    },
    // The picker sends each remote as an organization, project and name.
    async resolveRepository(input: RepositoryInput) {
      calls.resolve++;
      return stub<ResolvedRepository>({ id: input.name, azureId: input.name, name: input.name, organization, project });
    },
  });
  const sync = createSync({ store, provider });
  const server = createApp({ store, provider, sync, browse, discover: async () => ({ repositories, warnings: [] }), accessKey: TEST_KEY });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ executablePath: await browserPath(), headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await rememberKey(page);
  const errors: string[] = [];
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
  await page.goto(`http://127.0.0.1:${portOf(server)}/${existing ? '#repositories' : ''}`);
  if (existing) await page.locator('#add-repositories').click();
  return { page, store, calls };
}

test('a background render leaves the repository picker in place, so its focused toggle keeps focus', async t => {
  const { page, store } = await setupPicker(t);
  const search = page.getByRole('combobox', { name: 'Search local repositories' });
  await search.press('Escape');
  await expect(search).toHaveAttribute('aria-expanded', 'false');
  const toggle = page.getByRole('button', { name: 'Open repository picker' });
  await toggle.focus();
  await page.evaluate(() => {
    const search = document.getElementById('checkout-search');
    const heading = document.querySelector('#page h1');
    if (!search || !heading) throw new Error('The picker search or the page heading is missing.');
    Object.assign(search, { marker: 'picker' });
    heading.setAttribute('data-before-refresh', '');
  });
  store.saveRepo({ ...store.getRepo('existing'), name: 'existing-renamed' });
  const polled = page.waitForResponse(response => response.url().includes('/api/state') && response.ok());
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await polled;
  await expect(page.locator('#page [data-before-refresh]')).toHaveCount(0);
  await expect(toggle).toBeFocused();
  assert.equal(await page.evaluate(() => document.querySelector<Marked>('#checkout-search')?.marker), 'picker');
});

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
  store.saveRepo(stub<Repository>({ ...repo, id: 'other', name: 'Another watched repository', localPath: undefined }));
  store.saveRepo(stub<Repository>(repo));
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
  const provider = stub<AzureProvider>({ checkConnection: async () => stub<ConnectionStatus>({ available: true }) });
  const sync = stub<AppSync>({
    status: () => stub<SyncEngineStatus & { repos: Record<string, never> }>({ running: false, repos: {} }),
  });
  const app = createApp({ store, provider, sync, checkoutGit, accessKey: TEST_KEY });
  await new Promise<void>(resolve => app.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ executablePath: await browserPath(), headless: true });
  t.after(async () => {
    await browser.close();
    await new Promise(resolve => app.close(resolve));
    store.close();
  });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  page.setDefaultTimeout(5000);
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await rememberKey(page);
  await page.goto(`http://127.0.0.1:${portOf(app)}/#activity`);
  await page.locator('#activity-filters-toggle').click();
  const search = page.getByRole('searchbox', { name: 'Search activity' });
  await search.fill('checkout-from-activity');
  await page.getByRole('button', { name: `${branch} · repository ${repo.name}`, exact: true }).click();
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
  await page.getByRole('link', { name: /Back to Activity/ }).click();
  await expect(page.locator('#feed-search')).toHaveValue('checkout-from-activity');
  assert.deepEqual(errors, []);
});

test('Repositories switches between watched branches, and a merged pull request switches back to main', async t => {
  const { source, local, repo, checkoutGit, commit, original } = checkoutFixture(t);
  git(source, 'switch', '-c', 'topic');
  commit(source, 'topic.txt', 'topic work');
  git(source, 'push', 'origin', 'topic');
  const store = createStore();
  store.saveRepo(stub<Repository>(repo));
  const ref = (name: string, lastPushId: number): import('../server/store.ts').Entity => ({
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
  const provider = stub<AzureProvider>({ checkConnection: async () => stub<ConnectionStatus>({ available: true }) });
  const sync = stub<AppSync>({
    status: () => stub<SyncEngineStatus & { repos: Record<string, never> }>({ running: false, repos: {} }),
  });
  const app = createApp({ store, provider, sync, checkoutGit, accessKey: TEST_KEY });
  await new Promise<void>(resolve => app.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ executablePath: await browserPath(), headless: true });
  t.after(async () => {
    await browser.close();
    await new Promise(resolve => app.close(resolve));
    store.close();
  });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  page.setDefaultTimeout(5000);
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await rememberKey(page);
  await page.goto(`http://127.0.0.1:${portOf(app)}/#repositories`);
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

  await page.goto(`http://127.0.0.1:${portOf(app)}/#event/merged-topic`);
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
  await expect(page).toHaveURL(/#activity$/);
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

test('the focused picker search shows the text the picker resets it to', async t => {
  const { page } = await setupPicker(t);
  let search = page.getByRole('combobox', { name: 'Search local repositories' });
  await search.fill('zzz');
  await search.press('Escape');
  await expect(search).toHaveAttribute('aria-expanded', 'false');
  await search.press('Escape');
  await expect(search).toBeFocused();
  await expect(search).toHaveValue('');
  await page.getByRole('button', { name: 'Change folder', exact: true }).click();
  search = page.getByRole('combobox', { name: 'Find a folder' });
  await search.fill('/workspace/projects');
  await search.press('Enter');
  await expect(page.locator('.picker-crumbs [aria-current]')).toHaveText('projects');
  await expect(search).toBeFocused();
  await expect(search).toHaveValue('');
});

test('picker keeps a search typed during initial loading and retains failed selections on partial add', async t => {
  const { page, store } = await setupPicker(t);
  const { promise: reading, resolve: release } = Promise.withResolvers<void>();
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

async function groupedFixture(t: TestContext) {
  const app = await setup(t);
  for (const repo of app.runtime.store.listRepos()) app.runtime.store.removeRepo(repo.id);
  app.runtime.store.saveRepo(
    stub<Repository>({
      id: 'demo-orders',
      name: 'Orders',
      project: 'Demo',
      organization: 'https://dev.azure.com/example',
      azureId: 'orders',
    }),
  );
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
  } satisfies Partial<ActivityEvent>;
  const event = (id: string, status: string, offset: number): ActivityEvent => ({
    ...record,
    id,
    time: new Date(now + offset).toISOString(),
    observedAt: new Date(now + offset).toISOString(),
    data: { ...record.data, status },
  });
  app.runtime.store.insertEvents([event('build-queued', 'notStarted', -120000), event('build-running', 'inProgress', -60000)]);
  for (const stream of ['pushes', 'refs', 'prs', 'closedPrs', 'builds', 'activeBuilds'] as const)
    app.runtime.store.saveStream({
      repoId: 'demo-orders',
      stream,
      initialized: true,
      nextAt: new Date(now).toISOString(),
      lastSuccess: new Date(now).toISOString(),
    });
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
  await expect(page.locator('li.row .kind')).toHaveText('CI running');
  await expect(page.locator('li.row .feed-title .title')).toHaveText('Orders CI 2 new');
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
  await expect(page.locator('li.row .kind')).toHaveText('CI succeeded');
  assert.equal(runtime.store.listEvents().find(item => item.id === 'build-queued')?.seen, true);
  assert.equal(runtime.store.listEvents().find(item => item.id === 'build-running')?.seen, true);
  assert.equal(runtime.store.listEvents().find(item => item.id === 'build-succeeded')?.seen, false);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Activity summary' })).toContainText('3 updates');
  assert.equal(runtime.store.listEvents({ unseen: true }).length, 3);
});

test('filtered group marks only shown matching updates while the hidden transition stays unseen', async t => {
  const { page, runtime } = await groupedFixture(t);
  await page.getByRole('searchbox', { name: 'Search activity' }).fill('Running');
  await page.getByRole('button', { name: 'Mark all matching seen (1)', exact: true }).click();
  await expect(page.locator('.feed-actions button')).toHaveCount(0);
  assert.equal(runtime.store.listEvents().find(item => item.id === 'build-running')?.seen, true);
  assert.equal(runtime.store.listEvents().find(item => item.id === 'build-queued')?.seen, false);
});

test('mixed control rows use one height per size on desktop and phone', async t => {
  const { page, runtime } = await groupedFixture(t);
  runtime.store.setSetting('savedActivityFilters', [
    { id: 'team', name: 'Orders team', filters: { search: '', people: '', kind: '', repoIds: null, view: 'new' } },
  ]);
  await page.reload();
  const height = (selector: string, expected: number) => expect(page.locator(selector)).toHaveCSS('height', `${expected}px`);

  for (const [width, standard, compact] of [
    [1280, 36, 28],
    [390, 44, 36],
  ] satisfies [number, number, number][]) {
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
  ] satisfies [number, number][]) {
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

test('CI summary shortcuts filter the full activity scope on desktop and compact layouts', async t => {
  const { page, runtime } = await setup(t, true, { hasTouch: true });
  const ci = (id: string, buildId: number, result: string, second: number, extra: Partial<ActivityEvent> = {}): ActivityEvent => ({
    id,
    repoId: 'demo-orders',
    kind: 'build',
    title: 'Summary CI fixture',
    time: new Date(Date.UTC(2026, 10, 24, 10, 0, second)).toISOString(),
    data: { buildId, status: 'completed', result },
    ...extra,
  });
  runtime.store.insertEvents([
    ...Array.from({ length: 51 }, (_, index) => ci(`summary-success-${index}`, 1000 + index, 'succeeded', index + 10)),
    ci('summary-failure', 1100, 'failed', 0),
    ci('summary-failure-seen', 1101, 'failed', 1, { seen: true }),
    ci('summary-retry-failed', 1102, 'failed', 2),
    ci('summary-retry-succeeded', 1102, 'succeeded', 3),
    ci('summary-other-repo', 1103, 'failed', 61, { repoId: 'demo-billing' }),
    ci('summary-other-search', 1104, 'failed', 62, { title: 'Unrelated CI' }),
    { id: 'summary-push', repoId: 'demo-orders', kind: 'push', title: 'Summary CI fixture push', time: '2026-11-24T10:02:00Z' },
  ]);
  const repoPicker = page.locator('#repo-toggle');
  await repoPicker.click();
  await page.locator('#repo-panel [data-scope-repo="demo-billing"]').uncheck();
  await page.locator('#repo-panel [data-scope-repo="demo-shared"]').uncheck();
  await repoPicker.click();
  const search = page.getByRole('searchbox', { name: 'Search activity' });
  await search.fill('Summary CI fixture');
  const summary = page.getByRole('region', { name: 'Activity summary' });
  const allRuns = summary.getByRole('button', { name: 'CI runs, 53 unread' });
  const failed = summary.getByRole('button', { name: '1 failed CI run' });
  const failureRow = page.locator('li[data-event-id="summary-failure"]');
  await expect(summary).toContainText('Showing 50 of 55 items');
  await expect(failureRow).toHaveCount(0);
  await expect(failed).toBeVisible();
  await allRuns.getByText('CI runs', { exact: true }).click();
  await expect(page.getByRole('button', { name: 'Activity type: CI runs', exact: true })).toBeFocused();
  await expect(summary).toContainText('Showing 50 of 54 items');
  await page.screenshot({ path: 'test-results/activity-filter-desktop.png' });
  await expect(page.locator('li[data-event-id="summary-push"]')).toHaveCount(0);

  await page.setViewportSize({ width: 375, height: 900 });
  const filters = page.locator('#activity-filters-toggle');
  await filters.tap();
  await expect(search).toBeHidden();
  await expect(failed).toBeVisible();
  for (const shortcut of [allRuns, failed]) {
    const box = await shortcut.boundingBox();
    assert.ok(box && box.width >= 24 && box.height >= 24, 'The compact shortcut has a usable touch target');
  }
  await failed.tap();
  const failedType = page.getByRole('button', { name: 'Activity type: Failed CI runs', exact: true });
  const clear = page.getByRole('button', { name: 'Clear filter', exact: true });
  await expect(failedType).toBeVisible();
  await expect(failedType).toHaveAttribute('aria-expanded', 'false');
  await expect(clear).toBeVisible();
  await expect(failureRow).toBeVisible();
  await expect(page.locator('li[data-event-id]')).toHaveCount(2);
  await expect(page.locator('li[data-event-id="summary-failure-seen"]')).toBeVisible();
  const showAll = summary.getByRole('button', { name: 'Show all CI runs', exact: true });
  await expect(showAll).toBeVisible();
  await expect(summary.getByRole('button', { name: 'CI runs, 1 unread' })).toHaveCount(0);
  await page.screenshot({ path: 'test-results/activity-filter-compact.png' });
  await failedType.tap();
  await expect(page.getByRole('option', { name: 'Failed CI runs', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('option', { name: 'CI runs', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await showAll.press('Space');
  await expect(page.getByRole('button', { name: 'Activity type: CI runs', exact: true })).toBeFocused();
  await expect(allRuns).toBeVisible();
  await expect(search).toHaveValue('Summary CI fixture');
  await search.fill('No matching CI fixture');
  await expect(page.getByText('No activity matches these filters').first()).toBeVisible();
  await clear.press('Enter');
  await expect(search).toBeFocused();
  await expect(search).toHaveValue('');
  await expect(page.getByRole('button', { name: 'Activity type: All types', exact: true })).toBeVisible();
  await expect(clear).toHaveCount(0);
  await expect(page.locator('li[data-event-id="summary-push"]')).toBeVisible();
  await expect(repoPicker).toHaveAccessibleName('1 repository shown');
  await expect(page.getByRole('link', { name: 'Activity', exact: true })).toHaveAttribute('aria-current', 'page');
});

test('detail reload and back restore Activity filters, open trail and source row focus', async t => {
  const { page } = await groupedFixture(t);
  await page.getByRole('link', { name: 'Activity', exact: true }).click();
  await page.getByRole('searchbox', { name: 'Search activity' }).fill('Orders');
  await selectActivityType(page, 'CI runs');
  await page.locator('.trail > summary').click();
  await page.locator('li.row .feed-title').click();
  await expect(page.getByRole('link', { name: '← Back to Activity', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Update history' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Orders CI', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Copy full commit ID' })).toBeVisible();
  await page.reload();
  await page.getByRole('link', { name: '← Back to Activity', exact: true }).click();
  await expect(page.getByRole('searchbox', { name: 'Search activity' })).toHaveValue('Orders');
  await expect(page.getByRole('button', { name: 'Activity type: CI runs', exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Activity', exact: true })).toHaveAttribute('aria-current', 'page');
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
  await expect(page.locator('li.row .feed-title .title')).toHaveText('hotfix/finished');
  await expect(page.getByRole('button', { name: 'Activity type: Branch deleted', exact: true })).toBeVisible();
  await page.locator('li.row .feed-title').click();
  await expect(page.getByRole('heading', { name: 'Branch deleted · hotfix/finished' })).toBeVisible();
  assert.equal(await page.getByText('Branch missing', { exact: false }).count(), 0);
});

test('Activity shows history by default and filters to unread without changing seen state', async t => {
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
  await expect(main.getByRole('link', { name: 'Activity', exact: true })).toHaveAttribute('aria-current', 'page');
  await expect(page.getByRole('navigation', { name: 'Activity view' })).toHaveCount(0);
  const unread = page.getByRole('button', { name: 'Unread only', exact: true });
  await expect(unread).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('li.row')).toHaveCount(3);
  const remoteReads: string[] = [];
  page.on('request', request => {
    if (/\/api\/(refresh|connection|repos)(\?|$)/.test(request.url())) remoteReads.push(request.url());
  });
  await page.getByRole('searchbox', { name: 'Search activity' }).fill('Orders');
  await expect(page).toHaveURL(/#activity$/);
  await expect(page.getByRole('searchbox', { name: 'Search activity' })).toHaveValue('Orders');
  await expect(page.locator('li.row')).toHaveCount(3);
  await expect(page.locator('[data-event-id="seen-push"]')).toBeVisible();
  const importedHistory = page.locator('details[data-group="Imported history"]');
  if ((await importedHistory.getAttribute('open')) === null) await importedHistory.locator('summary').click();
  await expect(page.locator('[data-event-id="imported-push"]')).toBeVisible();
  await expect(page.getByRole('region', { name: 'Activity summary' })).toContainText('1 new item');
  // Every matching item is loaded, so the summary does not repeat the count.
  await expect(page.getByRole('region', { name: 'Activity summary' })).not.toContainText('Showing');
  await unread.press('Space');
  await expect(page).toHaveURL(/#activity\/unread$/);
  await expect(unread).toHaveAttribute('aria-pressed', 'true');
  await expect(unread).toBeFocused();
  await expect(page.getByRole('searchbox', { name: 'Search activity' })).toHaveValue('Orders');
  await expect(page.locator('li.row')).toHaveCount(1);
  assert.equal(runtime.store.listEvents({ unseen: true }).length, 2);
  assert.deepEqual(remoteReads, []);
  await page.getByRole('link', { name: 'Repositories', exact: true }).click();
  await main.getByRole('link', { name: 'Activity', exact: true }).click();
  await expect(unread).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('link', { name: 'Repo Pulse', exact: true }).click();
  await expect(unread).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('li.row')).toHaveCount(3);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('#activity-filters-toggle').click();
  await unread.click();
  await expect(page.locator('#activity-filters-toggle')).toHaveText('Filters · 2');
  await expect(page.locator('li.row')).toHaveCount(1);
  await page.getByRole('button', { name: 'Clear filter', exact: true }).click();
  await expect(unread).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('li.row')).toHaveCount(3);
});

test('legacy activity links normalize and detail returns to the unread filter', async t => {
  const { page } = await groupedFixture(t);
  const base = page.url().split('#')[0];
  await page.goto(base + '#activity/all');
  await expect(page).toHaveURL(/#activity$/);
  await expect(page.getByRole('link', { name: 'Activity', exact: true })).toHaveAttribute('aria-current', 'page');
  await page.goto(base + '#catchup');
  await expect(page).toHaveURL(/#activity\/unread$/);
  await page.locator('li.row .feed-title').click();
  await expect(page.getByRole('link', { name: '← Back to Activity', exact: true })).toBeVisible();
  await page.reload();
  await page.getByRole('link', { name: '← Back to Activity', exact: true }).click();
  await expect(page).toHaveURL(/#activity\/unread$/);
  await expect(page.getByRole('button', { name: 'Unread only', exact: true })).toHaveAttribute('aria-pressed', 'true');
});

test('semantic status colors match rows, imported history, details and trails in both themes', async t => {
  const { page, runtime, event } = await groupedFixture(t);
  const cases: [string, ActivityKind, EventData, string, string][] = [
    ['deleted', 'branch-deleted', { evidence: 'push' }, 'crit', 'Branch deleted'],
    ['failed', 'build', { status: 'completed', result: 'failed' }, 'crit', 'CI failed'],
    ['canceled', 'build', { status: 'completed', result: 'canceled' }, 'warn', 'CI canceled'],
    ['abandoned', 'pr', { status: 'abandoned' }, 'warn', 'PR abandoned'],
    ['partial', 'build', { status: 'completed', result: 'partiallySucceeded' }, 'warn', 'CI partially succeeded'],
    ['completed', 'pr', { status: 'completed' }, 'ok', 'PR merged'],
    ['succeeded', 'build', { status: 'completed', result: 'succeeded' }, 'ok', 'CI succeeded'],
    ['open', 'pr', { status: 'active' }, 'info', 'Open PR'],
    ['queued', 'build', { status: 'notStarted' }, 'info', 'CI queued'],
    ['created', 'branch-created', {}, 'info', 'New branch'],
    ['push', 'push', {}, 'info', 'Push'],
    ['draft', 'pr', { status: 'active', isDraft: true }, 'neutral', 'Draft PR'],
    ['skipped', 'build', { status: 'completed', result: 'skipped' }, 'neutral', 'CI skipped'],
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
  await page.goto(page.url().split('#')[0] + '#activity');
  for (const theme of ['Light', 'Dark']) {
    await page.getByRole('button', { name: theme, exact: true }).click();
    const history = page.locator('details[data-group="Imported history"]');
    if (!(await history.evaluate((element: HTMLDetailsElement) => element.open))) await history.locator('summary').first().click();
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
      if (!context) throw new Error('The canvas has no 2D context.');
      const rgba = (color: string): [number, number, number, number] => {
        context.clearRect(0, 0, 1, 1);
        context.fillStyle = color;
        context.fillRect(0, 0, 1, 1);
        // One pixel is always four channels, so the defaults never apply.
        const [red = 0, green = 0, blue = 0, alpha = 0] = context.getImageData(0, 0, 1, 1).data;
        return [red, green, blue, alpha];
      };
      const linear = (value: number) => {
        const c = value / 255;
        return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
      };
      const luminance = ([red, green, blue]: [number, number, number, number]) =>
        linear(red) * 0.2126 + linear(green) * 0.7152 + linear(blue) * 0.0722;
      const tokens = getComputedStyle(document.documentElement);
      const names: Record<string, string> = {
        crit: '--critical',
        warn: '--warning',
        ok: '--ok',
        info: '--info',
        neutral: '--muted-foreground',
      };
      const washes: Record<string, string> = { crit: '--critical-wash', warn: '--warning-wash', ok: '--ok-wash', info: '--primary-wash' };
      return [...document.querySelectorAll<HTMLElement>('li[data-event-id^="color-"]')].map(row => {
        const kind = row.querySelector('.kind');
        const card = row.closest('.card');
        if (!kind || !card) throw new Error(`${row.dataset.eventId} has no status label or card.`);
        const named = Object.entries(names).find(([name]) => kind.classList.contains(name));
        if (!named) throw new Error(`${row.dataset.eventId} has no status tone.`);
        const [tone, defaultToken] = named;
        const token = kind.classList.contains('merged') ? '--merged' : defaultToken;
        const foreground = rgba(getComputedStyle(kind).color);
        let background = rgba(getComputedStyle(card).backgroundColor);
        const hasWash = getComputedStyle(row).backgroundImage !== 'none';
        const washToken = washes[tone];
        if (washToken && hasWash) {
          const [washRed, washGreen, washBlue, washAlpha] = rgba(tokens.getPropertyValue(washToken));
          const blend = (value: number, tint: number) => (tint * washAlpha) / 255 + value * (1 - washAlpha / 255);
          const [red, green, blue] = background;
          background = [blend(red, washRed), blend(green, washGreen), blend(blue, washBlue), 255];
        }
        const first = luminance(foreground),
          second = luminance(background);
        return {
          id: row.dataset.eventId,
          tone,
          hasWash,
          unread: row.classList.contains('new'),
          critical: row.classList.contains('crit'),
          ratio: (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05),
          matchesToken: JSON.stringify(foreground) === JSON.stringify(rgba(tokens.getPropertyValue(token))),
        };
      });
    });
    for (const result of contrast) {
      assert.equal(result.matchesToken, true, `${theme} ${result.id} token`);
      assert.equal(result.hasWash, result.critical || (theme === 'Dark' && result.unread), `${theme} ${result.id} wash`);
      assert.ok(result.ratio >= 4.5, `${theme} ${result.id} contrast ${result.ratio}`);
    }
    const trail = page.locator('[data-event-id="canceled-transition"] .trail');
    if (!(await trail.evaluate((element: HTMLDetailsElement) => element.open))) await trail.locator('summary').click();
    await expect(trail.locator('.status-text.warn')).toHaveText('Canceled');
    await expect(trail.locator('.status-text.info')).toHaveCount(2);
    await page.screenshot({ path: `test-results/status-colors-${theme.toLowerCase()}.png`, fullPage: true });
  }
  await page.getByRole('button', { name: 'Light', exact: true }).click();
  await page.locator('[data-event-id="color-completed"] .feed-title').click();
  await expect(page.locator('#page .status-chip')).toHaveClass(/\bok\b/);
  await expect(page.locator('#page .status-chip')).toHaveText('Merged');
  await expect(page.locator('#page .status-chip')).toHaveCSS('color', 'rgb(15, 123, 95)');
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
      await page.evaluate(() => {
        const style = (selector: string) => {
          const element = document.querySelector(selector);
          if (!element) throw new Error(`${selector} is missing.`);
          return getComputedStyle(element);
        };
        return {
          panel: style('#kind-panel').backgroundColor,
          card: style('.feed').backgroundColor,
          option: style('.type-option').color,
          body: getComputedStyle(document.body).color,
        };
      }),
      await page.evaluate(() => {
        const style = (selector: string) => {
          const element = document.querySelector(selector);
          if (!element) throw new Error(`${selector} is missing.`);
          return getComputedStyle(element);
        };
        return {
          panel: style('.feed').backgroundColor,
          card: style('.feed').backgroundColor,
          option: getComputedStyle(document.body).color,
          body: getComputedStyle(document.body).color,
        };
      }),
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
    await panel.getByRole('option', { name: 'CI runs', exact: true }).focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('button', { name: 'Activity type: CI runs', exact: true })).toBeFocused();
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
      await expect(page.locator('li.row .kind')).toHaveText('CI succeeded', { timeout: 8000 });
      await expect(toggle).toBeFocused();
    }
    await toggle.press('ArrowDown');
    await expect(panel.getByRole('option', { name: 'CI runs', exact: true })).toHaveAttribute('aria-selected', 'true');
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
  assert.ok(box);
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
  await expect(page.locator('li.row .kind')).toHaveText('PR merged');
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
  await new Promise<void>(resolve => app.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ executablePath: await browserPath(), headless: true });
  t.after(async () => {
    await browser.close();
    await new Promise(resolve => app.close(resolve));
    store.close();
  });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await rememberKey(page);
  const url = `http://127.0.0.1:${portOf(app)}`;
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
    assert.ok(pill && column && checkout);
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
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const { promise: stateHeld, resolve: releaseState } = Promise.withResolvers<void>();
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
  const reviewers = page.locator('.detail-section', { has: page.getByRole('heading', { name: 'Reviewers', exact: true }) });
  await expect(reviewers.getByRole('listitem').filter({ hasText: 'Redacted 3' }).locator('.chip')).toHaveText(['Required', 'approved']);
  await expect(reviewers.getByRole('listitem').filter({ hasText: 'Redacted 1' }).locator('.status-chip')).toHaveText('waiting for author');
  await expect(reviewers.getByRole('listitem').filter({ hasText: 'Billing reviewers' }).locator('.chip')).toHaveText([
    'Required',
    'no vote',
  ]);
});

test('a pull request detail loads its discussion and policy results only when asked', async t => {
  const { page } = await setup(t);
  await page.locator('[data-event-id="demo-pr-1"] .feed-title').click();
  const detail = page.locator('.detail-data');
  await expect(detail.locator('.discussion-stats')).toHaveCount(0);
  await detail.getByRole('button', { name: 'Load discussion and policies' }).click();
  await expect(detail.locator('.discussion-stats > span')).toHaveText(['2 open threads', '3 resolved']);
  await expect(detail.getByRole('listitem').filter({ hasText: 'Minimum number of reviewers' }).locator('.chip')).toHaveText([
    'Required',
    'waiting',
  ]);
  await expect(detail.getByRole('listitem').filter({ hasText: 'Build' }).locator('.chip')).toHaveText(['Required', 'failed']);
  await expect(detail.getByRole('listitem').filter({ hasText: 'Comment requirements' }).locator('.status-chip')).toHaveText('passed');
  await expect(detail.getByRole('button', { name: 'Reload discussion and policies' })).toBeVisible();
});

test('the launch link works once, hides its token, and a stale or forged link cannot replace a working key', async t => {
  const app = await setup(t);
  const { page, runtime } = app;
  assert.equal(new URL(page.url()).hash.includes('launch='), false);
  // A forged link in a fresh document tries the exchange, fails, and keeps the working key. A separate tab with this run's
  // key stored keeps its expected 401 responses out of the setup's console check.
  const browser = page.context().browser();
  assert.ok(browser);
  const context = await browser.newContext();
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
  const stranger = await browser.newPage();
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
  const server = createApp({ store, provider, sync, accessKey: TEST_KEY });
  let browser: Browser | undefined;
  const errors: string[] = [];
  t.after(async () => {
    gate.closed = false;
    gate.release();
    await browser?.close().catch(() => {});
    await sync.stop();
    if (server.listening) await new Promise(resolve => server.close(resolve));
    store.close();
    assert.deepEqual(errors, []);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  sync.start();
  sync.refresh();
  for (let i = 0; i < 200 && !store.listEvents().length; i++) await new Promise(resolve => setTimeout(resolve, 10));
  browser = await chromium.launch({ executablePath: await browserPath(), headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.on('pageerror', error => errors.push(error.message));
  await rememberKey(page);
  const url = `http://127.0.0.1:${portOf(server)}`;
  await page.goto(`${url}/#activity`);
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

test('the branch tree works with the unread filter and keeps status markers on narrow screens', async t => {
  const { page } = await setup(t);
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
  await expect(page.locator('[data-event-id="demo-build-2"] svg.tree rect.ci-node:not(.lane-none)')).toHaveCount(1);
  // A lane must run unbroken through a row, so each cell covers its row from border to border.
  const [cell, row] = await Promise.all([hotfix.locator('svg.tree').boundingBox(), hotfix.boundingBox()]);
  assert.ok(cell && row);
  assert.ok(Math.abs(cell.y - row.y) <= 1 && Math.abs(cell.y + cell.height - (row.y + row.height)) <= 1, 'tree cell spans the row');
  await expect(hotfix.locator('.kind > svg')).toBeHidden();

  await page.setViewportSize({ width: 420, height: 900 });
  await expect(hotfix.locator('svg.tree')).toBeHidden();
  const glyph = hotfix.locator('.kind > svg');
  await expect(glyph).toBeVisible();
  await expect
    .poll(() =>
      glyph.evaluate(element => {
        const glyph = element.getBoundingClientRect();
        const label = element.parentElement!.getBoundingClientRect();
        const firstLineCentre = label.top + parseFloat(getComputedStyle(element.parentElement!).lineHeight) / 2;
        return Math.abs(glyph.top + glyph.height / 2 - firstLineCentre);
      }),
    )
    .toBeLessThanOrEqual(1);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.getByRole('button', { name: 'Unread only', exact: true }).click();
  await expect(hotfix.locator('svg.tree')).toBeVisible();
  await expect(hotfix.locator('.event-main')).toHaveText('Started at 3f9a2c1, the tip of main');
  await page.setViewportSize({ width: 640, height: 900 });
  await expect(hotfix.locator('svg.tree')).toBeVisible();
  await page.setViewportSize({ width: 390, height: 900 });
  await expect(hotfix.locator('svg.tree')).toBeHidden();
  await expect(hotfix.locator('.kind > svg')).toBeVisible();
});

test('Activity gives wrapped titles room and keeps their event metadata together on desktop', async t => {
  const { page, runtime } = await setup(t);
  // A pull request title long enough to wrap at 1280px.
  runtime.store.insertEvents([
    {
      id: 'long-title-pr',
      repoId: 'demo-orders',
      kind: 'pr',
      title:
        'PR 21431 · DAT-9861: the 12 animal seeds load into seed_standards, bridge views in animal and refined bull, and verify downstream transformations and intermediate reports',
      branch: 'refs/heads/feature/DAT-9861_animal_seeds_standards',
      actor: 'Ana',
      time: new Date().toISOString(),
      data: {
        pullRequestId: 21431,
        status: 'active',
        sourceRefName: 'refs/heads/feature/DAT-9861_animal_seeds_standards',
        targetRefName: 'refs/heads/main',
      },
    },
    {
      id: 'long-branch-ci',
      repoId: 'demo-orders',
      kind: 'build',
      title: 'orders-api PR validation · 20261120.87',
      branch: 'refs/pull/21432/merge',
      actor: 'Ana',
      time: new Date().toISOString(),
      data: {
        buildId: 9001,
        reason: 'pullRequest',
        status: 'completed',
        result: 'succeeded',
        pullRequest: {
          id: 21432,
          sourceRefName: 'refs/heads/feature/DAT-11441-tag-gap-scope-and-product-and-more-words',
          targetRefName: 'refs/heads/main',
        },
      },
    },
  ]);
  await page.reload();
  const longTitle = page.locator('[data-event-id="long-title-pr"] .feed-title .title');
  await expect(longTitle).toBeVisible();
  // The page re-renders as it polls, so box reads retry until a rendered row answers.
  await expect.poll(async () => (await longTitle.boundingBox())?.height ?? 0, { message: 'the long title wraps' }).toBeGreaterThan(30);
  await expect(page.locator('.with-tree .row').first()).toBeVisible();
  const event = page.locator('[data-event-id="long-title-pr"] .event');
  await expect
    .poll(() =>
      event.evaluate(element => {
        const title = element.closest('.row')?.querySelector('.title');
        const meta = element.querySelector('.event-meta');
        if (!title || !meta) return false;
        const content = title.getBoundingClientRect();
        const metadata = meta.getBoundingClientRect();
        return Math.abs(metadata.top - content.top) <= 2 && content.width > element.getBoundingClientRect().width;
      }),
    )
    .toBe(true);

  // At the narrowest wide layout, refs and PR chips stay in the title column.
  await page.setViewportSize({ width: 1100, height: 900 });
  const prRow = page.locator('[data-event-id="long-title-pr"]');
  await expect(prRow.locator('.feed-title')).toHaveAccessibleName(
    /source branch feature\/DAT-9861_animal_seeds_standards targeting branch main/,
  );
  await expect(prRow.locator('svg.tree circle')).toHaveCount(0);
  await expect(prRow.locator('.standalone-pr-ring')).toHaveCount(0);
  const connectedPr = page.locator('[data-event-id="demo-pr-1"]');
  await expect(connectedPr.locator('svg.tree circle.hole')).toBeVisible();
  const destinationFits = async () =>
    prRow.locator('.ref-destination').evaluate(element => {
      const column = element.closest('.subject')?.getBoundingClientRect();
      return !!column && element.getBoundingClientRect().right <= column.right && element.scrollWidth <= element.clientWidth;
    });
  await expect.poll(destinationFits).toBe(true);
  const ciRow = page.locator('[data-event-id="long-branch-ci"]');
  await expect
    .poll(
      async () => {
        const [subject, chip] = await Promise.all([ciRow.locator('.subject').boundingBox(), ciRow.locator('.ref-pr').boundingBox()]);
        return subject && chip ? chip.x + chip.width - (subject.x + subject.width) : Infinity;
      },
      { message: 'PR chip right edge past the title column' },
    )
    .toBeLessThanOrEqual(0);
  await page.screenshot({ path: 'test-results/open-pr-activity-desktop.png' });
  // On a phone the type label shares its line with the taller Seen control, so it centres on it.
  await page.setViewportSize({ width: 390, height: 900 });
  await expect(prRow.locator('.kind > .d')).toBeVisible();
  await expect.poll(destinationFits).toBe(true);
  await page.screenshot({ path: 'test-results/open-pr-activity-phone.png' });
  const centre = (box: { y: number; height: number }) => box.y + box.height / 2;
  const first = page.locator('.rows .row').first();
  await expect
    .poll(
      async () => {
        const [label, seen] = await Promise.all([first.locator('.kind').boundingBox(), first.locator('.seen-toggle').boundingBox()]);
        return label && seen ? Math.abs(centre(label) - centre(seen)) : Infinity;
      },
      { message: 'label centres on Seen' },
    )
    .toBeLessThanOrEqual(1);
});

test('Git Graph shows a merged branch and exact CI links alongside the Activity feed', async t => {
  const { local, repo, checkoutGit, commit } = checkoutFixture(t);
  git(local, 'switch', '-c', 'graph-topic');
  const topic = commit(local, 'topic.txt', 'Feature branch work');
  git(local, 'switch', 'main');
  git(local, 'merge', '--no-ff', 'graph-topic', '-m', 'Merge graph topic');
  const head = git(local, 'rev-parse', 'HEAD');
  const longRef = 'feature/long-reference-for-testing-that-must-not-push-linked-ci-and-pr-offscreen';
  git(local, 'branch', longRef);
  const store = createStore();
  store.saveRepo(repo);
  const time = new Date().toISOString();
  store.insertEvents([
    {
      id: 'finished-pr',
      repoId: repo.id,
      kind: 'pr',
      time,
      title: 'Graph topic PR',
      data: { pullRequestId: 7, status: 'completed', mergeCommit: head },
    },
    {
      id: 'build-on-merge',
      repoId: repo.id,
      kind: 'build',
      time,
      title: 'Merge pipeline',
      data: { buildId: 9, status: 'completed', result: 'succeeded', sourceVersion: head },
    },
    {
      id: 'pr-preview',
      repoId: repo.id,
      kind: 'build',
      time,
      title: 'Preview pipeline',
      branch: 'refs/pull/7/merge',
      data: { buildId: 10, status: 'completed', result: 'failed', sourceVersion: 'f'.repeat(40) },
    },
  ]);
  const app = createApp({
    store,
    checkoutGit,
    provider: stub<AzureProvider>({ checkConnection: async () => stub<ConnectionStatus>({ available: true }) }),
    sync: stub<AppSync>({ status: () => stub<SyncEngineStatus>({ running: false }) }),
    accessKey: TEST_KEY,
  });
  await new Promise<void>(resolve => app.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ executablePath: await browserPath(), headless: true });
  t.after(async () => {
    await browser.close();
    await new Promise(resolve => app.close(resolve));
    store.close();
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await rememberKey(page);
  await page.goto(`http://127.0.0.1:${portOf(app)}/#activity`);
  await page.getByText('Activity lane key', { exact: true }).click();
  await expect(page.getByText(/Lines can pass rows of other branches/)).toBeVisible();
  await page.getByRole('link', { name: 'Open Git Graph', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Git Graph' })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator('.graph-subject').first()).toHaveText('Merge graph topic');
  await expect(page.locator(`#commit-${topic}`)).toContainText('Feature branch work');
  await expect(page.locator(`#commit-${head} .graph-rail path`)).toHaveCount(2);
  await expect(page.getByRole('link', { name: 'CI · Succeeded' })).toHaveAttribute('href', '#event/build-on-merge');
  await expect(page.getByRole('link', { name: 'PR · Merged' })).toHaveAttribute('href', '#event/finished-pr');
  await expect(page.getByRole('link', { name: 'CI · Failed' })).toHaveCount(0);
  await expect(page.locator(`#commit-${head} .graph-ref[title="${longRef}"]`)).toBeVisible();
  for (const width of [390, 1280]) {
    await page.setViewportSize({ width, height: 844 });
    const graph = page.locator('.graph-commits');
    assert.ok(await graph.evaluate(list => list.scrollWidth <= list.clientWidth));
    const marker = await page.locator(`#commit-${head} .graph-rail circle`).boundingBox();
    assert.ok(marker && Math.abs(marker.width - marker.height) < 1, 'Branch nodes stay round as rows wrap');
  }
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);

  for (let i = 0; i < 50; i++) git(local, 'commit', '--allow-empty', '-m', `Later commit ${i}`);
  await page.getByRole('button', { name: 'Reload graph' }).click();
  await page.getByRole('button', { name: 'Load more commits' }).click();
  const build = page.getByRole('link', { name: 'CI · Succeeded' });
  await build.evaluate(link => link.scrollIntoView({ block: 'center' }));
  const scrollY = await page.evaluate(() => window.scrollY);
  assert.ok(scrollY > 1000);
  await build.click();
  await expect(page.locator('#page .status-chip').first()).toHaveText('Succeeded');
  await page.goBack();
  await expect(page.locator('.graph-commit')).toHaveCount(53);
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(scrollY);
  await build.click();
  await expect(page.locator('#page .status-chip').first()).toHaveText('Succeeded');
  await page.getByRole('link', { name: 'Git Graph', exact: true }).click();
  await expect(page.locator('.graph-commit')).toHaveCount(50);
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);

  await page.getByRole('link', { name: 'Activity', exact: true }).click();
  await expect(page.getByRole('button', { name: /^Preview pipeline/ })).toBeVisible();

  await page.getByRole('link', { name: 'Repositories', exact: true }).click();
  git(local, 'switch', 'graph-topic');
  store.resetActivity();
  await page.getByRole('link', { name: 'Git Graph', exact: true }).click();
  await expect(page.locator('.graph-subject').first()).toHaveText('Feature branch work');
  await expect(page.locator('.graph-scope')).toHaveText('graph-topic');
  await expect(page.locator('.graph-link')).toHaveCount(0);

  git(local, 'config', 'core.sshCommand', 'unused');
  await page.getByRole('button', { name: 'Reload graph' }).click();
  await expect(page.getByRole('alert')).toContainText('core.sshcommand');
  await expect(page.locator('.graph-commit')).toHaveCount(0);
  git(local, 'config', '--unset', 'core.sshCommand');
  await page.getByRole('link', { name: 'Activity', exact: true }).click();
  await page.getByRole('link', { name: 'Git Graph', exact: true }).click();
  await expect(page.locator('.graph-subject').first()).toHaveText('Feature branch work');
});

test('Activity keeps the branch tree while exposing merge status, CI and push commits inline', async t => {
  const { page, runtime } = await setup(t);
  const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60000).toISOString();
  const sha = 'a'.repeat(40);
  const main = 'refs/heads/main';
  const base = { repoId: 'demo-billing', branch: 'main' };
  runtime.store.insertEvents([
    {
      ...base,
      id: 'readable-merge',
      seen: true,
      kind: 'pr',
      title: 'PR 504 · Update billing',
      time: minutesAgo(6),
      data: { pullRequestId: 504, status: 'completed', targetRefName: main, mergeCommit: sha },
    },
    {
      ...base,
      id: 'seen-passing-run',
      kind: 'build',
      title: 'Billing CI',
      time: minutesAgo(4),
      seen: true,
      data: { buildId: 521, status: 'completed', result: 'succeeded', reason: 'individualCI', sourceBranch: main, sourceVersion: sha },
    },
    {
      ...base,
      id: 'failed-after-merge',
      kind: 'build',
      title: 'Billing CI',
      time: minutesAgo(3),
      data: { buildId: 520, status: 'completed', result: 'failed', reason: 'individualCI', sourceBranch: main, sourceVersion: sha },
    },
  ]);
  await page.reload();
  const merge = page.locator('[data-event-id="readable-merge"]');
  const failure = page.locator('[data-event-id="failed-after-merge"]');
  await expect(merge.locator('.kind')).toHaveText('PR merged');
  await expect(merge.getByText('Merged into main')).toBeVisible();
  const passing = page.locator('[data-event-id="seen-passing-run"]');
  const seen = merge.locator('.seen-toggle');
  await expect(passing).toHaveCount(0);
  await expect(seen).toHaveAttribute('aria-pressed', 'true');
  await seen.click();
  await expect(seen).toHaveAttribute('aria-pressed', 'false');
  await expect(passing).toHaveCount(0);
  await seen.click();
  await expect(seen).toHaveAttribute('aria-pressed', 'true');
  await expect(passing).toHaveCount(0);
  assert.equal(runtime.store.getEvent('seen-passing-run')?.seen, true);
  const rollup = merge.getByText('CI · 1 failed · 1 passed', { exact: true });
  await expect(rollup.locator('.crit')).toHaveText('1 failed');
  await rollup.focus();
  await page.keyboard.press('Enter');
  await expect(rollup).toBeFocused();
  await expect
    .poll(() =>
      merge.evaluate(row => {
        const cell = row.querySelector('svg.tree')!.getBoundingClientRect();
        const bounds = row.getBoundingClientRect();
        return Math.abs(cell.top - bounds.top) <= 1 && Math.abs(cell.bottom - bounds.bottom) <= 1;
      }),
    )
    .toBe(true);
  await expect(merge.getByRole('button', { name: 'Post-merge CI failed' })).toBeVisible();
  await expect(failure.locator('svg.tree rect.ci-node')).toBeVisible();
  await expect(page.locator('svg.tree .default-lane').first()).toHaveCSS('stroke-width', '2.5px');

  const push = page.locator('[data-event-id="demo-push-1"]');
  const loadCommits = push.getByRole('button', { name: 'Load commits', exact: true });
  await loadCommits.focus();
  await page.keyboard.press('Enter');
  await expect(push.getByRole('button', { name: 'Reload commits', exact: true })).toBeFocused();
  await expect(push.getByText('Cover export retry behavior', { exact: false })).toBeVisible();
  await expect(page).toHaveURL(/#activity$/);
  await page.screenshot({ path: 'test-results/activity-tree-redesign-desktop.png' });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(failure.locator('.kind')).toHaveText('CI failed');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: 'test-results/activity-tree-redesign-mobile.png' });
});

test('Activity shows only highlights and links a landing and quieter CI to its details', async t => {
  const { page, runtime } = await setup(t, true, { highlights: true });
  const head = 'c'.repeat(40);
  const base = { repoId: 'demo-billing', branch: 'main', time: new Date().toISOString() };
  const main = 'refs/heads/main';
  const source = 'refs/heads/feature/DAT-1324_fatty_acids_individual_advice_and_governance';
  const reviewer = { name: 'Required reviewer', required: true, vote: 10 };
  const approval = {
    ...base,
    kind: 'pr' as const,
    title: 'PR 513 · Rework the advice decision tree of fatty_acids_individual_risks and insemination_return_distribution',
    actor: 'Ines Adriaens - Doekes',
    url: 'https://dev.azure.com/demo/project/_git/billing/pullrequest/513',
    data: { status: 'active' as const, pullRequestId: 513, sourceRefName: source, targetRefName: main, previewCommit: 'd'.repeat(40) },
  };
  const branchMilestones: ActivityEvent[] = Array.from({ length: 5 }, (_, index) => {
    const branch = `refs/heads/feature/active-${index}`;
    const pr = {
      repoId: base.repoId,
      branch,
      kind: 'pr' as const,
      title: `PR ${514 + index} · Update model ${index}`,
      data: { status: 'active' as const, pullRequestId: 514 + index, sourceRefName: branch, targetRefName: main },
    };
    return [
      { ...pr, id: `opened-${index}`, time: new Date(Date.parse(base.time) - 120_000 + index * 1000).toISOString() },
      {
        ...pr,
        id: `retargeted-${index}`,
        time: new Date(Date.parse(base.time) + 120_000 + index * 1000).toISOString(),
        data: { ...pr.data, targetRefName: 'refs/heads/integration' },
      },
    ];
  }).flat();
  runtime.store.insertEvents([
    ...branchMilestones,
    {
      ...approval,
      id: 'approval-baseline',
      imported: true,
      time: new Date(Date.parse(base.time) - 60_000).toISOString(),
      data: { ...approval.data, previewCommit: 'e'.repeat(40), reviewers: [{ ...reviewer, vote: 0 }] },
    },
    {
      ...approval,
      id: 'approval-highlight',
      data: { ...approval.data, reviewers: [reviewer], voteChanges: [reviewer] },
    },
    {
      ...base,
      id: 'stale-validation',
      kind: 'build',
      title: 'Billing CI',
      time: new Date(Date.parse(base.time) + 60_000).toISOString(),
      data: {
        sourceBranch: 'refs/pull/513/merge',
        sourceVersion: 'e'.repeat(40),
        buildId: 601,
        status: 'completed',
        result: 'partiallySucceeded',
      },
    },
    {
      ...base,
      id: 'highlight-pr',
      kind: 'pr',
      title: 'PR 512 · Landing in highlights',
      data: { status: 'completed', pullRequestId: 512, targetRefName: main, mergeCommit: head },
    },
    {
      ...base,
      id: 'quiet-landing-push',
      kind: 'push',
      title: 'Landing push',
      data: { refUpdates: [{ name: main, oldObjectId: 'a'.repeat(40), newObjectId: head }] },
    },
    {
      ...base,
      id: 'quiet-pass',
      kind: 'build',
      title: 'Billing CI',
      data: { sourceBranch: main, sourceVersion: head, buildId: 600, status: 'completed', result: 'succeeded' },
    },
    {
      ...base,
      id: 'later-push-to-same-tip',
      kind: 'push',
      title: 'Later default branch push',
      time: new Date(Date.parse(base.time) + 60 * 60_000).toISOString(),
      data: { refUpdates: [{ name: main, oldObjectId: 'b'.repeat(40), newObjectId: head }] },
    },
  ]);
  await page.reload();
  const merge = page.locator('[data-event-id="highlight-pr"]');
  await expect(merge.locator('.kind')).toHaveText('PR merged');
  await expect(merge.getByText('Landed on main', { exact: false })).toBeVisible();
  await expect(merge.getByRole('button', { name: 'Post-merge CI passed' })).toBeVisible();
  await expect(page.locator('[data-event-id="quiet-landing-push"], [data-event-id="quiet-pass"]')).toHaveCount(0);
  await expect(merge.locator('svg.tree')).toBeVisible();
  await expect(page.locator('[data-event-id="later-push-to-same-tip"]')).toContainText('Later default branch push');
  const approved = page.locator('[data-event-id="approval-highlight"]');
  const approvalLabel = approved.locator('.kind');
  const readyLabel = page.locator('[data-event-id="opened-0"] .kind');
  await expect(approvalLabel).toHaveText('Approvals met');
  await expect(approved.locator('.event-meta time')).toHaveCSS('white-space', 'nowrap');
  const statusColor = () => approvalLabel.evaluate(element => getComputedStyle(element).color);
  const sharesStatusColor = (label: typeof approvalLabel) =>
    label.evaluate(element => getComputedStyle(element).color).then(color => statusColor().then(approval => approval === color));
  assert.equal(await sharesStatusColor(readyLabel), false);
  assert.equal(await sharesStatusColor(merge.locator('.kind')), false);
  await expect(approved.locator('.title')).toHaveText(approval.title);
  await expect(approved.locator('.feed-title')).toHaveAccessibleName(/fatty_acids_individual_risks/);
  await expect(approved.locator('.event-meta')).toContainText('PR author Ines Adriaens - Doekes');
  await expect(approved.locator('.ref-repo')).toBeVisible();
  await expect(approved.locator('xpath=..')).toHaveAttribute('data-tree-lanes', '5');
  const longCi = approved.getByRole('button', { name: 'PR validation partially succeeded on earlier revision' });
  await expect(longCi).toBeVisible();
  const rowFits = () =>
    approved.evaluate(row => {
      const kind = row.querySelector('.kind')!;
      const range = document.createRange();
      range.selectNodeContents(kind);
      const rect = range.getBoundingClientRect();
      const bounds = kind.getBoundingClientRect();
      const box = (selector: string) => row.querySelector(selector)!.getBoundingClientRect();
      const overlaps = (a: DOMRect, b: DOMRect) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
      const subject = box('.subject');
      const actions = box('.rowact');
      const event = box('.event');
      const ci = box('.event-ci button');
      return {
        labelFits: rect.right <= bounds.right + 1 && [subject, actions, event].every(area => !overlaps(rect, area)),
        actionsClearTitle: !overlaps(actions, subject),
        ciFits: ci.right <= event.right + 1,
        pageFits: document.documentElement.scrollWidth <= innerWidth,
      };
    });
  const allFit = { labelFits: true, actionsClearTitle: true, ciFits: true, pageFits: true };
  for (const width of [1100, 640, 767, 1278, 320, 390, 639, 1024, 1099, 1536]) {
    await page.setViewportSize({ width, height: 900 });
    await expect.poll(rowFits, { message: `The approval row fits at ${width}px` }).toEqual(allFit);
  }
  await page.setViewportSize({ width: 1278, height: 900 });
  const metadataLeft = (row: typeof approved) => row.locator('.event').evaluate(element => element.getBoundingClientRect().left);
  assert.ok(
    Math.abs((await metadataLeft(approved)) - (await metadataLeft(merge))) <= 1,
    'metadata keeps its alignment on rows with and without an Azure link',
  );
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(page.locator('html')).toHaveClass(/\bdark\b/);
  assert.equal(await sharesStatusColor(readyLabel), false);
  assert.equal(await sharesStatusColor(merge.locator('.kind')), false);
  await approved.scrollIntoViewIfNeeded();
  await page.screenshot({ path: 'test-results/activity-highlights.png' });
  await page.evaluate(() => {
    const rule = new CSSStyleSheet();
    rule.replaceSync(
      '* { line-height: 1.5 !important; letter-spacing: .12em !important; word-spacing: .16em !important; } p { margin-bottom: 2em !important; }',
    );
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, rule];
  });
  await expect.poll(rowFits).toEqual(allFit);
  assert.ok(
    Math.abs((await metadataLeft(approved)) - (await metadataLeft(merge))) <= 1,
    'metadata stays aligned with wider control labels',
  );
  await page.setViewportSize({ width: 320, height: 900 });
  await expect.poll(rowFits).toEqual(allFit);
  await page.evaluate(() => {
    document.adoptedStyleSheets = document.adoptedStyleSheets.slice(0, -1);
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await approved.scrollIntoViewIfNeeded();
  await page.screenshot({ path: 'test-results/activity-highlights-phone.png' });
  await merge.locator('.feed-title').click();
  await page.getByText('Related activity', { exact: false }).click();
  await expect(page.locator('.detail-related h3')).not.toHaveCount(0);
  await expect(page.locator('.detail-related time').first()).toHaveAttribute('datetime', /T/);
  await expect(page.getByRole('link', { name: /Merge of PR 512 pushed to main/ })).toBeVisible();
  await page.getByRole('link', { name: /Billing CI/ }).click();
  await expect(page.getByRole('heading', { name: 'Billing CI' })).toBeVisible();
});
