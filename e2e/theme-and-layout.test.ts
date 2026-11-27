import test from 'node:test';
import assert from 'node:assert/strict';
import { capture } from './fixtures/app.ts';
import { expect } from '@playwright/test';
import type { ActivityKind } from '../src/activity.ts';
import type { EventData } from '../src/contract.d.ts';
import { setup, groupedFixture } from './fixtures/ui-app.ts';

test('approved light/dark/System UI and responsive routes work without remote traffic', async t => {
  const { page } = await setup(t);
  await expect(page.getByText('Demo mode · fictional repositories and people')).toBeVisible();
  await expect(page.locator('[data-event-id="demo-branch-1"]')).toContainText('hotfix/2026.11-dose-rounding');
  const remoteReads: string[] = [];
  page.on('request', request => {
    if (/\/api\/(refresh|connection|repos)(\?|$)/.test(request.url())) remoteReads.push(request.url());
  });
  await page.getByRole('button', { name: 'Light', exact: true }).click();
  await capture(page, 'app-light.png', { fullPage: true });
  await page.getByRole('button', { name: 'Dark', exact: true }).click();
  await expect(page.locator('html')).toHaveClass(/dark/);
  await page.reload();
  await expect(page.getByRole('button', { name: 'Dark', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await capture(page, 'app-dark.png', { fullPage: true });
  await page.getByRole('button', { name: 'System', exact: true }).click();
  await page.emulateMedia({ colorScheme: 'light' });
  await expect(page.locator('html')).not.toHaveClass(/dark/);
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(page.locator('html')).toHaveClass(/dark/);
  assert.deepEqual(remoteReads, []);
  for (const width of [360, 728, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    for (const route of ['activity/unread', 'activity', 'repositories', 'settings']) {
      await page.goto(`${page.url().split('#')[0]}#${route}`);
      await expect(page.locator('main h1')).toHaveCount(1);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${route} overflow at ${width}`);
    }
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${page.url().split('#')[0]}#activity/unread`);
  await capture(page, 'app-phone-dark.png', { fullPage: true });
  await page.getByRole('button', { name: 'Light', exact: true }).click();
  await capture(page, 'app-phone-light.png', { fullPage: true });
});

test('Light uses the vivid palette with glass chrome, status pills and an opaque Activity feed', async t => {
  const { page } = await setup(t);
  const palette = await page.locator('html').evaluate(root => {
    const style = getComputedStyle(root);
    return ['background', 'foreground', 'muted-foreground', 'primary', 'border', 'input', 'lane-1', 'lane-2', 'lane-3'].map(name =>
      style.getPropertyValue(`--${name}`).trim(),
    );
  });
  assert.deepEqual(palette, ['#dfe7f1', '#0a1020', '#47506a', '#2447e0', '#b8c3d6', '#9eabc2', '#2447e0', '#0a7269', '#c2255c']);
  const pill = page.locator('.feed .kind.crit .kind-label').first();
  await expect(pill).toHaveCSS('font-weight', '600');
  await expect(pill).toHaveCSS('background-color', /^color\(srgb 0\.97\d* 0\.88\d* 0\.89\d*\)$/);
  await page.getByRole('button', { name: 'Save filter…' }).click();
  const save = page.getByRole('dialog').getByRole('button', { name: 'Save', exact: true });
  await save.hover();
  const primaryHover = await save.evaluate(async element => {
    await Promise.all(element.getAnimations().map(animation => animation.finished));
    const { backgroundColor, color } = getComputedStyle(element);
    const context = document.createElement('canvas').getContext('2d');
    if (!context) throw new Error('2D canvas is unavailable');
    const luminance = (value: string) => {
      context.fillStyle = value;
      context.fillRect(0, 0, 1, 1);
      const [red = 0, green = 0, blue = 0] = context.getImageData(0, 0, 1, 1).data;
      const linear = (channel: number) => (channel <= 10 ? channel / 3294.6 : ((channel / 255 + 0.055) / 1.055) ** 2.4);
      return 0.2126 * linear(red) + 0.7152 * linear(green) + 0.0722 * linear(blue);
    };
    const levels = [luminance(backgroundColor), luminance(color)];
    return (Math.max(...levels) + 0.05) / (Math.min(...levels) + 0.05);
  });
  assert.ok(primaryHover >= 4.5, `Primary action hover contrast is ${primaryHover}`);
  await page.keyboard.press('Escape');
  const summary = page.getByRole('region', { name: 'Activity summary' });
  const headline = await summary.locator('.headline').boundingBox();
  const counts = await summary.locator('.cells').boundingBox();
  assert.ok(headline && counts && counts.y >= headline.y + headline.height, 'Counts sit below the headline on desktop');
  const backdrop = await page.locator('body').evaluate(body => getComputedStyle(body, '::before').backgroundImage);
  assert.match(backdrop, /74, 168, 255/);
  assert.match(backdrop, /123, 107, 255/);
  assert.match(backdrop, /31, 184, 201/);
  await expect(summary).toHaveCSS('backdrop-filter', 'blur(20px) saturate(1.35)');
  await expect(summary).toHaveCSS('border-top-color', 'rgb(255, 255, 255)');
  await expect(page.locator('.feed')).toHaveCSS('backdrop-filter', 'none');
  await expect(page.locator('.feed')).toHaveCSS('background-color', 'rgb(255, 255, 255)');
  await expect(page.locator('#demo .banner')).toHaveCSS('background-color', 'rgb(255, 255, 255)');
  const unread = page.getByRole('button', { name: 'Unread only', exact: true });
  await unread.click();
  await expect(unread).toHaveAttribute('aria-pressed', 'true');
  await expect(unread).toHaveCSS('background-image', /linear-gradient/);
  const filterOpacity = () =>
    unread.evaluate(element => {
      const context = document.createElement('canvas').getContext('2d');
      if (!context) throw new Error('2D canvas is unavailable');
      context.fillStyle = getComputedStyle(element).backgroundColor;
      context.fillRect(0, 0, 1, 1);
      return context.getImageData(0, 0, 1, 1).data[3] ?? 0;
    });
  assert.ok((await filterOpacity()) > 127, 'Active filter keeps a glass backing');
  const session = await page.context().newCDPSession(page);
  await session.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-transparency', value: 'reduce' }] });
  await expect(summary).toHaveCSS('backdrop-filter', 'none');
  await expect(summary).toHaveCSS('background-color', 'rgb(255, 255, 255)');
  await expect(unread).toHaveCSS('background-image', 'none');
  await expect.poll(filterOpacity).toBe(255);
  await session.send('Emulation.setEmulatedMedia', { features: [] });
  await session.detach();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(summary.locator('.headline')).toBeVisible();
  await expect(summary.locator('.cells')).toBeHidden();

  // An unknown media feature is unmatched even when negated.
  await page.route('**/web/styles/tokens.css', async route => {
    const response = await route.fetch();
    const body = (await response.text()).replaceAll('prefers-reduced-transparency', 'repo-pulse-unknown-preference');
    await route.fulfill({ response, body });
  });
  await page.reload();
  await expect(summary).toHaveCSS('backdrop-filter', /blur/);
});

test('mixed control rows use one height per size on desktop and phone', async t => {
  const { page, runtime } = await groupedFixture(t);
  runtime.store.setSetting('savedActivityFilters', [
    { id: 'team', name: 'Orders team', filters: { search: '', people: '', kind: '', repoIds: null, view: 'new' } },
  ]);
  await page.reload();
  const height = (selector: string, expected: number) => expect(page.locator(selector)).toHaveCSS('height', `${expected}px`);

  for (const [width, standard, compact] of [
    [1280, 36, 28],
    [390, 44, 36],
  ] satisfies [number, number, number][]) {
    await page.setViewportSize({ width, height: 900 });
    if (width < 640) await expect(page.locator('#activity-filters')).toBeHidden();
    await page.locator('#saved-filter-toggle').click();
    await page.getByRole('option', { name: /Orders team/ }).click();
    if (width < 640) await page.locator('#activity-filters-toggle').click();
    await page.locator('#feed-search').fill(' ');
    for (const theme of ['Light', 'Dark']) {
      await page.getByRole('button', { name: theme, exact: true }).click();
      for (const selector of ['#feed-search', '#kind-toggle', '#clear-filters', '#saved-filter-toggle', '#saved-filter-actions-toggle'])
        await height(selector, standard);
      await height('.rowact [data-action="ack-item"]', compact);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    }
  }

  await page.getByRole('link', { name: 'Settings', exact: true }).click();
  await page.locator('#azure-connection-toggle').click();
  for (const [width, compact] of [
    [390, 36],
    [1280, 28],
  ] satisfies [number, number][]) {
    await page.setViewportSize({ width, height: 900 });
    await height('#connection-repo', compact);
    await height('#check-settings-connection', compact);
  }
});

test('healthy phone catch-up shows first activity and theme icons before the fold', async t => {
  const { page } = await groupedFixture(t);
  for (const theme of ['Light', 'Dark']) {
    await page.getByRole('button', { name: theme, exact: true }).click();
    await page.setViewportSize({ width: 375, height: 812 });
    await expect(page.locator('#activity-filters')).toBeHidden();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    const top = await page
      .locator('li.row')
      .first()
      .evaluate(element => element.getBoundingClientRect().top);
    assert.ok(top < 600, `first activity starts at ${top}px`);
    for (const name of ['System', 'Light', 'Dark']) {
      const box = await page.getByRole('button', { name, exact: true }).boundingBox();
      assert.ok(box && box.x >= 0 && box.x + box.width <= 375 && box.y + box.height < 120);
    }
    await capture(page, `improved-phone-${theme.toLowerCase()}.png`, { fullPage: true });
    await page.setViewportSize({ width: 1280, height: 900 });
    await capture(page, `improved-desktop-${theme.toLowerCase()}.png`, { fullPage: true });
  }
});

test('activity hover uses color instead of underlining and retains keyboard focus in both themes', async t => {
  const { page } = await groupedFixture(t);
  const title = page.locator('li.row .feed-title');
  for (const theme of ['Light', 'Dark']) {
    await page.getByRole('button', { name: theme, exact: true }).click();
    await page.mouse.move(0, 0);
    const initial = await title.evaluate(element => getComputedStyle(element).color);
    await title.hover();
    const hovered = await title.evaluate(element => ({
      color: getComputedStyle(element).color,
      decoration: getComputedStyle(element).textDecorationLine,
    }));
    assert.equal(hovered.decoration, 'none');
    assert.notEqual(hovered.color, initial);
    await title.focus();
    await page.keyboard.press('Tab');
    await page.keyboard.press('Shift+Tab');
    await expect(title).toBeFocused();
    assert.deepEqual(
      await title.evaluate(element => ({ style: getComputedStyle(element).outlineStyle, width: getComputedStyle(element).outlineWidth })),
      { style: 'solid', width: '2px' },
    );
    await capture(page, `hover-${theme.toLowerCase()}.png`, { fullPage: true });
  }
});

test('semantic status colors match rows, imported history, details and trails in both themes', async t => {
  const { page, runtime, event } = await groupedFixture(t);
  const cases: [string, ActivityKind, EventData, string, string][] = [
    ['deleted', 'branch-deleted', { evidence: 'push' }, 'crit', 'Branch deleted'],
    ['failed', 'build', { status: 'completed', result: 'failed' }, 'crit', 'CI failed'],
    ['canceled', 'build', { status: 'completed', result: 'canceled' }, 'warn', 'CI canceled'],
    ['abandoned', 'pr', { status: 'abandoned' }, 'warn', 'PR abandoned'],
    ['partial', 'build', { status: 'completed', result: 'partiallySucceeded' }, 'warn', 'CI partially succeeded'],
    ['completed', 'pr', { status: 'completed' }, 'ok', 'PR merged'],
    ['succeeded', 'build', { status: 'completed', result: 'succeeded' }, 'ok', 'CI succeeded'],
    ['open', 'pr', { status: 'active' }, 'info', 'Open PR'],
    ['queued', 'build', { status: 'notStarted' }, 'info', 'CI queued'],
    ['created', 'branch-created', {}, 'info', 'New branch'],
    ['push', 'push', {}, 'info', 'Push'],
    ['draft', 'pr', { status: 'active', isDraft: true }, 'neutral', 'Draft PR'],
    ['skipped', 'build', { status: 'completed', result: 'skipped' }, 'neutral', 'CI skipped'],
    ['uncertain', 'branch-deleted', { evidence: 'snapshot' }, 'warn', 'No longer listed'],
  ];
  runtime.store.insertEvents(
    cases.map(([id, kind, data], index) => ({
      id: `color-${id}`,
      repoId: 'demo-orders',
      kind,
      branch: 'feature/example',
      title: id,
      time: new Date(Date.now() - 600000 - index * 1000).toISOString(),
      observedAt: new Date(Date.now() - 600000).toISOString(),
      imported: true,
      seen: true,
      data: { ...data, ...(kind === 'build' ? { buildId: 800 + index } : {}) },
    })),
  );
  runtime.store.insertEvents([
    { ...event('canceled-transition', 'completed', 0), data: { ...event('', '', 0).data, status: 'completed', result: 'canceled' } },
  ]);
  await page.goto(page.url().split('#')[0] + '#activity');
  for (const theme of ['Light', 'Dark']) {
    await page.getByRole('button', { name: theme, exact: true }).click();
    const history = page.locator('details[data-group="Imported history"]');
    if (!(await history.evaluate((element: HTMLDetailsElement) => element.open))) await history.locator('summary').first().click();
    for (const [id, , , tone, label] of cases) {
      const row = page.locator(`li[data-event-id="color-${id}"]`);
      await expect(row.locator('.kind')).toHaveText(label);
      await expect(row.locator('.kind')).toHaveClass(new RegExp(`\\b${tone}\\b`));
      await expect(row).toHaveClass(new RegExp(`\\btone-${tone}\\b`));
    }
    await expect(page.locator('[data-event-id="color-deleted"]')).not.toHaveClass(/(?:^|\s)crit(?:\s|$)/);
    await expect(page.locator('[data-event-id="color-failed"]')).toHaveClass(/(?:^|\s)crit(?:\s|$)/);
    const contrast = await page.evaluate(() => {
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 1;
      const context = canvas.getContext('2d');
      if (!context) throw new Error('The canvas has no 2D context.');
      const rgba = (color: string): [number, number, number, number] => {
        context.clearRect(0, 0, 1, 1);
        context.fillStyle = color;
        context.fillRect(0, 0, 1, 1);
        // One pixel is always four channels, so the defaults never apply.
        const [red = 0, green = 0, blue = 0, alpha = 0] = context.getImageData(0, 0, 1, 1).data;
        return [red, green, blue, alpha];
      };
      const linear = (value: number) => {
        const c = value / 255;
        return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
      };
      const luminance = ([red, green, blue]: [number, number, number, number]) =>
        linear(red) * 0.2126 + linear(green) * 0.7152 + linear(blue) * 0.0722;
      const tokens = getComputedStyle(document.documentElement);
      const names: Record<string, string> = {
        crit: '--critical',
        warn: '--warning',
        ok: '--ok',
        info: '--info',
        neutral: '--muted-foreground',
      };
      const washes: Record<string, string> = { crit: '--critical-wash', warn: '--warning-wash', ok: '--ok-wash', info: '--primary-wash' };
      return [...document.querySelectorAll<HTMLElement>('li[data-event-id^="color-"]')].map(row => {
        const kind = row.querySelector('.kind');
        const card = row.closest('.card');
        if (!kind || !card) throw new Error(`${row.dataset.eventId} has no status label or card.`);
        const named = Object.entries(names).find(([name]) => kind.classList.contains(name));
        if (!named) throw new Error(`${row.dataset.eventId} has no status tone.`);
        const [tone, defaultToken] = named;
        const token = kind.classList.contains('merged') ? '--merged' : defaultToken;
        const foreground = rgba(getComputedStyle(kind).color);
        let background = rgba(getComputedStyle(card).backgroundColor);
        const hasWash = getComputedStyle(row).backgroundImage !== 'none';
        const washToken = washes[tone];
        if (washToken && hasWash) {
          const [washRed, washGreen, washBlue, washAlpha] = rgba(tokens.getPropertyValue(washToken));
          const blend = (value: number, tint: number) => (tint * washAlpha) / 255 + value * (1 - washAlpha / 255);
          const [red, green, blue] = background;
          background = [blend(red, washRed), blend(green, washGreen), blend(blue, washBlue), 255];
        }
        const first = luminance(foreground),
          second = luminance(background);
        return {
          id: row.dataset.eventId,
          tone,
          hasWash,
          unread: row.classList.contains('new'),
          critical: row.classList.contains('crit'),
          ratio: (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05),
          matchesToken: JSON.stringify(foreground) === JSON.stringify(rgba(tokens.getPropertyValue(token))),
        };
      });
    });
    for (const result of contrast) {
      assert.equal(result.matchesToken, true, `${theme} ${result.id} token`);
      assert.equal(result.hasWash, result.critical || (theme === 'Dark' && result.unread), `${theme} ${result.id} wash`);
      assert.ok(result.ratio >= 4.5, `${theme} ${result.id} contrast ${result.ratio}`);
    }
    const trail = page.locator('[data-event-id="canceled-transition"] .trail');
    if (!(await trail.evaluate((element: HTMLDetailsElement) => element.open))) await trail.locator('summary').click();
    await expect(trail.locator('.status-text.warn')).toHaveText('Canceled');
    await expect(trail.locator('.status-text.info')).toHaveCount(2);
    await capture(page, `status-colors-${theme.toLowerCase()}.png`, { fullPage: true });
  }
  await page.getByRole('button', { name: 'Light', exact: true }).click();
  await page.locator('[data-event-id="color-completed"] .feed-title').click();
  await expect(page.locator('#page .status-chip')).toHaveClass(/\bok\b/);
  await expect(page.locator('#page .status-chip')).toHaveText('Merged');
  await expect(page.locator('#page .status-chip')).toHaveCSS('color', 'rgb(6, 116, 61)');
});

test('at 640px a long repository status pill wraps inside its column instead of covering the checkout status', async t => {
  const { page } = await setup(t);
  const delayed = { state: 'delayed', reason: 'Checks are behind schedule', stream: 'pushes' };
  await page.route('**/api/state', async route => {
    const state = await (await route.fetch()).json();
    const repos = Object.fromEntries(Object.keys(state.syncStatus.repos).map(id => [id, delayed]));
    await route.fulfill({ json: { ...state, demo: false, syncStatus: { overall: { ...delayed, repoId: 'demo-orders' }, repos } } });
  });
  await page.setViewportSize({ width: 640, height: 900 });
  await page.goto(`${page.url().split('#')[0]}#repositories`);
  const entries = page.locator('.repo-entry:not(.repo-disabled)');
  await expect(entries.first().locator('.sync-pill')).toHaveText('Delayed · checks are behind schedule');
  for (const entry of await entries.all()) {
    const [pill, column, checkout] = await Promise.all(
      ['.repo-overview .sync-pill', '.repo-overview', '.repo-checkout-line'].map(selector => entry.locator(selector).boundingBox()),
    );
    assert.ok(pill && column && checkout);
    assert.ok(
      pill.x + pill.width <= column.x + column.width + 0.5,
      `pill ends at ${pill.x + pill.width}, its column at ${column.x + column.width}`,
    );
    const overlaps =
      pill.x < checkout.x + checkout.width &&
      checkout.x < pill.x + pill.width &&
      pill.y < checkout.y + checkout.height &&
      checkout.y < pill.y + pill.height;
    assert.equal(overlaps, false, 'pill and checkout status overlap');
  }
});
