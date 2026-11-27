import test from 'node:test';
import assert from 'node:assert/strict';
import { refreshNow, startTestApp } from './fixtures/app.ts';
import { expect } from '@playwright/test';
import { present } from '../test/fixtures/typed.ts';
import { fetch, setup, renderInBackground, setupPicker } from './fixtures/ui-app.ts';
import type { ActivityEvent } from '../src/activity.ts';

type Runtime = Awaited<ReturnType<typeof startTestApp>>['runtime'];

/** An element a test tags in the page, to tell afterwards whether a render kept the same node. */
type Marked = HTMLElement & { marker?: string };

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
  await refreshNow(page);
  await expect(page.locator(`[data-event-id="${incoming.id}"]`)).toBeVisible();
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
    await refreshNow(page);
    await expect(page.locator(`[data-event-id="${incoming.id}"]`)).toBeVisible();
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
  await refreshNow(page);
  await expect(page.locator(`[data-event-id="${incoming.id}"]`)).toBeVisible();
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
  await refreshNow(page);
  await expect(page.locator(`[data-event-id="${incoming.id}"]`)).toBeVisible();
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
  await refreshNow(page);
  await expect(page.locator(`[data-event-id="${incoming.id}"]`)).toBeVisible();
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
  await refreshNow(page);
  await expect(page.locator(`[data-event-id="${incoming.id}"]`)).toBeVisible();
  await expect(panel).toBeVisible();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await expect(orders).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(panel).toBeHidden();
  await expect(toggle).toBeFocused();
});

test('a focused saved-filter option keeps focus while incoming activity renders', async t => {
  const { page, runtime } = await setup(t);
  const filters = (search: string): import('../src/contract.ts').ActivityFilters => ({
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
  await refreshNow(page);
  await expect(page.locator(`[data-event-id="${incoming.id}"]`)).toBeVisible();
  await expect(second).toBeFocused();
});

test('a focused saved-filter option stays on its preset when another preset is deleted, and falls back to the toggle', async t => {
  const { page, runtime } = await setup(t);
  const filters = (search: string): import('../src/contract.ts').ActivityFilters => ({
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

test('opening a toolbar menu closes the scope panel, and a breakpoint change closes it like the other filter menus', async t => {
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
  await expect(scope).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(scope).toBeHidden();
  await page.locator('#activity-filters-toggle').click();
  await expect(page.locator('#repo-toggle')).toHaveAttribute('aria-expanded', 'false');
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
  await refreshNow(page);
  await expect(page.locator(`[data-event-id="${incoming.id}"]`)).toBeVisible();
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
  await refreshNow(page);
  await expect(page.locator(`[data-event-id="${incoming.id}"]`)).toBeVisible();
  assert.equal(await page.evaluate(() => getSelection()?.toString()), selected);
});

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

test('crossing the 640px breakpoint moves focus from a filter menu to its visible trigger or the Filters disclosure', async t => {
  const { page } = await setup(t);
  const active = () => page.evaluate(() => document.activeElement?.id || document.activeElement?.tagName);
  const cases = [
    { name: 'type option', toggle: 'kind-toggle', focus: '#kind-option-all', open: true },
    { name: 'scope checkbox', toggle: 'repo-toggle', focus: '[data-scope-repo="demo-billing"]', open: true },
    { name: 'type toggle', toggle: 'kind-toggle', focus: '#kind-toggle', open: false },
    { name: 'scope toggle', toggle: 'repo-toggle', focus: '#repo-toggle', open: false },
  ];
  for (const { name, toggle, focus, open } of cases) {
    // Wide to narrow: the Filters disclosure collapses and hides the trigger.
    await page.setViewportSize({ width: 1100, height: 900 });
    await page.reload();
    await expect(page.locator(`#${toggle}`)).toBeVisible();
    if (open) await page.locator(`#${toggle}`).click();
    await page.locator(focus).focus();
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.locator('#activity-filters')).toBeHidden();
    await expect.poll(active, { message: `${name}, wide to narrow` }).toBe('activity-filters-toggle');

    // Narrow to wide: the trigger is visible again.
    await page.locator('#activity-filters-toggle').click();
    await expect(page.locator(`#${toggle}`)).toBeVisible();
    if (open) await page.locator(`#${toggle}`).click();
    await page.locator(focus).focus();
    await page.setViewportSize({ width: 1100, height: 900 });
    await expect.poll(active, { message: `${name}, narrow to wide` }).toBe(toggle);
  }
});
