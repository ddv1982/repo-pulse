// @ts-check
// Every text field that reaches the page from Azure DevOps or Git is set to a probe tag. A field that reaches the
// markup without escape() leaves a raw `<x-` in the output, also when the view cut it short or serialized it first.
// Each view lists the fields it shows escaped, and pins the escaped form of every value it cuts or serializes at the
// place it renders it, so removing escape() at that sink fails even when the full value appears escaped elsewhere.
// The repository picker, toasts and the error banner write to the DOM directly; e2e/escaping.test.js covers them.

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
/** A transformed value and the exact escaped markup expected where it is rendered. @typedef {{ field: string, html: string }} Sink */
/** @typedef {{ render: () => string[], shows: string[], sinks: Sink[] }} View */

// themeSwitch() in the header reads the theme that web/theme.js puts on window.
Object.assign(globalThis, { window: globalThis });

/** @param {string} field */
const probe = field => `<x-probe a="${field}">`;
/** A field the server sends but no view displays. It is still scanned for raw output, but no view must show it. @param {string} field */
const hidden = field => `<x-hidden a="${field}">`;
/** An Azure URL whose query holds a probe. URL parsing percent-encodes it, so it is never shown escaped. @param {string} field */
const url = field => `https://dev.azure.com/org/project/_git/repo?x=${hidden(field)}`;
/** The escaped form expected in markup, written independently of the escape() under test. @param {string} value */
const html = value =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
/** The field a probe names, for failure messages. @param {string} value */
const fieldOf = value => value.match(/<x-\w+ a="([^"]*)">/)?.[1] ?? value;
const zero = '0000000000000000000000000000000000000000';
const time = '2026-11-17T10:00:00Z';

/** @type {Repo} */
const repo = {
  id: probe('repo.id'),
  name: probe('repo.name'),
  project: probe('repo.project'),
  organization: hidden('repo.organization'),
  azureId: hidden('repo.azureId'),
  webUrl: url('repo.webUrl'),
  // Repositories shows a path under the home folder as ~/…, so this path is rewritten before it is escaped.
  localPath: `/home/someone/${probe('repo.localPath')}`,
};
/** @type {Repo} */
const disabledRepo = { ...repo, id: probe('disabledRepo.id'), name: probe('disabledRepo.name'), disabled: true };

/** @type {ActivityEvent[]} */
const events = [
  // The grouped build shows its newest event, so the queued event's own text is never displayed.
  ...['queued', 'running'].map((status, index) => {
    const text = status === 'running' ? probe : hidden;
    return {
      id: text(`build.${status}.id`),
      repoId: repo.id,
      kind: /** @type {const} */ ('build'),
      time: `2026-11-17T10:0${index}:00Z`,
      observedAt: `2026-11-17T10:0${index}:00Z`,
      title: text(`build.${status}.title`),
      actor: text(`build.${status}.actor`),
      branch: text(`build.${status}.branch`),
      url: url(`build.${status}.url`),
      data: {
        buildId: 7,
        status: status === 'queued' ? 'notStarted' : 'inProgress',
        reason: 'manual',
        sourceVersion: text(`build.${status}.sourceVersion`),
      },
    };
  }),
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
      sourceRefName: hidden('pr.sourceRefName'),
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
            commitId: probe('push.mergeEvidence.commits.commitId'),
            parents: [hidden('push.mergeEvidence.commits.parents')],
            // Two branches, so the view joins them before escaping.
            branches: [`refs/heads/${probe('push.mergeEvidence.commits.branches.0')}`, probe('push.mergeEvidence.commits.branches.1')],
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
    data: { refUpdates: [{ name: 'refs/heads/feature', oldObjectId: zero, newObjectId: probe('newBranchPush.refUpdates.newObjectId') }] },
  },
  { id: 'deleted', repoId: repo.id, kind: 'branch-deleted', time, branch: probe('deleted.branch'), data: { evidence: 'push' } },
  { id: 'created', repoId: repo.id, kind: 'branch-created', time, title: probe('created.title'), branch: probe('created.branch') },
];
const [, running, , pr, push, , newBranchPush] = events;

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
  receipt: { target: hidden(`${field}.receipt.target`), result: hidden(`${field}.receipt.result`) },
  destination: 'local',
});
/** A checkout that can switch shows the switch button instead of the message and suggestion. @param {string} name @param {boolean} canSwitch */
const diagnostic = (name, canSwitch) => {
  const blockedText = canSwitch ? hidden : probe;
  return {
    title: probe(`${name}.diagnostic.title`),
    message: blockedText(`${name}.diagnostic.message`),
    suggestion: blockedText(`${name}.diagnostic.suggestion`),
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
  };
};
/** @param {string} name @param {Partial<CheckoutSnapshot>} [fields] @returns {CheckoutSnapshot} */
const reading = (name, fields = {}) => ({
  state: 'upstream-missing',
  canCheck: true,
  canPull: false,
  branch: probe(`${name}.branch`),
  // Only a detached checkout shows its head, cut to 8 characters.
  head: hidden(`${name}.head`),
  upstream: probe(`${name}.upstream`),
  identity: hidden(`${name}.identity`),
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
    followup: { id: hidden('reviewed.followup.id'), source: probe('reviewed.followup.source') },
    review: {
      kind: 'local-followup',
      branch: hidden('reviewed.review.branch'),
      commits: [{ id: probe('reviewed.review.commits.id'), subject: probe('reviewed.review.commits.subject') }],
      canRemove: true,
    },
  }),
  // A follow-up in its own worktree names the worktree; its source shows only once the old branch is reviewed.
  worktree: reading('worktree', {
    state: 'current',
    followup: {
      id: hidden('worktree.followup.id'),
      source: hidden('worktree.followup.source'),
      workspace: probe('worktree.followup.workspace'),
    },
  }),
  detached: reading('detached', { state: 'detached', branch: '', head: probe('detached.head') }),
};

/** @param {string} name @param {string[]} [unshown] fields the view rendering this status does not display @returns {ConnectionStatus} */
const connection = (name, unshown = []) => {
  /** @param {string} field */
  const text = field => (unshown.includes(field) ? hidden : probe)(`${name}.${field}`);
  return {
    available: false,
    identity: null,
    identityVerified: false,
    message: text('message'),
    version: text('version'),
    extension: text('extension'),
    account: { name: text('account.name') },
  };
};
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
const pickerConnection = connection('pickerConnection', ['version', 'extension']);

/** @type {CommitsView[]} */
const commitViews = [
  { items: [{ commitId: probe('pushCommits.commitId'), comment: probe('pushCommits.comment') }], nextCursor: null },
  { error: probe('pushCommits.error') },
];

/** @type {import('../src/ui/feed.js').FeedView} */
const feedView = { route: 'activity', repoIds: null, search: '', kind: '', filtersOpen: false };

/** A full commit ID in its title with the first 8 characters shown, as the detail view renders commits. @param {string} id */
const shortCommit = id => `<code title="${html(id)}">${html(id.slice(0, 8))}</code>`;
/** The serialized event IDs a row and its buttons carry, ahead of the attribute that follows them. @param {string[]} ids @param {string} next */
const eventIds = (ids, next) => `data-event-ids="${html(JSON.stringify(ids))}"${next}`;
/** @param {string[]} ids */
const idsField = ids => `eventIds ${ids.map(fieldOf).join(', ')}`;
const summary = `Branch starts at ${html(String(newBranchPush.data?.refUpdates?.[0].newObjectId).slice(0, 8))}`;
const evidence = push.data?.mergeEvidence ?? {};

/** @type {Record<string, View>} */
const views = {
  feed: {
    render: () => [
      renderFeed(state, { ...feedView, route: 'catchup' }),
      renderFeed(state, feedView),
      renderFeed(pageState({ items: [], error: probe('activity.error') }), feedView),
    ],
    shows: [
      'stream.pushes.error',
      'activity.filterOption',
      'created.title',
      'repo.name',
      'created.branch',
      'build.running.id',
      'build.running.title',
      'build.running.branch',
      'build.running.actor',
      'pr.title',
      'pr.branch',
      'pr.targetRefName',
      'pr.actor',
      'pr.time',
      'untitledBuild.definition.name',
      'untitledBuild.buildId',
      'push.title',
      'push.branch',
      'push.summary',
      'push.actor',
      'olderPush.branch',
      'deleted.branch',
      'activity.error',
    ],
    sinks: [
      ...items.flatMap(item => [
        { field: `row ${idsField(item.eventIds)}`, html: eventIds(item.eventIds, ' data-group-key=') },
        { field: `seen button ${idsField(item.eventIds)}`, html: eventIds(item.eventIds, ' aria-label=') },
      ]),
      { field: 'newBranchPush.refUpdates.newObjectId', html: `<div class="event">${summary}` },
    ],
  },
  detail: {
    render: () => events.flatMap(event => [undefined, ...commitViews].map(commits => renderDetail(event, state, commits))),
    shows: [
      'repo.name',
      'build.running.title',
      'build.running.branch',
      'build.running.id',
      'repo.project',
      'build.running.actor',
      'build.running.sourceVersion',
      'untitledBuild.definition.name',
      'untitledBuild.buildId',
      'pr.title',
      'pr.branch',
      'pr.targetRefName',
      'pr.actor',
      'pr.sourceCommit',
      'pr.mergeCommit',
      'pr.closedBy',
      'pr.pullRequestId',
      'push.title',
      'push.branch',
      'push.summary',
      'push.actor',
      'push.commitId',
      'push.pushId',
      'push.mergeEvidence.prs.pullRequestId',
      'push.mergeEvidence.prs.sourceRefName',
      'push.mergeEvidence.prs.targetRefName',
      'push.mergeEvidence.prs.closedBy.displayName',
      'push.mergeEvidence.prs.mergeCommit',
      'push.mergeEvidence.prs.id',
      'push.mergeEvidence.prs.closedBy',
      'push.mergeEvidence.commits.branches.0',
      'push.mergeEvidence.commits.branches.1',
      'push.mergeEvidence.limitations',
      'push.mergeEvidence.error',
      'repo.id',
      'pushCommits.commitId',
      'pushCommits.comment',
      'pushCommits.error',
      'olderPush.branch',
      'olderPush.mergeEvidence.error.message',
      'deleted.branch',
      'created.title',
      'created.branch',
    ],
    sinks: [
      ...items.map(item => ({ field: idsField(item.eventIds), html: eventIds(item.eventIds, '>Mark') })),
      { field: 'build.running.sourceVersion', html: shortCommit(String(running.data?.sourceVersion)) },
      { field: 'pr.sourceCommit', html: shortCommit(String(pr.data?.sourceCommit)) },
      { field: 'pr.mergeCommit', html: shortCommit(String(pr.data?.mergeCommit)) },
      { field: 'push.commitId', html: shortCommit(String(push.data?.commitId)) },
      { field: 'pushCommits.commitId', html: shortCommit(String(commitViews[0].items?.[0].commitId)) },
      { field: 'push.mergeEvidence.prs.mergeCommit', html: `result ${shortCommit(String(evidence.prs?.[0].mergeCommit))}` },
      {
        field: 'push.mergeEvidence.commits.commitId',
        html: `<li><code>${html(String(evidence.commits?.[0].commitId).slice(0, 8))}</code> ·`,
      },
      {
        field: 'push.mergeEvidence.commits.branches',
        html: ` · ${html(`${probe('push.mergeEvidence.commits.branches.0')}, ${probe('push.mergeEvidence.commits.branches.1')}`)}</li>`,
      },
      { field: 'newBranchPush.refUpdates.newObjectId', html: `<p>${summary}</p>` },
    ],
  },
  repositories: {
    render: () => [
      renderRepositories(state, { connection: { results: new Map([['', pickerConnection]]) } }, { [repo.id]: checkouts.blocked }),
    ],
    shows: [
      'pickerConnection.account.name',
      'pickerConnection.message',
      'repo.id',
      'repo.name',
      'blocked.branch',
      'blocked.diagnostic.title',
      'blocked.upstream',
      'blocked.diagnostic.message',
      'blocked.diagnostic.advice.branch',
      'blocked.diagnostic.suggestion',
      'blocked.diagnostic.comparison.previous',
      'blocked.diagnostic.comparison.tip',
      'blocked.diagnostic.comparison.commits.id',
      'blocked.diagnostic.comparison.commits.subject',
      'blocked.nextStep',
      'job.error.message',
      'repo.project',
      'repo.localPath',
      'stream.pushes.error',
      'stream.prs.error',
      'disabledRepo.id',
      'disabledRepo.name',
    ],
    sinks: [{ field: 'repo.localPath', html: `title="${html(String(repo.localPath))}">~/${html(probe('repo.localPath'))}</p>` }],
  },
  settings: {
    render: () => settingsConnections.map(connection => renderSettings(state, connection)),
    shows: [
      'repo.id',
      'repo.name',
      'repo.project',
      'connection.version',
      'connection.extension',
      'connection.account.name',
      'connection.access.message',
      'diagnostics.lastError.message',
      'failedConnection.version',
      'failedConnection.extension',
      'failedConnection.account.name',
      'failedConnection.message',
      'localConnection.version',
      'localConnection.extension',
      'localConnection.account.name',
    ],
    sinks: [],
  },
  header: {
    render: () => [renderHeader(state, { repoIds: null, route: 'activity', activityRoute: 'activity' })],
    shows: ['repo.id', 'repo.name', 'repo.project'],
    sinks: [],
  },
  checkout: {
    render: () =>
      Object.values(checkouts).flatMap(checkout =>
        ['status', 'guidance', 'last-check'].map(part => renderCheckout(repo.id, checkout, part)),
      ),
    shows: [
      'switchable.branch',
      'switchable.diagnostic.title',
      'repo.id',
      'switchable.upstream',
      'switchable.diagnostic.advice.branch',
      'switchable.diagnostic.comparison.previous',
      'switchable.diagnostic.comparison.tip',
      'switchable.diagnostic.comparison.commits.id',
      'switchable.diagnostic.comparison.commits.subject',
      'switchable.nextStep',
      'blocked.branch',
      'blocked.diagnostic.title',
      'blocked.upstream',
      'blocked.diagnostic.message',
      'blocked.diagnostic.advice.branch',
      'blocked.diagnostic.suggestion',
      'blocked.diagnostic.comparison.previous',
      'blocked.diagnostic.comparison.tip',
      'blocked.diagnostic.comparison.commits.id',
      'blocked.diagnostic.comparison.commits.subject',
      'blocked.nextStep',
      'reviewed.branch',
      'reviewed.upstream',
      'reviewed.followup.source',
      'reviewed.review.commits.id',
      'reviewed.review.commits.subject',
      'reviewed.nextStep',
      'worktree.branch',
      'worktree.upstream',
      'worktree.followup.workspace',
      'worktree.nextStep',
      'detached.upstream',
      'detached.nextStep',
    ],
    sinks: [
      ...['switchable', 'blocked'].flatMap(name =>
        /** @type {const} */ (['previous', 'tip']).map(side => {
          const value = String(checkouts[name].diagnostic?.comparison?.[side]);
          return {
            field: `${name}.diagnostic.comparison.${side}`,
            html: `<code title="${html(value)}">${html(value.slice(0, 12))}</code>`,
          };
        }),
      ),
      { field: 'reviewed.review.commits.id', html: `<code>${html(probe('reviewed.review.commits.id').slice(0, 8))}</code>` },
      {
        field: 'detached.head',
        html: `title="${html(probe('detached.head').slice(0, 8))}">${html(probe('detached.head').slice(0, 8))}</code>`,
      },
    ],
  },
};

/** Every probe field in the fixtures, so a field that no view expects is noticed. */
const fixtureFields = () => {
  const fixtures = { repo, disabledRepo, events, streams, state, checkouts, settingsConnections, pickerConnection, commitViews };
  const text = JSON.stringify(fixtures, (_, value) => (value instanceof Map ? [...value] : value));
  return new Set([...text.matchAll(/<x-probe a=\\"([^"\\]*)\\">/g)].map(([, field]) => field));
};

test('no Azure or Git text reaches the rendered views unescaped', () => {
  const found = [];
  for (const [name, view] of Object.entries(views)) {
    const markup = view.render().join('\n');
    // A probe cut short or serialized loses its closing quote, so name its field where it survives and else show the context.
    for (const { index } of markup.matchAll(/<x-/g)) {
      const raw = markup.slice(index, index + 60);
      found.push(`${name}: ${raw.match(/^<x-\w+ a=\\?"([^"\\]*)/)?.[1] ?? raw}`);
    }
  }
  assert.deepEqual([...new Set(found)], [], 'these fields reach the markup unescaped');
});

test('each view shows its fields escaped', () => {
  const missing = Object.entries(views).flatMap(([name, view]) => {
    const markup = view.render().join('\n');
    return view.shows.filter(field => !markup.includes(html(probe(field)))).map(field => `${name}: ${field}`);
  });
  assert.deepEqual(missing, []);
});

test('values the views cut short or serialize are escaped where they are rendered', () => {
  const missing = Object.entries(views).flatMap(([name, view]) => {
    const markup = view.render().join('\n');
    return view.sinks.filter(sink => !markup.includes(sink.html)).map(sink => `${name}: ${sink.field}`);
  });
  assert.deepEqual(missing, []);
});

test('every probed field is expected by a view, so the escaping test covers it', () => {
  const expected = new Set(Object.values(views).flatMap(view => [...view.shows, ...view.sinks.map(sink => sink.field)]));
  assert.deepEqual(
    [...fixtureFields()].filter(field => !expected.has(field)),
    [],
  );
});
