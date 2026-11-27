import test from 'node:test';
import assert from 'node:assert/strict';
import { expect } from '@playwright/test';
import { groupedFixture } from './fixtures/ui-app.ts';
import { refreshNow } from './fixtures/app.ts';
import { demo, isSeen } from './fixtures/history-app.ts';
import type { Store } from '../server/store.ts';
import type { ActivityEvent } from '../src/activity.ts';

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
  await expect(page.locator('li[data-event-id="seen-push"]')).toBeVisible();
  const importedHistory = page.locator('details[data-group="imported-history"]');
  if ((await importedHistory.getAttribute('open')) === null) await importedHistory.locator('summary').click();
  await expect(page.locator('li[data-event-id="imported-push"]')).toBeVisible();
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

test('unread filtering, paged history, filters and deep links reach events beyond the old 1000 window', async t => {
  const { runtime, page } = await demo(t);
  seedHistory(runtime.store);
  await page.goto(runtime.url + '/#activity/unread');
  await expect(page.locator('li[data-event-id="old-unseen"]')).toBeVisible();
  await page.getByRole('button', { name: 'Unread only', exact: true }).click();
  await expect(page.locator('li.row')).toHaveCount(50);
  await page.getByRole('button', { name: 'Load more', exact: true }).click();
  await expect(page.locator('li.row')).toHaveCount(100);
  await expect(page.getByRole('region', { name: 'Activity summary' })).toContainText('Showing 100 of 1063 items');
  await page.locator('details[data-group="imported-history"] > summary').click();
  const last = page.locator('li.row').last();
  const id = await last.getAttribute('data-event-id');
  await last.locator('.feed-title').click();
  await expect(page.getByRole('link', { name: '← Back to Activity', exact: true })).toBeVisible();
  await page.reload();
  await page.getByRole('link', { name: '← Back to Activity', exact: true }).click();
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

test('paged query reset follows type and repository scope without acknowledging hidden history', async t => {
  const { runtime, page } = await demo(t);
  seedHistory(runtime.store);
  await page.goto(runtime.url + '/#activity');
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

test('idle Activity polling skips history queries at one page and after loading 250 items', async t => {
  const { runtime, page } = await demo(t);
  seedHistory(runtime.store);
  let reads = 0;
  page.on('request', request => {
    if (new URL(request.url()).pathname === '/api/activity') reads++;
  });
  // A refresh runs the same load as the five second poll. The second one starts only after the first has finished.
  async function readsDuringRefresh() {
    const before = reads;
    await refreshNow(page);
    await refreshNow(page);
    return reads - before;
  }
  await page.goto(runtime.url + '/#activity');
  await expect(page.locator('li.row')).toHaveCount(50);
  const one = await readsDuringRefresh();
  for (let count = 100; count <= 250; count += 50) {
    await page.getByRole('button', { name: 'Load more', exact: true }).click();
    await expect(page.locator('li.row')).toHaveCount(count);
  }
  const several = await readsDuringRefresh();
  assert.deepEqual({ one, several }, { one: 0, several: 0 });
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
  await page.goto(runtime.url + '/#activity');
  await expect(page.locator('li.row')).toHaveCount(50);
  await expect(page.locator('li[data-event-id="archived-canceled"]')).toHaveCount(0);
  const toggle = page.getByRole('button', { name: /^Activity type:/ });
  const panel = page.getByRole('listbox', { name: 'Activity type' });
  await toggle.click();
  await expect(panel.getByRole('option', { name: 'Merged', exact: true })).toBeVisible();
  await expect(panel.getByRole('option', { name: 'PR evidence', exact: true })).toBeVisible();
  await panel.getByRole('option', { name: 'Canceled', exact: true }).click();
  await expect(page.locator('li[data-event-id="archived-canceled"] .kind')).toHaveText('CI canceled');
  await expect(page.locator('li.row')).toHaveCount(1);
  await toggle.click();
  await expect(panel.getByRole('option', { name: 'Merged', exact: true })).toBeVisible();
  await panel.getByRole('option', { name: 'PR evidence', exact: true }).click();
  await expect(page.locator('li[data-event-id="archive-1049"]')).toBeVisible();
});
