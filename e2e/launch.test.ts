import test from 'node:test';
import assert from 'node:assert/strict';
import { gate, openContext, openPage, startTestApp } from './fixtures/app.ts';
import { expect } from '@playwright/test';
import { rememberKey } from '../test/fixtures/access.ts';
import { setup } from './fixtures/ui-app.ts';
import { demo } from './fixtures/history-app.ts';

test('Escape before the first state load does not throw', async t => {
  const { runtime } = await startTestApp(t, { highlights: true });
  const page = await openPage(t);
  const stateHeld = gate(t, 'first state read');
  await page.route('**/api/state', async route => {
    await stateHeld.opened;
    await route.continue();
  });
  await page.goto(runtime.launchUrl, { waitUntil: 'domcontentloaded' });
  await page.keyboard.press('Escape');
  stateHeld.release();
  await expect(page.locator('#repo-toggle')).toBeVisible();
});

test('the launch link works once, hides its token, and a stale or forged link cannot replace a working key', async t => {
  const app = await setup(t);
  const { page, runtime } = app;
  assert.equal(new URL(page.url()).hash.includes('launch='), false);
  // A forged link in a fresh document tries the exchange, fails, and keeps the working key. A separate tab with this run's
  // key stored keeps its expected 401 responses out of the setup's console check.
  const context = await openContext(t);
  const tab = await context.newPage();
  await rememberKey(tab, runtime.accessKey);
  const forged = tab.waitForResponse(response => new URL(response.url()).pathname === '/api/session');
  await tab.goto(`${runtime.url}/#launch=forged-token`);
  assert.equal((await forged).status(), 401);
  await tab.goto(runtime.url + '/#repositories');
  // The watched demo repositories load only if the state request was authorized.
  await expect(tab.getByRole('article').first()).toBeVisible();
  // A launch link opened in the tab that already shows the app reloads it, so the exchange runs again.
  const again = tab.waitForResponse(response => new URL(response.url()).pathname === '/api/session');
  await tab.evaluate(() => {
    location.hash = '#launch=another-forged-token';
  });
  assert.equal((await again).status(), 401);
  await expect(tab.getByRole('link', { name: 'Repo Pulse', exact: true })).toBeVisible();
  const stranger = await openPage(t);
  // The same launch link in a browser without the key is already spent.
  await stranger.goto(runtime.launchUrl);
  await expect(
    stranger
      .getByText(
        'Open the newest link printed in the terminal where Repo Pulse runs. Each link works once; restart Repo Pulse for a new one.',
      )
      .first(),
  ).toBeVisible();
});

test('opening Activity before the first state load arrives stays on Activity', async t => {
  const { runtime, page } = await demo(t);
  const release = gate(t, 'first state read');
  const held = Promise.withResolvers<void>();
  await page.route('**/api/state', async route => {
    held.resolve();
    await release.opened;
    await route.continue();
  });
  await page.reload();
  await held.promise;
  // The page has not seen its repositories yet, so it must not judge that none are watched.
  await page.goto(runtime.url + '/#activity/unread');
  // Activity has rendered from the hash change while the first state read is still held.
  await expect(page.getByRole('region', { name: 'Repository activity' }).getByText('Loading activity…')).toBeVisible();
  release.release();
  await expect(page.getByRole('button', { name: /^Mark all seen/ })).toBeVisible();
  assert.match(page.url(), /#activity\/unread$/);
});
