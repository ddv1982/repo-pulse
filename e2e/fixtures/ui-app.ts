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
  { highlights = false, ...options }: { hasTouch?: boolean; highlights?: boolean; locale?: string } = {},
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

/**
 * Rows that use the rare pieces of the Activity layout, across two repositories, for layout tests and screenshots: a
 * merged PR with a failing pipeline next to a passing one, an open PR whose failed validation is being retried, an open
 * PR with a partially succeeded validation on an older revision and a mixed vote, an unread merged PR from a fork with
 * its linked push, a push with commits to load and failing branch CI after a listed new branch, a CI run with three
 * updates, a CI run on a pull request ref, a push that rewrote history, a merged PR with a long branch in the second
 * repository, and an imported row. The browser clock is fixed at MULTI_DAY_NOW. In highlights mode only the PR
 * milestones show, and the older validation counts as stale.
 */
export async function awkwardFixture(
  t: TestContext,
  { colorScheme, highlights = false }: { colorScheme?: 'light' | 'dark'; highlights?: boolean } = {},
) {
  // CI browsers run in en-US, whose 12-hour times are wider; the fixture uses it everywhere so layouts match.
  const app = await setup(t, true, { highlights, locale: 'en-US' });
  if (colorScheme) await app.page.emulateMedia({ colorScheme });
  for (const repo of app.runtime.store.listRepos()) app.runtime.store.removeRepo(repo.id);
  const organization = 'https://dev.azure.com/example';
  for (const [id, name] of [
    ['orders', 'orders-dbt'],
    ['pipelines', 'adf-pipelines'],
  ] as const)
    app.runtime.store.saveRepo(
      stub<Repository>({ id, name, project: 'Demo', organization, azureId: id, defaultBranch: 'refs/heads/main' }),
    );
  const at = (hour: number, minute = 0) => new Date(2026, 10, 28, hour, minute).toISOString();
  const sha = (text: string) => text.repeat(40).slice(0, 40);
  const url = (path: string) => `${organization}/Demo/_git/orders-dbt/${path}`;
  const base = { repoId: 'orders', actor: 'A. Author', seen: true, imported: false };
  const main = 'refs/heads/main';
  const pr = (
    id: string,
    subject: string,
    number: number,
    time: string,
    source: string,
    data: ActivityEvent['data'],
    seen = true,
  ): ActivityEvent => ({
    ...base,
    seen,
    id,
    kind: 'pr',
    branch: `refs/heads/${source}`,
    title: `PR ${number} · ${subject}`,
    time,
    url: url(`pullrequest/${number}`),
    data: { pullRequestId: number, sourceRefName: `refs/heads/${source}`, targetRefName: main, ...data },
  });
  const build = (id: string, time: string, title: string, data: ActivityEvent['data'], seen = true): ActivityEvent => ({
    ...base,
    seen,
    id,
    kind: 'build',
    title,
    branch: 'main',
    time,
    url: `${organization}/Demo/_build/results?buildId=${id.length}`,
    data: { status: 'completed', ...data },
  });
  const forkMerge = sha('d4');
  const forkEvidence = { pullRequestId: 21910, targetRefName: main, mergeCommit: forkMerge, relationship: 'result-introduced' };
  const pushTip = sha('e5');
  const longBranch = 'feature/DAT-1005-a-very-long-branch-name-that-keeps-going-and-going-past-the-column';
  const events: ActivityEvent[] = [
    pr('mixed-merge', 'DAT-1000: split nightly build', 21901, at(14, 40), 'feature/DAT-1000-split-nightly-build', {
      status: 'completed',
      mergeCommit: sha('a1'),
    }),
    build('mixed-validation', at(14, 20), 'dbt-build', {
      buildId: 101,
      result: 'succeeded',
      sourceBranch: 'refs/pull/21901/merge',
      sourceVersion: sha('a0'),
      definition: { id: 71, name: 'dbt-build' },
    }),
    build('mixed-dbt', at(14, 45), 'dbt-build', {
      buildId: 102,
      result: 'failed',
      reason: 'individualCI',
      sourceBranch: main,
      sourceVersion: sha('a1'),
      buildStartedAt: at(14, 41),
      definition: { id: 71, name: 'dbt-build' },
    }),
    build('mixed-adf', at(14, 46), 'adf-deploy', {
      buildId: 103,
      result: 'succeeded',
      reason: 'individualCI',
      sourceBranch: main,
      sourceVersion: sha('a1'),
      buildStartedAt: at(14, 41),
      definition: { id: 72, name: 'adf-deploy' },
    }),
    pr(
      'retry-pr',
      'DAT-1001: calving interval model',
      21907,
      at(13, 50),
      'feature/DAT-1001-calving-interval',
      { status: 'active', previewCommit: sha('b2') },
      false,
    ),
    build('retry-failed', at(14, 0), 'billing-validation', {
      buildId: 201,
      result: 'failed',
      reason: 'pullRequest',
      sourceBranch: 'refs/pull/21907/merge',
      sourceVersion: sha('b2'),
      buildStartedAt: at(13, 55),
      definition: { id: 78, name: 'billing-validation' },
    }),
    build('retry-running', at(14, 30), 'billing-validation', {
      buildId: 202,
      status: 'inProgress',
      reason: 'pullRequest',
      sourceBranch: 'refs/pull/21907/merge',
      sourceVersion: sha('b2'),
      buildStartedAt: at(14, 29),
      definition: { id: 78, name: 'billing-validation' },
    }),
    pr('vote-pr', 'DAT-1002: herd snapshot refresh', 21899, at(12, 30), 'feature/DAT-1002-herd-snapshot', {
      status: 'active',
      previewCommit: sha('c3'),
      reviewers: [
        { name: '[Demo]\\Cloudforce Team Data Team', vote: 10 },
        { name: 'Max Coenen', vote: -5 },
      ],
      voteChanges: [
        { name: '[Demo]\\Cloudforce Team Data Team', vote: 10 },
        { name: 'Max Coenen', vote: -5 },
      ],
    }),
    build('stale-validation', at(12, 10), 'billing-validation', {
      buildId: 301,
      result: 'partiallySucceeded',
      reason: 'pullRequest',
      sourceBranch: 'refs/pull/21899/merge',
      sourceVersion: sha('c2'),
      definition: { id: 78, name: 'billing-validation' },
    }),
    pr(
      'fork-merge',
      'DAT-1003: sandbox export',
      21910,
      at(12, 5),
      'feature/DAT-1003-sandbox-export',
      { ...forkEvidence, status: 'completed', fork: { repository: 'data-sandbox', project: 'Team Project' } },
      false,
    ),
    {
      ...base,
      seen: false,
      id: 'fork-push',
      kind: 'push',
      branch: 'main',
      time: at(12, 5),
      data: { pushId: 9100, refUpdates: [{ name: main, oldObjectId: sha('9'), newObjectId: forkMerge }] },
    },
    {
      ...base,
      id: 'incremental-push',
      kind: 'push',
      branch: 'feature/DAT-1004-incremental-key',
      title: 'A. Author pushed to feature/DAT-1004-incremental-key',
      time: at(11, 20),
      url: url('commit/e5'),
      data: {
        pushId: 9200,
        refUpdates: [{ name: 'refs/heads/feature/DAT-1004-incremental-key', oldObjectId: sha('e4'), newObjectId: pushTip }],
        commits: [{ commitId: pushTip, comment: 'Fix incremental key on fact_milk_yield' }],
      },
    },
    build('incremental-ci', at(11, 30), 'orders-dbt CI', {
      buildId: 401,
      result: 'failed',
      reason: 'individualCI',
      sourceBranch: 'refs/heads/feature/DAT-1004-incremental-key',
      sourceVersion: pushTip,
      definition: { id: 79, name: 'orders-dbt CI' },
    }),
    {
      ...base,
      id: 'incremental-branch',
      kind: 'branch-created',
      branch: 'feature/DAT-1004-incremental-key',
      title: 'New branch · feature/DAT-1004-incremental-key',
      time: at(10, 0),
      data: {
        name: 'refs/heads/feature/DAT-1004-incremental-key',
        oldObjectId: sha('0'),
        newObjectId: sha('e4'),
        evidence: 'refs',
        forkOrigin: { status: 'found', base: sha('e4'), on: [main], via: 'tip' },
      },
    },
    ...(['notStarted', 'inProgress', 'completed'] as const).map((status, index) =>
      build(
        `nightly-${status}`,
        at(9, index * 10),
        'nightly-snapshot',
        {
          buildId: 501,
          status,
          ...(status === 'completed' ? { result: 'failed' } : {}),
          reason: 'schedule',
          sourceBranch: 'refs/heads/release/2026.11',
          sourceVersion: sha('f6'),
          definition: { id: 80, name: 'nightly-snapshot' },
        },
        false,
      ),
    ),
    build('pr-ref-ci', at(8, 40), 'orders-dbt PR validation', {
      buildId: 601,
      result: 'succeeded',
      reason: 'pullRequest',
      sourceBranch: 'refs/pull/21950/merge',
      sourceVersion: sha('a7'),
      definition: { id: 81, name: 'orders-dbt PR validation' },
      pullRequest: { id: 21950, sourceRefName: 'refs/heads/feature/DAT-1006-seed-tests', targetRefName: main },
    }),
    {
      ...base,
      id: 'rewrite-push',
      kind: 'push',
      branch: 'release/2026.11',
      title: 'A. Author pushed to release/2026.11',
      time: at(8, 15),
      data: {
        pushId: 9300,
        refUpdates: [{ name: 'refs/heads/release/2026.11', oldObjectId: sha('f5'), newObjectId: sha('f6') }],
        mergeEvidence: { rewrite: [{ ref: 'refs/heads/release/2026.11', status: 'rewrite', dropped: 2 }] },
      },
    },
    {
      ...pr('long-merge', 'DAT-1005: long branch name with several repositories shown', 21880, at(7, 30), longBranch, {
        status: 'completed',
        mergeCommit: sha('a9'),
      }),
      repoId: 'pipelines',
      url: `${organization}/Demo/_git/adf-pipelines/pullrequest/21880`,
    },
    {
      ...base,
      id: 'imported-push',
      kind: 'push',
      imported: true,
      branch: 'main',
      title: 'A. Author pushed to main',
      time: new Date(2026, 10, 26, 16, 0).toISOString(),
      data: { refUpdates: [{ name: main, oldObjectId: sha('8'), newObjectId: sha('7') }] },
    },
  ];
  app.runtime.store.insertEvents(events);
  app.runtime.store.enrichEvent('fork-push', { mergeEvidence: { prs: [forkEvidence] } });
  await app.page.clock.setFixedTime(MULTI_DAY_NOW);
  await app.page.reload();
  await expect(app.page.locator('li.row').first()).toBeVisible();
  return app;
}
