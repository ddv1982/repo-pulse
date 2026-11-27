import type { ActivityEvent } from '../src/activity.ts';
import type { AzureStream } from '../src/contract.d.ts';

export type Store = ReturnType<typeof import('./store.ts').createStore>;
/** Fixtures carry provider fields beyond EventData, as stored events do. */
export type DemoEvent = ActivityEvent & { data?: import('../src/activity.ts').EventData & Record<string, unknown> };

const STREAMS: AzureStream[] = ['pushes', 'refs', 'prs', 'closedPrs', 'builds', 'activeBuilds'];
const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
const orders = {
  id: 'demo-orders',
  azureId: 'orders',
  organization: 'https://dev.azure.com/example',
  project: 'Demo',
  name: 'orders-api',
  webUrl: 'https://dev.azure.com/example/Demo/_git/orders-api',
  defaultBranch: 'refs/heads/main',
  disabled: false,
};
const billing = {
  id: 'demo-billing',
  azureId: 'billing',
  organization: 'https://dev.azure.com/example',
  project: 'Demo',
  name: 'billing-web',
  webUrl: 'https://dev.azure.com/example/Demo/_git/billing-web',
  defaultBranch: 'refs/heads/main',
  disabled: false,
};
const shared = {
  id: 'demo-shared',
  azureId: 'shared',
  organization: 'https://dev.azure.com/example',
  project: 'Demo',
  name: 'shared-components',
  webUrl: 'https://dev.azure.com/example/Demo/_git/shared-components',
  defaultBranch: 'refs/heads/main',
  disabled: false,
};
export const demoRepos = [orders, billing, shared];

export function seedDemo(store: Store) {
  if (store.getSetting('demoSeeded', false)) return;
  for (const repo of demoRepos) store.saveRepo(repo);
  const source = orders.webUrl;
  const events: DemoEvent[] = [
    {
      id: 'demo-tag-1',
      repoId: 'demo-orders',
      kind: 'tag',
      title: 'Tag moved · release/2026.11',
      branch: 'release/2026.11',
      actor: 'Redacted 1',
      time: ago(30),
      summary: 'Moved in push 41',
      seen: true,
      data: {
        change: 'moved',
        evidence: 'push',
        pushId: 41,
        name: 'refs/tags/release/2026.11',
        oldObjectId: '3f9a2c1',
        newObjectId: '8d41e07',
      },
      url: source,
    },
    {
      id: 'demo-branch-1',
      repoId: 'demo-orders',
      kind: 'branch-created',
      title: 'hotfix/2026.11-dose-rounding',
      branch: 'hotfix/2026.11-dose-rounding',
      actor: 'Redacted 1',
      time: ago(8),
      summary: 'New remote branch at existing revision 3f9a2c1. No PR yet.',
      data: {
        newObjectId: '3f9a2c1',
        evidence: 'push',
        forkOrigin: { status: 'found', base: '3f9a2c1', on: ['refs/heads/main'], via: 'tip' },
      },
      url: source,
    },
    {
      id: 'demo-branch-2',
      repoId: 'demo-shared',
      kind: 'branch-created',
      title: 'feature/audit-log',
      branch: 'feature/audit-log',
      actor: '',
      time: ago(15),
      summary: 'First discovered in remote refs. Creation time and author were not supplied.',
      data: { evidence: 'refs' },
      url: shared.webUrl,
    },
    {
      id: 'demo-push-1',
      repoId: 'demo-billing',
      kind: 'push',
      title: '2 commits pushed to fix/export-retry',
      branch: 'fix/export-retry',
      actor: 'Redacted 2',
      time: ago(23),
      summary: 'Retry export after a transient timeout; add regression coverage.',
      data: {
        pushId: 124,
        commits: [
          { commitId: 'b42e9d15f08', comment: 'Retry transient export failures' },
          { commitId: 'd19e40223ac', comment: 'Cover export retry behavior' },
        ],
      },
      url: billing.webUrl,
    },
    {
      id: 'demo-build-1',
      repoId: 'demo-orders',
      kind: 'build',
      title: 'orders-api CI',
      branch: 'main',
      actor: '',
      time: ago(30),
      summary: 'Run 20261117.6 failed. A build result does not establish deployment.',
      data: { status: 'completed', result: 'failed', buildId: 200, sourceVersion: '3f9a2c1' },
      url: 'https://dev.azure.com/example/Demo/_build/results?buildId=200',
    },
    {
      id: 'demo-pr-1',
      repoId: 'demo-billing',
      kind: 'pr',
      title: 'PR 1175 · Retry export on timeout',
      branch: 'fix/export-retry',
      actor: 'Redacted 2',
      time: ago(45),
      summary: 'Active PR targeting main; CI unavailable for this repository.',
      data: {
        pullRequestId: 1175,
        status: 'active',
        targetRefName: 'refs/heads/main',
        reviewers: [
          { name: 'Redacted 3', vote: 10, required: true },
          { name: 'Redacted 1', vote: -5 },
          { name: 'Billing reviewers', vote: 0, required: true },
        ],
      },
      url: `${billing.webUrl}/pullrequest/1175`,
    },
    {
      id: 'demo-branch-3',
      repoId: 'demo-billing',
      kind: 'branch-created',
      title: 'fix/export-retry',
      branch: 'fix/export-retry',
      actor: 'Redacted 2',
      time: ago(60),
      summary: 'New remote branch. Its first push already carried new commits.',
      seen: true,
      data: { name: 'refs/heads/fix/export-retry', newObjectId: 'a7c05e9', evidence: 'push' },
      url: billing.webUrl,
    },
    {
      id: 'demo-pr-2',
      repoId: 'demo-shared',
      kind: 'pr',
      title: 'PR 412 · Shared date range picker',
      branch: 'feature/date-range',
      actor: 'Redacted 3',
      time: ago(50),
      summary: 'Completed PR into main.',
      seen: true,
      data: {
        pullRequestId: 412,
        status: 'completed',
        sourceRefName: 'refs/heads/feature/date-range',
        targetRefName: 'refs/heads/main',
        mergeStrategy: 'squash',
        closedBy: 'Redacted 1',
      },
      url: `${shared.webUrl}/pullrequest/412`,
    },
    {
      id: 'demo-build-2',
      repoId: 'demo-shared',
      kind: 'build',
      title: 'shared-components PR validation',
      branch: 'refs/pull/412/merge',
      actor: 'Redacted 3',
      time: ago(60),
      summary: 'Run 20261117.3 succeeded on the merge preview of PR 412.',
      seen: true,
      data: { status: 'completed', result: 'succeeded', buildId: 198, sourceVersion: '6e0f9a3', reason: 'pullRequest' },
      url: 'https://dev.azure.com/example/Demo/_build/results?buildId=198',
    },
    {
      id: 'demo-push-2',
      repoId: 'demo-shared',
      kind: 'push',
      title: '3 commits pushed to feature/date-range',
      branch: 'feature/date-range',
      actor: 'Redacted 3',
      time: ago(75),
      summary: 'Add a shared date range picker.',
      seen: true,
      data: { pushId: 97, refUpdates: [{ name: 'refs/heads/feature/date-range', oldObjectId: '1b7d4e2', newObjectId: '6e0f9a3' }] },
      url: shared.webUrl,
    },
    {
      id: 'demo-push-3',
      repoId: 'demo-orders',
      kind: 'push',
      title: 'Redacted 1 pushed to main',
      branch: 'main',
      actor: 'Redacted 1',
      time: ago(90),
      summary: 'Release preparation for 2026.11.',
      seen: true,
      data: { pushId: 39, refUpdates: [{ name: 'refs/heads/main', oldObjectId: '9c2b771', newObjectId: '3f9a2c1' }] },
      url: source,
    },
    {
      id: 'demo-history',
      repoId: 'demo-shared',
      kind: 'push',
      title: 'Improve shared validation messages',
      branch: 'main',
      actor: 'Redacted 3',
      time: ago(1440),
      summary: 'Imported baseline history; not counted as unseen.',
      seen: true,
      imported: true,
      data: {
        pushId: 98,
        refUpdates: [{ name: 'refs/heads/main', oldObjectId: '5c1d0aa', newObjectId: 'e07b3f2' }],
        mergeEvidence: {
          status: 'complete',
          checkedAt: ago(1430),
          prs: [],
          commits: [],
          refRanges: [
            {
              name: 'refs/heads/main',
              oldObjectId: '5c1d0aa',
              newObjectId: 'e07b3f2',
              commitIds: [],
              complete: true,
              update: { status: 'rewrite', dropped: 2 },
            },
          ],
        },
      },
      url: shared.webUrl,
    },
  ];
  store.insertEvents(events.map(event => ({ observedAt: ago(0), seen: false, imported: false, ...event })));
  for (const repo of demoRepos) {
    for (const stream of STREAMS) {
      store.saveStream({
        repoId: repo.id,
        stream,
        initialized: true,
        lastSuccess: ago(1),
        nextAt: ago(-3),
        ...(repo.id === 'demo-billing' && stream === 'builds'
          ? {
              error: { code: 'FORBIDDEN', message: 'Demo: CI reads refused (403). Pushes and PRs remain available.' },
              lastSuccess: ago(45),
            }
          : {}),
      });
    }
  }
  store.setSetting('demoSeeded', true);
}

export function addDemoEvent(store: Store): ActivityEvent {
  const counter = Number(store.getSetting('demoCounter', 0)) + 1;
  store.setSetting('demoCounter', counter);
  const event: ActivityEvent = {
    id: `demo-incoming-${counter}`,
    repoId: 'demo-orders',
    kind: 'branch-created',
    title: `hotfix/demo-${counter}`,
    branch: `hotfix/demo-${counter}`,
    actor: 'Redacted 4',
    time: ago(0),
    observedAt: ago(0),
    summary: 'A new remote branch was added. This fictional event makes no Azure calls.',
    seen: false,
    imported: false,
    url: orders.webUrl,
  };
  store.insertEvents([event]);
  return event;
}

export const demoProvider = {
  /** Like the live client, the check never claims an identity. */
  async checkConnection(): Promise<import('../src/contract.d.ts').ConnectionStatus> {
    return { available: true, identity: null, identityVerified: false, message: 'Isolated demo mode. Azure CLI is never invoked.' };
  },
  /** Fictional review data for the demo PR; no Azure read. */
  async prReview(): Promise<import('../src/contract.d.ts').PullRequestReview> {
    return {
      threads: { open: 2, resolved: 3 },
      policies: [
        { name: 'Minimum number of reviewers', status: 'queued', blocking: true },
        { name: 'Build', status: 'rejected', blocking: true },
        { name: 'Comment requirements', status: 'approved', blocking: false },
      ],
    };
  },
  async pushCommits() {
    return {
      items: [
        { commitId: 'b42e9d15f08', comment: 'Retry transient export failures' },
        { commitId: 'd19e40223ac', comment: 'Cover export retry behavior' },
      ],
      nextCursor: null,
    };
  },
};
