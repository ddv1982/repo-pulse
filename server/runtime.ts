import { mkdir, chmod, rm, stat } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { createSavedActivityFilters } from './saved-activity-filters.ts';
import { createStore, type Store } from './store.ts';
import { lockDatabase } from './database-lock.ts';
import { createSync } from './sync.ts';
import { createAzureCli, defaultExecutor } from './azure-cli.ts';
import { createRestReader, useSystemNetworkSettings } from './azure-rest.ts';
import { createAzureClient } from './azure-client.ts';
import { discoverRepositories } from './repositories.ts';
import { seedDemo, demoProvider, demoSync, NOT_IN_DEMO } from './demo.ts';
import { notFound, notInDemo } from './errors.ts';
import { createBackfill } from './backfill.ts';
import { createRewriteCheck } from './rewrite-check.ts';
import { createForkOriginCheck } from './fork-origin.ts';
import { createCheckoutLookup } from './checkout-advice.ts';
import { createCheckoutGit } from './checkout-git.ts';
import { browseFolders } from './folders.ts';
import { createHttpServer, type Handlers } from './http.ts';
import { createReset, type AppContext, type AppProvider, type AppSync } from './routes/context.ts';
import { activityRoutes } from './routes/activity.ts';
import { filterRoutes } from './routes/filters.ts';
import { repositoryRoutes } from './routes/repositories.ts';
import { checkoutRoutes } from './routes/checkout.ts';
import { historyRoutes } from './routes/history.ts';
import { stateRoutes } from './routes/state.ts';
import type { FoldersResponse, RouteKey } from '../src/contract.ts';

export type AppOptions = {
  store: Store;
  provider: AppProvider;
  sync: AppSync;
  cli?: AppContext['cli'];
  backfill?: AppContext['backfill'];
  demo?: boolean;
  discover?: typeof discoverRepositories;
  browse?: (input: unknown) => Promise<FoldersResponse>;
  checkoutGit?: ReturnType<typeof createCheckoutGit>;
  onStateRead?: () => void;
  accessKey: string;
  launchToken?: string;
};

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** The checkout adapter on the app's store, which keeps follow-up plans and observations in its settings. */
function storeCheckoutGit(store: Store, provider: AppProvider) {
  return createCheckoutGit({
    findPulls: createCheckoutLookup({
      cached: store.completedCheckoutPulls,
      lookup: provider.completedCheckoutPulls,
    }),
    followups: { get: store.getCheckoutFollowup, save: store.saveCheckoutFollowup },
    observations: { get: store.getCheckoutObservation, save: store.saveCheckoutObservation },
  });
}

/** Refuses each route demo mode cannot serve, and the demo-only route in live mode. */
function refuseFor(demo: boolean) {
  return (key: RouteKey) => {
    if (demo && Object.hasOwn(NOT_IN_DEMO, key)) throw notInDemo(NOT_IN_DEMO[key as keyof typeof NOT_IN_DEMO]);
    // Live mode answers 404, as for a path no route matches.
    if (!demo && key === 'POST /api/demo/event') throw notFound('Demo activity can be added only in demo mode.');
  };
}

/** The loopback app: every route group on one store, behind the HTTP boundary in server/http.ts. */
export function createApp({
  store,
  provider,
  sync,
  cli,
  backfill,
  demo = false,
  discover = discoverRepositories,
  browse = browseFolders,
  checkoutGit = storeCheckoutGit(store, provider),
  onStateRead = () => {},
  accessKey,
  launchToken,
}: AppOptions) {
  const app: AppContext = {
    store,
    provider,
    sync,
    cli,
    backfill,
    demo,
    discover,
    browse,
    checkoutGit,
    savedFilters: createSavedActivityFilters(store),
    onStateRead,
    startedAt: Date.now(),
    reset: createReset(store, sync),
  };
  const handlers: Handlers = {
    ...stateRoutes(app),
    ...activityRoutes(app),
    ...filterRoutes(app),
    ...repositoryRoutes(app),
    ...checkoutRoutes(app),
    ...historyRoutes(app),
  };
  return createHttpServer({
    handlers,
    refuse: refuseFor(demo),
    accessKey,
    launchToken,
  });
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
    : createAzureCli({
        executor: defaultExecutor,
        reader: createRestReader({ cliExecutor: defaultExecutor }),
        limitPerMinute: 60,
        concurrency: 4,
      });
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
  const sync =
    (liveSync && {
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
    }) ||
    demoSync;
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
