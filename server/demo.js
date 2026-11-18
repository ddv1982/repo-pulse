/** @typedef {ReturnType<typeof import('./store.js').createStore>} Store */
/** @typedef {import('../src/activity.js').ActivityEvent} ActivityEvent */
/** Fixtures carry provider fields beyond EventData, as stored events do. */
/** @typedef {ActivityEvent & { data?: import('../src/activity.js').EventData & Record<string, unknown> }} DemoEvent */
/** @typedef {import('./azure-client.js').AzureStream} AzureStream */

/** @type {AzureStream[]} */
const STREAMS = ['pushes', 'refs', 'prs', 'closedPrs', 'builds', 'activeBuilds'];
/** @param {number} minutes */
const ago = minutes => new Date(Date.now() - minutes * 60_000).toISOString();
export const demoRepos = [
  {
    id: 'demo-orders',
    azureId: 'orders',
    organization: 'https://dev.azure.com/example',
    project: 'Demo',
    name: 'orders-api',
    webUrl: 'https://dev.azure.com/example/Demo/_git/orders-api',
    disabled: false,
  },
  {
    id: 'demo-billing',
    azureId: 'billing',
    organization: 'https://dev.azure.com/example',
    project: 'Demo',
    name: 'billing-web',
    webUrl: 'https://dev.azure.com/example/Demo/_git/billing-web',
    disabled: false,
  },
  {
    id: 'demo-shared',
    azureId: 'shared',
    organization: 'https://dev.azure.com/example',
    project: 'Demo',
    name: 'shared-components',
    webUrl: 'https://dev.azure.com/example/Demo/_git/shared-components',
    disabled: false,
  },
];

/** @param {Store} store */
export function seedDemo(store) {
  if (store.getSetting('demoSeeded', false)) return;
  for (const repo of demoRepos) store.saveRepo(repo);
  const source = demoRepos[0].webUrl;
  /** @type {DemoEvent[]} */
  const events = [
    {
      id: 'demo-tag-1',
      repoId: 'demo-orders',
      kind: 'tag',
      title: 'Tag moved · release/2026.11',
      branch: 'release/2026.11',
      actor: 'Sam Ortega',
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
      actor: 'Sam Ortega',
      time: ago(8),
      summary: 'New remote branch at existing revision 3f9a2c1. No PR yet.',
      data: { newObjectId: '3f9a2c1', evidence: 'push' },
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
      url: demoRepos[2].webUrl,
    },
    {
      id: 'demo-push-1',
      repoId: 'demo-billing',
      kind: 'push',
      title: '2 commits pushed to fix/export-retry',
      branch: 'fix/export-retry',
      actor: 'Priya Nair',
      time: ago(23),
      summary: 'Retry export after a transient timeout; add regression coverage.',
      data: {
        pushId: 124,
        commits: [
          { commitId: 'b42e9d15f08', comment: 'Retry transient export failures' },
          { commitId: 'd19e40223ac', comment: 'Cover export retry behavior' },
        ],
      },
      url: demoRepos[1].webUrl,
    },
    {
      id: 'demo-build-1',
      repoId: 'demo-orders',
      kind: 'build',
      title: 'orders-api CI · failed',
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
      actor: 'Priya Nair',
      time: ago(45),
      summary: 'Active PR targeting main; CI unavailable for this repository.',
      data: { pullRequestId: 1175, status: 'active', targetRefName: 'refs/heads/main' },
      url: `${demoRepos[1].webUrl}/pullrequest/1175`,
    },
    {
      id: 'demo-history',
      repoId: 'demo-shared',
      kind: 'push',
      title: 'Improve shared validation messages',
      branch: 'main',
      actor: 'Lars de Wit',
      time: ago(1440),
      summary: 'Imported baseline history; not counted as unseen.',
      seen: true,
      imported: true,
      url: demoRepos[2].webUrl,
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

/** @param {Store} store */
export function addDemoEvent(store) {
  const counter = Number(store.getSetting('demoCounter', 0)) + 1;
  store.setSetting('demoCounter', counter);
  /** @type {ActivityEvent} */
  const event = {
    id: `demo-incoming-${counter}`,
    repoId: 'demo-orders',
    kind: 'branch-created',
    title: `hotfix/demo-${counter}`,
    branch: `hotfix/demo-${counter}`,
    actor: 'Demo developer',
    time: ago(0),
    observedAt: ago(0),
    summary: 'A new remote branch was added. This fictional event makes no Azure calls.',
    seen: false,
    imported: false,
    url: demoRepos[0].webUrl,
  };
  store.insertEvents([event]);
  return event;
}

export const demoProvider = {
  /** Like the live client, the check never claims an identity. @returns {Promise<import('./azure-client.js').ConnectionStatus>} */
  async checkConnection() {
    return { available: true, identity: null, identityVerified: false, message: 'Isolated demo mode. Azure CLI is never invoked.' };
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
