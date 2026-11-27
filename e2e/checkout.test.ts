import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanupStack, defer, listen, openPage, capture } from './fixtures/app.ts';
import { readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { expect } from '@playwright/test';
import { createApp } from '../server/runtime.ts';
import { TEST_KEY } from '../test/fixtures/access.ts';
import { checkoutFixture, git } from '../test/fixtures/checkout.ts';
import { createStore } from '../server/store.ts';
import type { AppSync } from '../server/routes/context.ts';
import type { AzureProvider } from '../server/azure-client.ts';
import type { ConnectionStatus, Repository, Repository as LinkedRepo } from '../src/contract.ts';
import { stub } from '../test/fixtures/typed.ts';
import { idleSyncStatus } from '../server/demo.ts';

test('a New branch detail reviews a rewritten tracking ref before switching, then pulls without leaving the detail', async t => {
  const { source, local, repo, checkoutGit, commit, original } = checkoutFixture(cleanupStack(t));
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
  defer(t, () => store.close());
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
    status: () => idleSyncStatus(),
  });
  const app = createApp({ store, provider, sync, checkoutGit, accessKey: TEST_KEY });
  const url = await listen(t, app);
  const page = await openPage(t, { viewport: { width: 390, height: 844 }, key: TEST_KEY });
  page.setDefaultTimeout(5000);
  await page.goto(`${url}/#activity`);
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

  await expect(page).toHaveURL(/#event\//);
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

  await expect(page.getByRole('link', { name: 'View in Repositories' })).toBeVisible();
  git(local, 'switch', 'main');
  await expect(page.getByRole('button', { name: `Switch to ${branch}…` })).toBeVisible({ timeout: 12000 });
  await page.getByRole('link', { name: /Back to Activity/ }).click();
  await expect(page.locator('#feed-search')).toHaveValue('checkout-from-activity');
});

test('Repositories switches between watched branches, and a merged pull request switches back to main', async t => {
  const { source, local, repo, checkoutGit, commit, original } = checkoutFixture(cleanupStack(t));
  git(source, 'switch', '-c', 'topic');
  commit(source, 'topic.txt', 'topic work');
  git(source, 'push', 'origin', 'topic');
  const store = createStore();
  defer(t, () => store.close());
  store.saveRepo(stub<Repository>(repo));
  const ref = (name: string, lastPushId: number): import('../server/store-records.ts').Entity => ({
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
    status: () => idleSyncStatus(),
  });
  const app = createApp({ store, provider, sync, checkoutGit, accessKey: TEST_KEY });
  const url = await listen(t, app);
  const page = await openPage(t, { viewport: { width: 390, height: 844 }, key: TEST_KEY });
  page.setDefaultTimeout(5000);
  await page.goto(`${url}/#repositories`);
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

  await page.goto(`${url}/#event/merged-topic`);
  await page.getByRole('button', { name: 'Switch to main…' }).click();
  await confirmDialog.getByRole('button', { name: 'Switch branch', exact: true }).click();
  await expect(page).toHaveURL(/#event\/merged-topic$/);
  await expect(checkout.locator('.checkout-state > code').first()).toHaveText('main');
  assert.equal(git(local, 'branch', '--show-current'), 'main');
  assert.equal(git(local, 'rev-parse', 'HEAD'), original);
});

test('Repositories shows the checkout, checks on demand, and pulls only after confirmation', async t => {
  const { checkoutFixture, git } = await import('../test/fixtures/checkout.ts');
  const fixture = checkoutFixture(cleanupStack(t));
  const store = createStore();
  defer(t, () => store.close());
  store.saveRepo(stub<Repository>(fixture.repo));
  store.setSetting('refreshEnabled', false);
  store.saveStream({
    repoId: 'repo',
    stream: 'pushes',
    initialized: true,
    nextAt: new Date().toISOString(),
    lastSuccess: new Date(Date.now() - 60 * 60_000).toISOString(),
  });
  const app = createApp({
    accessKey: TEST_KEY,
    store,
    checkoutGit: fixture.checkoutGit,
    provider: stub<AzureProvider>({ checkConnection: async () => stub<ConnectionStatus>({ available: true }) }),
    sync: stub<AppSync>({ status: () => idleSyncStatus() }),
  });
  const base = await listen(t, app);
  const page = await openPage(t, { key: TEST_KEY });
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
  await capture(page, 'repository-branch-up-to-date-light.png');
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
  await capture(page, 'repository-update-options-dark.png');
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.emulateMedia({ colorScheme: 'light' });
  const beforeRecheck = await lastGitCheck.getAttribute('datetime');
  assert.ok(beforeRecheck !== null);
  await check.click();
  await expect(lastGitCheck).not.toHaveAttribute('datetime', beforeRecheck);
  await expect(row.getByText(/Try Pull first/)).toBeVisible();
  assert.equal(git(fixture.local, 'rev-parse', 'HEAD'), fixture.original);
  await row.getByLabel('Details for Orders').click();
  await capture(page, 'repository-checkout-light.png');
  await page.setViewportSize({ width: 375, height: 812 });
  await page.emulateMedia({ colorScheme: 'dark' });
  await capture(page, 'repository-checkout-dark.png');
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
  await capture(page, 'repository-branch-up-to-date-dark.png');
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

test('verified PR follow-up switches, reviews and removes the old branch from Repositories', async t => {
  const { squashFixture, git } = await import('../test/fixtures/checkout.ts');
  const { repo, pr, local, remote } = squashFixture(cleanupStack(t));
  const { createCheckoutGit } = await import('../server/checkout-git.ts');
  const oldBranch = 'feature/poc_while_rewriting_delphi_sql_and_testing_the_updated_checkout';
  git(local, 'branch', '-m', oldBranch);
  git(local, 'fetch', 'origin', 'release');
  git(local, 'branch', '--track', 'release', 'origin/release');
  const store = createStore();
  defer(t, () => store.close());
  store.saveRepo(stub<Repository>(repo));
  store.setSetting('refreshEnabled', false);
  let clock = Date.now();
  const checkoutGit = createCheckoutGit({ matchesRemote: url => url === remote, findPulls: async () => [pr], now: () => clock });
  const app = createApp({
    accessKey: TEST_KEY,
    store,
    checkoutGit,
    provider: stub<AzureProvider>({ checkConnection: async () => stub<ConnectionStatus>({ available: true }) }),
    sync: stub<AppSync>({ status: () => idleSyncStatus() }),
  });
  const url = await listen(t, app);
  const page = await openPage(t, { viewport: { width: 375, height: 812 }, colorScheme: 'dark', key: TEST_KEY });
  await page.goto(`${url}/#repositories`);
  const row = page.getByRole('article');
  await expect(row.locator('code').first()).toHaveText(oldBranch);
  await row.locator('summary').click();
  await row.getByRole('button', { name: 'Check for updates' }).click();
  const switchButton = row.getByRole('button', { name: 'Switch to release and update' });
  await expect(switchButton).toBeVisible();
  await capture(page, 'repo-checkout-follow-up-phone-dark.png');
  await page.setViewportSize({ width: 1280, height: 850 });
  await page.emulateMedia({ colorScheme: 'light' });
  const layout = await row.locator('.checkout-guidance').boundingBox();
  assert.ok(layout);
  assert.ok(layout.width > 1000);
  await capture(page, 'repo-checkout-follow-up-desktop-light.png');
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
  await expect(removal).toHaveAccessibleDescription(new RegExp(oldBranch));
  for (const [width, colorScheme] of [
    [1280, 'dark'],
    [320, 'light'],
  ] as const) {
    await page.setViewportSize({ width, height: 812 });
    await page.emulateMedia({ colorScheme });
    await expect.poll(() => removal.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    await expect(removal.getByRole('button', { name: 'Cancel' })).toBeInViewport();
    await expect(removal.getByRole('button', { name: 'Remove local branch' })).toBeInViewport();
    await capture(page, `confirm-remove-branch-${colorScheme}.png`);
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

test('ticked follow-up commits survive a checkout snapshot poll that changes the snapshot', async t => {
  const { squashFixture, git, expectedOf } = await import('../test/fixtures/checkout.ts');
  const { repo, pr, local, remote, commit } = squashFixture(cleanupStack(t));
  const { createCheckoutGit } = await import('../server/checkout-git.ts');
  git(local, 'config', 'user.email', 'test@example.test');
  git(local, 'config', 'user.name', 'Test');
  commit(local, 'first.txt', 'first local commit');
  commit(local, 'second.txt', 'second local commit');
  git(local, 'fetch', 'origin', 'release');
  git(local, 'branch', '--track', 'release', 'origin/release');
  const store = createStore();
  defer(t, () => store.close());
  store.saveRepo(stub<Repository>(repo));
  store.setSetting('refreshEnabled', false);
  let clock = Date.now();
  const checkoutGit = createCheckoutGit({ matchesRemote: url => url === remote, findPulls: async () => [pr], now: () => clock });
  const app = createApp({
    accessKey: TEST_KEY,
    store,
    checkoutGit,
    provider: stub<AzureProvider>({ checkConnection: async () => stub<ConnectionStatus>({ available: true }) }),
    sync: stub<AppSync>({ status: () => idleSyncStatus() }),
  });
  const url = await listen(t, app);
  const page = await openPage(t, { viewport: { width: 1280, height: 850 }, key: TEST_KEY });
  await page.goto(`${url}/#repositories`);
  const row = page.getByRole('article');
  await row.locator('summary').click();
  await row.getByRole('button', { name: 'Check for updates' }).click();
  await row.getByRole('button', { name: 'Switch to release and update' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Switch and update' }).click();
  await row.getByRole('button', { name: 'Review old branch' }).click();
  const second = row.getByRole('checkbox', { name: /second local commit/ });
  await second.check();
  await expect(second).toBeChecked();
  const before = await row.innerText();

  // A Check from another tab records a new last check, so the next poll returns a different snapshot for the same
  // checkout, head and follow-up.
  clock += 60000;
  await checkoutGit.update(stub<LinkedRepo>(repo), 'check', expectedOf(await checkoutGit.status(stub<LinkedRepo>(repo))));
  clock += 60000;
  const polled = page.waitForResponse(response => response.url().includes('/api/checkouts') && response.ok());
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await polled;
  await expect.poll(() => row.innerText()).not.toBe(before);
  await expect(row.getByRole('checkbox', { name: /second local commit/ })).toBeChecked();
});
