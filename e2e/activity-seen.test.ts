import test from 'node:test';
import assert from 'node:assert/strict';
import { expect } from '@playwright/test';
import { fetch, setup, groupedFixture } from './fixtures/ui-app.ts';
import { defer, gate } from './fixtures/app.ts';
import type { ActivityEvent } from '../src/contract.d.ts';
import { demo, isSeen } from './fixtures/history-app.ts';

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
  await page.goto(runtime.url + '/#activity/unread');
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
  await page.goto(runtime.url + '/#activity/unread');
  await expect(page.getByRole('button', { name: 'All 2 repositories' })).toBeVisible();
  await page.locator('details[data-group="Activity"] > summary').click();
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
  await page.goto(runtime.url + '/#activity/unread');
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
  await page.goto(runtime.url + '/#activity/unread');
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
    await page.goto(runtime.url + '/#activity/unread');
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
  await page.goto(runtime.url + '/#activity/unread');
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

test('seen feedback waits for its refresh when a background poll is in flight', async t => {
  const { runtime, page } = await demo(t);
  await page.goto(runtime.url + '/#activity/unread');
  // Hold the poll only once the page shows what it will mark.
  await expect(page.getByRole('button', { name: /^Mark all seen/ })).toBeVisible();
  const started = Promise.withResolvers<void>();
  const release = gate(t, 'background poll');
  let holdFirst = true;
  await page.route('**/api/state', async route => {
    const response = await route.fetch();
    if (holdFirst) {
      holdFirst = false;
      started.resolve();
      await release.opened;
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
    release.release();
  }
  await expect(page.locator('#toast')).toContainText('marked seen');
  await expect(page.locator('.feed-actions button')).toHaveCount(0);
});

test('Unread only filters a grouped run by the status it shows and acknowledges only its unseen members', async t => {
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
  await page.goto(runtime.url + '/#activity/unread');
  await expect(page.locator('[data-event-id="scope-succeeded"] .kind')).toHaveText('CI succeeded');
  const toggle = page.getByRole('button', { name: /^Activity type:/ });
  await toggle.click();
  await page.getByRole('option', { name: 'Succeeded', exact: true }).click();
  await expect(page.locator('li.row')).toHaveCount(1);
  await page.getByRole('button', { name: 'Mark all matching seen (1)', exact: true }).click();
  await expect(page.locator('li.row')).toHaveCount(0);
  assert.equal(isSeen(runtime.store, 'scope-running'), true);
  assert.equal(isSeen(runtime.store, 'demo-branch-1'), false);
});

test('People detail only acknowledges the updates that matched the originating row', async t => {
  const { runtime, page } = await demo(t);
  const common = { repoId: 'demo-orders', kind: 'build', time: new Date().toISOString() } satisfies Partial<ActivityEvent>;
  runtime.store.insertEvents([
    { ...common, id: 'alice-build', actor: 'Alice Example', title: 'Alice run', data: { buildId: 18001, status: 'queued' } },
    { ...common, id: 'other-build', actor: 'Chris Example', title: 'Chris run', data: { buildId: 18001, status: 'completed' } },
  ]);
  await page.goto(runtime.url + '/#activity');
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

test('an unread backlog beyond the shown rows is confirmed with its count below and then reads zero', async t => {
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
  await page.goto(runtime.url + '/#activity/unread');
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
  // The poll's interval is created at page load, so the clock goes in before a fresh load of Activity and is paused
  // once the page has read its snapshot. The page then keeps that snapshot until the test acts.
  await page.clock.install();
  // A page left paused takes seconds to close.
  defer(t, () => page.clock.resume());
  await page.goto(runtime.url + '/#activity');
  await page.reload();
  const headline = page.getByRole('region', { name: 'Activity summary' }).locator('.headline b');
  const catchUp = page.getByRole('button', { name: 'Mark all seen (235)', exact: true });
  await expect(headline).toHaveText('235 new items');
  // The clock keeps flowing until the pause, so the target leaves room; a poll the jump fires reads the same snapshot.
  await page.clock.pauseAt(await page.evaluate(() => Date.now() + 5000));
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

test('Unread only offers one bulk action that clears a fully shown list without a dialog', async t => {
  const { runtime, page } = await demo(t);
  const total = runtime.store.queryActivity({ view: 'new' }).newUpdates;
  assert.ok(total > 0 && total < 50);
  runtime.store.setSetting('savedActivityFilters', [
    { id: 'pushes', name: 'Pushes', filters: { view: 'new', search: '', kind: 'push', repoIds: null, people: '' } },
  ]);
  await page.goto(runtime.url + '/#activity/unread');
  const bar = page.locator('.feed-actions button');
  await expect(bar).toHaveCount(1);
  await expect(bar).toHaveText(`Mark all seen (${total})`);
  // The saved-filter picker defers redraws while open; the write's refresh must still land.
  const release = gate(t, 'seen write');
  await page.route(
    '**/api/ack',
    async route => {
      const response = await route.fetch();
      await release.opened;
      await route.fulfill({ response });
    },
    { times: 1 },
  );
  await bar.click();
  await page.getByRole('button', { name: 'Saved filters', exact: true }).click();
  await expect(page.getByRole('listbox', { name: 'Saved filters' })).toBeVisible();
  release.release();
  await expect(page.getByText(`${total} updates marked seen.`)).toBeVisible();
  await expect(page.getByRole('dialog')).not.toBeVisible();
  await expect(page.locator('li[data-event-id]')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('region', { name: 'Activity summary' }).locator('.headline b')).toHaveText('No new updates');
  // With nothing to mark there is no empty action bar.
  await expect(page.locator('.feed-actions')).toHaveCount(0);
  assert.equal(runtime.store.queryActivity({ view: 'new' }).newUpdates, 0);
});
