import test from 'node:test';
import assert from 'node:assert/strict';
import { capture } from './fixtures/app.ts';
import { expect } from '@playwright/test';
import { multiDayFixture, setup } from './fixtures/ui-app.ts';
import type { ActivityEvent } from '../src/activity.ts';

test('the branch tree works with the unread filter and keeps status markers on narrow screens', async t => {
  const { page } = await setup(t);
  const rows = page.locator('.with-tree .row');
  await expect(rows.first()).toBeVisible();
  await expect(page.locator('.with-tree li.row > svg.tree')).toHaveCount(await rows.count());
  const hotfix = page.locator('li[data-event-id="demo-branch-1"]');
  // A new branch has nothing else to say first, so where it started is its top line, above who and when.
  await expect(hotfix.locator('.event-main')).toHaveText('Started at 3f9a2c1, the tip of main');
  await expect(hotfix.locator('.event-origin')).toHaveCount(0);
  await expect(hotfix.locator('svg.tree path')).toHaveCount(1);
  await expect(hotfix.locator('svg.tree path.assumed')).toHaveCount(0);
  await expect(page.locator('li[data-event-id="demo-branch-3"]')).toContainText('PR 1175 targets main, origin not checked');
  await expect(page.locator('li[data-event-id="demo-branch-3"] svg.tree path.assumed')).toHaveCount(1);
  await expect(page.locator('li[data-event-id="demo-pr-2"] svg.tree path')).toHaveCount(1);
  // A CI run on a pull request ref takes the branch of the stored PR and joins its lane.
  const ciRef = page.locator('li[data-event-id="demo-build-2"] .subref');
  await expect(ciRef.locator('.ref-repo')).toHaveText(' · repository shared-components');
  await expect(ciRef.locator('.ref-name')).toHaveText('feature/date-range');
  await expect(ciRef.locator('.ref-pr')).toHaveText(' · PR 412');
  await expect(ciRef.locator('.ref-pr')).toBeVisible();
  await expect(page.locator('li[data-event-id="demo-build-2"] svg.tree rect.ci-node:not(.lane-none)')).toHaveCount(1);
  // A lane must run unbroken through a row, so each cell covers its row from border to border.
  const [cell, row] = await Promise.all([hotfix.locator('svg.tree').boundingBox(), hotfix.boundingBox()]);
  assert.ok(cell && row);
  assert.ok(Math.abs(cell.y - row.y) <= 1 && Math.abs(cell.y + cell.height - (row.y + row.height)) <= 1, 'tree cell spans the row');
  await expect(hotfix.locator('.kind > svg')).toBeHidden();

  await page.setViewportSize({ width: 420, height: 900 });
  await expect(hotfix.locator('svg.tree')).toBeHidden();
  const glyph = hotfix.locator('.kind > svg');
  await expect(glyph).toBeVisible();
  await expect
    .poll(() =>
      glyph.evaluate(element => {
        const glyph = element.getBoundingClientRect();
        const label = element.parentElement!.getBoundingClientRect();
        const firstLineCentre = label.top + parseFloat(getComputedStyle(element.parentElement!).lineHeight) / 2;
        return Math.abs(glyph.top + glyph.height / 2 - firstLineCentre);
      }),
    )
    .toBeLessThanOrEqual(1);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.getByRole('button', { name: 'Unread only', exact: true }).click();
  await expect(hotfix.locator('svg.tree')).toBeVisible();
  await expect(hotfix.locator('.event-main')).toHaveText('Started at 3f9a2c1, the tip of main');
  await page.setViewportSize({ width: 640, height: 900 });
  await expect(hotfix.locator('svg.tree')).toBeVisible();
  await page.setViewportSize({ width: 390, height: 900 });
  await expect(hotfix.locator('svg.tree')).toBeHidden();
  await expect(hotfix.locator('.kind > svg')).toBeVisible();
});

test('Activity gives wrapped titles room and keeps their event metadata together on desktop', async t => {
  const { page, runtime } = await setup(t);
  // A pull request title long enough to wrap at 1280px.
  runtime.store.insertEvents([
    {
      id: 'long-title-pr',
      repoId: 'demo-orders',
      kind: 'pr',
      title:
        'PR 21431 · DAT-9861: the 12 animal seeds load into seed_standards, bridge views in animal and refined bull, and verify downstream transformations and intermediate reports',
      branch: 'refs/heads/feature/DAT-9861_animal_seeds_standards',
      actor: 'Ana',
      time: new Date().toISOString(),
      data: {
        pullRequestId: 21431,
        status: 'active',
        sourceRefName: 'refs/heads/feature/DAT-9861_animal_seeds_standards',
        targetRefName: 'refs/heads/main',
      },
    },
    {
      id: 'long-branch-ci',
      repoId: 'demo-orders',
      kind: 'build',
      title: 'orders-api PR validation · 20261120.87',
      branch: 'refs/pull/21432/merge',
      actor: 'Ana',
      time: new Date().toISOString(),
      data: {
        buildId: 9001,
        reason: 'pullRequest',
        status: 'completed',
        result: 'succeeded',
        pullRequest: {
          id: 21432,
          sourceRefName: 'refs/heads/feature/DAT-11441-tag-gap-scope-and-product-and-more-words',
          targetRefName: 'refs/heads/main',
        },
      },
    },
  ]);
  await page.reload();
  const longTitle = page.locator('li[data-event-id="long-title-pr"] .feed-title .title');
  await expect(longTitle).toBeVisible();
  // The page re-renders as it polls, so box reads retry until a rendered row answers.
  await expect.poll(async () => (await longTitle.boundingBox())?.height ?? 0, { message: 'the long title wraps' }).toBeGreaterThan(30);
  await expect(page.locator('.with-tree .row').first()).toBeVisible();
  const event = page.locator('li[data-event-id="long-title-pr"] .event');
  await expect
    .poll(() =>
      event.evaluate(element => {
        const title = element.closest('.row')?.querySelector('.title');
        const meta = element.querySelector('.event-meta');
        if (!title || !meta) return false;
        const content = title.getBoundingClientRect();
        const metadata = meta.getBoundingClientRect();
        return Math.abs(metadata.top - content.top) <= 2 && content.width > element.getBoundingClientRect().width;
      }),
    )
    .toBe(true);

  // At the narrowest wide layout, refs and PR chips stay in the title column.
  await page.setViewportSize({ width: 1100, height: 900 });
  const prRow = page.locator('li[data-event-id="long-title-pr"]');
  await expect(prRow.locator('.feed-title')).toHaveAccessibleName(
    /source branch feature\/DAT-9861_animal_seeds_standards targeting branch main/,
  );
  await expect(prRow.locator('svg.tree circle')).toHaveCount(0);
  await expect(prRow.locator('.standalone-pr-ring')).toHaveCount(0);
  const connectedPr = page.locator('li[data-event-id="demo-pr-1"]');
  await expect(connectedPr.locator('svg.tree circle.hole')).toBeVisible();
  const destinationFits = async () =>
    prRow.locator('.ref-destination').evaluate(element => {
      const column = element.closest('.subject')?.getBoundingClientRect();
      return !!column && element.getBoundingClientRect().right <= column.right && element.scrollWidth <= element.clientWidth;
    });
  await expect.poll(destinationFits).toBe(true);
  const ciRow = page.locator('li[data-event-id="long-branch-ci"]');
  await expect
    .poll(
      async () => {
        const [subject, chip] = await Promise.all([ciRow.locator('.subject').boundingBox(), ciRow.locator('.ref-pr').boundingBox()]);
        return subject && chip ? chip.x + chip.width - (subject.x + subject.width) : Infinity;
      },
      { message: 'PR chip right edge past the title column' },
    )
    .toBeLessThanOrEqual(0);
  await capture(page, 'open-pr-activity-desktop.png');
  // On a phone the type label shares its line with the taller Seen control, so it centres on it.
  await page.setViewportSize({ width: 390, height: 900 });
  await expect(prRow.locator('.kind > .d')).toBeVisible();
  await expect.poll(destinationFits).toBe(true);
  await capture(page, 'open-pr-activity-phone.png');
  const centre = (box: { y: number; height: number }) => box.y + box.height / 2;
  const first = page.locator('.rows .row').first();
  await expect
    .poll(
      async () => {
        const [label, seen] = await Promise.all([first.locator('.kind').boundingBox(), first.locator('.seen-toggle').boundingBox()]);
        return label && seen ? Math.abs(centre(label) - centre(seen)) : Infinity;
      },
      { message: 'label centres on Seen' },
    )
    .toBeLessThanOrEqual(1);
});

test('Activity keeps the branch tree while exposing merge status, CI and push commits inline', async t => {
  const { page, runtime } = await setup(t);
  const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60000).toISOString();
  const sha = 'a'.repeat(40);
  const main = 'refs/heads/main';
  const base = { repoId: 'demo-billing', branch: 'main' };
  runtime.store.insertEvents([
    {
      ...base,
      id: 'readable-merge',
      seen: true,
      kind: 'pr',
      title: 'PR 504 · Update billing',
      time: minutesAgo(6),
      data: { pullRequestId: 504, status: 'completed', targetRefName: main, mergeCommit: sha },
    },
    {
      ...base,
      id: 'seen-passing-run',
      kind: 'build',
      title: 'Billing CI',
      time: minutesAgo(4),
      seen: true,
      data: { buildId: 521, status: 'completed', result: 'succeeded', reason: 'individualCI', sourceBranch: main, sourceVersion: sha },
    },
    {
      ...base,
      id: 'failed-after-merge',
      kind: 'build',
      title: 'Billing CI',
      time: minutesAgo(3),
      data: { buildId: 520, status: 'completed', result: 'failed', reason: 'individualCI', sourceBranch: main, sourceVersion: sha },
    },
  ]);
  await page.reload();
  const merge = page.locator('li[data-event-id="readable-merge"]');
  const failure = page.locator('li[data-event-id="failed-after-merge"]');
  await expect(merge.locator('.kind')).toHaveText('PR merged');
  await expect(merge.getByText('Merged into main')).toBeVisible();
  const passing = page.locator('li[data-event-id="seen-passing-run"]');
  const seen = merge.locator('.seen-toggle');
  await expect(passing).toHaveCount(0);
  await expect(seen).toHaveAttribute('aria-pressed', 'true');
  await seen.click();
  await expect(seen).toHaveAttribute('aria-pressed', 'false');
  await expect(passing).toHaveCount(0);
  await seen.click();
  await expect(seen).toHaveAttribute('aria-pressed', 'true');
  await expect(passing).toHaveCount(0);
  assert.equal(runtime.store.getEvent('seen-passing-run')?.seen, true);
  const rollup = merge.getByText('Run history · 1 run', { exact: true });
  await expect(merge.locator('.ci-run.crit')).toContainText('failed');
  await rollup.focus();
  await page.keyboard.press('Enter');
  await expect(rollup).toBeFocused();
  await expect
    .poll(() =>
      merge.evaluate(row => {
        const cell = row.querySelector('svg.tree')!.getBoundingClientRect();
        const bounds = row.getBoundingClientRect();
        return Math.abs(cell.top - bounds.top) <= 1 && Math.abs(cell.bottom - bounds.bottom) <= 1;
      }),
    )
    .toBe(true);
  await expect(merge.getByRole('button', { name: /Post-merge CI.*failed/ })).toBeVisible();
  await expect(failure.locator('svg.tree rect.ci-node')).toBeVisible();
  await expect(page.locator('svg.tree .default-lane').first()).toHaveCSS('stroke-width', '2.5px');

  const push = page.locator('li[data-event-id="demo-push-1"]');
  const loadCommits = push.getByRole('button', { name: 'Load commits', exact: true });
  await loadCommits.focus();
  await page.keyboard.press('Enter');
  await expect(push.getByRole('button', { name: 'Reload commits', exact: true })).toBeFocused();
  await expect(push.getByText('Cover export retry behavior', { exact: false })).toBeVisible();
  await expect(page).toHaveURL(/#activity$/);
  await capture(page, 'activity-tree-redesign-desktop.png');
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(failure.locator('.kind')).toHaveText('CI failed');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await capture(page, 'activity-tree-redesign-mobile.png');
});

test('Activity shows only highlights and links a landing and quieter CI to its details', async t => {
  const { page, runtime } = await setup(t, true, { highlights: true });
  const head = 'c'.repeat(40);
  const base = { repoId: 'demo-billing', branch: 'main', time: new Date().toISOString() };
  const main = 'refs/heads/main';
  const source = 'refs/heads/feature/DAT-1324_fatty_acids_individual_advice_and_governance';
  const reviewer = { name: 'Required reviewer', required: true, vote: 10 };
  const approval = {
    ...base,
    kind: 'pr' as const,
    title: 'PR 513 · Rework the advice decision tree of fatty_acids_individual_risks and insemination_return_distribution',
    actor: 'Ines Adriaens - Doekes',
    url: 'https://dev.azure.com/demo/project/_git/billing/pullrequest/513',
    data: { status: 'active' as const, pullRequestId: 513, sourceRefName: source, targetRefName: main, previewCommit: 'd'.repeat(40) },
  };
  const branchMilestones: ActivityEvent[] = Array.from({ length: 5 }, (_, index) => {
    const branch = `refs/heads/feature/active-${index}`;
    const pr = {
      repoId: base.repoId,
      branch,
      kind: 'pr' as const,
      title: `PR ${514 + index} · Update model ${index}`,
      data: { status: 'active' as const, pullRequestId: 514 + index, sourceRefName: branch, targetRefName: main },
    };
    return [
      { ...pr, id: `opened-${index}`, time: new Date(Date.parse(base.time) - 120_000 + index * 1000).toISOString() },
      {
        ...pr,
        id: `retargeted-${index}`,
        time: new Date(Date.parse(base.time) + 120_000 + index * 1000).toISOString(),
        data: { ...pr.data, targetRefName: 'refs/heads/integration' },
      },
    ];
  }).flat();
  runtime.store.insertEvents([
    ...branchMilestones,
    {
      ...approval,
      id: 'approval-baseline',
      imported: true,
      time: new Date(Date.parse(base.time) - 60_000).toISOString(),
      data: { ...approval.data, previewCommit: 'e'.repeat(40), reviewers: [{ ...reviewer, vote: 0 }] },
    },
    {
      ...approval,
      id: 'approval-highlight',
      data: { ...approval.data, reviewers: [reviewer], voteChanges: [reviewer] },
    },
    {
      ...base,
      id: 'stale-validation',
      kind: 'build',
      title: 'Billing CI',
      time: new Date(Date.parse(base.time) + 60_000).toISOString(),
      data: {
        sourceBranch: 'refs/pull/513/merge',
        sourceVersion: 'e'.repeat(40),
        buildId: 601,
        status: 'completed',
        result: 'partiallySucceeded',
      },
    },
    {
      ...base,
      id: 'highlight-pr',
      kind: 'pr',
      title: 'PR 512 · Landing in highlights',
      data: { status: 'completed', pullRequestId: 512, targetRefName: main, mergeCommit: head },
    },
    {
      ...base,
      id: 'quiet-landing-push',
      kind: 'push',
      title: 'Landing push',
      data: { refUpdates: [{ name: main, oldObjectId: 'a'.repeat(40), newObjectId: head }] },
    },
    {
      ...base,
      id: 'quiet-pass',
      kind: 'build',
      title: 'Billing CI',
      data: { sourceBranch: main, sourceVersion: head, buildId: 600, status: 'completed', result: 'succeeded', reason: 'individualCI' },
    },
    ...Array.from({ length: 6 }, (_, index) => ({
      ...base,
      id: `earlier-pass-${index}`,
      kind: 'build' as const,
      title: `Billing validation ${index}`,
      time: new Date(Date.parse(base.time) - (index + 1) * 60_000).toISOString(),
      data: { sourceBranch: 'refs/pull/512/merge', buildId: 610 + index, status: 'completed', result: index < 3 ? 'succeeded' : 'failed' },
    })),
    {
      ...base,
      id: 'later-push-to-same-tip',
      kind: 'push',
      title: 'Later default branch push',
      time: new Date(Date.parse(base.time) + 60 * 60_000).toISOString(),
      data: { refUpdates: [{ name: main, oldObjectId: 'b'.repeat(40), newObjectId: head }] },
    },
  ]);
  await page.reload();
  const merge = page.locator('li[data-event-id="highlight-pr"]');
  await expect(merge.locator('.kind')).toHaveText('PR merged');
  await expect(merge.getByText('Landed on main', { exact: false })).toBeVisible();
  const headline = merge.getByRole('button', { name: 'Post-merge CI passed' });
  await expect(headline).toBeVisible();
  await headline.click();
  await expect(page).toHaveURL(/#event\/quiet-pass$/);
  await page.getByRole('link', { name: /Back to Activity/ }).click();
  await expect(merge.locator('.event-ci .crit')).toHaveCount(0);
  await expect(merge.getByRole('button', { name: 'PR validation failed' })).toHaveCount(0);
  await merge.getByText('Run history · 6 runs').click();
  await expect(merge.locator('.ci-history').getByRole('button', { name: 'PR validation failed' }).first()).toBeVisible();
  await expect(merge.locator('.ci-run time')).toHaveCount(6);
  await expect(merge.getByRole('button', { name: 'Post-merge CI passed' }).locator('time')).toHaveAttribute('datetime', base.time);
  await expect(merge.getByRole('button', { name: 'View all CI runs' })).toBeVisible();
  await expect(page.locator('li[data-event-id="quiet-landing-push"], li[data-event-id="quiet-pass"]')).toHaveCount(0);
  await expect(merge.locator('svg.tree')).toBeVisible();
  await expect(page.locator('li[data-event-id="later-push-to-same-tip"]')).toContainText('Later default branch push');
  const approved = page.locator('li[data-event-id="approval-highlight"]');
  const approvalLabel = approved.locator('.kind');
  const readyLabel = page.locator('li[data-event-id="opened-0"] .kind');
  await expect(approvalLabel).toHaveText('Approvals met');
  await expect(approved.locator('.event-meta time')).toHaveCSS('white-space', 'nowrap');
  const statusColor = () => approvalLabel.evaluate(element => getComputedStyle(element).color);
  const sharesStatusColor = (label: typeof approvalLabel) =>
    label.evaluate(element => getComputedStyle(element).color).then(color => statusColor().then(approval => approval === color));
  assert.equal(await sharesStatusColor(readyLabel), false);
  assert.equal(await sharesStatusColor(merge.locator('.kind')), false);
  await expect(approved.locator('.title')).toHaveText(approval.title);
  await expect(approved.locator('.feed-title')).toHaveAccessibleName(/fatty_acids_individual_risks/);
  await expect(approved.locator('.event-meta')).toContainText('PR author Ines Adriaens - Doekes');
  await expect(approved.locator('.ref-repo')).toBeVisible();
  await expect(approved.locator('xpath=..')).toHaveAttribute('data-tree-lanes', '5');
  const longCi = approved.getByRole('button', { name: 'PR validation partially succeeded on earlier revision' });
  await expect(longCi).toBeVisible();
  await expect(longCi.locator('time')).toHaveAttribute('datetime', new Date(Date.parse(base.time) + 60_000).toISOString());
  const rowFits = () =>
    approved.evaluate(row => {
      const kind = row.querySelector('.kind')!;
      const range = document.createRange();
      range.selectNodeContents(kind);
      const rect = range.getBoundingClientRect();
      const bounds = kind.getBoundingClientRect();
      const box = (selector: string) => row.querySelector(selector)!.getBoundingClientRect();
      const overlaps = (a: DOMRect, b: DOMRect) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
      const subject = box('.subject');
      const actions = box('.rowact');
      const event = box('.event');
      const ci = box('.event-ci button');
      return {
        labelFits: rect.right <= bounds.right + 1 && [subject, actions, event].every(area => !overlaps(rect, area)),
        actionsClearTitle: !overlaps(actions, subject),
        ciFits: ci.right <= event.right + 1,
        pageFits: document.documentElement.scrollWidth <= innerWidth,
      };
    });
  const allFit = { labelFits: true, actionsClearTitle: true, ciFits: true, pageFits: true };
  for (const width of [1100, 640, 767, 1278, 320, 390, 639, 1024, 1099, 1536]) {
    await page.setViewportSize({ width, height: 900 });
    await expect.poll(rowFits, { message: `The approval row fits at ${width}px` }).toEqual(allFit);
  }
  await page.setViewportSize({ width: 1278, height: 900 });
  const metadataLeft = (row: typeof approved) => row.locator('.event').evaluate(element => element.getBoundingClientRect().left);
  assert.ok(
    Math.abs((await metadataLeft(approved)) - (await metadataLeft(merge))) <= 1,
    'metadata keeps its alignment on rows with and without an Azure link',
  );
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(page.locator('html')).toHaveClass(/\bdark\b/);
  assert.equal(await sharesStatusColor(readyLabel), false);
  assert.equal(await sharesStatusColor(merge.locator('.kind')), false);
  await approved.scrollIntoViewIfNeeded();
  await capture(page, 'activity-highlights.png');
  await merge.scrollIntoViewIfNeeded();
  await capture(merge, 'activity-dated-ci-dark.png');
  await page.evaluate(() => {
    const rule = new CSSStyleSheet();
    rule.replaceSync(
      '* { line-height: 1.5 !important; letter-spacing: .12em !important; word-spacing: .16em !important; } p { margin-bottom: 2em !important; }',
    );
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, rule];
  });
  await expect.poll(rowFits).toEqual(allFit);
  assert.ok(
    Math.abs((await metadataLeft(approved)) - (await metadataLeft(merge))) <= 1,
    'metadata stays aligned with wider control labels',
  );
  await page.setViewportSize({ width: 320, height: 900 });
  await expect.poll(rowFits).toEqual(allFit);
  await page.evaluate(() => {
    document.adoptedStyleSheets = document.adoptedStyleSheets.slice(0, -1);
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await approved.scrollIntoViewIfNeeded();
  await capture(page, 'activity-highlights-phone.png');
  await page.emulateMedia({ colorScheme: 'light' });
  await expect(page.locator('html')).not.toHaveClass(/\bdark\b/);
  await capture(merge, 'activity-dated-ci-light-phone.png');
  await merge.getByRole('button', { name: 'View all CI runs' }).click();
  await expect(page.locator('.detail-related')).toHaveAttribute('open', '');
  await expect(page.locator('.detail-related summary')).toHaveText('Related CI runs · 7');
  await expect(page.locator('.detail-related summary')).toBeFocused();
  await expect(page.locator('.detail-related summary')).toBeInViewport();
  await expect(page.getByRole('link', { name: /Billing validation 5/ })).toBeVisible();
  await page.getByRole('link', { name: /Back to Activity/ }).click();
  await merge.locator('.feed-title').click();
  await page.getByText('Related activity', { exact: false }).click();
  await expect(page.locator('.detail-related h3')).not.toHaveCount(0);
  await expect(page.locator('.detail-related time').first()).toHaveAttribute('datetime', /T/);
  await expect(page.getByRole('link', { name: /Merge of PR 512 pushed to main/ })).toBeVisible();
  await page.getByRole('link', { name: /Billing CI/ }).click();
  await expect(page.getByRole('heading', { name: 'Billing CI' })).toBeVisible();
});

test('Activity starts each local day with a header that the lanes run through and that never counts as a row', async t => {
  const { page } = await multiDayFixture(t);
  const activity = page.locator('details[data-group="activity"]');
  const list = activity.locator('ul.rows.with-tree');
  const headers = list.locator('li.day');
  await expect(headers).toHaveCount(3);
  const labels = await headers.allInnerTexts();
  assert.equal(labels[0], 'Today');
  assert.match(labels[1] ?? '', /^Yesterday · .*\b27\b/);
  assert.match(labels[2] ?? '', /\b26\b/);
  assert.doesNotMatch(labels[2] ?? '', /Yesterday|Today|2026/);
  // A header sits before the first row of its day.
  assert.deepEqual(await headers.evaluateAll(items => items.map(item => item.nextElementSibling?.getAttribute('data-event-id'))), [
    'today-main',
    'yesterday-merge',
    'older-main',
  ]);
  // Imported history starts its own headers.
  await expect(page.locator('details[data-group="imported-history"] ul.rows li.day')).toHaveCount(2);
  // A header is not a row: rows, row IDs, the group count and Seen toggles leave it out, and it holds nothing to act on.
  await expect(list.locator('li.row')).toHaveCount(9);
  await expect(list.locator('li[data-event-id]')).toHaveCount(9);
  await expect(list.locator('.seen-toggle')).toHaveCount(9);
  await expect(activity.locator('summary .pill')).toHaveText('9');
  await expect(list.locator('li.day :is(a, button, input, [tabindex])')).toHaveCount(0);
  await expect(list.locator('li.row > svg.tree')).toHaveCount(9);

  for (const width of [1100, 1265]) {
    await page.setViewportSize({ width, height: 1000 });
    // Every lane that leaves the row above at its bottom crosses the header and enters the row below at its top.
    const crossings = await headers.evaluateAll(items =>
      items.map(header => {
        const keys = (lines: Iterable<Element>) =>
          [...lines].map(line => `${line.getAttribute('x1')} ${line.getAttribute('class')}`).sort();
        const above = header.previousElementSibling?.querySelector(':scope > svg.tree');
        const below = header.nextElementSibling?.querySelector(':scope > svg.tree');
        const cell = header.querySelector(':scope > svg.tree-pass');
        const box = header.getBoundingClientRect();
        const cellBox = cell?.getBoundingClientRect();
        return {
          header: keys(cell?.querySelectorAll('line') ?? []),
          above: keys(above?.querySelectorAll('line[y2="100%"]') ?? []),
          below: keys(below?.querySelectorAll('line[y1="-40"]') ?? []),
          spans: !cellBox || (Math.abs(cellBox.top - (box.top - 1)) <= 1 && Math.abs(cellBox.bottom - box.bottom) <= 1),
        };
      }),
    );
    assert.deepEqual(crossings[0], { header: [], above: [], below: [], spans: true }, 'nothing crosses the first header');
    for (const [index, crossing] of crossings.entries()) {
      assert.deepEqual(crossing.header, crossing.below, `header ${index} at ${width}px: lanes entering the row below`);
      if (index) assert.deepEqual(crossing.header, crossing.above, `header ${index} at ${width}px: lanes leaving the row above`);
      assert.ok(crossing.spans, `header ${index} at ${width}px: the lane cell covers the header`);
    }
    assert.ok(
      crossings.every((crossing, index) => !index || crossing.header.length >= 2),
      'several lanes cross each later header',
    );
    await expect(list.locator('li.day svg.tree-pass').first()).toBeVisible();
  }
  // Below 640px the tree is gone and the headers stay.
  await page.setViewportSize({ width: 360, height: 900 });
  await expect(headers.first()).toBeVisible();
  await expect(list.locator('li.day svg.tree-pass').first()).toBeHidden();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
});
