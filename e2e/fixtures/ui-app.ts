import type { TestContext } from 'node:test';
import { refreshNow, defer, listen, openPage, startTestApp } from './app.ts';
import { expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { createApp } from '../../server/runtime.ts';
import { TEST_KEY, fetchWithKey } from '../../test/fixtures/access.ts';
import { createStore } from '../../server/store.ts';
import { createSync } from '../../server/sync.ts';
import type { AzureProvider, RepositoryInput, ResolvedRepository } from '../../server/azure-client.ts';
import type { ConnectionStatus, Repository } from '../../src/contract.ts';
import { stub } from '../../test/fixtures/typed.ts';
import type { ActivityEvent } from '../../src/activity.ts';
import { invalid } from '../../server/errors.ts';

export const fetch = fetchWithKey;

export async function selectActivityType(page: Page, label: string) {
  await page.getByRole('button', { name: /^Activity type:/ }).click();
  await page.getByRole('option', { name: label, exact: true }).click();
}

export async function setup(
  t: TestContext,
  demo = true,
  { highlights = false, ...options }: { hasTouch?: boolean; highlights?: boolean } = {},
) {
  const app = await startTestApp(t, { demo, highlights });
  const page = await openPage(t, { colorScheme: 'light', consoleErrors: true, ...options });
  await page.goto(app.runtime.launchUrl);
  await expect(page.getByRole('link', { name: 'Repo Pulse', exact: true })).toBeVisible();
  return {
    page,
    get runtime() {
      return app.runtime;
    },
    async restart() {
      // A new port is a new origin, so the browser needs the launch link again.
      await page.goto((await app.restart()).launchUrl);
    },
  };
}

// A background render keeps focus on the same item, never on a neighbour that took its place in the markup.
export const renderInBackground = refreshNow;

export async function setupPicker(t: TestContext, { existing = true } = {}) {
  const store = createStore();
  defer(t, () => store.close());
  const organization = 'https://dev.azure.com/example',
    project = 'Demo';
  if (existing)
    store.saveRepo(
      stub<Repository>({
        id: 'existing',
        azureId: 'existing',
        name: 'existing',
        localPath: '/workspace/projects/existing',
        organization,
        project,
      }),
    );
  const remote = (name: string, repoName: string) => ({
    name,
    repoName,
    organization,
    project,
    url: `${organization}/${project}/_git/${repoName}`,
  });
  const repositories = [
    { localPath: '/workspace/projects/alpha', remotes: [remote('origin', 'alpha-api'), remote('upstream', 'alpha-upstream')] },
    { localPath: '/workspace/projects/beta', remotes: [remote('origin', 'beta-web')] },
    { localPath: '/workspace/projects/existing', remotes: [remote('origin', 'existing')] },
  ];
  const calls = { browse: 0, resolve: 0 };
  const browse = async (input: unknown) => {
    calls.browse++;
    const path = input || '/workspace/projects';
    // The handler passes the request's path through; anything but a string is a regression this fake must not hide.
    if (typeof path !== 'string') throw new TypeError('browse expects a folder path string');
    if (path === '/missing') throw invalid('This folder cannot be opened. Choose another local folder.');
    return {
      path,
      parent: path === '/workspace' ? '/' : '/workspace',
      breadcrumbs: [
        { name: '/', path: '/' },
        { name: 'workspace', path: '/workspace' },
        ...(path === '/workspace' ? [] : [{ name: path.split('/').at(-1) ?? '', path }]),
      ],
      folders: [{ name: 'nested', path: '/workspace/projects/nested' }],
      repositories: path === '/workspace/projects' ? repositories : [],
      warnings: [],
    };
  };
  const provider = stub<AzureProvider>({
    async checkConnection() {
      return stub<ConnectionStatus>({
        available: true,
        signedIn: true,
        account: { name: 'existing@example.test' },
        message: 'Existing Azure CLI sign-in detected.',
      });
    },
    // The picker sends each remote as an organization, project and name.
    async resolveRepository(input: RepositoryInput) {
      calls.resolve++;
      return stub<ResolvedRepository>({ id: input.name, azureId: input.name, name: input.name, organization, project });
    },
  });
  const sync = createSync({ store, provider });
  const server = createApp({ store, provider, sync, browse, discover: async () => ({ repositories, warnings: [] }), accessKey: TEST_KEY });
  const url = await listen(t, server);
  const page = await openPage(t, { key: TEST_KEY });
  defer(t, async () => {
    if (t.passed) return;
    const picker = page.locator('#repository-picker');
    if (await picker.count()) t.diagnostic(await picker.innerText());
    t.diagnostic(JSON.stringify(calls));
  });
  await page.goto(`${url}/${existing ? '#repositories' : ''}`);
  if (existing) await page.locator('#add-repositories').click();
  return { page, store, calls };
}

export async function groupedFixture(t: TestContext) {
  const app = await setup(t);
  for (const repo of app.runtime.store.listRepos()) app.runtime.store.removeRepo(repo.id);
  app.runtime.store.saveRepo(
    stub<Repository>({
      id: 'demo-orders',
      name: 'Orders',
      project: 'Demo',
      organization: 'https://dev.azure.com/example',
      azureId: 'orders',
    }),
  );
  const now = Date.now();
  const record = {
    repoId: 'demo-orders',
    kind: 'build',
    title: 'Orders CI · 20261117.6',
    branch: 'main',
    actor: 'Demo developer',
    seen: false,
    imported: false,
    data: { buildId: 700, sourceVersion: 'abcdef0123456789', definition: { name: 'Orders CI' }, reason: 'manual' },
  } satisfies Partial<ActivityEvent>;
  const event = (id: string, status: string, offset: number): ActivityEvent => ({
    ...record,
    id,
    time: new Date(now + offset).toISOString(),
    observedAt: new Date(now + offset).toISOString(),
    data: { ...record.data, status },
  });
  app.runtime.store.insertEvents([event('build-queued', 'notStarted', -120000), event('build-running', 'inProgress', -60000)]);
  for (const stream of ['pushes', 'refs', 'prs', 'closedPrs', 'builds', 'activeBuilds'] as const)
    app.runtime.store.saveStream({
      repoId: 'demo-orders',
      stream,
      initialized: true,
      nextAt: new Date(now).toISOString(),
      lastSuccess: new Date(now).toISOString(),
    });
  // Exercise the normal healthy layout, using only the isolated fixture backend.
  await app.page.route('**/api/state', async route => {
    const response = await route.fetch();
    await route.fulfill({ json: { ...(await response.json()), demo: false } });
  });
  await app.page.reload();
  await expect(app.page.locator('li[data-event-id]')).toHaveCount(1);
  return { ...app, event };
}

/** The browser's fixed local time in the multi-day fixture: a Saturday afternoon. */
export const MULTI_DAY_NOW = new Date(2026, 10, 28, 15, 0);

/**
 * One repository with rows on three local days and lanes that cross each day boundary, including a merge and a fork
 * whose other lane runs on above them, plus imported rows on two older days. The browser clock is fixed at
 * MULTI_DAY_NOW so the day labels do not depend on when the test runs.
 */
export async function multiDayFixture(t: TestContext, options: { colorScheme?: 'light' | 'dark' } = {}) {
  const app = await setup(t);
  if (options.colorScheme) await app.page.emulateMedia({ colorScheme: options.colorScheme });
  for (const repo of app.runtime.store.listRepos()) app.runtime.store.removeRepo(repo.id);
  app.runtime.store.saveRepo(
    stub<Repository>({ id: 'days', name: 'Orders', project: 'Demo', organization: 'https://dev.azure.com/example', azureId: 'days' }),
  );
  const at = (day: number, hour: number, minute = 0) => new Date(2026, 10, day, hour, minute).toISOString();
  const sha = (letter: string) => letter.repeat(40);
  const base = { repoId: 'days', actor: 'Ana', seen: false, imported: false };
  const push = (id: string, branch: string, time: string, to: string, extra: Partial<ActivityEvent> = {}): ActivityEvent => ({
    ...base,
    id,
    kind: 'push',
    branch,
    title: `Ana pushed to ${branch}`,
    time,
    data: { refUpdates: [{ name: `refs/heads/${branch}`, oldObjectId: sha('1'), newObjectId: sha(to) }] },
    ...extra,
  });
  const pr = (id: string, number: number, source: string, status: string, time: string): ActivityEvent => ({
    ...base,
    id,
    kind: 'pr',
    branch: `refs/heads/${source}`,
    title: `PR ${number} · Update ${source}`,
    time,
    data: {
      pullRequestId: number,
      status,
      sourceRefName: `refs/heads/${source}`,
      targetRefName: 'refs/heads/main',
      ...(status === 'completed' ? { mergeCommit: sha('f') } : {}),
    },
  });
  app.runtime.store.insertEvents([
    push('today-main', 'main', at(28, 14, 30), 'a'),
    push('today-a', 'feature/a', at(28, 13), 'b'),
    push('today-b', 'feature/b', at(28, 12), 'c'),
    pr('yesterday-merge', 7, 'feature/a', 'completed', at(27, 16)),
    pr('yesterday-pr', 8, 'feature/b', 'active', at(27, 10, 30)),
    push('yesterday-a', 'feature/a', at(27, 9), 'd'),
    push('older-main', 'main', at(26, 18), 'e'),
    {
      ...base,
      id: 'older-branch',
      kind: 'branch-created',
      branch: 'feature/b',
      title: 'New branch · feature/b',
      time: at(26, 10),
      data: { name: 'refs/heads/feature/b', oldObjectId: sha('0'), newObjectId: sha('9'), evidence: 'push' },
    },
    push('older-main-2', 'main', at(26, 8), '8'),
    push('imported-1', 'main', at(25, 11), '7', { imported: true }),
    push('imported-2', 'main', at(24, 11), '6', { imported: true }),
  ]);
  await app.page.clock.setFixedTime(MULTI_DAY_NOW);
  await app.page.reload();
  await expect(app.page.locator('li[data-event-id="older-main-2"]')).toBeVisible();
  return app;
}
