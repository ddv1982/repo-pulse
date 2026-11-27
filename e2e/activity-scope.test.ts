import test from 'node:test';
import assert from 'node:assert/strict';
import { expect } from '@playwright/test';
import { present } from '../test/fixtures/typed.ts';
import { setup } from './fixtures/ui-app.ts';

test('the repository scope is an Activity filter and leaves the header on every page', async t => {
  const { page } = await setup(t);
  await expect(page.locator('#activity-filters #repo-toggle')).toBeVisible();
  await expect(page.locator('header.app #repo-toggle, header.app #repo-panel')).toHaveCount(0);
  const nav = page.getByRole('navigation', { name: 'Main' });
  for (const name of ['Git Graph', 'Repositories', 'Settings']) {
    await nav.getByRole('link', { name, exact: true }).click();
    await expect(page.getByRole('heading', { name, exact: true, level: 1 })).toBeAttached();
    await expect(page.locator('#repo-toggle, #repo-panel')).toHaveCount(0);
  }
  await nav.getByRole('link', { name: 'Activity', exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  const filters = page.locator('#activity-filters-toggle');
  await expect(page.locator('#repo-toggle')).toBeHidden();
  await expect(filters).toHaveText('Filters');
  await filters.click();
  await expect(page.locator('#activity-filters #repo-toggle')).toBeVisible();
  await page.locator('#repo-toggle').click();
  await page.locator('[data-scope-repo="demo-billing"]').uncheck();
  await expect(filters).toHaveText('Filters · 1');
});

test('a narrowed scope looks like an active filter', async t => {
  const { page } = await setup(t);
  await page.goto(`${page.url().split('#')[0]}#activity/unread`);
  const scope = page.locator('#repo-toggle');
  const unread = page.locator('#unread-only');
  // The panel is a group of checkboxes, not a menu, so the toggle is a plain disclosure.
  await expect(scope).not.toHaveAttribute('aria-haspopup');
  await expect(unread).toHaveAttribute('aria-pressed', 'true');
  for (const theme of ['Light', 'Dark']) {
    await page.getByRole('button', { name: theme, exact: true }).click();
    const look = (selector: string) =>
      page.locator(selector).evaluate(element => {
        const style = getComputedStyle(element);
        return [style.borderColor, style.backgroundColor, style.backgroundImage];
      });
    assert.notDeepEqual(await look('#repo-toggle'), await look('#unread-only'), `${theme}: the full scope is not an active filter`);
    await scope.click();
    await page.locator('[data-scope-repo="demo-billing"]').uncheck();
    await page.keyboard.press('Escape');
    await expect(scope).toHaveAttribute('data-active', 'true');
    await page.mouse.move(0, 0);
    assert.deepEqual(await look('#repo-toggle'), await look('#unread-only'), `${theme}: a narrowed scope matches Unread only`);
    await scope.click();
    await page.getByRole('button', { name: 'All', exact: true }).click();
    await expect(scope).toHaveAttribute('data-active', 'false');
  }
});

test('a long repository list scrolls inside the scope panel while All and None stay in view', async t => {
  const { page, runtime } = await setup(t);
  const first = present(runtime.store.listRepos()[0]);
  for (let index = 0; index < 30; index++)
    runtime.store.saveRepo({ ...first, id: `many-${index}`, azureId: `many-${index}`, name: `many-repository-${index}` });
  await page.reload();
  for (const [width, height] of [
    [1280, 900],
    [925, 900],
    [390, 640],
  ] satisfies [number, number][]) {
    await page.setViewportSize({ width, height });
    if (width < 640) await page.locator('#activity-filters-toggle').click();
    await page.locator('#repo-toggle').click();
    const panel = page.getByRole('group', { name: 'Repositories shown' });
    await expect(panel).toBeVisible();
    const none = panel.getByRole('button', { name: 'None', exact: true });
    await expect(none).toBeInViewport();
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth),
      width,
      `the open panel adds no horizontal scroll at ${width}px`,
    );
    await expect(panel).toBeInViewport({ ratio: 1 });
    const box = present(await panel.boundingBox());
    assert.ok(box.height <= Math.min(height * 0.55, 360) + 80, `panel height ${box.height} at ${width}px`);
    const list = panel.locator('.scope-options');
    assert.ok(await list.evaluate(element => element.scrollHeight > element.clientHeight), `the list scrolls at ${width}px`);
    await page.keyboard.press('End');
    const last = page.locator('[data-scope-repo="many-29"]');
    await expect(last).toBeFocused();
    const shown = present(await list.boundingBox());
    const row = present(await last.locator('xpath=..').boundingBox());
    assert.ok(
      row.y >= shown.y && row.y + row.height <= shown.y + shown.height + 0.5,
      `the last row is scrolled into the list at ${width}px`,
    );
    await expect(none).toBeInViewport();
    assert.deepEqual(present(await panel.boundingBox()), box, `the panel stays put while its list scrolls at ${width}px`);
    await page.keyboard.press('Escape');
  }
});

test('the scope panel closes when focus leaves it, and arrow keys move between repositories', async t => {
  const { page } = await setup(t);
  const scope = page.locator('#repo-toggle');
  const panel = page.getByRole('group', { name: 'Repositories shown' });
  const boxes = page.locator('[data-scope-repo]');
  await scope.focus();
  await page.keyboard.press('ArrowDown');
  await expect(panel).toBeVisible();
  await expect(boxes.nth(0)).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(boxes.nth(1)).toBeFocused();
  await page.keyboard.press('ArrowUp');
  await expect(boxes.nth(0)).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(boxes.nth(1)).toBeFocused();
  await expect(panel).toBeVisible();
  const none = page.getByRole('button', { name: 'None', exact: true });
  await none.focus();
  await page.keyboard.press('ArrowUp');
  await expect(boxes.last()).toBeFocused();
  await none.focus();
  await page.keyboard.press('Tab');
  await expect(panel).toBeHidden();
  await expect(scope).toHaveAttribute('aria-expanded', 'false');
  await expect(page.locator('#unread-only')).toBeFocused();

  await scope.click();
  await expect(panel).toBeVisible();
  await scope.focus();
  await page.keyboard.press('Shift+Tab');
  await expect(panel).toBeHidden();
  await expect(scope).not.toBeFocused();

  await scope.click();
  await boxes.nth(2).focus();
  await page.keyboard.press('Escape');
  await expect(panel).toBeHidden();
  await expect(scope).toBeFocused();
});
