// @ts-check
// Every text field that reaches the page from Azure DevOps or Git is set to a probe tag. A field that reaches the
// markup without escape() leaves a live `<x-` tag in the output, and the tag names that field.

import test from 'node:test';
import assert from 'node:assert/strict';
import { groupActivity } from '../src/activity.js';
import { renderFeed, renderDetail } from '../src/ui/feed.js';
import { renderRepositories } from '../src/ui/repositories.js';
import { renderSettings } from '../src/ui/settings.js';
import { renderHeader } from '../src/ui/header.js';
import { renderCheckout } from '../src/ui/checkout.js';

/** @typedef {import('../src/activity.js').ActivityEvent} ActivityEvent */
/** @typedef {import('../src/ui/refresh.js').PageState} PageState */
/** @typedef {import('../src/ui/refresh.js').Repo} Repo */
/** @typedef {import('../src/ui/checkout.js').CheckoutSnapshot} CheckoutSnapshot */
/** @typedef {import('../src/ui/connection.js').ConnectionState} ConnectionState */
/** @typedef {import('../src/ui/connection.js').ConnectionStatus} ConnectionStatus */
/** @typedef {import('../src/ui/activity-detail.js').CommitsView} CommitsView */

// themeSwitch() in the header reads the theme that web/theme.js puts on window.
Object.assign(globalThis, { window: globalThis });

/** Fields whose probe must appear escaped somewhere, so a fixture field the views never render is noticed. */
const rendered = new Set();
/**
 * @param {string} field
 * @param {boolean} [shown] false for a field the server sends but no view displays; it is still checked for raw output.
 */
const probe = (field, shown = true) => {
  if (shown) rendered.add(field);
  return `<x-probe a="${field}">`;
};
/** Fields the views only show cut to their first 8 characters, so their probe is a whole 8-character tag. */
const cuts = new Map();
/** @param {string} field */
const cut = field => {
  const tag = `<x-cut${cuts.size + 1}>`;
  cuts.set(tag, field);
  return `${tag}${field}`;
};
/** An Azure URL whose query holds a probe. URL parsing percent-encodes it, so it is checked but never shown escaped. @param {string} field */
const url = field => `https://dev.azure.com/org/project/_git/repo?x=${probe(field, false)}`;
const zero = '0000000000000000000000000000000000000000';
const time = '2026-11-17T10:00:00Z';

/** @type {Repo} */
const repo = {
  id: probe('repo.id'),
  name: probe('repo.name'),
  project: probe('repo.project'),
  organization: probe('repo.organization', false),
  azureId: probe('repo.azureId', false),
  webUrl: url('repo.webUrl'),
  localPath: probe('repo.localPath'),
};
/** @type {Repo} */
const disabledRepo = { ...repo, id: probe('disabledRepo.id'), name: probe('disabledRepo.name'), disabled: true };

/** @type {ActivityEvent[]} */
const events = [
  // The grouped build shows its newest event, so the queued event's own text is never displayed.
  ...['queued', 'running'].map((status, index) => ({
    id: probe(`build.${status}.id`, status === 'running'),
    repoId: repo.id,
    kind: /** @type {const} */ ('build'),
    time: `2026-11-17T10:0${index}:00Z`,
    observedAt: `2026-11-17T10:0${index}:00Z`,
    title: probe(`build.${status}.title`, status === 'running'),
    actor: probe(`build.${status}.actor`, status === 'running'),
    branch: probe(`build.${status}.branch`, status === 'running'),
    url: url(`build.${status}.url`),
    data: {
      buildId: 7,
      status: status === 'queued' ? 'notStarted' : 'inProgress',
      reason: 'manual',
      sourceVersion: probe(`build.${status}.sourceVersion`, status === 'running'),
    },
  })),
  {
    id: 'untitled-build',
    repoId: repo.id,
    kind: 'build',
    time,
    data: {
      buildId: probe('untitledBuild.buildId'),
      definition: { name: probe('untitledBuild.definition.name') },
      status: 'completed',
      result: 'failed',
    },
  },
  {
    id: 'pr',
    repoId: repo.id,
    kind: 'pr',
    time: probe('pr.time'),
    observedAt: time,
    title: probe('pr.title'),
    actor: probe('pr.actor'),
    branch: probe('pr.branch'),
    data: {
      status: 'completed',
      targetRefName: `refs/heads/${probe('pr.targetRefName')}`,
      sourceRefName: probe('pr.sourceRefName', false),
      sourceCommit: probe('pr.sourceCommit'),
      mergeCommit: probe('pr.mergeCommit'),
      mergeStrategy: 'squash',
      closedBy: probe('pr.closedBy'),
      pullRequestId: probe('pr.pullRequestId'),
    },
  },
  {
    id: 'push',
    repoId: repo.id,
    kind: 'push',
    time,
    title: probe('push.title'),
    actor: probe('push.actor'),
    branch: probe('push.branch'),
    summary: probe('push.summary'),
    data: {
      pushId: probe('push.pushId'),
      commitId: probe('push.commitId'),
      mergeEvidence: {
        status: 'complete',
        checkedAt: time,
        limitations: [probe('push.mergeEvidence.limitations')],
        error: probe('push.mergeEvidence.error'),
        prs: [
          {
            pullRequestId: probe('push.mergeEvidence.prs.pullRequestId'),
            url: url('push.mergeEvidence.prs.url'),
            sourceRefName: probe('push.mergeEvidence.prs.sourceRefName'),
            targetRefName: probe('push.mergeEvidence.prs.targetRefName'),
            closedBy: { displayName: probe('push.mergeEvidence.prs.closedBy.displayName') },
            mergeCommit: probe('push.mergeEvidence.prs.mergeCommit'),
          },
          { id: probe('push.mergeEvidence.prs.id'), closedBy: probe('push.mergeEvidence.prs.closedBy') },
        ],
        commits: [
          {
            commitId: cut('push.mergeEvidence.commits.commitId'),
            parents: [probe('push.mergeEvidence.commits.parents', false)],
            branches: [probe('push.mergeEvidence.commits.branches')],
          },
        ],
      },
    },
  },
  {
    id: 'older-push',
    repoId: repo.id,
    kind: 'push',
    time,
    branch: probe('olderPush.branch'),
    data: { mergeEvidence: { status: 'partial', error: { message: probe('olderPush.mergeEvidence.error.message') } } },
  },
  {
    id: 'new-branch-push',
    repoId: repo.id,
    kind: 'push',
    time,
    data: { refUpdates: [{ name: 'refs/heads/feature', oldObjectId: zero, newObjectId: cut('newBranchPush.refUpdates.newObjectId') }] },
  },
  { id: 'deleted', repoId: repo.id, kind: 'branch-deleted', time, branch: probe('deleted.branch'), data: { evidence: 'push' } },
  { id: 'created', repoId: repo.id, kind: 'branch-created', time, title: probe('created.title'), branch: probe('created.branch') },
];

/** @param {string} field */
const streamError = field => ({ code: 'FAILED', message: probe(field) });
/** @type {PageState['streams']} */
const streams = [
  { repoId: repo.id, stream: 'pushes', initialized: true, nextAt: time, lastSuccess: time, error: streamError('stream.pushes.error') },
  { repoId: repo.id, stream: 'prs', initialized: true, nextAt: time, error: streamError('stream.prs.error') },
];

/** @param {PageState['activity']} activity @returns {PageState} */
function pageState(activity) {
  return {
    repos: [repo],
    watched: [repo, disabledRepo],
    streams,
    settings: { refreshEnabled: true },
    diagnostics: {
      startsLastMinute: 1,
      limitPerMinute: 10,
      running: 0,
      concurrency: 2,
      lastError: { code: 'FAILED', message: probe('diagnostics.lastError.message') },
    },
    mergeQueue: { pending: 1, errors: 1 },
    jobs: [
      /** @type {import('../server/backfill.js').HistoryJob} */ ({
        id: 'job',
        type: 'backfill',
        repoId: repo.id,
        status: 'retrying',
        pages: 2,
        lastProgressAt: time,
        error: { code: 'FAILED', message: probe('job.error.message') },
      }),
    ],
    activity,
    events,
  };
}

const items = groupActivity(events);
const activity = {
  items,
  total: items.length,
  newItems: items.length,
  newUpdates: events.length,
  nextCursor: null,
  filterOptions: [probe('activity.filterOption')],
};
const state = pageState(activity);

/** @param {string} field @param {string} branch @returns {import('../server/checkout-advice.js').PullAdvice} */
const advice = (field, branch) => ({
  branch,
  id: 12,
  url: url(`${field}.url`),
  strategy: 'squash',
  verified: false,
  targetVerified: false,
  receipt: { target: probe(`${field}.receipt.target`, false), result: probe(`${field}.receipt.result`, false) },
  destination: 'local',
});
/** A checkout that can switch shows the switch button instead of the message and suggestion. @param {string} name @param {boolean} canSwitch */
const diagnostic = (name, canSwitch) => ({
  title: probe(`${name}.diagnostic.title`),
  message: probe(`${name}.diagnostic.message`, !canSwitch),
  suggestion: probe(`${name}.diagnostic.suggestion`, !canSwitch),
  advice: advice(`${name}.diagnostic.advice`, probe(`${name}.diagnostic.advice.branch`)),
  comparison: {
    previous: probe(`${name}.diagnostic.comparison.previous`),
    tip: probe(`${name}.diagnostic.comparison.tip`),
    verified: false,
    commits: [
      {
        side: /** @type {const} */ ('old'),
        id: probe(`${name}.diagnostic.comparison.commits.id`),
        subject: probe(`${name}.diagnostic.comparison.commits.subject`),
      },
    ],
  },
});
/** @param {string} name @param {Partial<CheckoutSnapshot>} [fields] @returns {CheckoutSnapshot} */
const reading = (name, fields = {}) => ({
  state: 'upstream-missing',
  canCheck: true,
  canPull: false,
  branch: probe(`${name}.branch`, !('branch' in fields)),
  // Only a detached checkout shows its head, cut to 8 characters.
  head: probe(`${name}.head`, false),
  upstream: probe(`${name}.upstream`),
  identity: probe(`${name}.identity`, false),
  ahead: 0,
  behind: 0,
  dirty: false,
  lastBranchCheck: { at: time, matchesFetchedTip: true },
  nextStep: probe(`${name}.nextStep`),
  ...fields,
});

/** @type {Record<string, CheckoutSnapshot>} */
const checkouts = {
  // A clean checkout whose PR is recorded locally can switch, which shows the switch button.
  switchable: reading('switchable', { diagnostic: diagnostic('switchable', true) }),
  // Local changes block the switch, which shows the message and suggestion instead.
  blocked: reading('blocked', { dirty: true, diagnostic: diagnostic('blocked', false) }),
  reviewed: reading('reviewed', {
    state: 'current',
    followup: { id: probe('reviewed.followup.id', false), source: probe('reviewed.followup.source') },
    review: {
      kind: 'local-followup',
      branch: probe('reviewed.review.branch', false),
      commits: [{ id: probe('reviewed.review.commits.id'), subject: probe('reviewed.review.commits.subject') }],
      canRemove: true,
    },
  }),
  // A follow-up in its own worktree names the worktree; its source shows only once the old branch is reviewed.
  worktree: reading('worktree', {
    state: 'current',
    followup: {
      id: probe('worktree.followup.id', false),
      source: probe('worktree.followup.source', false),
      workspace: probe('worktree.followup.workspace'),
    },
  }),
  detached: reading('detached', { state: 'detached', branch: '', head: cut('detached.head') }),
};

/** @param {string} name @param {string[]} [unshown] fields the view rendering this status does not display @returns {ConnectionStatus} */
const connection = (name, unshown = []) => ({
  available: false,
  identity: null,
  identityVerified: false,
  message: probe(`${name}.message`, !unshown.includes('message')),
  version: probe(`${name}.version`, !unshown.includes('version')),
  extension: probe(`${name}.extension`, !unshown.includes('extension')),
  account: { name: probe(`${name}.account.name`) },
});
/** @param {Partial<ConnectionState>} fields @returns {ConnectionState} */
const connectionState = fields => ({ results: new Map(), local: null, pending: null, repoId: repo.id, ...fields });
const settingsConnections = [
  // A reachable CLI shows the repository check's message rather than its own.
  connectionState({
    results: new Map([
      [
        repo.id,
        {
          ...connection('connection', ['message']),
          available: true,
          access: { status: 'failed', checkedAt: time, message: probe('connection.access.message') },
        },
      ],
    ]),
  }),
  connectionState({ results: new Map([[repo.id, connection('failedConnection')]]) }),
  // Before a repository is checked, Settings shows the CLI that the first check found.
  connectionState({ local: connection('localConnection', ['message']) }),
];

/** @type {CommitsView[]} */
const commitViews = [
  { items: [{ commitId: probe('pushCommits.commitId'), comment: probe('pushCommits.comment') }], nextCursor: null },
  { error: probe('pushCommits.error') },
];

/** @type {import('../src/ui/feed.js').FeedView} */
const feedView = { route: 'activity', repoIds: null, search: '', kind: '', filtersOpen: false };

/** @type {Record<string, () => string[]>} */
const views = {
  feed: () => [
    renderFeed(state, { ...feedView, route: 'catchup' }),
    renderFeed(state, feedView),
    renderFeed(pageState({ items: [], error: probe('activity.error') }), feedView),
  ],
  detail: () => events.flatMap(event => [undefined, ...commitViews].map(commits => renderDetail(event, state, commits))),
  repositories: () => [
    renderRepositories(
      state,
      { connection: { results: new Map([['', connection('pickerConnection', ['version', 'extension'])]]) } },
      { [repo.id]: checkouts.blocked },
    ),
  ],
  settings: () => settingsConnections.map(connection => renderSettings(state, connection)),
  header: () => [renderHeader(state, { repoIds: null, route: 'activity', activityRoute: 'activity' })],
  checkout: () =>
    Object.values(checkouts).flatMap(checkout => ['status', 'guidance', 'last-check'].map(part => renderCheckout(repo.id, checkout, part))),
};

test('no Azure or Git text reaches the rendered views unescaped', () => {
  const found = [];
  for (const [view, render] of Object.entries(views)) {
    const markup = render().join('\n');
    assert.match(markup, /&lt;x-probe/, `${view} renders no probe at all`);
    for (const [tag, field = cuts.get(tag)] of markup.matchAll(/<x-probe a="([^"]*)">|<x-cut\d>/g)) found.push(`${view}: ${field}`);
  }
  assert.deepEqual([...new Set(found)], [], 'these fields reach the markup unescaped');
});

test('every probed field is rendered somewhere, so the escaping test covers it', () => {
  const markup = Object.values(views)
    .flatMap(render => render())
    .join('\n');
  const missing = [
    ...[...rendered].filter(field => !markup.includes(`&lt;x-probe a=&quot;${field}&quot;&gt;`)),
    ...[...cuts].filter(([tag]) => !markup.includes(tag.replace('<', '&lt;').replace('>', '&gt;'))).map(([, field]) => field),
  ];
  assert.deepEqual(missing, []);
});
