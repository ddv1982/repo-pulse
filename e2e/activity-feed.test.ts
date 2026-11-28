import test from 'node:test';
import assert from 'node:assert/strict';
import { capture } from './fixtures/app.ts';
import { expect } from '@playwright/test';
import { awkwardFixture, multiDayFixture, setup } from './fixtures/ui-app.ts';
import type { ActivityEvent } from '../src/activity.ts';

test('the branch tree works with the unread filter and keeps status markers on narrow screens', async t => {
  const { page } = await setup(t);
  const rows = page.locator('.with-tree .row');
  await expect(rows.first()).toBeVisible();
  await expect(page.locator('.with-tree li.row > svg.tree')).toHaveCount(await rows.count());
  const hotfix = page.locator('li[data-event-id="demo-branch-1"]');
  // A new branch has nothing else to say, so where it started is the summary at the end of line 2.
  await expect(hotfix.locator('.ref-summary')).toHaveText('Started at 3f9a2c1, the tip of main');
  await expect(hotfix.locator('.event-origin')).toHaveCount(0);
  await expect(hotfix.locator('svg.tree path')).toHaveCount(1);
  await expect(hotfix.locator('svg.tree path.assumed')).toHaveCount(0);
  await expect(page.locator('li[data-event-id="demo-branch-3"]')).toContainText('PR 1175 targets main, origin not checked');
  await expect(page.locator('li[data-event-id="demo-branch-3"] svg.tree path.assumed')).toHaveCount(1);
  await expect(page.locator('li[data-event-id="demo-pr-2"] svg.tree path')).toHaveCount(1);
  // A CI run on a pull request ref takes the branch of the stored PR and joins its lane.
  const ciRef = page.locator('li[data-event-id="demo-build-2"] .subref');
  await expect(ciRef.locator('.ref-repo')).toHaveText('repository shared-components');
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
  await expect(hotfix.locator('.ref-summary')).toHaveText('Started at 3f9a2c1, the tip of main');
  await page.setViewportSize({ width: 640, height: 900 });
  await expect(hotfix.locator('svg.tree')).toBeVisible();
  await page.setViewportSize({ width: 390, height: 900 });
  await expect(hotfix.locator('svg.tree')).toBeHidden();
  await expect(hotfix.locator('.kind > svg')).toBeVisible();
});

test("each row's tree node sits on the first line of its kind label wherever the tree shows", async t => {
  const { page } = await setup(t);
  await expect(page.locator('.with-tree .row').first()).toBeVisible();
  for (const width of [800, 1100, 1265]) {
    await page.setViewportSize({ width, height: 900 });
    const offsets = await page.locator('.with-tree li.row').evaluateAll(rows =>
      rows.flatMap(row => {
        const node = row.querySelector(':scope > svg.tree > g > :is(circle, rect, g.tag-mark)');
        const kind = row.querySelector('.kind');
        if (!node || !kind) return [];
        const box = node.getBoundingClientRect();
        const label = kind.getBoundingClientRect();
        const firstLine = label.top + parseFloat(getComputedStyle(kind).lineHeight) / 2;
        return [{ id: row.getAttribute('data-event-id'), off: Math.round((box.top + box.height / 2 - firstLine) * 10) / 10 }];
      }),
    );
    assert.ok(offsets.length >= 5, `${width}px: rows with a node`);
    // The plan allows 2px; a node one row padding step off is exactly 2px out, so the check holds it to 1px.
    for (const { id, off } of offsets)
      assert.ok(Math.abs(off) <= 1, `${width}px: the node of ${id} is ${off}px off the label's first line`);
  }
});

test('Activity gives wrapped titles room and keeps their facts line under them on desktop', async t => {
  const { page, runtime } = await setup(t);
  const longBranch =
    'feature/DAT-11441-tag-gap-scope-and-product-and-more-words-that-keep-going-until-the-name-is-wider-than-the-title-column';
  // A pull request title long enough to wrap at 1280px.
  runtime.store.insertEvents([
    {
      id: 'long-title-pr',
      repoId: 'demo-orders',
      kind: 'pr',
      title:
        'PR 21431 · DAT-9861: the 12 animal seeds load into seed_standards, bridge views in animal and refined bull, and verify downstream transformations and intermediate reports',
      branch: 'refs/heads/feature/DAT-9861_animal_seeds_standards',
      // An Azure display name can be one long word; it wraps inside the column instead of running out of it.
      actor: 'Ana_'.repeat(30),
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
          sourceRefName: `refs/heads/${longBranch}`,
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
  // Line 2 follows the wrapped title directly.
  const facts = page.locator('li[data-event-id="long-title-pr"] .row-head .subref');
  await expect
    .poll(() =>
      facts.evaluate(element => {
        const title = element.closest('.row')?.querySelector('.title')?.getBoundingClientRect();
        const line = element.getBoundingClientRect();
        return !!title && line.top >= title.bottom - 1 && line.top - title.bottom <= 4;
      }),
    )
    .toBe(true);

  // At the narrowest wide layout, refs and PR chips stay in the title column.
  await page.setViewportSize({ width: 1100, height: 900 });
  const prRow = page.locator('li[data-event-id="long-title-pr"]');
  // The phase 2 layout's title column was 444px wide here with 4 lanes. Without the event column it is wider.
  await expect(prRow.locator('xpath=..')).toHaveAttribute('data-tree-lanes', '4');
  await expect.poll(async () => (await prRow.locator('.subject').boundingBox())?.width ?? 0).toBeGreaterThan(444);
  await expect(prRow.locator('.feed-title')).toHaveAccessibleDescription(
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
  const actorFits = async () =>
    prRow.locator('.ref-actor').evaluate(element => {
      const column = element.closest('.subject')?.getBoundingClientRect();
      return !!column && element.getBoundingClientRect().right <= column.right + 0.5;
    });
  await expect.poll(actorFits).toBe(true);
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
  // A branch name wider than the column ends in an ellipsis, keeps its full name on hover, and the page does not scroll.
  const branch = ciRow.locator('.ref-branch');
  await expect(branch).toHaveAttribute('title', longBranch);
  await expect.poll(() => branch.evaluate(element => element.scrollWidth > element.clientWidth)).toBe(true);
  await expect(branch).toHaveCSS('text-overflow', 'ellipsis');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await capture(page, 'open-pr-activity-desktop.png');
  // On a phone the type label shares its line with the taller Seen control, so it centres on it.
  await page.setViewportSize({ width: 390, height: 900 });
  await expect(prRow.locator('.kind > .d')).toBeVisible();
  await expect.poll(actorFits).toBe(true);
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
  // Line 2 names the target and the merge commit instead of a sentence.
  await expect(merge.locator('.ref-destination')).toHaveText('main');
  await expect(merge.locator('.ref-sha')).toHaveText(/ a{9}$/);
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
  // A failed result stays in view; the CI count in the status cell opens the runs it does not show.
  const rollup = merge.locator('.status').getByRole('button', { name: 'CI · 2 runs', exact: true });
  await expect(merge.locator('.ci-run.crit')).toContainText('failed');
  await expect(rollup).toHaveAttribute('aria-expanded', 'false');
  await expect(merge.locator('.ci-history .ci-run')).toBeHidden();
  await rollup.focus();
  await page.keyboard.press('Enter');
  await expect(rollup).toBeFocused();
  await expect(rollup).toHaveAttribute('aria-expanded', 'true');
  await expect(merge.locator('.ci-history .ci-run')).toHaveText(/Post-merge CI passed/);
  // The browser can open the list by itself, as find in page does: the count and the stored state follow it.
  await page.keyboard.press('Enter');
  await expect(rollup).toHaveAttribute('aria-expanded', 'false');
  await merge.locator('details.ci-history').evaluate(list => {
    (list as HTMLDetailsElement).open = true;
  });
  await expect(rollup).toHaveAttribute('aria-expanded', 'true');
  await seen.click();
  await expect(seen).toHaveAttribute('aria-pressed', 'false');
  await expect(merge.locator('.ci-history .ci-run')).toBeVisible();
  await seen.click();
  await expect(seen).toHaveAttribute('aria-pressed', 'true');
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
  // The landing reads as `→ main` and the merge commit on line 2, not as words.
  await expect(merge.getByText('Landed on', { exact: false })).toHaveCount(0);
  await expect(merge.locator('.ref-destination')).toHaveText('main');
  await expect(merge.locator('.ref-sha')).toHaveText(/ c{9}$/);
  // Passing results fold into the CI count, which counts every run, until the reader opens the run list.
  const ciCount = merge.locator('.status').getByRole('button', { name: 'CI · 7 runs', exact: true });
  const headline = merge.getByRole('button', { name: 'Post-merge CI passed' });
  await expect(headline).toBeHidden();
  await expect(merge.locator('.ci-trouble')).toHaveCount(0);
  await expect(merge.getByRole('button', { name: 'PR validation failed' })).toHaveCount(0);
  await ciCount.click();
  await expect(ciCount).toHaveAttribute('aria-expanded', 'true');
  await expect(headline).toBeVisible();
  await expect(merge.locator('.ci-history').getByRole('button', { name: 'PR validation failed' }).first()).toBeVisible();
  await expect(merge.locator('.ci-run time')).toHaveCount(6);
  await expect(headline.locator('time')).toHaveAttribute('datetime', base.time);
  // View all CI runs ends the run list the count opens.
  await expect(merge.locator('.row-extra > .ci-history .ci-rollup > :last-child')).toHaveText('View all CI runs');
  await expect(merge.getByRole('button', { name: 'View all CI runs' })).toBeVisible();
  await headline.click();
  await expect(page).toHaveURL(/#event\/quiet-pass$/);
  await page.getByRole('link', { name: /Back to Activity/ }).click();
  await expect(ciCount).toHaveAttribute('aria-expanded', 'true');
  await expect(page.locator('li[data-event-id="quiet-landing-push"], li[data-event-id="quiet-pass"]')).toHaveCount(0);
  await expect(merge.locator('svg.tree')).toBeVisible();
  await expect(page.locator('li[data-event-id="later-push-to-same-tip"]')).toContainText('Later default branch push');
  const approved = page.locator('li[data-event-id="approval-highlight"]');
  const approvalLabel = approved.locator('.kind');
  const readyLabel = page.locator('li[data-event-id="opened-0"] .kind');
  await expect(approvalLabel).toHaveText('Approvals met');
  await expect(approved.locator('.rowact time')).toHaveCSS('white-space', 'nowrap');
  const statusColor = () => approvalLabel.evaluate(element => getComputedStyle(element).color);
  const sharesStatusColor = (label: typeof approvalLabel) =>
    label.evaluate(element => getComputedStyle(element).color).then(color => statusColor().then(approval => approval === color));
  assert.equal(await sharesStatusColor(readyLabel), false);
  assert.equal(await sharesStatusColor(merge.locator('.kind')), false);
  await expect(approved.locator('.title')).toHaveText(approval.title);
  await expect(approved.locator('.feed-title')).toHaveAccessibleName(/fatty_acids_individual_risks/);
  await expect(approved.locator('.ref-actor')).toHaveText('author Ines Adriaens - Doekes');
  await expect(approved.locator('.ref-repo')).toBeVisible();
  await expect(approved.locator('xpath=..')).toHaveAttribute('data-tree-lanes', '5');
  const longCi = approved.getByRole('button', { name: 'PR validation partially succeeded on earlier revision' });
  await expect(longCi).toBeVisible();
  // The trouble line keeps first-screen timestamps down: the run's time is in its title, not on the line.
  await expect(longCi.locator('time')).toHaveCount(0);
  await expect(longCi).toHaveAttribute('title', /^PR validation · Billing CI · .*\d/);
  await expect(longCi).toHaveText('! PR validation partially succeeded on earlier revision · Billing CI');
  await expect(approved.locator('.status .ci-run')).toHaveCount(0);
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
      const ci = box('.ci-trouble button');
      return {
        labelFits: rect.right <= bounds.right + 1 && [subject, actions].every(area => !overlaps(rect, area)),
        actionsClearTitle: !overlaps(actions, subject),
        ciFits: ci.right <= subject.right + 1,
        pageFits: document.documentElement.scrollWidth <= innerWidth,
      };
    });
  const allFit = { labelFits: true, actionsClearTitle: true, ciFits: true, pageFits: true };
  for (const width of [1100, 640, 767, 1278, 320, 390, 639, 1024, 1099, 1536]) {
    await page.setViewportSize({ width, height: 900 });
    await expect.poll(rowFits, { message: `The approval row fits at ${width}px` }).toEqual(allFit);
  }
  await page.setViewportSize({ width: 1278, height: 900 });
  const metadataLeft = (row: typeof approved) => row.locator('.subject').evaluate(element => element.getBoundingClientRect().left);
  assert.ok(
    Math.abs((await metadataLeft(approved)) - (await metadataLeft(merge))) <= 1,
    'titles and their facts keep their alignment on rows with and without an Azure link',
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
    'titles and their facts stay aligned with wider control labels',
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

test('an idle Activity tab moves its day headers on after midnight', async t => {
  const { page } = await multiDayFixture(t);
  const headers = page.locator('details[data-group="activity"] ul.rows li.day');
  await expect(headers.first()).toHaveText('Today');
  // The server state stays the same, so only the local day changing can move the labels on at the next poll.
  await page.clock.setFixedTime(new Date(2026, 10, 29, 0, 5));
  await expect(headers.first()).toHaveText(/^Yesterday · .*\b28\b/, { timeout: 15000 });
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
  // An imported row shows its time and Azure link in the right cell, and no Seen toggle.
  const imported = page.locator('details[data-group="imported-history"] li.row');
  await expect(imported).toHaveCount(2);
  await expect(imported.locator('.rowact > time')).toHaveCount(2);
  await expect(imported.locator('.seen-toggle, [aria-pressed], input[type="checkbox"]')).toHaveCount(0);
  // A header is not a row: rows, row IDs, the group count and Seen toggles leave it out, and it holds nothing to act on.
  await expect(list.locator('li.row')).toHaveCount(9);
  await expect(list.locator('li[data-event-id]')).toHaveCount(9);
  await expect(list.locator('.seen-toggle')).toHaveCount(9);
  await expect(activity.locator('summary .pill')).toHaveText('9');
  await expect(list.locator('li.day :is(a, button, input, [tabindex])')).toHaveCount(0);
  await expect(list.locator('li.row > svg.tree')).toHaveCount(9);
  // A row shows only its clock under its day header; the full date stays in the title.
  const time = list.locator('li[data-event-id="yesterday-merge"] .rowact time');
  await expect(time).toHaveText(
    await page.evaluate(() => new Date(2026, 10, 27, 16).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })),
  );
  await expect(time).toHaveAttribute('title', /27/);

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

test('the vote tally on line 2 opens the named votes under it, and the rest of line 2 still opens the detail', async t => {
  const { page, runtime } = await setup(t);
  const branch = 'refs/heads/feature/votes';
  const votes = [
    { name: '[Demo]\\Data Team', vote: 10 },
    { name: 'Cy', vote: -5 },
  ];
  runtime.store.insertEvents([
    {
      id: 'voted-pr',
      repoId: 'demo-orders',
      kind: 'pr',
      title: 'PR 900 · Two votes',
      branch,
      actor: 'Ana',
      time: new Date().toISOString(),
      data: {
        pullRequestId: 900,
        status: 'active',
        sourceRefName: branch,
        targetRefName: 'refs/heads/main',
        reviewers: votes,
        voteChanges: votes,
      },
    },
  ]);
  await page.reload();
  const pr = page.locator('li[data-event-id="voted-pr"]');
  const tally = pr.getByRole('button', { name: '1 approval, 1 waiting for author', exact: true });
  await expect(tally).toHaveAttribute('aria-expanded', 'false');
  const list = pr.locator('.vote-list');
  await expect(list.locator('li').first()).toBeHidden();
  await tally.click();
  await expect(tally).toHaveAttribute('aria-expanded', 'true');
  await expect(list.locator('li')).toHaveText(['Data Team approved', 'Cy waiting for author']);
  await expect(page).toHaveURL(/#activity$/);
  // The list sits under line 2, and line 2 names no reviewer.
  const [facts, names] = await Promise.all([pr.locator('.row-head .subref').boundingBox(), list.boundingBox()]);
  assert.ok(facts && names && names.y >= facts.y + facts.height - 1);
  await expect(pr.locator('.row-head .subref')).not.toContainText('Cy');
  await pr.locator('.row-head .ref-actor').click();
  await expect(page).toHaveURL(/#event\/voted-pr$/);
});

test('at 360px a long vote tally wraps and the named votes shrink, so both stay inside the row', async t => {
  const { page, runtime } = await setup(t);
  const branch = 'refs/heads/feature/many-votes';
  const votes = [
    { name: '[Demo]\\Cloudforce Team Data Engineering Platform Reviewers', vote: 10 },
    { name: 'Bea', vote: 5 },
    { name: 'Cy', vote: -5 },
    { name: 'Dee', vote: -10 },
    { name: 'Ed', vote: 0 },
  ];
  runtime.store.insertEvents([
    {
      id: 'many-votes',
      repoId: 'demo-orders',
      kind: 'pr',
      title: 'PR 901 · Many votes',
      branch,
      actor: 'Ana',
      time: new Date().toISOString(),
      data: {
        pullRequestId: 901,
        status: 'active',
        sourceRefName: branch,
        targetRefName: 'refs/heads/main',
        reviewers: votes,
        voteChanges: votes,
      },
    },
  ]);
  await page.setViewportSize({ width: 360, height: 900 });
  await page.reload();
  const pr = page.locator('li[data-event-id="many-votes"]');
  const tally = pr.locator('.vote-tally');
  await tally.click();
  await expect(pr.locator('.vote-list li')).toHaveCount(5);
  const outside = await pr.evaluate(row => {
    const bounds = row.getBoundingClientRect();
    const right = bounds.right - parseFloat(getComputedStyle(row).paddingRight) + 0.5;
    return [row.querySelector('.vote-tally')!, ...row.querySelectorAll('.vote-list li > *')]
      .filter(element => element.getBoundingClientRect().right > right || element.scrollWidth > element.clientWidth + 1)
      .map(element => `${element.className}: ${element.textContent}`);
  });
  assert.deepEqual(outside, [], 'controls that reach past the row');
});

test('line 3 holds tokens of one shape in a fixed order, opens what they open under it, and is left out when empty', async t => {
  const { page } = await awkwardFixture(t);
  const line3 = (id: string) => page.locator(`li[data-event-id="${id}"] .subject > .row-line3`);
  const tokens = (id: string) => line3(id).locator(':scope > .token');
  // An unread merged PR from a fork: its linked push in the unread blue, then where it came from, which is plain text.
  await expect(tokens('fork-merge')).toHaveText(['Linked push · unread ›', 'From fork data-sandbox in Team Project']);
  await expect(tokens('fork-merge').first()).toHaveClass(/\bunread\b/);
  await expect(tokens('fork-merge').nth(1)).toHaveClass(/\bplain\b/);
  await expect(tokens('fork-merge').nth(1).locator('xpath=self::button')).toHaveCount(0);
  // A CI run with three updates offers them as a token in the unread blue.
  await expect(tokens('nightly-completed')).toHaveText(['3 updates ›']);
  await expect(tokens('nightly-completed')).toHaveClass(/\bunread\b/);
  await expect(tokens('incremental-push')).toHaveText(['Load commits']);
  // A listed new branch keeps its caveat on line 2, so where it started goes to line 3.
  await expect(tokens('incremental-branch')).toHaveText([/^Started at /]);
  await expect(line3('long-merge')).toHaveCount(0);
  await expect(page.locator('li[data-event-id="long-merge"] .row-extra')).toHaveCount(0);
  // Every token has the same shape.
  const shapes = await page.locator('.row-line3 > .token:not(.plain)').evaluateAll(elements =>
    elements.map(element => {
      const style = getComputedStyle(element);
      return [style.borderTopWidth, style.borderRadius, style.fontSize, style.height].join(' ');
    }),
  );
  assert.ok(shapes.length >= 3);
  assert.equal(new Set(shapes).size, 1, `token shapes: ${shapes.join(', ')}`);
  // A token opens its panel under line 3 and says so.
  const linked = page.locator('li[data-event-id="fork-merge"]').getByRole('button', { name: 'Linked push · unread', exact: true });
  await expect(linked).toHaveAttribute('aria-expanded', 'false');
  await linked.click();
  await expect(linked).toHaveAttribute('aria-expanded', 'true');
  const view = page.locator('li[data-event-id="fork-merge"]').getByRole('button', { name: 'View push to main' });
  await expect(view).toBeVisible();
  const below = async (id: string, panel: typeof view) => {
    const [line, box] = await Promise.all([line3(id).boundingBox(), panel.boundingBox()]);
    return !!line && !!box && box.y >= line.y + line.height - 1;
  };
  assert.ok(await below('fork-merge', view), 'the linked push opens under line 3');
  const trail = page.locator('li[data-event-id="nightly-completed"]');
  await trail.getByRole('button', { name: '3 updates', exact: true }).click();
  await expect(trail.locator('.trail li')).toHaveCount(3);
  assert.ok(await below('nightly-completed', trail.locator('.trail ol')), 'the trail opens under line 3');
  const push = page.locator('li[data-event-id="incremental-push"]');
  await push.getByRole('button', { name: 'Load commits', exact: true }).click();
  await expect(push.getByRole('button', { name: 'Reload commits', exact: true })).toBeVisible();
  await expect(push.locator('.row-extra summary')).toHaveText('Push commits');
});

test('rows use flat tints that the tree cuts out of, and colour only failures, runs in progress and warnings', async t => {
  const { page } = await awkwardFixture(t);
  await page.setViewportSize({ width: 1265, height: 1400 });
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await expect(page.locator('html')).toHaveClass(scheme === 'dark' ? /\bdark\b/ : /^(?!.*\bdark\b)/);
    await page.mouse.move(0, 0);
    // Controls fade to the new theme's colours, so read them once that has ended.
    await page.waitForFunction(() => document.getAnimations().length === 0);
    const read = await page.evaluate(() => {
      const probe = document.createElement('span');
      document.querySelector('.feed')!.append(probe);
      const token = (value: string) => {
        probe.style.color = value;
        return getComputedStyle(probe).color;
      };
      const css = (selector: string, property: string) => {
        const element = document.querySelector(selector);
        if (!element) throw new Error(`no ${selector}`);
        return getComputedStyle(element).getPropertyValue(property);
      };
      const row = (id: string) => `li[data-event-id="${id}"]`;
      const result = {
        card: token('var(--card)'),
        unreadTint: token('var(--row-unread)'),
        failedTint: token('var(--row-failed)'),
        critical: token('var(--critical)'),
        warning: token('var(--warning)'),
        muted: token('var(--muted-foreground)'),
        info: token('var(--info)'),
        unread: css(row('retry-pr'), 'background-color'),
        unreadImage: css(row('retry-pr'), 'background-image'),
        unreadBar: css(row('retry-pr'), 'box-shadow'),
        unreadTitle: css(`${row('retry-pr')} .title`, 'font-weight'),
        seenTitle: css(`${row('mixed-merge')} .title`, 'font-weight'),
        unreadSeenBox: css(`${row('retry-pr')} .seen-box`, 'color'),
        failed: css(row('incremental-ci'), 'background-color'),
        failedSeen: document.querySelector(row('incremental-ci'))!.classList.contains('new'),
        unreadFailed: css(row('nightly-completed'), 'background-color'),
        unreadFailedClasses: document.querySelector(row('nightly-completed'))!.className,
        seen: css(row('mixed-merge'), 'background-color'),
        failure: css(`${row('mixed-merge')} .ci-trouble .ci-run.crit`, 'color'),
        pass: css(`${row('mixed-merge')} .ci-trouble .ci-run.muted`, 'color'),
        running: css(`${row('retry-pr')} .ci-trouble .ci-run.warn`, 'color'),
        count: css(`${row('mixed-merge')} .ci-count`, 'color'),
        rewrite: css(`${row('rewrite-push')} .subref .status-chip.warn`, 'color'),
        // Every ring cutout and node outline is the colour of the row it sits on.
        cutouts: [...document.querySelectorAll('li.row')]
          .filter(element => element.checkVisibility())
          .flatMap(element => {
            const background = getComputedStyle(element).backgroundColor;
            return [...element.querySelectorAll('svg.tree .hole, svg.tree .dot, svg.tree .ci-node')].map(node => ({
              id: element.getAttribute('data-event-id'),
              unread: element.classList.contains('new'),
              background,
              paint: getComputedStyle(node).getPropertyValue(node.classList.contains('hole') ? 'fill' : 'stroke'),
            }));
          }),
      };
      probe.remove();
      return result;
    });
    assert.equal(read.unread, read.unreadTint, `${scheme}: an unread row has a flat blue tint`);
    assert.equal(read.unreadImage, 'none', `${scheme}: no gradient`);
    assert.equal(read.unreadBar, 'none', `${scheme}: no left bar while the tree shows`);
    assert.ok(Number(read.unreadTitle) > Number(read.seenTitle), `${scheme}: the unread title is bolder`);
    assert.equal(read.unreadSeenBox, read.info, `${scheme}: the unread Seen box is blue`);
    assert.equal(read.failedSeen, false, `${scheme}: the failed row is seen`);
    assert.equal(read.failed, read.failedTint, `${scheme}: a seen failed row has a flat red tint`);
    for (const name of ['new', 'crit']) assert.match(read.unreadFailedClasses, new RegExp(`\\b${name}\\b`), `${scheme}: unread and failed`);
    assert.equal(read.unreadFailed, read.unreadTint, `${scheme}: unread outranks failed: ${read.unreadFailedClasses}`);
    assert.equal(read.seen, read.card, `${scheme}: a seen row is the card`);
    assert.equal(read.failure, read.critical, `${scheme}: a failure is red`);
    assert.equal(read.running, read.warning, `${scheme}: a run in progress is amber`);
    assert.equal(read.pass, read.muted, `${scheme}: a pass is muted`);
    assert.equal(read.count, read.muted, `${scheme}: the CI count is muted`);
    assert.equal(read.rewrite, read.warning, `${scheme}: the rewrite warning is amber`);
    assert.ok(
      read.cutouts.some(cutout => cutout.unread),
      `${scheme}: an unread row has a node`,
    );
    for (const cutout of read.cutouts) assert.equal(cutout.paint, cutout.background, `${scheme}: the node cutout of ${cutout.id}`);
  }
  // Hover keeps the tint flat, and the cutouts follow it.
  const hovered = page.locator('li[data-event-id="fork-merge"]');
  await hovered.hover();
  // The background changes at once, as the cutouts do: a fade would show them in the new colour on the old background.
  assert.deepEqual(await hovered.evaluate(row => row.getAnimations().map(animation => String(animation.constructor.name))), []);
  await page.waitForFunction(() => document.getAnimations().length === 0);
  const hover = await hovered.evaluate(row => ({
    background: getComputedStyle(row).backgroundColor,
    hole: getComputedStyle(row.querySelector('svg.tree .hole, svg.tree .dot')!).getPropertyValue(
      row.querySelector('svg.tree .hole') ? 'fill' : 'stroke',
    ),
  }));
  assert.equal(hover.hole, hover.background);
});

test('Mark all seen, the lane key and Open Git Graph share one top line, and the key opens below it', async t => {
  const { page } = await setup(t);
  await page.setViewportSize({ width: 1265, height: 900 });
  const bulk = page.locator('.feed-actions button');
  const key = page.locator('.activity-graph-guide > details > summary');
  const graph = page.getByRole('link', { name: 'Open Git Graph', exact: true });
  await expect(bulk).toHaveText(/^Mark all seen \(\d+\)$/);
  const centres = async () =>
    Promise.all([bulk, key, graph].map(async item => item.boundingBox().then(box => (box ? Math.round(box.y + box.height / 2) : NaN))));
  const [first = NaN, ...rest] = await centres();
  for (const centre of rest) assert.ok(Math.abs(centre - first) <= 2, `top line centres: ${[first, ...rest].join(', ')}`);
  await key.click();
  const legend = page.locator('.tree-legend');
  await expect(legend).toBeVisible();
  const [summary, open] = await Promise.all([key.boundingBox(), legend.boundingBox()]);
  assert.ok(summary && open && open.y >= summary.y + summary.height - 1, 'the key opens below the top line');
  assert.deepEqual(await centres(), [first, ...rest], 'the top line stays where it was');
  // Below 640px the key and the tree are gone, and the bulk action keeps its line.
  await page.setViewportSize({ width: 360, height: 800 });
  await expect(key).toBeHidden();
  await expect(bulk).toBeVisible();
});

test('rows keep kind and time on their top line at 800 and 360px, and times line up with or without Azure and Seen', async t => {
  const { page } = await awkwardFixture(t);
  await page.locator('details[data-group="imported-history"] > summary').click();
  const layout = () =>
    page.locator('li.row').evaluateAll(rows =>
      rows
        .filter(row => row.checkVisibility())
        .map(row => {
          const box = (selector: string) => row.querySelector(selector)?.getBoundingClientRect();
          const kind = box('.kind')!;
          const time = box('.row-time')!;
          const status = box('.status')!;
          const subject = box('.subject')!;
          const count = box('.ci-count');
          const centre = (rect: DOMRect) => rect.top + rect.height / 2;
          return {
            id: row.getAttribute('data-event-id'),
            sameLine: Math.abs(centre(kind) - centre(time)) <= 4 && time.left > kind.right,
            countBeside: !count || Math.abs(centre(count) - centre(kind)) <= 2,
            subjectBelow: subject.top >= status.bottom - 1,
            timeRight: Math.round(time.right),
            bar: getComputedStyle(row).boxShadow,
            unread: row.classList.contains('new'),
          };
        }),
    );
  const fits = () => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);
  for (const width of [800, 360]) {
    await page.setViewportSize({ width, height: 1200 });
    await expect.poll(fits, { message: `no horizontal scroll at ${width}px` }).toBe(true);
    const rows = await layout();
    assert.ok(rows.length >= 12, `${width}px rows`);
    for (const row of rows) {
      assert.ok(row.sameLine, `${width}px: kind and time share the top line of ${row.id}`);
      assert.ok(row.countBeside, `${width}px: the CI count of ${row.id} sits beside its kind`);
      assert.ok(row.subjectBelow, `${width}px: the main cell of ${row.id} is below its top line`);
      // Only the phone layout marks unread with a bar; the tree's blue lane would sit next to it otherwise.
      if (row.unread && width < 640) assert.match(row.bar, /^\S.* 2px 0px 0px 0px inset$/, `${width}px: ${row.id} bar`);
      else assert.equal(row.bar, 'none', `${width}px: ${row.id} bar`);
    }
    assert.equal(new Set(rows.map(row => row.timeRight)).size, 1, `${width}px: times line up`);
  }
  // Phone: no tree, the kind glyph shows, and the Seen box is 16px.
  await expect(page.locator('li[data-event-id="retry-pr"] svg.tree')).toBeHidden();
  await expect(page.locator('li[data-event-id="retry-pr"] .kind > .d')).toBeVisible();
  const seenBox = await page.locator('li[data-event-id="retry-pr"] .seen-box').boundingBox();
  assert.equal(seenBox?.width, 16);
  await expect(page.locator('li[data-event-id="retry-pr"] .seen-toggle')).toHaveAccessibleName(/^Seen: /);
  // Wide: times line up across rows with and without an Azure link or Seen box.
  for (const width of [1100, 1265]) {
    await page.setViewportSize({ width, height: 1200 });
    const rows = await layout();
    assert.equal(new Set(rows.map(row => row.timeRight)).size, 1, `${width}px: times line up`);
  }
});

test('each rare piece of a row has its place', async t => {
  const { page } = await awkwardFixture(t);
  const row = (id: string) => page.locator(`li[data-event-id="${id}"]`);
  // Merge evidence sits on line 2; a history rewrite is a warning.
  const rewrite = row('rewrite-push').locator('.row-head > .subref > .status-chip.warn');
  await expect(rewrite).toHaveText('History rewritten · 2 commits dropped');
  // The "N new" pill sits on line 1, in the title.
  await expect(row('fork-merge').locator('.feed-title .title > .new-count')).toHaveText('2 new');
  // A CI run on a pull request ref names the PR with a chip on line 2.
  await expect(row('pr-ref-ci').locator('.row-head > .subref .ref-pr')).toHaveText(' · PR 21950');
  await expect(row('pr-ref-ci').locator('.row-head > .subref .ref-pr')).toBeVisible();
  // Where a listed branch started is a plain note on line 3.
  await expect(row('incremental-branch').locator('.row-line3 > .token.plain.event-origin')).toHaveText(/^Started at /);
  // A failed run links to the change it tested from its trouble line.
  const host = row('mixed-dbt').locator('.subject > .ci-trouble > .ci-host');
  await expect(host).toHaveText('View tested change');
  await host.click();
  await expect(page).toHaveURL(/#event\/mixed-merge$/);
  await page.getByRole('link', { name: /Back to Activity/ }).click();
  // An imported row has no Seen toggle, only the space one would take.
  await page.locator('details[data-group="imported-history"] > summary').click();
  const imported = row('imported-push');
  await expect(imported).toBeVisible();
  await expect(imported.locator('.seen-toggle, [aria-pressed], input[type="checkbox"]')).toHaveCount(0);
  await expect(imported.locator('.rowact > .slot')).toHaveCount(2);
});
