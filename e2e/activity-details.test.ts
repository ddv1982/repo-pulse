import test from 'node:test';
import assert from 'node:assert/strict';
import { expect } from '@playwright/test';
import { selectActivityType, setup, groupedFixture } from './fixtures/ui-app.ts';
import { demo, isSeen } from './fixtures/history-app.ts';

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

test('an open Activity view picks up a seen action in another tab and later merge evidence', async t => {
  const { runtime, page } = await demo(t);
  const id = 'revision-test';
  const result = 'a'.repeat(40);
  runtime.store.insertEvents([
    {
      id,
      repoId: 'demo-orders',
      kind: 'push',
      title: 'Microsoft.VisualStudio.Services.TFS pushed to main',
      branch: 'main',
      actor: 'Microsoft.VisualStudio.Services.TFS',
      time: new Date().toISOString(),
      data: { pushId: 18000, refUpdates: [{ name: 'refs/heads/main', oldObjectId: 'b'.repeat(40), newObjectId: result }] },
    },
  ]);
  await page.goto(runtime.url + '/#activity');
  const row = page.locator('li[data-event-id="revision-test"]');
  await expect(row).toHaveClass(/\bnew\b/);
  await expect(row.getByRole('button', { name: /^main(?: · repository .+)?$/ })).toBeVisible();
  await expect(row.getByText('Pushed by Azure DevOps service')).toBeVisible();

  const other = await page.context().newPage();
  await other.goto(runtime.url + '/#activity/unread');
  await other
    .locator('li[data-event-id="revision-test"]')
    .getByRole('button', { name: 'Seen: Azure DevOps service pushed to main' })
    .click();
  await expect(other.locator('li[data-event-id="revision-test"]')).toHaveCount(0);
  await other.close();
  await expect(row).not.toHaveClass(/\bnew\b/, { timeout: 8000 });

  runtime.store.enrichEvent(id, {
    mergeEvidence: {
      status: 'complete',
      prs: [
        {
          pullRequestId: 12,
          relationship: 'result-introduced',
          targetRefName: 'refs/heads/main',
          mergeCommit: result,
          closedBy: 'Alice Morgan',
          url: 'https://dev.azure.com/example/project/_git/orders/pullrequest/12',
        },
      ],
    },
  });
  const title = 'Merge of PR 12 pushed to main';
  await expect(row.getByText('Merge of PR 12 pushed', { exact: true })).toBeVisible({ timeout: 8000 });
  await expect(row.getByText('Completed PR linked')).toHaveCount(0);
  await expect(row.getByText('Pushed by Azure DevOps service')).toBeVisible();
  // The row title leaves the branch to the ref line; the detail heading keeps the whole title.
  await row.getByRole('button', { name: /^Merge of PR 12 pushed · .*branch main$/ }).click();
  await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible();
  await expect(page.getByText('Pushed by', { exact: true })).toBeVisible();
  await expect(page.getByText(/PR closed by Alice Morgan/)).toBeVisible();
  await expect(page.getByRole('link', { name: 'PR #12' })).toBeVisible();
});

test('a verified merge push folds in the mixed feed and keeps its own detail, filters, and unread state', async t => {
  const { runtime, page } = await demo(t);
  const result = 'c'.repeat(40);
  const time = new Date().toISOString();
  const target = `release/${'long-target-branch-'.repeat(12)}candidate`;
  const targetRefName = `refs/heads/${target}`;
  const pullRequestId = 23456;
  const evidence = { pullRequestId, targetRefName, mergeCommit: result, relationship: 'result-introduced' };
  runtime.store.insertEvents([
    {
      id: 'linked-pr',
      repoId: 'demo-orders',
      kind: 'pr',
      title: 'PR 23456 · Fix invoices',
      branch: 'fix/invoices',
      time,
      data: { ...evidence, status: 'completed', sourceRefName: 'refs/heads/fix/invoices' },
    },
    {
      id: 'linked-push',
      repoId: 'demo-orders',
      kind: 'push',
      branch: target,
      time,
      data: { pushId: 23100, refUpdates: [{ name: targetRefName, oldObjectId: 'b'.repeat(40), newObjectId: result }] },
    },
  ]);
  runtime.store.enrichEvent('linked-push', { mergeEvidence: { prs: [evidence] } });
  await page.goto(runtime.url + '/#activity');
  const merge = page.locator('li[data-event-id="linked-pr"]');
  const push = page.locator('li[data-event-id="linked-push"]');
  await expect(push).toHaveCount(0);
  await expect(merge.getByText('2 new')).toBeVisible();
  await merge.getByText('Linked push · unread', { exact: true }).click();
  const openPush = merge.getByRole('button', { name: `View push to ${target}` });
  for (const width of [1280, 390, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    assert.ok(
      await openPush.evaluate(element => {
        const column = element.closest('.event')?.getBoundingClientRect();
        const button = element.getBoundingClientRect();
        return (
          column &&
          button.right <= column.right &&
          button.bottom <= column.bottom &&
          element.scrollHeight <= element.clientHeight &&
          document.documentElement.scrollWidth <= innerWidth
        );
      }),
      `The linked push fits the ${width}px viewport`,
    );
  }
  await openPush.click();
  await expect(page.getByRole('heading', { name: `Merge of PR 23456 pushed to ${target}` })).toBeVisible();
  await page.getByRole('link', { name: 'Back to Activity' }).click();
  await expect(openPush).toBeFocused();

  const search = page.getByRole('searchbox', { name: 'Search activity' });
  await search.fill(result);
  await expect(push).toBeVisible();
  await search.clear();
  await expect(push).toHaveCount(0);
  await page.getByRole('button', { name: /^Activity type:/ }).click();
  await page.getByRole('option', { name: 'Push', exact: true }).click();
  await expect(push).toBeVisible();
  await expect(merge).toHaveCount(0);
  await page.getByRole('button', { name: /^Activity type:/ }).click();
  await page.getByRole('option', { name: 'All types', exact: true }).click();
  await expect(push).toHaveCount(0);

  await merge.getByRole('button', { name: /Seen: .* and linked push/ }).click();
  await expect.poll(() => [isSeen(runtime.store, 'linked-pr'), isSeen(runtime.store, 'linked-push')]).toEqual([true, true]);
  runtime.store.acknowledge(['linked-pr'], false);
  await page.reload();
  await expect(merge.getByRole('button', { name: 'Seen: PR 23456 · Fix invoices', exact: true })).toHaveAttribute(
    'data-event-ids',
    '["linked-pr"]',
  );
  // A seen PR and an independently unread push must show both rows in the mixed feed.
  runtime.store.acknowledge(['linked-pr']);
  runtime.store.acknowledge(['linked-push'], false);
  await page.reload();
  await expect(push).toBeVisible();
  await expect(merge).toBeVisible();
  await page.getByRole('button', { name: 'Unread only', exact: true }).click();
  await expect(push).toBeVisible();
  await expect(merge).toHaveCount(0);
});

test('a successful tag build folds only for the exact tag revision in the mixed feed', async t => {
  const { runtime, page } = await demo(t);
  const repoId = 'demo-orders';
  const ref = 'refs/tags/test-release';
  const tagObject = 'a'.repeat(40);
  const commit = 'b'.repeat(40);
  const buildUrl = 'https://dev.azure.com/example/project/_build/results?buildId=24000';
  runtime.store.insertEvents([
    {
      id: 'release-tag',
      repoId,
      kind: 'tag',
      title: 'New tag · test-release',
      branch: 'test-release',
      time: new Date(Date.now() - 60_000).toISOString(),
      data: { evidence: 'push', change: 'created', name: ref, newObjectId: tagObject },
    },
    {
      id: 'release-build',
      repoId,
      kind: 'build',
      title: 'Release test CI',
      branch: ref,
      time: new Date().toISOString(),
      url: buildUrl,
      data: { buildId: 24000, sourceBranch: ref, sourceVersion: commit, status: 'completed', result: 'succeeded', reason: 'individualCI' },
    },
  ]);
  runtime.store.acknowledge(['release-tag', 'release-build']);
  const cacheTag = (objectId: string) =>
    runtime.store.commitPage({ repoId, entities: [{ type: 'ref', id: ref, data: { objectId, peeledObjectId: commit, active: true } }] });
  const tag = page.locator('li[data-event-id="release-tag"]');
  const build = page.locator('li[data-event-id="release-build"]');
  cacheTag('c'.repeat(40));
  await page.goto(runtime.url + '/#activity');
  await expect(build).toBeVisible();

  cacheTag(tagObject);
  await page.reload();
  await expect(tag.locator('summary').filter({ hasText: 'CI succeeded' })).toBeVisible();
  await expect(build).toHaveCount(0);
  await tag.locator('summary').filter({ hasText: 'CI succeeded' }).click();
  await expect(tag.getByRole('link', { name: 'Build in Azure ↗' })).toHaveAttribute('href', buildUrl);
  const detail = tag.getByRole('button', { name: 'Release test CI' });
  await detail.click();
  await expect(page.getByRole('heading', { name: 'Release test CI', exact: true })).toBeVisible();
  await page.getByRole('link', { name: 'Back to Activity' }).click();
  await expect(detail).toBeFocused();

  const search = page.getByRole('searchbox', { name: 'Search activity' });
  await search.fill('Release test CI');
  await expect(build).toBeVisible();
  await search.clear();
  await expect(build).toHaveCount(0);
  await page.getByRole('button', { name: /^Activity type:/ }).click();
  await page.getByRole('option', { name: 'CI runs', exact: true }).click();
  await expect(build).toBeVisible();
  await expect(tag).toHaveCount(0);
  await page.getByRole('button', { name: /^Activity type:/ }).click();
  await page.getByRole('option', { name: 'All types', exact: true }).click();
  await expect(build).toHaveCount(0);

  runtime.store.acknowledge(['release-build'], false);
  await page.reload();
  await expect(build).toBeVisible();
  await expect(tag.locator('summary').filter({ hasText: 'CI succeeded' })).toHaveCount(0);
});

test('a pending refresh leaves Activity details available', async t => {
  const { page } = await setup(t);
  let release = () => {};
  const held = new Promise<void>(resolve => {
    release = resolve;
  });
  await page.route('**/api/refresh', async route => {
    await held;
    await route.continue();
  });
  const refreshed = page.waitForResponse('**/api/refresh');
  await page.getByRole('button', { name: 'Refresh activity', exact: true }).first().click();
  const row = page.locator('#page li.row').first();
  const title = (await row.locator('.feed-title .title').first().innerText()).trim();
  await row.locator('.feed-title').first().click();
  await expect(page).toHaveURL(/#event\//);
  await expect(page.getByRole('heading', { name: title, exact: false }).first()).toBeVisible();
  release();
  await refreshed;
  await expect(page.locator('#toast')).toContainText('Activity refresh queued.');
});
