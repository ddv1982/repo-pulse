// The repository picker, toasts and the error banner write Azure and Git text to innerHTML in the browser, so they
// are checked in a real page. Every such value holds a probe: markup that reaches innerHTML unescaped creates <x-…>
// elements whose `a` attribute names the field, and each value must read back as text exactly as the server sent it.
// test/escaping.test.js covers the views rendered to strings.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { chromium, expect } from '@playwright/test';
import { startApp, createApp } from '../server.ts';
import { createStore } from '../server/store.js';
import { createSync } from '../server/sync.js';
import { TEST_KEY, rememberKey } from '../test/fixtures/access.js';

/** @typedef {import('../server.ts').FoldersResponse} FoldersResponse */
/** @typedef {import('../server.ts').DiscoverResponse} DiscoverResponse */
/** @typedef {import('../server/repositories.ts').DiscoveredRemote} DiscoveredRemote */
/** @typedef {import('@playwright/test').Page} Page */

async function browserPath() {
  if (process.env.CHROME) return process.env.CHROME;
  if (existsSync(chromium.executablePath())) return chromium.executablePath();
  const cache = join(homedir(), '.cache', 'ms-playwright');
  for (const name of (await readdir(cache).catch(() => []))
    .filter(name => /^chromium-\d+$/.test(name))
    .sort()
    .reverse()) {
    for (const relative of ['chrome-linux64/chrome', 'chrome-linux/chrome']) {
      const candidate = join(cache, name, relative);
      if (existsSync(candidate)) return candidate;
    }
  }
  throw new Error('Install Chromium with npx playwright install chromium, or set CHROME.');
}

/**
 * Two tags, so a value the picker splits around a search match still has markup on both sides of the match.
 * @param {string} field
 */
const probe = field => `<x-probe a="${field}"><x-probe a="${field}">`;

/** @param {import('node:test').TestContext} t @param {string} url @param {string} [key] stored before the page loads */
async function openPage(t, url, key) {
  const browser = await chromium.launch({ executablePath: await browserPath(), headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  /** @type {string[]} */
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  t.after(async () => {
    await browser.close();
    assert.deepEqual(errors, []);
  });
  if (key) await rememberKey(page, key);
  await page.goto(url);
  return page;
}

/** The fields whose markup reached the page unescaped, named by the probe elements it created. @param {Page} page */
const rawProbes = page =>
  page.evaluate(() =>
    [...document.querySelectorAll('*')]
      .filter(node => node.localName.startsWith('x-'))
      .map(node => node.getAttribute('a') ?? node.localName),
  );

/** @param {string} name @param {string} [organization] @param {string} [project] @returns {DiscoveredRemote} */
const remote = (name, organization = `${name}.organization`, project = `${name}.project`) => ({
  name: probe(`${name}.name`),
  repoName: probe(`${name}.repoName`),
  organization: `https://dev.azure.com/${probe(organization)}`,
  project: probe(project),
  url: 'https://dev.azure.com/example/Demo/_git/unused',
});
const root = `/srv/${probe('folder.path')}`;
/** A checkout with two remotes under the home folder, and one with a remote in another organization under the listed folder. */
const discovery = /** @satisfies {DiscoverResponse} */ ({
  repositories: [
    { localPath: `/home/someone/${probe('multi.localPath')}`, remotes: [remote('multi.origin'), remote('multi.second')] },
    { localPath: `${root}/${probe('single.localPath')}`, remotes: [remote('single.origin')] },
  ],
  warnings: [probe('discovery.warning')],
});
/** @type {FoldersResponse} */
const folder = {
  path: root,
  parent: '/srv',
  breadcrumbs: [
    { name: '/', path: '/' },
    { name: probe('breadcrumb.parent.name'), path: '/srv' },
    { name: probe('breadcrumb.name'), path: root },
  ],
  folders: [{ name: probe('folder.name'), path: `${root}/${probe('folder.child')}` }],
  ...discovery,
};

/** What each checkout row shows, read back as text and attribute values. @param {Page} page */
const checkoutRows = page =>
  page.locator('#checkout-options [role="option"]').evaluateAll(rows =>
    rows.map(row => {
      const [path, context] = row.querySelectorAll('small');
      return {
        title: row.getAttribute('title'),
        name: row.querySelector('b')?.textContent,
        pathTitle: path.getAttribute('title'),
        path: path.textContent,
        context: context?.textContent,
        remote: row.querySelector('.picker-badges .chip')?.textContent,
      };
    }),
  );

/** @param {{ localPath: string }} checkout @param {DiscoveredRemote} item @param {string} path */
const checkoutRow = (checkout, item, path) => ({
  title: `${checkout.localPath} · ${item.project} · ${item.organization}`,
  name: item.repoName,
  pathTitle: checkout.localPath,
  path,
  context: `${item.project} · ${item.organization.replace('https://dev.azure.com/', '')}`,
  remote: item.name,
});

test('the repository picker shows folder, checkout and remote names as text', async t => {
  const [multi, single] = discovery.repositories;
  const store = createStore();
  const provider = {
    async checkConnection() {
      return { available: true, signedIn: true, account: { name: 'someone@example.test' }, message: 'Signed in.' };
    },
  };
  const server = createApp({
    accessKey: TEST_KEY,
    store,
    provider,
    sync: createSync({ store, provider }),
    browse: async () => folder,
    discover: async () => discovery,
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    store.close();
  });
  const page = await openPage(t, `http://127.0.0.1:${server.address().port}/#repositories`, TEST_KEY);

  const search = page.getByRole('combobox', { name: 'Search local repositories' });
  await search.focus();
  await expect(page.getByRole('option')).toHaveCount(3);
  assert.deepEqual(await rawProbes(page), []);
  const rows = [
    checkoutRow(multi, multi.remotes[0], `~/${probe('multi.localPath')}`),
    checkoutRow(multi, multi.remotes[1], `~/${probe('multi.localPath')}`),
    { ...checkoutRow(single, single.remotes[0], `./${probe('single.localPath')}`), remote: undefined },
  ];
  assert.deepEqual(await checkoutRows(page), rows);
  assert.deepEqual(
    await page.locator('.picker-crumbs').evaluate(nav => ({
      current: nav.querySelector('[aria-current]')?.textContent,
      currentTitle: nav.querySelector('[aria-current]')?.getAttribute('title'),
      parent: nav.querySelector('button[data-path="/srv"]')?.textContent,
    })),
    { current: probe('breadcrumb.name'), currentTitle: root, parent: probe('breadcrumb.parent.name') },
  );
  await expect(page.locator('#repository-picker > p.help:not([role])')).toHaveText(probe('discovery.warning'));

  // A search splits each matching value around the match to highlight it.
  await search.fill('probe');
  assert.deepEqual(await rawProbes(page), []);
  assert.deepEqual(await checkoutRows(page), rows);
  await expect(page.locator('#checkout-options mark')).toHaveCount(6);

  const second = multi.remotes[1];
  await page.getByRole('option').nth(1).click();
  const chip = page.locator('.picker-chips .chip');
  await expect(chip).toHaveText(`${second.repoName} · ${second.name}×`);
  await expect(chip.getByRole('button')).toHaveAttribute('aria-label', `Remove ${second.repoName} ${second.name}`);
  await expect(chip.getByRole('button')).toHaveAttribute('data-key', JSON.stringify([multi.localPath, second.name]));
  assert.deepEqual(await rawProbes(page), []);

  await page.route('**/api/repos', route =>
    route.fulfill({ status: 502, contentType: 'application/json', body: JSON.stringify({ message: probe('add.error') }) }),
  );
  await page.getByRole('button', { name: 'Watch 1 selected', exact: true }).click();
  await expect(page.locator('#repository-picker [role="alert"]')).toHaveText(`${second.repoName} · ${second.name}: ${probe('add.error')}`);
  assert.deepEqual(await rawProbes(page), []);

  await page.getByRole('button', { name: 'Change folder', exact: true }).click();
  await expect(page.getByRole('option')).toHaveCount(2);
  const child = page.getByRole('option').nth(1);
  await expect(child.locator('b')).toHaveText(probe('folder.name'));
  await expect(child.locator('small')).toHaveText(`./${probe('folder.child')}`);
  await expect(child.locator('small')).toHaveAttribute('title', folder.folders[0].path);
  assert.deepEqual(await rawProbes(page), []);
});

test('toasts and the error banner show repository names and API messages as text', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'repo-pulse-escaping-'));
  const runtime = await startApp({ demo: true, port: 0, dataDir: directory });
  t.after(async () => {
    await runtime.close();
    await rm(directory, { recursive: true, force: true });
  });
  const name = probe('repo.name');
  runtime.store.saveRepo({ ...runtime.store.getRepo('demo-billing'), name });
  const page = await openPage(t, runtime.launchUrl);
  await page.goto(`${runtime.url}/#repositories`);

  const toggle = page.locator('[data-repo-toggle][data-id="demo-billing"]');
  await toggle.click();
  await expect(page.locator('#toast')).toHaveText(`${name} disabled.`);
  assert.deepEqual(await rawProbes(page), []);

  // A failed action shows the message the API returned.
  await page.route('**/api/repos/demo-billing', route =>
    route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ message: probe('action.error') }) }),
  );
  await toggle.click();
  await expect(page.locator('#notice .error-message')).toHaveText(probe('action.error'));
  assert.deepEqual(await rawProbes(page), []);

  // A failed state refresh shows its message too.
  await page.route('**/api/state', route =>
    route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ message: probe('state.error') }) }),
  );
  await page.locator('#notice [data-action="dismiss-error"]').click();
  await page.reload();
  await expect(page.locator('#notice .error-message')).toHaveText(
    `Cannot refresh local state: ${probe('state.error')} Last loaded events remain visible.`,
  );
  assert.deepEqual(await rawProbes(page), []);
});
