// @ts-check
import { createServer } from 'node:http';
import { readFile, mkdir, chmod, rm, stat } from 'node:fs/promises';
import { resolve, dirname, extname, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { homedir } from 'node:os';
import { createStore } from './server/store.js';
import { createSync } from './server/sync.js';
import { createAzureCli, defaultExecutor } from './server/azure-cli.js';
import { createRestExecutor, useSystemNetworkSettings } from './server/azure-rest.js';
import { createAzureClient } from './server/azure-client.js';
import { discoverRepositories, parseRemote } from './server/repositories.js';
import { seedDemo, addDemoEvent, demoProvider } from './server/demo.js';
import { syncStatus } from './server/sync-status.js';
import { createBackfill } from './server/backfill.js';
import { createRewriteCheck } from './server/rewrite-check.js';
import { createCheckoutLookup } from './server/checkout-advice.js';
import { isBranchAction } from './server/checkout-branches.js';
import { createCheckoutGit, isCheckoutIntent } from './server/checkout-git.js';
import { browseFolders } from './server/folders.js';
import { canOpenBrowser, openBrowser } from './server/open-browser.js';

/** @typedef {import('node:http').IncomingMessage} Request */
/** @typedef {import('node:http').ServerResponse} Response */
/** @typedef {ReturnType<typeof createStore>} Store */
/** @typedef {import('./server/azure-client.js').AzureProvider} AzureProvider */
/** Live mode passes the Azure client; demo mode passes demoProvider, which answers only the routes demo serves. */
/** @typedef {AzureProvider | typeof demoProvider} AppProvider */
/** @typedef {{ demo: true, running: false }} DemoSyncStatus */
/** Demo mode passes a stub, so the app relies only on the two calls both share with createSync, and reset in live mode. */
/**
 * @typedef {{
 *   status: () => import('./server/sync.js').SyncStatus | DemoSyncStatus,
 *   refresh: (repoIds?: string[]) => import('./server/sync.js').RefreshStatus | { demo: true },
 *   reset?: (clear: () => void) => Promise<void>,
 * }} AppSync
 */
/** @typedef {{ req: Request, res: Response, url: URL, params: string[] }} RouteContext */
/** @typedef {{ method: 'GET'|'POST'|'PATCH'|'DELETE', path: string | RegExp, handler: (context: RouteContext) => unknown }} Route */
/** @typedef {Error & { status?: number, code?: string }} RequestError */
/**
 * @typedef {{
 *   store: Store,
 *   provider: AppProvider,
 *   sync: AppSync,
 *   cli?: Pick<ReturnType<typeof createAzureCli>, 'diagnostics'> | null,
 *   backfill?: Pick<ReturnType<typeof createBackfill>, 'start'>,
 *   demo?: boolean,
 *   discover?: typeof discoverRepositories,
 *   browse?: (input: unknown) => Promise<FoldersResponse>,
 *   checkoutGit?: ReturnType<typeof createCheckoutGit>,
 *   onStateRead?: () => void,
 *   accessKey: string,
 *   launchToken?: string,
 * }} AppOptions
 */

// The JSON each route answers with. src/api.js maps request paths to these types, so the browser
// modules that read a response are checked against what the handler below produces.
/** @typedef {import('./server/store.js').Repository} Repository */
/** @typedef {import('./server/store.js').HydratedEvent} HydratedEvent */
/** @typedef {{ message: string, code?: string }} ErrorResponse */
/** @typedef {{ ok: true }} OkResponse */
/** POST /api/session: the key, given once for the launch token. @typedef {{ key: string }} SessionResponse */
/**
 * GET /api/state. The settings are only ever written by POST /api/settings.
 * @typedef {{
 *   repos: Repository[],
 *   streams: import('./server/sync.js').StreamState[],
 *   diagnostics: Partial<ReturnType<ReturnType<typeof createAzureCli>['diagnostics']>> & { sync: ReturnType<AppSync['status']> },
 *   jobs: import('./server/backfill.js').HistoryJob[],
 *   activityRevision: string,
 *   settings: { refreshEnabled: boolean, refreshResumedAt: number | null },
 *   syncStatus: ReturnType<typeof syncStatus>,
 *   demo: boolean,
 * }} StateResponse
 */
/** GET /api/activity, built by server/activity-query.js. @typedef {import('./src/activity.js').ActivityPage} ActivityResponse */
/** GET /api/events/:id: the event and every event grouped with it. @typedef {{ event: HydratedEvent, events: HydratedEvent[] }} EventResponse */
/** GET /api/checkouts: status per enabled repository id, empty in demo mode. */
/** @typedef {Record<string, import('./server/checkout-git.js').CheckoutStatus>} CheckoutsResponse */
/** @typedef {ReturnType<typeof createCheckoutGit>} CheckoutGit */
/** POST /api/repos/:id/checkout. */
/** @typedef {Awaited<ReturnType<CheckoutGit['update']>> | Awaited<ReturnType<CheckoutGit['branchAction']>>} CheckoutUpdateResponse */
/** GET /api/connection. @typedef {Awaited<ReturnType<AppProvider['checkConnection']>>} ConnectionResponse */
/** @typedef {{ commitId: string, comment?: string }} PushCommit */
/** GET /api/push/:repo/:id/commits. @typedef {{ items: PushCommit[], nextCursor: unknown, message?: string }} PushCommitsResponse */
/** GET /api/pr/:repo/:id/review. @typedef {import('./server/azure-client.js').PullRequestReview & { message?: string }} PrReviewResponse */
/** POST /api/backfill. @typedef {ReturnType<ReturnType<typeof createBackfill>['start']>} BackfillResponse */
/** POST /api/refresh. @typedef {{ ok: true, status: ReturnType<AppSync['refresh']> }} RefreshResponse */
/** POST /api/reset. @typedef {{ started: true }} ResetResponse */
/** POST /api/discover. @typedef {import('./server/repositories.js').Discovery} DiscoverResponse */
/** POST /api/folders. @typedef {Awaited<ReturnType<typeof browseFolders>>} FoldersResponse */
/** POST /api/demo/event. @typedef {ReturnType<typeof addDemoEvent>} DemoEventResponse */

const ROOT = dirname(fileURLToPath(import.meta.url));
/** @type {Record<string, string>} */
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
const HEADERS = {
  'content-security-policy':
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'cache-control': 'no-store',
};

/** @param {string} message @returns {RequestError} */
function problem(message, status = 400) {
  return Object.assign(new Error(message), { status });
}

/**
 * Parses a JSON object body. Its fields stay unknown until each route validates them.
 * @param {Request} req
 * @returns {Promise<Record<string, unknown>>}
 */
async function body(req) {
  if (!req.headers['content-type']?.startsWith('application/json')) throw problem('Send application/json.', 415);
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 64 * 1024) throw problem('Request is too large.', 413);
    chunks.push(chunk);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString());
    if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error();
    return value;
  } catch {
    throw problem('Expected a JSON object.');
  }
}

/** @param {Request} req */
function checkLocalRequest(req) {
  // Compare the actual bound port too: other localhost apps are different origins.
  const port = req.socket.localPort;
  const hosts = new Set([`localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`]);
  const host = req.headers.host;
  if (!host || !hosts.has(host)) throw problem('Open Repo Pulse through its localhost address.', 403);
  if (req.headers.origin && req.headers.origin !== `http://${host}`) throw problem('Origin is not allowed.', 403);
  // A top-level load of the app page from elsewhere, such as the launch page the browser opens from a file, is allowed;
  // nothing can frame or read it, and every API request still has to be same-site and carry the key.
  const pageLoad =
    req.method === 'GET' && req.headers['sec-fetch-mode'] === 'navigate' && new URL(String(req.url), 'http://local').pathname === '/';
  if (req.headers['sec-fetch-site'] === 'cross-site' && !pageLoad) throw problem('Cross-site requests are not allowed.', 403);
}

/** @param {string} pathname @param {Response} res */
async function staticFile(pathname, res) {
  /** @type {Record<string, string>} */
  const alias = { '/': 'web/index.html', '/app.css': 'web/app.css', '/theme.js': 'web/theme.js', '/favicon.svg': 'web/favicon.svg' };
  let relative = alias[pathname];
  if (!relative && /^\/(src|web)\/[a-zA-Z0-9_./-]+\.(js|css|svg)$/.test(pathname)) relative = pathname.slice(1);
  if (!relative) return false;
  const path = resolve(ROOT, relative);
  if (![resolve(ROOT, 'web') + sep, resolve(ROOT, 'src') + sep].some(prefix => path.startsWith(prefix))) return false;
  try {
    const content = await readFile(path);
    res.writeHead(200, { 'content-type': `${TYPES[extname(path)]}; charset=utf-8` }).end(content);
    return true;
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT') return false;
    throw error;
  }
}

/**
 * Narrow loopback HTTP boundary. Azure commands, sync and persistence live in separate modules.
 * @param {AppOptions} options
 */
export function createApp({
  store,
  provider,
  sync,
  cli,
  backfill,
  demo = false,
  discover = discoverRepositories,
  browse = browseFolders,
  checkoutGit = createCheckoutGit({
    findPulls: createCheckoutLookup({
      cached: store.completedCheckoutPulls,
      lookup: 'completedCheckoutPulls' in provider ? provider.completedCheckoutPulls : undefined,
    }),
    // Settings are stored JSON; these keys only ever hold what the matching save wrote.
    followups: {
      get: id => /** @type {import('./server/checkout-branches.js').Followup | undefined} */ (store.getSetting(`checkout-followup:${id}`)),
      save: (id, value) => store.setSetting(`checkout-followup:${id}`, value),
    },
    observations: {
      get: id => /** @type {import('./server/checkout-observations.js').Observation | undefined} */ (store.getSetting(`checkout:${id}`)),
      save: (id, value) => store.setSetting(`checkout:${id}`, value),
    },
  }),
  onStateRead = () => {},
  accessKey,
  launchToken,
}) {
  if (typeof accessKey !== 'string' || accessKey.length < 32) throw new Error('createApp needs an access key of at least 32 characters.');
  const expectedKey = Buffer.from(accessKey);
  const startedAt = Date.now();
  /** The reset in progress, shared by every request that arrives while it runs. @type {Promise<void> | null} */
  let resetting = null;
  /** @param {unknown} value @param {Buffer} expected */
  const matches = (value, expected) => {
    const given = Buffer.from(String(value ?? ''));
    return given.length === expected.length && timingSafeEqual(given, expected);
  };
  /** @param {Request} req */
  const hasAccessKey = req => matches(req.headers['x-repo-pulse-key'], expectedKey);
  // The launch link carries this token instead of the key. It works once, so a copied or recorded link is spent.
  let launch = launchToken ? Buffer.from(launchToken) : null;
  /** @param {Response} res @param {number} status @param {unknown} data */
  const json = (res, status, data) =>
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' }).end(JSON.stringify(data));
  /** @param {unknown} id */
  const repoById = id => {
    const repo = store.listRepos().find(item => item.id === id);
    if (!repo) throw problem('Repository is not watched.', 404);
    return repo;
  };
  /** @param {unknown} id */
  const enabledRepoById = id => {
    const repo = repoById(id);
    if (repo.disabled) throw problem('Repository is disabled. Enable it on Repositories first.', 409);
    return repo;
  };
  /** @param {unknown} value @returns {value is string[]} */
  const isStringList = value => Array.isArray(value) && value.every(item => typeof item === 'string');
  const enabledRepoIds = () =>
    store
      .listRepos()
      .filter(repo => !repo.disabled)
      .map(repo => repo.id);
  // First match wins, in table order. Route params arrive undecoded so each handler keeps its own check order.
  /** @type {Route[]} */
  const routes = [
    {
      method: 'GET',
      path: '/api/state',
      handler: ({ res }) => {
        onStateRead();
        const status = sync.status();
        const inProgress = 'inProgress' in status ? status.inProgress : [];
        const repos = store.listRepos();
        const streams = store.getStreams();
        const jobs = store.listJobs({ type: 'backfill' });
        // Both settings are only written by POST /api/settings: a boolean and a Date.now() stamp.
        const settings = {
          refreshEnabled: /** @type {boolean} */ (store.getSetting('refreshEnabled', true)),
          refreshResumedAt: /** @type {number | null} */ (store.getSetting('refreshResumedAt', null)),
        };
        const diagnostics = { ...(cli?.diagnostics() || {}), sync: status };
        return json(
          res,
          200,
          /** @satisfies {StateResponse} */ ({
            repos,
            streams,
            diagnostics,
            jobs,
            activityRevision: store.activityRevision(),
            settings,
            syncStatus: syncStatus({
              repos,
              streams,
              jobs,
              inProgress,
              settings,
              startedAt,
              now: Date.now(),
              demo,
              throttledUntil: diagnostics.throttledUntil,
              resetting: Boolean(resetting),
            }),
            demo,
          }),
        );
      },
    },
    {
      method: 'GET',
      path: '/api/activity',
      handler: ({ res, url }) => {
        const query = url.searchParams;
        let cursor;
        try {
          cursor = query.get('cursor') || undefined;
        } catch {
          throw problem('Invalid activity cursor.');
        }
        const view = query.get('view') || 'all';
        if (view !== 'new' && view !== 'all') throw problem('Invalid activity view.');
        const repoIdList = query.get('repoIds');
        const requested = repoIdList !== null ? repoIdList.split(',').filter(Boolean) : undefined;
        requested?.forEach(repoById);
        const enabled = enabledRepoIds();
        const repoIds = (requested || enabled).filter(id => enabled.includes(id));
        const limit = Number(query.get('limit') || 50);
        if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw problem('Choose a page size from 1 to 200.');
        const result = store.queryActivity({
          repoIds,
          view,
          kind: query.get('kind') || '',
          search: (query.get('search') || '').slice(0, 300),
          limit,
          cursor,
        });
        return json(res, 200, /** @satisfies {ActivityResponse} */ (result));
      },
    },
    {
      method: 'GET',
      path: /^\/api\/events\/(.+)$/,
      handler: ({ res, params: [rawId] }) => {
        const id = decodeURIComponent(rawId);
        const event = store.getEvent(id);
        if (!event || !enabledRepoIds().includes(event.repoId)) throw problem('Activity not found.', 404);
        return json(res, 200, /** @satisfies {EventResponse} */ ({ event, events: store.getEventGroup(id) }));
      },
    },
    {
      method: 'POST',
      path: '/api/backfill',
      handler: async ({ req, res }) => {
        if (demo || !backfill) throw problem('Historical import is available in live mode.');
        // The reset would delete the job this request creates.
        if (resetting) throw problem('Starting from scratch is in progress. Try again in a moment.', 409);
        const input = await body(req);
        const repo = repoById(input.repoId);
        const days = input.days;
        if (days !== 30 && days !== 90 && days !== 'all') throw problem('Choose 30 days, 90 days or all available history.');
        return json(res, 202, /** @satisfies {BackfillResponse} */ (backfill.start(repo.id, days)));
      },
    },
    {
      method: 'GET',
      path: '/api/connection',
      handler: async ({ res, url }) => {
        const org = url.searchParams.get('organization') || undefined;
        if (org && !/^https:\/\/dev\.azure\.com\/[A-Za-z0-9_.-]+\/?$/.test(org))
          throw problem('Use https://dev.azure.com/your-organization.');
        const repoId = url.searchParams.get('repoId');
        const connection = await provider.checkConnection(org, repoId === null ? undefined : enabledRepoById(repoId));
        return json(res, 200, /** @satisfies {ConnectionResponse} */ (connection));
      },
    },
    {
      method: 'POST',
      path: '/api/discover',
      handler: async ({ req, res }) => {
        const input = await body(req);
        if (typeof input.path !== 'string' || !input.path.trim()) throw problem('Enter a local folder path.');
        return json(res, 200, /** @satisfies {DiscoverResponse} */ (await discover(input.path)));
      },
    },
    {
      method: 'POST',
      path: '/api/folders',
      handler: async ({ req, res }) => {
        const input = await body(req);
        return json(res, 200, /** @satisfies {FoldersResponse} */ (await browse(input.path)));
      },
    },
    {
      method: 'POST',
      path: '/api/repos',
      handler: async ({ req, res }) => {
        // Only the live Azure client resolves repositories; demoProvider has no lookup.
        if (demo || !('resolveRepository' in provider))
          throw problem('Demo repositories are fictional. Start live mode to add your repositories.');
        const input = await body(req);
        /** @type {import('./server/repositories.js').ParsedRemote & { localPath?: string }} */
        let remote;
        if (typeof input.url === 'string' && input.url.trim()) remote = parseRemote(input.url.trim());
        else if (typeof input.path === 'string' && input.path.trim()) {
          const result = await discover(input.path);
          const enteredPath = input.path.startsWith('~/') ? resolve(homedir(), input.path.slice(2)) : resolve(input.path);
          const checkout = result.repositories.find(repo => resolve(repo.localPath) === enteredPath);
          if (!checkout) throw problem('This folder is not an Azure Git checkout. Choose a repository folder.');
          const remotes = input.remote ? checkout.remotes.filter(item => item.name === input.remote) : checkout.remotes;
          if (remotes.length !== 1) throw problem('Choose the remote explicitly for a checkout with multiple Azure remotes.');
          remote = { ...parseRemote(remotes[0].url), localPath: checkout.localPath };
        } else throw problem('Enter an Azure repository URL or local checkout path.');
        /** @type {import('./server/store.js').Repository} */
        const repo = await provider.resolveRepository(remote);
        if (remote.localPath) repo.localPath = remote.localPath;
        const existing = store.listRepos().find(item => item.id === repo.id);
        store.saveRepo({ ...repo, disabled: existing?.disabled || false });
        sync.refresh([repo.id]);
        return json(res, 201, /** @satisfies {Repository} */ (repo));
      },
    },
    {
      method: 'GET',
      path: '/api/checkouts',
      handler: async ({ res }) => {
        const repos = store.listRepos().filter(repo => !repo.disabled);
        /** @type {[string, import('./server/checkout-git.js').CheckoutStatus][]} */
        const results = [];
        if (!demo)
          for (let i = 0; i < repos.length; i += 2) {
            results.push(
              ...(await Promise.all(
                repos
                  .slice(i, i + 2)
                  .map(
                    async repo =>
                      /** @type {[string, import('./server/checkout-git.js').CheckoutStatus]} */ ([
                        repo.id,
                        await checkoutGit.status(repo),
                      ]),
                  ),
              )),
            );
          }
        return json(res, 200, /** @satisfies {CheckoutsResponse} */ (Object.fromEntries(results)));
      },
    },
    {
      method: 'POST',
      path: /^\/api\/repos\/([^/]+)\/checkout$/,
      handler: async ({ req, res, params: [rawId] }) => {
        if (demo) throw problem('Demo checkouts cannot be updated.', 403);
        const repo = enabledRepoById(decodeURIComponent(rawId));
        const input = (await body(req)) || {};
        const { operation, expected } = input;
        if (isBranchAction(input) && isCheckoutIntent(expected)) {
          return json(res, 200, /** @satisfies {CheckoutUpdateResponse} */ (await checkoutGit.branchAction(repo, input, expected)));
        }
        if ((operation !== 'check' && operation !== 'pull') || !isCheckoutIntent(expected)) {
          throw problem('Choose a checkout and Git action.');
        }
        return json(res, 200, /** @satisfies {CheckoutUpdateResponse} */ (await checkoutGit.update(repo, operation, expected)));
      },
    },
    {
      method: 'PATCH',
      path: /^\/api\/repos\/([^/]+)$/,
      handler: async ({ req, res, params: [rawId] }) => {
        const id = decodeURIComponent(rawId);
        const repo = repoById(id);
        const input = await body(req);
        if (typeof input.disabled !== 'boolean') throw problem('disabled must be true or false.');
        store.saveRepo({ ...repo, disabled: input.disabled });
        if (!input.disabled) sync.refresh([id]);
        return json(res, 200, /** @satisfies {OkResponse} */ ({ ok: true }));
      },
    },
    {
      method: 'DELETE',
      path: /^\/api\/repos\/([^/]+)$/,
      handler: ({ res, params: [rawId] }) => {
        const id = decodeURIComponent(rawId);
        repoById(id);
        store.removeRepo(id);
        return json(res, 200, /** @satisfies {OkResponse} */ ({ ok: true }));
      },
    },
    {
      method: 'POST',
      path: '/api/refresh',
      handler: async ({ req, res }) => {
        const input = await body(req);
        const { repoIds } = input;
        if (repoIds !== undefined && !isStringList(repoIds)) throw problem('repoIds must be a list.');
        repoIds?.forEach(repoById);
        return json(res, 202, /** @satisfies {RefreshResponse} */ ({ ok: true, status: sync.refresh(repoIds) }));
      },
    },
    {
      method: 'POST',
      path: '/api/reset',
      handler: async ({ req, res }) => {
        await body(req);
        if (demo || !sync.reset) throw problem('Demo data cannot be cleared. Start live mode to start from scratch.', 403);
        // The reset waits for the turn in flight, which can sit behind Azure's Retry-After for minutes, so it runs unawaited.
        resetting ??= sync
          .reset(() => store.resetActivity())
          .then(() => {
            sync.refresh();
          })
          .catch(error => console.error('Start from scratch failed:', error.name))
          .finally(() => {
            resetting = null;
          });
        return json(res, 202, /** @satisfies {ResetResponse} */ ({ started: true }));
      },
    },
    {
      method: 'POST',
      path: '/api/ack',
      handler: async ({ req, res }) => {
        const input = await body(req);
        const { ids, seen } = input;
        if (!Array.isArray(ids) || ids.length > 1000 || !isStringList(ids)) throw problem('Send up to 1000 explicit event IDs.');
        if (seen !== undefined && typeof seen !== 'boolean') throw problem('seen must be true or false.');
        store.acknowledge(ids, seen !== false);
        return json(res, 200, /** @satisfies {OkResponse} */ ({ ok: true }));
      },
    },
    {
      method: 'POST',
      path: '/api/settings',
      handler: async ({ req, res }) => {
        const input = await body(req);
        if (typeof input.refreshEnabled !== 'boolean') throw problem('refreshEnabled must be true or false.');
        if (input.refreshEnabled && store.getSetting('refreshEnabled', true) === false) {
          store.setSetting('refreshResumedAt', Date.now());
        }
        store.setSetting('refreshEnabled', input.refreshEnabled);
        return json(res, 200, /** @satisfies {OkResponse} */ ({ ok: true }));
      },
    },
    // Only demo mode has this route; in live mode the path is a plain 404.
    ...(demo
      ? /** @type {Route[]} */ ([
          {
            method: 'POST',
            path: '/api/demo/event',
            handler: async ({ req, res }) => {
              await body(req);
              return json(res, 201, /** @satisfies {DemoEventResponse} */ (addDemoEvent(store)));
            },
          },
        ])
      : []),
    {
      method: 'GET',
      path: /^\/api\/push\/([^/]+)\/(\d+)\/commits$/,
      handler: async ({ res, url, params: [rawId, pushId] }) => {
        const repo = enabledRepoById(decodeURIComponent(rawId));
        if (!provider.pushCommits)
          return json(
            res,
            200,
            /** @satisfies {PushCommitsResponse} */ ({ items: [], nextCursor: null, message: 'Open Azure DevOps for commit details.' }),
          );
        const skip = Number(url.searchParams.get('skip') || 0);
        if (!Number.isSafeInteger(skip) || skip < 0) throw problem('Invalid page offset.');
        const page = await provider.pushCommits(repo, Number(pushId), { skip });
        // The browser shows only these two fields; raw Azure commit objects stay behind this boundary.
        const items = page.items.map(item => ({
          commitId: typeof item?.commitId === 'string' ? item.commitId : '',
          ...(typeof item?.comment === 'string' ? { comment: item.comment } : {}),
        }));
        return json(res, 200, /** @satisfies {PushCommitsResponse} */ ({ items, nextCursor: page.nextCursor }));
      },
    },
    {
      method: 'GET',
      path: /^\/api\/pr\/([^/]+)\/(\d+)\/review$/,
      handler: async ({ res, params: [rawId, pullRequestId] }) => {
        const repo = enabledRepoById(decodeURIComponent(rawId));
        return json(res, 200, /** @satisfies {PrReviewResponse} */ (await provider.prReview(repo, pullRequestId)));
      },
    },
  ];
  return createServer(async (req, res) => {
    Object.entries(HEADERS).forEach(([key, value]) => res.setHeader(key, value));
    try {
      checkLocalRequest(req);
      const url = new URL(String(req.url), `http://${req.headers.host}`);
      const path = url.pathname;
      if (req.method === 'GET' && (await staticFile(path, res))) return;
      if (!path.startsWith('/api/')) return json(res, 404, /** @satisfies {ErrorResponse} */ ({ message: 'Not found.' }));
      if (path === '/api/session' && req.method === 'POST') {
        if (!launch || !matches(req.headers['x-repo-pulse-launch'], launch))
          throw Object.assign(problem('This launch link was already used. Open the newest link printed in the terminal.', 401), {
            code: 'LAUNCH_USED',
          });
        launch = null;
        return json(res, 200, /** @satisfies {SessionResponse} */ ({ key: accessKey }));
      }
      // Every API request, reads included, carries the key. A browser on another origin cannot add the header.
      if (!hasAccessKey(req))
        throw Object.assign(
          problem(
            'Open the newest link printed in the terminal where Repo Pulse runs. Each link works once; restart Repo Pulse for a new one.',
            401,
          ),
          { code: 'ACCESS_KEY' },
        );
      if (!['GET', 'POST', 'PATCH', 'DELETE'].includes(req.method ?? '')) throw problem('Method not allowed.', 405);
      for (const route of routes) {
        if (route.method !== req.method) continue;
        const match = typeof route.path === 'string' ? route.path === path && [path] : route.path.exec(path);
        if (match) return await route.handler({ req, res, url, params: match.slice(1) });
      }
      return json(res, 404, /** @satisfies {ErrorResponse} */ ({ message: 'Not found.' }));
    } catch (caught) {
      const error = /** @type {RequestError} */ (caught);
      // Adapter errors carry already-redacted, actionable text; unexpected errors stay local.
      const status =
        error.status ||
        (error.code === 'NOT_FOUND'
          ? 404
          : error.code === 'BAD_REQUEST' || error.code === 'INVALID_REPOSITORY'
            ? 400
            : error.code
              ? 502
              : 500);
      if (status === 500) console.error('Request failed:', error.name);
      return json(
        res,
        status,
        /** @satisfies {ErrorResponse} */ ({
          message: status === 500 ? 'Something went wrong. Try again; cached data is kept.' : error.message,
          code: error.code,
        }),
      );
    }
  });
}

/** @param {{ demo?: boolean, port?: number, dataDir?: string }} [options] */
export async function startApp({ demo = false, port = 0, dataDir = resolve(ROOT, '.repo-pulse') } = {}) {
  await secureDataDir(dataDir);
  // Earlier versions kept one key for good; every start now makes its own, so a key from a past run is useless.
  await rm(resolve(dataDir, 'access-key'), { force: true });
  const store = createStore(resolve(dataDir, demo ? 'demo.sqlite' : 'live.sqlite'));
  // Reads go over HTTPS with one CLI token, so the shared budget can be far above the 12 az starts per minute.
  if (!demo) useSystemNetworkSettings();
  const cli = demo
    ? null
    : createAzureCli({ executor: createRestExecutor({ cliExecutor: defaultExecutor }), limitPerMinute: 60, concurrency: 4 });
  // The live pieces are null in demo mode; keeping them separate lets each consumer see the concrete type.
  const azure = cli && createAzureClient({ cli });
  const provider = azure || demoProvider;
  let lastClientAt = 0;
  /** @type {ReturnType<typeof createBackfill> | undefined} */
  let backfill;
  const rewriteCheck = azure && createRewriteCheck({ store, provider: azure });
  const liveSync =
    azure &&
    createSync({
      store,
      provider: azure,
      isForeground: () => Date.now() - lastClientAt < 45_000,
      // Assigned below, before sync.start() can schedule any work.
      background: { rewrite: () => rewriteCheck?.tick(), history: () => backfill?.tick() },
    });
  const sync = (liveSync && {
    ...liveSync,
    /** @param {() => void} clear */
    reset: clear =>
      liveSync.reset(() => {
        clear();
        rewriteCheck?.reset();
      }),
  }) || {
    start() {},
    stop() {},
    /** @returns {{ demo: true }} */
    refresh() {
      return { demo: true };
    },
    /** @returns {DemoSyncStatus} */
    status() {
      return { demo: true, running: false };
    },
  };
  if (!azure || !liveSync) seedDemo(store);
  else {
    backfill = createBackfill({ store, provider: azure, normalize: liveSync.normalize });
  }
  const accessKey = randomBytes(32).toString('base64url');
  const launchToken = randomBytes(32).toString('base64url');
  const app = createApp({
    store,
    provider,
    sync,
    cli,
    backfill,
    demo,
    accessKey,
    launchToken,
    onStateRead: () => {
      lastClientAt = Date.now();
    },
  });
  await new Promise((resolveListen, reject) => {
    app.once('error', reject);
    app.listen(port, '127.0.0.1', () => resolveListen(undefined));
  });
  sync.start();
  const close = async () => {
    const syncStopped = sync.stop();
    // Abort budget-queued CLI work before waiting for a sync that might be waiting on it.
    await cli?.close();
    await syncStopped;
    await new Promise(resolveClose => app.close(resolveClose));
    store.close();
  };
  const url = `http://127.0.0.1:${/** @type {import('node:net').AddressInfo} */ (app.address()).port}`;
  return { app, store, sync, provider, close, url, dataDir, accessKey, launchUrl: `${url}/#launch=${launchToken}` };
}

/**
 * The data directory holds the database: it must belong to this account and be closed to others.
 * @param {string} dataDir
 */
async function secureDataDir(dataDir) {
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  if (typeof process.getuid !== 'function') return;
  const info = await stat(dataDir);
  if (info.uid !== process.getuid()) throw new Error(`${dataDir} belongs to another account. Choose a data directory you own.`);
  if (info.mode & 0o077) await chmod(dataDir, 0o700);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  // No fixed port by default: a new origin every run means nothing another account served earlier on that port, such as a
  // service worker, applies to this run.
  const port = Number(process.env.PORT || 0);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('PORT must be an integer from 0 to 65535.');
  const runtime = await startApp({ demo: process.argv.includes('--demo'), port, dataDir: process.env.REPO_PULSE_DATA_DIR || undefined });
  console.log(`Repo Pulse${process.argv.includes('--demo') ? ' · demo data, no Azure calls' : ''}: ${runtime.launchUrl}`);
  const open = process.env.REPO_PULSE_NO_BROWSER !== '1' && canOpenBrowser(process.platform, process.env);
  console.log(
    `${open ? 'Opening it in your browser; if the browser does not show Repo Pulse, use the link above.' : 'Open the link above in your browser.'} It works once and a new one is printed at every start. Local only. Stop with Ctrl+C.`,
  );
  const removeLaunchPage = open ? await openBrowser(runtime.launchUrl, { dataDir: runtime.dataDir }) : async () => {};
  let closing = false;
  const stop = async () => {
    if (!closing) {
      closing = true;
      await removeLaunchPage().catch(() => {});
      await runtime.close();
    }
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
