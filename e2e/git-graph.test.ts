import test from 'node:test';
import assert from 'node:assert/strict';
import { capture, cleanupStack, defer, listen, openPage, refreshNow } from './fixtures/app.ts';
import { createCheckoutGit } from '../server/checkout-git.ts';
import { expect } from '@playwright/test';
import { TEST_KEY } from '../test/fixtures/access.ts';
import { checkoutFixture, git } from '../test/fixtures/checkout.ts';
import { createStore } from '../server/store.ts';
import { present } from '../test/fixtures/typed.ts';
import { setup } from './fixtures/ui-app.ts';
import { testApp } from '../test/fixtures/app.ts';

test('Git Graph shows a merged branch and exact CI links alongside the Activity feed', async t => {
  const { source, local, repo, checkoutGit, commit } = checkoutFixture(cleanupStack(t));
  git(local, 'switch', '-c', 'graph-topic');
  const topicSubject = 'Feature branch work · Andre\u0301 Lane';
  git(local, 'commit', '--allow-empty', '--author', 'José van Dijk <jose@example.test>', '-m', topicSubject);
  const topic = git(local, 'rev-parse', 'HEAD');
  git(local, 'push', '--set-upstream', 'origin', 'graph-topic');
  git(source, 'fetch', 'origin');
  git(source, 'switch', '--track', 'origin/graph-topic');
  git(local, 'switch', 'main');
  git(local, 'merge', '--no-ff', 'graph-topic', '-m', 'Merge graph topic');
  const head = git(local, 'rev-parse', 'HEAD');
  const longRef = 'feature/long-reference-for-testing-that-must-not-push-linked-ci-and-pr-offscreen';
  git(local, 'branch', longRef);
  const store = createStore();
  defer(t, () => store.close());
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
  const app = testApp({ store, checkoutGit });
  const url = await listen(t, app);
  const page = await openPage(t, { key: TEST_KEY });
  await page.goto(`${url}/#activity`);
  await page.getByText('Activity lane key', { exact: true }).click();
  await expect(page.getByText(/Lines can pass rows of other branches/)).toBeVisible();
  await page.getByRole('link', { name: 'Open Git Graph', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Git Graph' })).toBeVisible();
  await expect(page.locator('#graph-repo option').first()).toHaveText(`${repo.name} · ${repo.project}`);
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 844 });
    const heights = await page
      .locator('#graph-repo, #graph-reload')
      .evaluateAll(controls => controls.map(control => control.getBoundingClientRect().height));
    assert.equal(heights.length, 2);
    assert.equal(heights[0], heights[1], `Repository select and Reload graph share a height at ${width}px`);
  }
  await expect(page.locator('.graph-subject').first()).toHaveText('Merge graph topic');
  await expect(page.locator(`#commit-${topic}`)).toContainText('Feature branch work');
  await expect(page.locator(`#commit-${head} .graph-rail path`)).toHaveCount(2);
  await expect(page.getByRole('link', { name: 'CI · Succeeded' })).toHaveAttribute('href', '#event/build-on-merge');
  await expect(page.getByRole('link', { name: 'CI · Succeeded' }).locator('time')).toHaveAttribute('datetime', time);
  await expect(page.getByRole('link', { name: 'PR · Merged' })).toHaveAttribute('href', '#event/finished-pr');
  await expect(page.getByRole('link', { name: 'CI · Failed' })).toHaveCount(0);
  await expect(page.locator(`#commit-${head} .graph-ref[title="${longRef}"]`)).toBeVisible();
  const search = page.getByRole('searchbox', { name: 'Search commits' });
  await page.keyboard.press('/');
  await expect(search).toBeFocused();
  const mergeEdges = page.locator(`#commit-${head} .graph-rail path`);
  const paths = await mergeEdges.evaluateAll(edges => edges.map(edge => edge.getAttribute('d')));
  await search.fill('Feature | people:Jo Dij');
  await expect(page.locator('.graph-match')).toHaveCount(1);
  await expect(page.locator('.graph-match')).toHaveAttribute('id', `commit-${topic}`);
  await expect(search).toBeFocused();
  assert.deepEqual(await mergeEdges.evaluateAll(edges => edges.map(edge => edge.getAttribute('d'))), paths);
  for (const query of [topic.slice(0, 9), '\u0301 Lane']) {
    await search.fill(query);
    await expect(page.locator('.graph-match')).toHaveAttribute('id', `commit-${topic}`);
  }
  await search.fill(topic.slice(-12));
  await expect(page.locator('.graph-match')).toHaveCount(0);
  for (const query of [longRef, 'HEAD']) {
    await search.fill(query);
    await expect(page.locator('.graph-match')).toHaveAttribute('id', `commit-${head}`);
  }
  await search.fill(`people:${Array.from({ length: 13 }, (_, i) => `Person ${i}`).join(', ')}`);
  await expect(page.getByText('Enter up to 12 names and 300 characters in People.')).toBeVisible();
  await expect(page.locator('.graph-commit')).toHaveCount(3);
  await search.fill('Merge graph topic, Feature branch work');
  await page.getByRole('button', { name: 'Next match' }).click();
  await expect(page.getByText('Match 1 of 2', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: 'Next match' }).click();
  await expect(page.getByText('Match 2 of 2', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: 'Previous match' }).click();
  await expect(page.getByText('Match 1 of 2', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: 'Clear search' }).click();
  await expect(search).toBeFocused();
  await expect(search).toHaveValue('');
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
  await search.fill('people:Jo Dij');
  await page.getByRole('button', { name: 'Reload graph' }).click();
  await expect(page.getByText('0 matches in 50 loaded commits', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: 'Load more commits' }).click();
  await expect(page.getByText('1 match in 53 loaded commits')).toBeVisible();
  const build = page.getByRole('link', { name: 'CI · Succeeded' });
  await build.evaluate(link => link.scrollIntoView({ block: 'center' }));
  const scrollY = await page.evaluate(() => window.scrollY);
  assert.ok(scrollY > 1000);
  await build.click();
  await expect(page.locator('#page .status-chip').first()).toHaveText('Succeeded');
  await page.getByRole('link', { name: /Back to Git Graph/ }).click();
  await expect(page.locator('.graph-commit')).toHaveCount(53);
  await expect(build).toBeFocused();
  await expect(search).toHaveValue('people:Jo Dij');
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(scrollY);
  await build.click();
  await expect(page.locator('#page .status-chip').first()).toHaveText('Succeeded');
  await page.getByRole('link', { name: 'Git Graph', exact: true }).click();
  await expect(page.locator('.graph-commit')).toHaveCount(50);
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);

  await page.getByRole('link', { name: 'Activity', exact: true }).click();
  await expect(page.getByRole('button', { name: /^Preview pipeline/ })).toBeVisible();
  const activitySearch = page.getByRole('searchbox', { name: 'Search activity' });
  if (!(await activitySearch.isVisible())) await page.getByRole('button', { name: 'Filters', exact: true }).click();
  await expect(activitySearch).toHaveValue('');
  await activitySearch.fill('Preview pipeline');

  await page.getByRole('link', { name: 'Repositories', exact: true }).click();
  git(local, 'switch', 'graph-topic');
  store.resetActivity();
  store.commitPage({
    repoId: repo.id,
    entities: ['main', 'graph-topic'].map(name => ({ type: 'ref' as const, id: `refs/heads/${name}`, data: { active: true } })),
  });
  await page.getByRole('link', { name: 'Git Graph', exact: true }).click();
  await expect(page.locator('.graph-subject').first()).toHaveText(topicSubject);
  await expect(page.locator('.checkout-bar')).toContainText('graph-topic');
  await expect(search).toHaveValue('people:Jo Dij');
  await expect(page.locator('.graph-link')).toHaveCount(0);

  git(local, 'config', 'core.sshCommand', 'unused');
  await page.getByRole('button', { name: 'Reload graph' }).click();
  await expect(page.getByRole('alert')).toContainText('core.sshcommand');
  await expect(page.locator('.graph-commit')).toHaveCount(0);
  git(local, 'config', '--unset', 'core.sshCommand');
  await page.getByRole('link', { name: 'Activity', exact: true }).click();
  await page.getByRole('link', { name: 'Git Graph', exact: true }).click();
  await expect(page.locator('.graph-subject').first()).toHaveText(topicSubject);

  const checkout = page.locator('.checkout-bar');
  const remoteTip = commit(source, 'graph-remote.txt', 'Graph upstream update');
  git(source, 'push', 'origin', 'graph-topic');
  await checkout.getByRole('button', { name: 'Check for updates' }).click();
  await expect(checkout).toContainText('1 commit behind');
  await expect(page.locator(`#commit-${remoteTip}`)).toBeVisible();
  assert.equal(git(local, 'rev-parse', 'HEAD'), topic);
  await checkout.getByRole('button', { name: 'Pull', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Pull', exact: true }).click();
  await expect(page.locator(`#commit-${remoteTip}`)).toHaveAttribute('aria-current', 'true');
  await expect(search).toHaveValue('people:Jo Dij');

  const switchButton = checkout.getByRole('button', { name: 'Switch branch…' });
  const picker = page.locator('#branch-dialog');
  await switchButton.click();
  await page.keyboard.press('Escape');
  await expect(switchButton).toBeFocused();
  await switchButton.click();
  await picker.getByRole('button', { name: /^main/ }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Switch branch', exact: true }).click();
  await expect(page.locator('.checkout-bar .checkout-state > code').first()).toHaveText('main');
  await expect(page.locator('.graph-subject').first()).toHaveText('Later commit 49');

  git(local, 'switch', 'graph-topic');
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(page.getByText('Checkout changed. Reload the graph to see the current history.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Load more commits' })).toBeDisabled();
  await page.getByRole('button', { name: 'Reload graph' }).click();
  await expect(page.locator('.graph-subject').first()).toHaveText('Graph upstream update');
  await capture(page, 'git-graph-checkout-phone.png');

  git(local, 'switch', 'main');
  store.insertEvents([
    {
      id: 'topic-ci',
      repoId: repo.id,
      kind: 'build',
      time,
      title: 'Topic CI',
      data: { buildId: 16, status: 'completed', result: 'failed', sourceVersion: topic, sourceBranch: 'refs/heads/graph-topic' },
    },
  ]);
  await page.getByRole('button', { name: 'Reload graph' }).click();
  await expect(page.locator('.graph-subject').first()).toHaveText('Later commit 49');
  await page.getByRole('button', { name: 'Load more commits' }).click();
  await page.getByRole('link', { name: 'CI · Failed' }).click();
  await page.getByRole('button', { name: 'Switch to graph-topic…' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Switch branch', exact: true }).click();
  await expect(page.locator('.checkout-bar .checkout-state > code').first()).toHaveText('graph-topic');
  await page.getByRole('link', { name: /Back to Git Graph/ }).click();
  await expect(page.locator('.graph-subject').first()).toHaveText('Graph upstream update');
  await expect(search).toHaveValue('people:Jo Dij');
  await expect(page.getByRole('button', { name: 'Load more commits' })).toHaveCount(0);
});

test('picking a repository with the pointer leaves no focus ring, while keyboard focus still shows one', async t => {
  const { page } = await setup(t);
  await page.getByRole('link', { name: 'Git Graph', exact: true }).click();
  const select = page.locator('#graph-repo');
  const ring = () =>
    select.evaluate(element => ({ focusVisible: element.matches(':focus-visible'), outline: getComputedStyle(element).outlineStyle }));
  for (const theme of ['Light', 'Dark']) {
    await page.getByRole('button', { name: theme, exact: true }).click();
    const current = await select.inputValue();
    await select.click();
    assert.deepEqual(await ring(), { focusVisible: false, outline: 'none' }, `${theme}: opening with the pointer`);
    const other = page.locator('#graph-repo option:not(:checked)').first();
    const value = present(await other.getAttribute('value'));
    await other.click();
    await expect(select).toHaveValue(value);
    assert.notEqual(value, current);
    await expect(select).toBeFocused();
    assert.deepEqual(await ring(), { focusVisible: false, outline: 'none' }, `${theme}: after a pointer pick`);
    await page.keyboard.press('Shift+Tab');
    await page.keyboard.press('Tab');
    await expect(select).toBeFocused();
    assert.deepEqual(await ring(), { focusVisible: true, outline: 'solid' }, `${theme}: keyboard focus`);
  }
});

test('a long repository name wraps inside the picker on a narrow screen', async t => {
  const { page, runtime } = await setup(t);
  const first = present(runtime.store.listRepos()[0]);
  const name = 'customer-onboarding-and-identity-verification-service';
  runtime.store.saveRepo({ ...first, id: 'long-name', azureId: 'long-name', name, project: 'Regulatory Reporting Platform' });
  await page.setViewportSize({ width: 320, height: 640 });
  await page.reload();
  await page.getByRole('link', { name: 'Git Graph', exact: true }).click();
  await page.locator('#graph-repo').click();
  const option = page.locator('#graph-repo option', { hasText: name });
  await expect(option).toBeVisible();
  const box = present(await option.boundingBox());
  assert.ok(box.x >= 0 && box.x + box.width <= 320, `the option spans ${box.x} to ${box.x + box.width} on a 320px screen`);
  await expect(option).toContainText('Regulatory Reporting Platform');
});

test('a state answer that disables the shown repository moves the graph to the next one while its selector has focus', async t => {
  const cleanup = cleanupStack(t);
  const first = checkoutFixture(cleanup);
  const second = checkoutFixture(cleanup);
  const subjectA = first.commit(first.local, 'a.txt', 'Only in repository A');
  const subjectB = second.commit(second.local, 'b.txt', 'Only in repository B');
  const repoA = { ...first.repo, id: 'repo-a', azureId: 'repo-a', name: 'Alpha' };
  const repoB = { ...second.repo, id: 'repo-b', azureId: 'repo-b', name: 'Beta' };
  const store = createStore();
  defer(t, () => store.close());
  store.saveRepo(repoA);
  store.saveRepo(repoB);
  const app = createApp({
    store,
    checkoutGit: createCheckoutGit({ matchesRemote: url => url === first.remote || url === second.remote }),
    provider: stub<AzureProvider>({ checkConnection: async () => stub<ConnectionStatus>({ available: true }) }),
    sync: stub<AppSync>({ status: () => idleSyncStatus() }),
    accessKey: TEST_KEY,
  });
  const url = await listen(t, app);
  const page = await openPage(t, { key: TEST_KEY });
  const graphReads: string[] = [];
  page.on('request', request => {
    const match = /\/api\/repos\/([^/]+)\/graph/.exec(new URL(request.url()).pathname);
    if (match?.[1]) graphReads.push(match[1]);
  });
  await page.goto(`${url}/#graph`);
  const select = page.locator('#graph-repo');
  await expect(select).toHaveValue('repo-a');
  await expect(page.locator(`#commit-${subjectA}`)).toBeVisible();
  await select.focus();
  store.saveRepo({ ...repoA, disabled: true });
  await refreshNow(page);
  await expect(select).toHaveValue('repo-b');
  await expect(page.locator(`#commit-${subjectB}`)).toBeVisible();
  await expect(page.locator(`#commit-${subjectA}`)).toHaveCount(0);
  graphReads.length = 0;
  await page.getByRole('button', { name: 'Reload graph' }).click();
  await expect(page.locator(`#commit-${subjectB}`)).toBeVisible();
  assert.deepEqual([...new Set(graphReads)], ['repo-b']);
});

test('a state answer that disables the shown repository moves a focused graph to an unlinked one', async t => {
  const first = checkoutFixture(cleanupStack(t));
  const subjectA = first.commit(first.local, 'a.txt', 'Only in repository A');
  const repoA = { ...first.repo, id: 'repo-a', azureId: 'repo-a', name: 'Alpha' };
  const repoB = { ...first.repo, id: 'repo-b', azureId: 'repo-b', name: 'Beta', localPath: undefined };
  const store = createStore();
  defer(t, () => store.close());
  store.saveRepo(repoA);
  store.saveRepo(repoB);
  const app = createApp({
    store,
    checkoutGit: first.checkoutGit,
    provider: stub<AzureProvider>({ checkConnection: async () => stub<ConnectionStatus>({ available: true }) }),
    sync: stub<AppSync>({ status: () => idleSyncStatus() }),
    accessKey: TEST_KEY,
  });
  const url = await listen(t, app);
  const page = await openPage(t, { key: TEST_KEY });
  await page.goto(`${url}/#graph`);
  const select = page.locator('#graph-repo');
  await expect(select).toHaveValue('repo-a');
  await expect(page.locator(`#commit-${subjectA}`)).toBeVisible();
  await select.focus();
  store.saveRepo({ ...repoA, disabled: true });
  await refreshNow(page);
  await expect(select).toHaveValue('repo-b');
  await expect(page.locator(`#commit-${subjectA}`)).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Reload graph' })).toHaveCount(0);
  await expect(select).toBeFocused();
});
