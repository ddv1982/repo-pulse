import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { openPage, startTestApp } from './app.ts';
import { expect } from '@playwright/test';
import type { Store } from '../../server/store.ts';

// These history fixtures exercise recorded groups independently of the Activity highlight policy.
export async function demo(t: TestContext) {
  const app = await startTestApp(t);
  const page = await openPage(t);
  const { runtime } = app;
  // Open the launch link once on a page that shows no activity; later visits to this origin reuse the stored key.
  await page.goto(runtime.launchUrl);
  await page.goto(`${runtime.url}/#settings`);
  await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible();
  return { runtime, page, restart: () => app.restart() };
}

/** Whether a stored event is marked seen; fails when the event is not stored. */
export function isSeen(store: Store, id: string) {
  const event = store.getEvent(id);
  assert.ok(event, `Event ${id} is not stored.`);
  return event.seen;
}
