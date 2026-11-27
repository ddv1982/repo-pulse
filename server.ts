import { activityLabel } from './src/activity-text.ts';
import { createServer } from 'node:http';
import { readFile, mkdir, chmod, rm, stat } from 'node:fs/promises';
import { resolve, dirname, extname, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { homedir } from 'node:os';
import { createSavedActivityFilters } from './server/saved-activity-filters.ts';
import { createStore } from './server/store.ts';
import { isCorruptRow } from './server/store-records.ts';
import { lockDatabase } from './server/database-lock.ts';
import { createSync } from './server/sync.ts';
import { createAzureCli, defaultExecutor } from './server/azure-cli.ts';
import { createRestExecutor, useSystemNetworkSettings } from './server/azure-rest.ts';
import { createAzureClient } from './server/azure-client.ts';
import { discoverRepositories, parseRemote } from './server/repositories.ts';
import { seedDemo, addDemoEvent, demoProvider } from './server/demo.ts';
import { syncStatus } from './server/sync-status.ts';
import { createBackfill } from './server/backfill.ts';
import { createRewriteCheck } from './server/rewrite-check.ts';
import { createForkOriginCheck } from './server/fork-origin.ts';
import { createCheckoutLookup } from './server/checkout-advice.ts';
import { isBranchAction } from './server/checkout-branches.ts';
import { createCheckoutGit, isCheckoutIntent, isSwitchIntent } from './server/checkout-git.ts';
import { activityBranch } from './src/activity-branch.ts';
import { browseFolders } from './server/folders.ts';
import { canOpenBrowser, openBrowser } from './server/open-browser.ts';
import type { IncomingMessage as Request, ServerResponse as Response } from 'node:http';
import type { AzureProvider } from './server/azure-client.ts';
// The JSON each route answers with is defined in src/contract.d.ts, which src/api.ts maps request paths to, so the
// browser modules that read a response are checked against what the handler below produces.
import type {
  DemoSyncStatus,
  Repository,
  SessionResponse,
  ErrorResponse,
  OkResponse,
  StateResponse,
  EventResponse,
  CheckoutsResponse,
  CheckoutStatusResponse,
  CheckoutBranchesResponse,
  CheckoutUpdateResponse,
  ConnectionResponse,
  PushCommitsResponse,
  PrReviewResponse,
  BackfillResponse,
  RefreshResponse,
  ResetResponse,
  DiscoverResponse,
  FoldersResponse,
  DemoEventResponse,
} from './src/contract.d.ts';
import type { ActivityPage as ActivityResponse } from './src/activity.ts';

export type Store = ReturnType<typeof createStore>;

/** Live mode passes the Azure client; demo mode passes demoProvider, which answers only the routes demo serves. */
export type AppProvider = AzureProvider | typeof demoProvider;

/**
 * Demo mode passes a stub, so the app relies only on the two calls both share with createSync, and reset and forget
 * in live mode.
 */
export type AppSync = {
  status: () => import('./src/contract.d.ts').SyncEngineStatus | DemoSyncStatus;
  refresh: (repoIds?: string[], authOnly?: boolean) => import('./src/contract.d.ts').RefreshStatus | { demo: true };
  reset?: (clear: () => void) => Promise<void>;
  forget?: (repoId: string) => void;
};
export type RouteContext = { req: Request; res: Response; url: URL; params: string[] };
export type Route = { method: 'GET' | 'POST' | 'PATCH' | 'DELETE'; path: string | RegExp; handler: (context: RouteContext) => unknown };
export type RequestError = Error & { status?: number; code?: string };
export type AppOptions = {
  store: Store;
  provider: AppProvider;
  sync: AppSync;
  cli?: Pick<ReturnType<typeof createAzureCli>, 'diagnostics'> | null;
  backfill?:
    (Pick<ReturnType<typeof createBackfill>, 'start'> & Partial<Pick<ReturnType<typeof createBackfill>, 'retrySignIn'>>) | undefined;
  demo?: boolean;
  discover?: typeof discoverRepositories;
  browse?: (input: unknown) => Promise<FoldersResponse>;
  checkoutGit?: ReturnType<typeof createCheckoutGit>;
  onStateRead?: () => void;
  accessKey: string;
  launchToken?: string;
};

const ROOT = dirname(fileURLToPath(import.meta.url));
const TYPES: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
const HEADERS = {
  'content-security-policy':
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'cache-control': 'no-store',
};

function problem(message: string, status = 400): RequestError {
  return Object.assign(new Error(message), { status });
}

/** Every route group is required, so a matched route always supplies its parameters. */
function decodeParam(value: string | undefined) {
  if (value === undefined) throw problem('Invalid request path.', 400);
  try {
    return decodeURIComponent(value);
  } catch {
    throw problem('Invalid request path.', 400);
  }
}

/**
 * Parses a JSON object body. Its fields stay unknown until each route validates them.
 */
async function body(req: Request): Promise<Record<string, unknown>> {
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

function checkLocalRequest(req: Request) {
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

async function staticFile(pathname: string, res: Response) {
  const alias: Record<string, string> = {
    '/': 'web/index.html',
    '/app.css': 'web/app.css',
    '/theme.js': 'web/theme.js',
    '/favicon.svg': 'web/favicon.svg',
  };
  let relative = alias[pathname];
  if (!relative && /^\/(src|web)\/[a-zA-Z0-9_./-]+\.(js|css|svg)$/.test(pathname)) relative = pathname.slice(1);
  if (!relative) return false;
  // Browser modules are compiled into dist/ by `npm run build:web`; markup, styles, icons and vendored code are served as written.
  const built = extname(relative) === '.js' && !relative.startsWith('web/vendor/');
  const root = built ? resolve(ROOT, 'dist') : ROOT;
  const path = resolve(root, relative);
  if (!(built ? ['src', 'web'] : ['web']).some(dir => path.startsWith(resolve(root, dir) + sep))) return false;
  try {
    const content = await readFile(path);
    res.writeHead(200, { 'content-type': `${TYPES[extname(path)]}; charset=utf-8` }).end(content);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

/**
 * Narrow loopback HTTP boundary. Azure commands, sync and persistence live in separate modules.
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
    followups: {
      get: id => store.getSetting(`checkout-followup:${id}`),
      save: (id, value) => store.setSetting(`checkout-followup:${id}`, value),
    },
    observations: {
      get: (id, identity) => {
        const saved = store.getSetting(`checkout:${id}:${identity}`) ?? store.getSetting(`checkout:${id}`);
        return saved?.identity === identity ? saved : undefined;
      },
      save: (id, value) => store.setSetting(`checkout:${id}:${value.identity}`, value),
    },
  }),
  onStateRead = () => {},
  accessKey,
  launchToken,
}: AppOptions) {
  if (typeof accessKey !== 'string' || accessKey.length < 32) throw new Error('createApp needs an access key of at least 32 characters.');
  const expectedKey = Buffer.from(accessKey);
  const startedAt = Date.now();
  /** The reset in progress, shared by every request that arrives while it runs. */
  let resetting: Promise<void> | null = null;
  /** Set when the last reset failed, until another starts, so the page can say so instead of looking unchanged. */
  let resetFailed = false;
  const matches = (value: string | string[] | undefined, expected: Buffer) => {
    const given = Buffer.from(Array.isArray(value) ? value.join(',') : (value ?? ''));
    return given.length === expected.length && timingSafeEqual(given, expected);
  };
  const hasAccessKey = (req: Request) => matches(req.headers['x-repo-pulse-key'], expectedKey);
  // The launch link carries this token instead of the key. It works once, so a copied or recorded link is spent.
  let launch = launchToken ? Buffer.from(launchToken) : null;
  const json = (res: Response, status: number, data: unknown) =>
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' }).end(JSON.stringify(data));
  const repoById = (id: unknown) => {
    const repo = store.listRepos().find(item => item.id === id);
    if (!repo) throw problem('Repository is not watched.', 404);
    return repo;
  };
  const enabledRepoById = (id: unknown) => {
    const repo = repoById(id);
    if (repo.disabled) throw problem('Repository is disabled. Enable it on Repositories first.', 409);
    return repo;
  };
  const isStringList = (value: unknown): value is string[] => Array.isArray(value) && value.every(item => typeof item === 'string');
  const enabledRepoIds = () =>
    store
      .listRepos()
      .filter(repo => !repo.disabled)
      .map(repo => repo.id);
  const savedFilters = createSavedActivityFilters(store);
  function activityScope(query: URLSearchParams) {
    const repoIdList = query.get('repoIds');
    const requested = repoIdList !== null ? repoIdList.split(',').filter(Boolean) : undefined;
    requested?.forEach(repoById);
    const enabled = enabledRepoIds();
    return {
      repoIds: (requested || enabled).filter(id => enabled.includes(id)),
      kind: query.get('kind') || '',
      search: query.get('search') || '',
      people: query.get('people') || '',
    };
  }
  // First match wins, in table order. Route params arrive undecoded so each handler keeps its own check order.
  const routes: Route[] = [
    {
      method: 'GET',
      path: '/api/state',
      handler: ({ res }) => {
        onStateRead();
        const status = sync.status();
        const inProgress = 'inProgress' in status ? status.inProgress : [];
        const repos = store.listRepos();
        const streams = store.getStreams();
        const problems = 'backgroundProblems' in status ? status.backgroundProblems : undefined;
        let backgroundProblem = problems?.history ?? problems?.rewrite;
        let jobs: StateResponse['jobs'] = [];
        try {
          jobs = store.listJobs({ type: 'backfill' });
        } catch (error) {
          if (!isCorruptRow(error)) throw error;
          // Keep state readable so the Activity banner can explain why history progress is unavailable.
          backgroundProblem = error.message;
        }
        const settings = {
          refreshEnabled: store.getSetting('refreshEnabled', true),
          refreshResumedAt: store.getSetting('refreshResumedAt', null),
        };
        const diagnostics = { ...(cli?.diagnostics() || {}), sync: status };
        return json(res, 200, {
          repos,
          streams: streams.map(({ repoId, stream, initialized, lastSuccess, error, warning }) => ({
            repoId,
            stream,
            initialized,
            lastSuccess,
            ...(error === undefined ? {} : { error }),
            warning,
          })),
          diagnostics,
          jobs,
          activityRevision: store.activityRevision(),
          savedFilters: savedFilters.list(),
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
            resetFailed,
            backgroundProblem,
          }),
          demo,
        } satisfies StateResponse);
      },
    },
    {
      method: 'GET',
      path: '/api/activity',
      handler: ({ res, url }) => {
        const query = url.searchParams;
        const cursor = query.get('cursor') || undefined;
        const view = query.get('view') || 'all';
        if (view !== 'new' && view !== 'all') throw problem('Invalid activity view.');
        const limit = Number(query.get('limit') || 50);
        if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw problem('Choose a page size from 1 to 200.');
        const result = store.queryActivity({
          ...activityScope(query),
          view,
          limit,
          cursor,
        });
        return json(res, 200, result satisfies ActivityResponse);
      },
    },
    {
      method: 'GET',
      path: '/api/activity/unseen',
      handler: ({ res, url }) => {
        const raw = url.searchParams.get('through');
        const through = raw === null ? undefined : Number(raw);
        if (through !== undefined && !(Number.isSafeInteger(through) && through >= 0))
          throw Object.assign(new Error('Invalid activity snapshot.'), { code: 'BAD_REQUEST' });
        json(res, 200, { ids: store.queryActivity.unseenIds({ ...activityScope(url.searchParams), through }) });
      },
    },
    {
      method: 'POST',
      path: '/api/activity-filters',
      handler: async ({ req, res }) => json(res, 201, savedFilters.create(await body(req))),
    },
    {
      method: 'PATCH',
      path: /^\/api\/activity-filters\/([^/]+)$/,
      handler: async ({ req, res, params: [rawId] }) => json(res, 200, savedFilters.update(decodeParam(rawId), await body(req))),
    },
    {
      method: 'DELETE',
      path: /^\/api\/activity-filters\/([^/]+)$/,
      handler: ({ res, params: [rawId] }) => {
        savedFilters.remove(decodeParam(rawId));
        return json(res, 200, { ok: true } satisfies OkResponse);
      },
    },
    {
      method: 'GET',
      path: /^\/api\/events\/(.+)$/,
      handler: ({ res, url, params: [rawId] }) => {
        const id = decodeParam(rawId);
        const event = store.getEvent(id);
        if (!event || !enabledRepoIds().includes(event.repoId)) throw problem('Activity not found.', 404);
        return json(res, 200, {
          event,
          events: store.getEventGroup(id),
          related: store.relatedActivity(event, { ciOnly: url.searchParams.get('ci') === '1' }),
        } satisfies EventResponse);
      },
    },
    {
      method: 'POST',
      path: '/api/backfill',
      handler: async ({ req, res }) => {
        if (demo || !backfill) throw problem('Historical import is available in live mode.');
        const input = await body(req);
        const repo = repoById(input.repoId);
        const days = input.days;
        if (days !== 30 && days !== 90 && days !== 'all') throw problem('Choose 30 days, 90 days or all available history.');
        // Checked after the body arrives: the reset would delete the job this request creates.
        if (resetting) throw problem('Starting from scratch is in progress. Try again in a moment.', 409);
        return json(res, 202, backfill.start(repo.id, days) satisfies BackfillResponse);
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
        return json(res, 200, connection satisfies ConnectionResponse);
      },
    },
    {
      method: 'POST',
      path: '/api/discover',
      handler: async ({ req, res }) => {
        const input = await body(req);
        if (typeof input.path !== 'string' || !input.path.trim()) throw problem('Enter a local folder path.');
        return json(res, 200, (await discover(input.path)) satisfies DiscoverResponse);
      },
    },
    {
      method: 'POST',
      path: '/api/folders',
      handler: async ({ req, res }) => {
        const input = await body(req);
        return json(res, 200, (await browse(input.path)) satisfies FoldersResponse);
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
        let remote: import('./src/contract.d.ts').DiscoveredRemote & { localPath?: string };
        if (typeof input.url === 'string' && input.url.trim()) remote = parseRemote(input.url.trim());
        else if (typeof input.path === 'string' && input.path.trim()) {
          const result = await discover(input.path);
          const enteredPath = input.path.startsWith('~/') ? resolve(homedir(), input.path.slice(2)) : resolve(input.path);
          const checkout = result.repositories.find(repo => resolve(repo.localPath) === enteredPath);
          if (!checkout) throw problem('This folder is not an Azure Git checkout. Choose a repository folder.');
          const remotes = input.remote ? checkout.remotes.filter(item => item.name === input.remote) : checkout.remotes;
          const [only] = remotes;
          if (!only || remotes.length !== 1) throw problem('Choose the remote explicitly for a checkout with multiple Azure remotes.');
          remote = { ...parseRemote(only.url), localPath: checkout.localPath };
        } else throw problem('Enter an Azure repository URL or local checkout path.');
        const repo: import('./src/contract.d.ts').Repository = await provider.resolveRepository(remote);
        if (remote.localPath) repo.localPath = remote.localPath;
        const existing = store.listRepos().find(item => item.id === repo.id);
        store.saveRepo({ ...repo, disabled: existing?.disabled || false });
        sync.refresh([repo.id]);
        return json(res, 201, repo satisfies Repository);
      },
    },
    {
      method: 'GET',
      path: '/api/checkouts',
      handler: async ({ res }) => {
        const repos = store.listRepos().filter(repo => !repo.disabled);
        const results: [string, import('./src/contract.d.ts').CheckoutStatus][] = [];
        if (!demo)
          for (let i = 0; i < repos.length; i += 2) {
            results.push(
              ...(await Promise.all(
                repos
                  .slice(i, i + 2)
                  .map(async repo => [repo.id, await checkoutGit.status(repo)] as [string, import('./src/contract.d.ts').CheckoutStatus]),
              )),
            );
          }
        return json(res, 200, Object.fromEntries(results) satisfies CheckoutsResponse);
      },
    },
    {
      method: 'GET',
      path: /^\/api\/repos\/([^/]+)\/graph\/snapshot$/,
      handler: async ({ res, params: [rawId] }) => {
        const repo = enabledRepoById(decodeParam(rawId));
        if (demo) throw problem('Demo repositories have no local Git history.', 404);
        return json(res, 200, await checkoutGit.historySnapshot(repo));
      },
    },
    {
      method: 'GET',
      path: /^\/api\/repos\/([^/]+)\/graph$/,
      handler: async ({ res, url, params: [rawId] }) => {
        const repo = enabledRepoById(decodeParam(rawId));
        if (demo) throw problem('Demo repositories have no local Git history.', 404);
        const page = await checkoutGit.history(repo, url.searchParams.get('cursor'));
        const commits = new Map(page.commits.map(commit => [commit.id, commit]));
        for (const { sha, event } of store.commitActivity(repo.id, [...commits.keys()])) {
          if (event.kind === 'pr' || event.kind === 'build') {
            commits.get(sha)?.activity.push({
              id: event.id,
              kind: event.kind,
              time: event.time,
              title: event.title ?? '',
              status: activityLabel(event) ?? 'Updated',
            });
          }
        }
        return json(res, 200, page);
      },
    },
    {
      method: 'GET',
      path: /^\/api\/repos\/([^/]+)\/checkout\/branches$/,
      handler: async ({ res, params: [rawId] }) => {
        if (demo) throw problem('Demo checkouts have no local branches.', 403);
        const repo = enabledRepoById(decodeParam(rawId));
        const local = new Set(await checkoutGit.localBranches(repo));
        const pinned = [repo.defaultBranch?.slice(11), 'main', 'master'];
        const branches = store
          .listEntities(repo.id, 'ref')
          .filter(({ id, data }) => id.startsWith('refs/heads/') && id.length > 11 && data.active !== false)
          .map(({ id, data }) => ({ name: id.slice(11), pushId: Number(data.lastPushId) || 0 }))
          .sort(
            (a, b) =>
              Number(pinned.includes(b.name)) - Number(pinned.includes(a.name)) ||
              pinned.indexOf(a.name) - pinned.indexOf(b.name) ||
              b.pushId - a.pushId ||
              a.name.localeCompare(b.name),
          )
          .map(({ name }) => ({ name, local: local.has(name) }));
        return json(res, 200, { branches } satisfies CheckoutBranchesResponse);
      },
    },
    {
      method: 'GET',
      path: /^\/api\/repos\/([^/]+)\/checkout\/status$/,
      handler: async ({ res, url, params: [rawId] }) => {
        if (demo) throw problem('Demo checkouts have no local status.', 403);
        const repo = enabledRepoById(decodeParam(rawId));
        return json(
          res,
          200,
          (await checkoutGit.status(repo, { fresh: url.searchParams.get('fresh') === '1' })) satisfies CheckoutStatusResponse,
        );
      },
    },
    {
      method: 'POST',
      path: /^\/api\/repos\/([^/]+)\/checkout$/,
      handler: async ({ req, res, params: [rawId] }) => {
        if (demo) throw problem('Demo checkouts cannot be updated.', 403);
        const repo = enabledRepoById(decodeParam(rawId));
        const input = (await body(req)) || {};
        const { operation, expected } = input;
        if (operation === 'switch-activity' && isSwitchIntent(expected) && typeof input.eventId === 'string') {
          const event = store.getEvent(input.eventId);
          if (event?.repoId !== repo.id) throw problem('Activity not found for this repository.', 404);
          const branch = activityBranch(event);
          if (!branch) throw problem('This activity does not identify one branch to switch to.');
          return json(
            res,
            200,
            (await checkoutGit.switchToActivityBranch(repo, branch, expected, {
              eventId: input.eventId,
              confirmation: typeof input.confirmation === 'string' ? input.confirmation : undefined,
            })) satisfies CheckoutUpdateResponse,
          );
        }
        if (operation === 'switch-branch' && isSwitchIntent(expected) && typeof input.branch === 'string') {
          // Only a branch the watched repository still lists, like an event, may name the switch target.
          const ref = store.getEntity(repo.id, 'ref', `refs/heads/${input.branch}`);
          if (!ref || ref.active === false) throw problem('The repository no longer lists this branch.');
          return json(
            res,
            200,
            (await checkoutGit.switchToActivityBranch(repo, input.branch, expected, {
              confirmation: typeof input.confirmation === 'string' ? input.confirmation : undefined,
            })) satisfies CheckoutUpdateResponse,
          );
        }
        if (isBranchAction(input) && isCheckoutIntent(expected)) {
          return json(res, 200, (await checkoutGit.branchAction(repo, input, expected)) satisfies CheckoutUpdateResponse);
        }
        if ((operation !== 'check' && operation !== 'pull') || !isCheckoutIntent(expected)) {
          throw problem('Choose a checkout and Git action.');
        }
        return json(res, 200, (await checkoutGit.update(repo, operation, expected)) satisfies CheckoutUpdateResponse);
      },
    },
    {
      method: 'PATCH',
      path: /^\/api\/repos\/([^/]+)$/,
      handler: async ({ req, res, params: [rawId] }) => {
        const id = decodeParam(rawId);
        const repo = repoById(id);
        const input = await body(req);
        if (typeof input.disabled !== 'boolean') throw problem('disabled must be true or false.');
        store.saveRepo({ ...repo, disabled: input.disabled });
        if (!input.disabled) sync.refresh([id]);
        return json(res, 200, { ok: true } satisfies OkResponse);
      },
    },
    {
      method: 'DELETE',
      path: /^\/api\/repos\/([^/]+)$/,
      handler: ({ res, params: [rawId] }) => {
        const id = decodeParam(rawId);
        repoById(id);
        store.removeRepo(id);
        sync.forget?.(id);
        return json(res, 200, { ok: true } satisfies OkResponse);
      },
    },
    {
      method: 'POST',
      path: '/api/refresh',
      handler: async ({ req, res }) => {
        const input = await body(req);
        const { repoIds, retrySignIn } = input;
        if (repoIds !== undefined && !isStringList(repoIds)) throw problem('repoIds must be a list.');
        if (retrySignIn !== undefined && typeof retrySignIn !== 'boolean') throw problem('retrySignIn must be a boolean.');
        repoIds?.forEach(repoById);
        const status = retrySignIn ? sync.refresh(repoIds, true) : sync.refresh(repoIds);
        const history = retrySignIn
          ? backfill?.retrySignIn?.(
              store
                .listRepos()
                .filter(repo => !repo.disabled && (!repoIds || repoIds.includes(repo.id)))
                .map(repo => repo.id),
            )
          : undefined;
        const combined = history?.scheduled
          ? { scheduled: true }
          : history?.cooldown && !('demo' in status) && !status.scheduled
            ? { scheduled: false, cooldown: true }
            : status;
        return json(res, 202, { ok: true, status: combined } satisfies RefreshResponse);
      },
    },
    {
      method: 'POST',
      path: '/api/reset',
      handler: async ({ req, res }) => {
        await body(req);
        if (demo || !sync.reset) throw problem('Demo data cannot be cleared. Start live mode to start from scratch.', 403);
        // The reset waits for the turn in flight, which can sit behind Azure's Retry-After for minutes, so it runs unawaited.
        if (!resetting) resetFailed = false;
        resetting ??= sync
          .reset(() => store.resetActivity())
          .then(() => {
            sync.refresh();
          })
          .catch(error => {
            resetFailed = true;
            console.error('Start from scratch failed:', error.name);
          })
          .finally(() => {
            resetting = null;
          });
        return json(res, 202, { started: true } satisfies ResetResponse);
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
        const changedIds = store.acknowledge(ids, seen !== false);
        return json(res, 200, { ok: true, changedIds });
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
        return json(res, 200, { ok: true } satisfies OkResponse);
      },
    },
    // Only demo mode has this route; in live mode the path is a plain 404.
    ...(demo
      ? ([
          {
            method: 'POST',
            path: '/api/demo/event',
            handler: async ({ req, res }) => {
              await body(req);
              return json(res, 201, addDemoEvent(store) satisfies DemoEventResponse);
            },
          },
        ] as Route[])
      : []),
    {
      method: 'GET',
      path: /^\/api\/push\/([^/]+)\/(\d+)\/commits$/,
      handler: async ({ res, url, params: [rawId, pushId] }) => {
        const repo = enabledRepoById(decodeParam(rawId));
        if (!provider.pushCommits)
          return json(res, 200, {
            items: [],
            nextCursor: null,
            message: 'Open Azure DevOps for commit details.',
          } satisfies PushCommitsResponse);
        const skip = Number(url.searchParams.get('skip') || 0);
        if (!Number.isSafeInteger(skip) || skip < 0) throw problem('Invalid page offset.');
        const page = await provider.pushCommits(repo, Number(pushId), { skip });
        // The browser shows only these two fields; raw Azure commit objects stay behind this boundary.
        const items = page.items.map(item => ({
          commitId: typeof item?.commitId === 'string' ? item.commitId : '',
          ...(typeof item?.comment === 'string' ? { comment: item.comment } : {}),
        }));
        return json(res, 200, { items, nextCursor: page.nextCursor } satisfies PushCommitsResponse);
      },
    },
    {
      method: 'GET',
      path: /^\/api\/pr\/([^/]+)\/(\d+)\/review$/,
      handler: async ({ res, params: [rawId, pullRequestId] }) => {
        const repo = enabledRepoById(decodeParam(rawId));
        // The ID is digits only, which decoding leaves unchanged.
        return json(res, 200, (await provider.prReview(repo, decodeParam(pullRequestId))) satisfies PrReviewResponse);
      },
    },
  ];
  const handle = async (req: Request, res: Response) => {
    Object.entries(HEADERS).forEach(([key, value]) => res.setHeader(key, value));
    try {
      checkLocalRequest(req);
      const url = new URL(String(req.url), `http://${req.headers.host}`);
      const path = url.pathname;
      if (req.method === 'GET' && (await staticFile(path, res))) return;
      if (!path.startsWith('/api/')) return json(res, 404, { message: 'Not found.' } satisfies ErrorResponse);
      if (path === '/api/session' && req.method === 'POST') {
        if (!launch || !matches(req.headers['x-repo-pulse-launch'], launch))
          throw Object.assign(problem('This launch link was already used. Open the newest link printed in the terminal.', 401), {
            code: 'LAUNCH_USED',
          });
        launch = null;
        return json(res, 200, { key: accessKey } satisfies SessionResponse);
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
      return json(res, 404, { message: 'Not found.' } satisfies ErrorResponse);
    } catch (caught) {
      const error = caught as RequestError;
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
      return json(res, status, {
        message: status === 500 && !isCorruptRow(error) ? 'Something went wrong. Try again; cached data is kept.' : error.message,
        code: error.code,
      } satisfies ErrorResponse);
    }
  };
  // handle answers every failure itself; only a throw while writing that answer rejects, and Node's unhandled-rejection
  // handling then prints it and stops the server, as an async listener's rejection did before.
  return createServer((req, res) => void handle(req, res));
}

export async function startApp({
  demo = false,
  highlights = true,
  port = 0,
  dataDir = resolve(ROOT, '.repo-pulse'),
}: { demo?: boolean; highlights?: boolean; port?: number; dataDir?: string | undefined } = {}) {
  await secureDataDir(dataDir);
  const database = resolve(dataDir, demo ? 'demo.sqlite' : 'live.sqlite');
  const lock = await lockDatabase(database);
  // A start that fails after this point releases what it opened, so a retry in this process is not refused.
  let opened: { close(): void } | undefined;
  try {
    return await startLocked(database, dataDir, demo, highlights, port, lock, store => (opened = store));
  } catch (error) {
    opened?.close();
    lock.close();
    throw error;
  }
}

async function startLocked(
  database: string,
  dataDir: string,
  demo: boolean,
  highlights: boolean,
  port: number,
  lock: { close(): void },
  onOpen: (store: { close(): void }) => void,
) {
  // Earlier versions kept one key for good; every start now makes its own, so a key from a past run is useless.
  await rm(resolve(dataDir, 'access-key'), { force: true });
  const store = createStore(database, { highlights });
  onOpen(store);
  // Reads go over HTTPS with one CLI token, so the shared budget can be far above the 12 az starts per minute.
  if (!demo) useSystemNetworkSettings();
  const cli = demo
    ? null
    : createAzureCli({ executor: createRestExecutor({ cliExecutor: defaultExecutor }), limitPerMinute: 60, concurrency: 4 });
  // The live pieces are null in demo mode; keeping them separate lets each consumer see the concrete type.
  const azure = cli && createAzureClient({ cli });
  const provider = azure || demoProvider;
  let lastClientAt = 0;
  let backfill: ReturnType<typeof createBackfill> | undefined;
  const rewriteCheck = azure && createRewriteCheck({ store, provider: azure });
  const forkCheck = azure && createForkOriginCheck({ store, provider: azure });
  const defaultBranchLookups = new Set<string>();
  async function loadMissingDefaultBranch() {
    const repo = store
      .listRepos()
      .find(entry => !entry.disabled && entry.defaultBranch === undefined && !defaultBranchLookups.has(entry.id));
    if (!azure || !repo) return false;
    defaultBranchLookups.add(repo.id);
    try {
      const resolved = await azure.resolveRepository({ ...repo, project: repo.projectId || repo.project, repoName: repo.azureId });
      const current = store.listRepos().find(entry => entry.id === repo.id);
      if (resolved.id === repo.id && current && current.defaultBranch === undefined)
        store.saveRepo({ ...current, defaultBranch: resolved.defaultBranch });
    } catch {
      // Optional metadata. Leave an unsuccessful lookup eligible the next time the app starts.
    }
    return true;
  }
  const liveSync =
    azure &&
    createSync({
      store,
      provider: azure,
      isForeground: () => Date.now() - lastClientAt < 45_000,
      // Assigned below, before sync.start() can schedule any work.
      // Fork origin checks share the automatic-check turn and run when no rewrite check is due.
      background: {
        rewrite: async () => (await rewriteCheck?.tick()) || (await forkCheck?.tick()) || loadMissingDefaultBranch(),
        history: () => backfill?.tick(),
      },
    });
  const sync = (liveSync && {
    ...liveSync,
    reset: (clear: () => void) =>
      liveSync.reset(() => {
        clear();
        rewriteCheck?.reset();
        forkCheck?.reset();
        backfill?.reset();
      }),
    forget(repoId: string) {
      liveSync.forget(repoId);
      rewriteCheck?.forget(repoId);
      forkCheck?.forget(repoId);
      backfill?.forget(repoId);
    },
  }) || {
    start() {},
    stop() {},
    refresh(): { demo: true } {
      return { demo: true };
    },
    status(): DemoSyncStatus {
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
      const at = Date.now();
      const returned = at - lastClientAt >= 45_000;
      lastClientAt = at;
      if (returned && liveSync && !(Date.parse(cli?.diagnostics().throttledUntil ?? '') > at)) liveSync.checkOnForeground();
    },
  });
  await new Promise((resolveListen, reject) => {
    app.once('error', reject);
    app.listen(port, '127.0.0.1', () => resolveListen(undefined));
  });
  const closeListener = () => new Promise(resolveClose => app.close(resolveClose));
  try {
    sync.start();
  } catch (error) {
    await closeListener();
    throw error;
  }
  const close = async () => {
    const syncStopped = sync.stop();
    // Abort budget-queued CLI work before waiting for a sync that might be waiting on it.
    cli?.close();
    await syncStopped;
    await closeListener();
    store.close();
    lock.close();
  };
  const url = `http://127.0.0.1:${(app.address() as import('node:net').AddressInfo).port}`;
  return { app, store, sync, provider, close, url, dataDir, accessKey, launchUrl: `${url}/#launch=${launchToken}` };
}

/**
 * The data directory holds the database: it must belong to this account and be closed to others.
 */
async function secureDataDir(dataDir: string) {
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
  const runtime = await startApp({
    demo: process.argv.includes('--demo'),
    port,
    dataDir: process.env.REPO_PULSE_DATA_DIR || undefined,
  }).catch((error: unknown) => {
    if ((error as { code?: unknown }).code !== 'DATA_DIR_LOCKED') throw error;
    console.error((error as Error).message);
    return process.exit(1);
  });
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
  // A failed close reaches Node's unhandled-rejection handling, which prints it and exits with code 1.
  process.on('SIGINT', () => void stop());
  process.on('SIGTERM', () => void stop());
}
