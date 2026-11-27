import test from 'node:test';
import assert from 'node:assert/strict';
import { capture, defer, gate, listen, openPage } from './fixtures/app.ts';
import { expect } from '@playwright/test';
import { createApp } from '../server/runtime.ts';
import { TEST_KEY } from '../test/fixtures/access.ts';
import { createStore } from '../server/store.ts';
import { createSync } from '../server/sync.ts';
import { createAzureCli } from '../server/azure-cli.ts';
import { createAzureClient } from '../server/azure-client.ts';
import type { Repository, ConnectionStatus } from '../src/contract.ts';
import { fetch, renderInBackground, setup, setupPicker } from './fixtures/ui-app.ts';
import type { AppSync } from '../server/routes/context.ts';
import type { AzureProvider } from '../server/azure-client.ts';
import { stub } from '../test/fixtures/typed.ts';
import { demo } from './fixtures/history-app.ts';
import { idleSyncStatus } from '../server/demo.ts';

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
  await page.getByRole('link', { name: 'Activity', exact: true }).click();
  await expect(page.locator('#repo-toggle')).toHaveAccessibleName('1 repository shown');
  await page.locator('#repo-toggle').click();
  await expect(page.locator('#repo-panel [data-scope-repo]')).toHaveCount(2);
  await expect(page.locator('#repo-panel [data-scope-repo="demo-billing"]')).toHaveCount(0);
  await page.locator('#repo-panel [data-scope-repo="demo-shared"]').check();
  await expect(page.locator('#repo-toggle')).toHaveAccessibleName('2 repositories shown');
  await page.locator('#repo-toggle').click();
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
  defer(t, () => store.close());
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
  defer(t, () => cli.close());
  const provider = createAzureClient({ cli });
  const sync = createSync({ store, provider });
  defer(t, () => sync.stop());
  const server = createApp({ store, provider, sync, cli, accessKey: TEST_KEY });
  const url = await listen(t, server);
  sync.start();
  const page = await openPage(t, { key: TEST_KEY });
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
    await capture(page, `picker-${theme.toLowerCase()}.png`, { fullPage: true });
    await page.setViewportSize({ width: 360, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await capture(page, `picker-phone-${theme.toLowerCase()}.png`, { fullPage: true });
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
  const reading = gate(t, 'folder listing');
  await page.route('**/api/folders', async route => {
    await reading.opened;
    await route.continue();
  });
  const search = page.getByRole('combobox', { name: 'Search local repositories' });
  await search.focus();
  await search.fill('beta');
  reading.release();
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

test('compact Settings keeps diagnostics closed until needed and copies the diagnostics alone', async t => {
  const { runtime, page } = await demo(t);
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.goto(runtime.url + '/#settings');
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
    await capture(page, `settings-redesign-${colorScheme}.png`);
  }
  await page.getByText('Troubleshooting', { exact: true }).click();
  await expect(page.locator('.sync-sentence')).toHaveText(/^Synced, last check /);
  await page.getByRole('button', { name: 'Copy diagnostics' }).click();
  await expect(page.getByRole('status').last()).toHaveText('Diagnostics copied.');
  const copied = JSON.parse(await page.evaluate(() => navigator.clipboard.readText()));
  assert.deepEqual(copied, { sync: idleSyncStatus() });
  await page.getByText('What Repo Pulse tracks', { exact: true }).click();
  await expect(page.getByText('A successful build or merged pull request does not confirm deployment.')).toBeVisible();
});

test('Settings shows scoped CLI access and header switches share the automatic check preference', async t => {
  const store = createStore();
  for (const id of ['orders', 'billing']) store.saveRepo(stub<Repository>({ id, name: id, project: 'QA' }));
  defer(t, () => store.close());
  store.saveStream({
    repoId: 'orders',
    stream: 'pushes',
    initialized: true,
    nextAt: new Date().toISOString(),
    lastSuccess: new Date(Date.now() - 3600000).toISOString(),
  });
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
      status: () => idleSyncStatus(),
      // Returns no status, which the page does not read.
      refresh: (() => {
        manual++;
      }) as AppSync['refresh'],
    }),
  });
  const url = await listen(t, app);
  const page = await openPage(t, { viewport: { width: 1280, height: 850 }, key: TEST_KEY });
  await page.goto(`${url}/#settings`);
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
  await capture(page, 'settings-connection-phone-dark.png');
  for (let id = 1; id <= 10; id++) store.saveRepo(stub<Repository>({ id: `extra-${id}`, name: `Extra ${id}` }));
  await page.setViewportSize({ width: 320, height: 812 });
  await page.reload();
  await expect(header.getByLabel('Checks: automatic off', { exact: true })).toBeVisible();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await header.getByLabel('Checks: automatic off', { exact: true }).click();
  const panel = await header.locator('.header-monitoring-menu').boundingBox();
  assert.ok(panel);
  assert.ok(panel.x >= 0 && panel.x + panel.width <= 320);
  await page.keyboard.press('Escape');
  await expect(header.getByRole('switch', { name: 'Automatic checks' })).toHaveCount(0);
});

test('the repository picker list closes when a pointer goes down or focus moves outside it, and stays open while choosing', async t => {
  const { page } = await setupPicker(t);
  const search = page.getByRole('combobox', { name: 'Search local repositories' });
  const list = page.getByRole('listbox', { name: 'Search local repositories' });
  await search.focus();
  await expect(list).toBeVisible();
  await expect(search).toHaveAttribute('aria-expanded', 'true');
  // A pointer going down outside closes it at once, before any click.
  await page.mouse.move(5, 5);
  await page.mouse.down();
  await expect(list).toBeHidden();
  await expect(search).toHaveAttribute('aria-expanded', 'false');
  await page.mouse.up();
  await search.focus();
  await expect(list).toBeVisible();
  // So does focus moving to another control by keyboard.
  await page.getByRole('link', { name: 'Settings', exact: true }).focus();
  await expect(list).toBeHidden();
  // Choosing in the list keeps it open.
  await search.focus();
  await page.getByRole('option').first().click();
  await expect(list).toBeVisible();
});

test('the repository picker list still closes after the viewport crosses the phone breakpoint', async t => {
  const { page } = await setupPicker(t);
  await page.setViewportSize({ width: 1024, height: 800 });
  const search = page.getByRole('combobox', { name: 'Search local repositories' });
  const list = page.getByRole('listbox', { name: 'Search local repositories' });
  await search.focus();
  await expect(list).toBeVisible();
  await page.setViewportSize({ width: 390, height: 800 });
  await expect(list).toBeVisible();
  await expect(search).toHaveAttribute('aria-expanded', 'true');
  await page.getByRole('link', { name: 'Settings', exact: true }).focus();
  await expect(list).toBeHidden();
  await search.focus();
  await page.setViewportSize({ width: 1024, height: 800 });
  await page.getByRole('button', { name: 'Close repository picker' }).click();
  await expect(list).toBeHidden();
});

test('the phone header check menu stays open while the page renders and closes on a click outside or Escape', async t => {
  const { page, runtime } = await setup(t);
  await page.setViewportSize({ width: 375, height: 812 });
  const header = page.locator('#header');
  const trigger = header.getByLabel(/^Checks: automatic/);
  const refresh = header.getByRole('button', { name: /^Refresh activity/ });
  await trigger.click();
  await expect(refresh).toBeVisible();
  await fetch(runtime.url + '/api/demo/event', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  await renderInBackground(page);
  await expect(refresh).toBeVisible();
  await page.locator('#page').click({ position: { x: 5, y: 5 } });
  await expect(refresh).toBeHidden();
  await trigger.click();
  await header.getByRole('switch', { name: 'Automatic checks' }).focus();
  await page.keyboard.press('Escape');
  await expect(refresh).toBeHidden();
  await expect(trigger).toBeFocused();
});

test('after the phone check menu was open, the first desktop Automatic checks click sends the new value', async t => {
  const { page } = await setup(t);
  await page.setViewportSize({ width: 375, height: 812 });
  const header = page.locator('#header');
  await header.getByLabel(/^Checks: automatic on/).click();
  await expect(header.getByRole('button', { name: /^Refresh activity/ })).toBeVisible();
  await page.setViewportSize({ width: 1280, height: 812 });
  const desktop = page.locator('#header-auto-desktop');
  await expect(desktop).toBeChecked();
  const patch = page.waitForRequest(request => request.method() === 'PATCH' && new URL(request.url()).pathname === '/api/settings');
  await desktop.click();
  assert.deepEqual((await patch).postDataJSON(), { refreshEnabled: false });
  await expect(desktop).not.toBeChecked();
});
