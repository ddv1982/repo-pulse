import test from 'node:test';
import assert from 'node:assert/strict';
import { expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { present } from '../test/fixtures/typed.ts';
import { setup, setupPicker } from './fixtures/ui-app.ts';
import { demo } from './fixtures/history-app.ts';

/** Requests that change state, which a refused action must not send. */
function writes(page: Page) {
  const sent: string[] = [];
  page.on('request', request => {
    if (request.method() !== 'GET') sent.push(`${request.method()} ${new URL(request.url()).pathname}`);
  });
  return sent;
}

test('a Seen toggle without data-mark-seen reports broken markup instead of marking the row unseen', async t => {
  const { page, runtime } = await setup(t);
  await page.goto(`${page.url().split('#')[0]}#activity/unread`);
  const row = page.locator('li[data-event-id]').first();
  await expect(row).toBeVisible();
  const id = present(await row.getAttribute('data-event-id'));
  await row.locator('.seen-toggle').evaluate(toggle => toggle.removeAttribute('data-mark-seen'));
  const sent = writes(page);
  await row.locator('.seen-toggle').click();
  await expect(page.locator('#notice .error-message')).toHaveText(/data-mark-seen/);
  assert.deepEqual(sent, []);
  assert.equal(runtime.store.getEvent(id)?.seen, false);
});

test('a control with an unknown data-action reports it instead of doing nothing', async t => {
  const { page } = await setup(t);
  await page.goto(`${page.url().split('#')[0]}#activity/unread`);
  const toggle = page.locator('li[data-event-id] .seen-toggle').first();
  await toggle.evaluate(element => element.setAttribute('data-action', 'no-such-action'));
  const sent = writes(page);
  await toggle.click();
  await expect(page.locator('#notice .error-message')).toHaveText(/unknown action "no-such-action"/);
  assert.deepEqual(sent, []);
});

test('a saved filter menu item with an unknown action reports it instead of doing nothing', async t => {
  const { page, runtime } = await setup(t);
  runtime.store.setSetting('savedActivityFilters', [
    { id: 'team', name: 'Orders team', filters: { search: '', people: '', kind: '', repoIds: null, view: 'new' } },
  ]);
  await page.reload();
  await page.locator('#saved-filter-toggle').click();
  await page.getByRole('option', { name: /Orders team/ }).click();
  await page.locator('#saved-filter-actions-toggle').click();
  const rename = page.getByRole('menuitem', { name: 'Rename…' });
  await rename.evaluate(element => element.setAttribute('data-filter-action', 'no-such-action'));
  const sent = writes(page);
  await rename.click();
  await expect(page.locator('#notice .error-message')).toHaveText(/unknown action "no-such-action"/);
  await expect(page.locator('#filter-name-dialog')).not.toBeVisible();
  assert.deepEqual(sent, []);
});

test('a picker option with an empty index reports it and selects nothing', async t => {
  const { page } = await setupPicker(t);
  const search = page.getByRole('combobox', { name: 'Search local repositories' });
  await search.focus();
  await expect(page.getByRole('option')).toHaveCount(4);
  const option = page.getByRole('option').nth(1);
  await option.evaluate(element => element.setAttribute('data-picker-option', ''));
  await option.click();
  await expect(page.locator('#notice .error-message')).toHaveText(/data-picker-option/);
  await expect(page.locator('[data-picker-option][aria-selected="true"]')).toHaveCount(0);
  await expect(page.locator('.picker-chips .chip')).toHaveCount(0);
});

test('a picker button with an unknown action reports it instead of doing nothing', async t => {
  const { page } = await setupPicker(t);
  const toggle = page.getByRole('button', { name: /repository picker/ });
  const expanded = await page.getByRole('combobox', { name: 'Search local repositories' }).getAttribute('aria-expanded');
  await toggle.evaluate(element => element.setAttribute('data-picker', 'no-such-action'));
  await toggle.click();
  await expect(page.locator('#notice .error-message')).toHaveText(/unknown picker action "no-such-action"/);
  await expect(page.getByRole('combobox', { name: 'Search local repositories' })).toHaveAttribute('aria-expanded', present(expanded));
});

test('a malformed API error message falls back to the HTTP status', async t => {
  const { page } = await demo(t);
  await page.route('**/api/state', route => route.fulfill({ status: 500, json: { message: {} } }));
  await page.reload();
  await expect(page.locator('#notice')).toContainText('Request failed (500).');
});
