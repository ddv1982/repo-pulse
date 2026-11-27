import test from 'node:test';
import assert from 'node:assert/strict';
import { capture, refreshNow, gate } from './fixtures/app.ts';
import { expect } from '@playwright/test';
import type { SavedActivityFilter } from '../src/contract.d.ts';
import { selectActivityType, setup, groupedFixture } from './fixtures/ui-app.ts';
import { demo } from './fixtures/history-app.ts';
import type { ActivityEvent } from '../src/activity.ts';

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
  await capture(page, 'activity-filter-desktop.png');
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
  await capture(page, 'activity-filter-compact.png');
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
      await refreshNow(page);
      await expect(page.locator('li[data-event-id="type-incoming"]')).toHaveCount(1);
      await expect(panel).toBeVisible();
    }
    await capture(page, `type-filter-${theme.toLowerCase()}.png`);
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
      await refreshNow(page);
      await expect(page.locator('li.row .kind')).toHaveText('CI succeeded');
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

test('People and named filters restore a scoped Activity search after app restart', async t => {
  const { runtime, page, restart } = await demo(t);
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
  await page.goto(runtime.url + '/#activity');
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
  await page.getByRole('button', { name: 'Clear filter', exact: true }).click();
  await expect(presets).toHaveAccessibleName('Saved filters');
  await expect(page.locator('li[data-event-id="text-only"]')).toBeVisible();
  await choosePreset('My team');
  await expect(people).toHaveValue('people:Ali Ex, Bo');
  const mixedSearch = 'result | people:Ali Ex, Bo';
  await people.fill(mixedSearch);
  await page.getByRole('button', { name: /^Alice result/ }).click();
  await expect(page).toHaveURL(/#event\/alice-person$/);
  await page.reload();
  await page.getByRole('link', { name: /Back to Activity/ }).click();
  await expect(people).toHaveValue(mixedSearch);
  await expect(presets).toHaveAccessibleName('Saved filter: My team, modified');
  await expect(page.locator('li[data-event-id="alice-person"]')).toBeVisible();
  await expect(page.locator('li[data-event-id="bob-person"]')).toBeVisible();

  const restarted = await restart();
  assert.notEqual(restarted.url, runtime.url);
  await Promise.all([
    page.waitForResponse(response => response.url() === restarted.url + '/api/state' && response.ok()),
    page.goto(restarted.launchUrl),
  ]);
  await page.goto(restarted.url + '/#activity/unread');
  await choosePreset('My team');
  await expect(page).toHaveURL(/#activity$/);
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
});

test('saved filters stay available on mobile, apply on keyboard selection, and save variations explicitly', async t => {
  const { runtime, page } = await demo(t);
  const filter = (view: 'new' | 'all') => ({ search: '', people: '', kind: '', repoIds: null, view });
  const longName = 'A'.repeat(80);
  runtime.store.setSetting('savedActivityFilters', [
    { id: 'new', name: 'New changes', filters: filter('new') },
    { id: 'all', name: longName, filters: filter('all') },
  ]);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(runtime.url + '/#activity/unread');
  const toggle = page.locator('#saved-filter-toggle');
  const drawer = page.locator('#activity-filters');
  const picker = page.getByRole('listbox', { name: 'Saved filters' });
  const option = picker.getByRole('option', { name: new RegExp(longName) });
  await expect(drawer).toBeHidden();
  await toggle.press('ArrowDown');
  await page.keyboard.press('End');
  await expect(option).toBeFocused();
  await expect(page).toHaveURL(/#activity\/unread$/);
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
  await expect(page).toHaveURL(/#activity$/);
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
  await page.goto(runtime.url + '/#activity/unread');
  await page.getByRole('button', { name: 'Save filter…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Save Activity filter' });
  await dialog.getByRole('textbox', { name: 'Filter name' }).fill('Fresh preset');
  const captured = Promise.withResolvers<void>();
  const release = gate(t, 'older state response');
  await page.route(
    '**/api/state',
    async route => {
      const response = await route.fetch();
      captured.resolve();
      await release.opened;
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
    release.release();
    await expect(page.locator('#saved-filter-toggle')).toHaveAccessibleName('Saved filter: Fresh preset');
    await expect(page.getByRole('button', { name: 'More saved filter actions' })).toBeVisible();
  } finally {
    release.release();
  }
});

test('an Activity response renders while a saved-filter menu stays open, and deletes keep newer selections', async t => {
  const { runtime, page } = await demo(t);
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
  await page.goto(runtime.url + '/#activity/unread');
  await page.reload();
  const toggle = page.locator('#saved-filter-toggle');
  const search = page.getByRole('searchbox', { name: 'Search activity' });
  const activity = page.getByRole('region', { name: 'Repository activity' });
  await expect(toggle).toBeVisible();
  let delayed: { term: string; release: ReturnType<typeof gate> } | undefined;
  await page.route(/\/api\/activity\?/, async route => {
    if (new URL(route.request().url()).searchParams.get('search') === delayed?.term) await delayed.release.opened;
    await route.continue();
  });
  async function respondWithMenuOpen(term: string, menu = toggle) {
    const release = gate(t, `activity response for ${term}`);
    delayed = { term, release };
    const matches = (url: string) => new URL(url).searchParams.get('search') === term;
    try {
      const started = page.waitForRequest(request => matches(request.url()), { timeout: 5000 });
      await search.fill(term);
      await started;
      await menu.press('ArrowDown');
      const completed = page.waitForResponse(response => matches(response.url()), { timeout: 5000 });
      release.release();
      await completed;
      // The response renders at once; the menu stays open with focus inside it.
      await expect(emptyFeed).toBeVisible();
      await expect(menu).toHaveAttribute('aria-expanded', 'true');
      await expect(page.locator(`#${await menu.getAttribute('aria-controls')}`)).toBeVisible();
      assert.equal(await menu.evaluate(element => element.closest('.menu')?.contains(document.activeElement)), true);
    } finally {
      release.release();
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
  const finishDelete = gate(t, 'filter delete');
  await page.route('**/api/activity-filters/first', async route => {
    await finishDelete.opened;
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
    finishDelete.release();
    await expect(page.getByRole('status').filter({ hasText: 'Saved filter deleted.' })).toBeVisible();
    await expect(toggle).toHaveAccessibleName('Saved filter: Second preset');
    await expect(search).toHaveValue('second');
  } finally {
    finishDelete.release();
  }
});
