import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { resolve, dirname, extname, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { createStore } from './server/store.js';
import { createSync } from './server/sync.js';
import { createAzureCli } from './server/azure-cli.js';
import { createAzureClient } from './server/azure-client.js';
import { discoverRepositories, parseRemote } from './server/repositories.js';
import { seedDemo, addDemoEvent, demoProvider } from './server/demo.js';
import { createEnrichment } from './server/enrichment.js';
import { createBackfill } from './server/backfill.js';
import { createCheckoutLookup } from './server/checkout-advice.js';
import { isBranchAction } from './server/checkout-branches.js';
import { createCheckoutGit, isCheckoutIntent } from './server/checkout-git.js';
import { browseFolders } from './server/folders.js';

const ROOT = dirname(fileURLToPath(import.meta.url));
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
const HEADERS = {
  'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'cache-control': 'no-store',
};

function problem(message, status = 400) {
  return Object.assign(new Error(message), { status });
}

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
  } catch { throw problem('Expected a JSON object.'); }
}

function checkLocalRequest(req) {
  // Compare the actual bound port too: other localhost apps are different origins.
  const port = req.socket.localPort;
  const hosts = new Set([`localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`]);
  const host = req.headers.host;
  if (!hosts.has(host)) throw problem('Open Repo Pulse through its localhost address.', 403);
  if (req.headers.origin && req.headers.origin !== `http://${host}`) throw problem('Origin is not allowed.', 403);
  if (req.headers['sec-fetch-site'] === 'cross-site') throw problem('Cross-site requests are not allowed.', 403);
}

async function staticFile(pathname, res) {
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
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

/** Narrow loopback HTTP boundary. Azure commands, sync and persistence live in separate modules. */
export function createApp({ store, provider, sync, cli, backfill, demo = false, discover = discoverRepositories, browse = browseFolders,
  checkoutGit = createCheckoutGit({ journal: store.pullJournal,
    findPulls: createCheckoutLookup({ cached: store.completedCheckoutPulls, lookup: provider.completedCheckoutPulls }),
    followups: { get: id => store.getSetting(`checkout-followup:${id}`), save: (id, value) => store.setSetting(`checkout-followup:${id}`, value) },
    observations: { get: id => store.getSetting(`checkout:${id}`), save: (id, value) => store.setSetting(`checkout:${id}`, value) },
  }), onStateRead = () => {} }) {
  const csrfToken = randomBytes(32).toString('hex');
  const json = (res, status, data) => res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' }).end(JSON.stringify(data));
  const repoById = id => {
    const repo = store.listRepos().find(item => item.id === id);
    if (!repo) throw problem('Repository is not watched.', 404);
    return repo;
  };
  const enabledRepoById = id => {
    const repo = repoById(id);
    if (repo.disabled) throw problem('Repository is disabled. Enable it on Repositories first.', 409);
    return repo;
  };
  const enabledRepoIds = () => store.listRepos().filter(repo => !repo.disabled).map(repo => repo.id);
  return createServer(async (req, res) => {
    Object.entries(HEADERS).forEach(([key, value]) => res.setHeader(key, value));
    try {
      checkLocalRequest(req);
      const url = new URL(req.url, `http://${req.headers.host}`);
      const path = url.pathname;
      if (req.method === 'GET' && await staticFile(path, res)) return;
      if (!path.startsWith('/api/')) return json(res, 404, { message: 'Not found.' });
      if (!['GET', 'POST', 'PATCH', 'DELETE'].includes(req.method)) throw problem('Method not allowed.', 405);
      if (req.method !== 'GET' && req.headers['x-repo-pulse-token'] !== csrfToken) throw problem('Reload the page before making changes.', 403);
      if (req.method === 'GET' && path === '/api/state') {
        onStateRead();
        return json(res, 200, {
          repos: store.listRepos(), streams: store.getStreams(),
          diagnostics: { ...(cli?.diagnostics() || {}), sync: sync.status() },
          jobs: store.listJobs({ type: 'backfill' }), mergeQueue: store.mergeQueueSummary(), activityRevision: store.activityRevision(),
          settings: { refreshEnabled: store.getSetting('refreshEnabled', true), refreshResumedAt: store.getSetting('refreshResumedAt', null) }, demo, csrfToken,
        });
      }
      if (req.method === 'GET' && path === '/api/activity') {
        const query = url.searchParams;
        let cursor;
        try { cursor = query.get('cursor') || undefined; }
        catch { throw problem('Invalid activity cursor.'); }
        const view = query.get('view') || 'all';
        if (!['new', 'all'].includes(view)) throw problem('Invalid activity view.');
        const requested = query.has('repoIds') ? query.get('repoIds').split(',').filter(Boolean) : undefined;
        requested?.forEach(repoById);
        const enabled = enabledRepoIds();
        const repoIds = (requested || enabled).filter(id => enabled.includes(id));
        const limit = Number(query.get('limit') || 50);
        if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw problem('Choose a page size from 1 to 200.');
        const result = store.queryActivity({ repoIds, view, kind: query.get('kind') || '', search: (query.get('search') || '').slice(0, 300), limit, cursor });
        return json(res, 200, result);
      }
      const eventRoute = path.match(/^\/api\/events\/(.+)$/);
      if (req.method === 'GET' && eventRoute) {
        const id = decodeURIComponent(eventRoute[1]);
        const event = store.getEvent(id);
        if (!event || !enabledRepoIds().includes(event.repoId)) throw problem('Activity not found.', 404);
        return json(res, 200, { event, events: store.getEventGroup(id) });
      }
      if (req.method === 'POST' && path === '/api/backfill') {
        if (demo || !backfill) throw problem('Historical import is available in live mode.');
        const input = await body(req);
        repoById(input.repoId);
        if (![30, 90, 'all'].includes(input.days)) throw problem('Choose 30 days, 90 days or all available history.');
        return json(res, 202, backfill.start(input.repoId, input.days));
      }
      if (req.method === 'GET' && path === '/api/connection') {
        const org = url.searchParams.get('organization') || undefined;
        if (org && !/^https:\/\/dev\.azure\.com\/[A-Za-z0-9_.-]+\/?$/.test(org)) throw problem('Use https://dev.azure.com/your-organization.');
        const repoId = url.searchParams.get('repoId');
        return json(res, 200, await provider.checkConnection(org, repoId === null ? undefined : enabledRepoById(repoId)));
      }
      if (req.method === 'POST' && path === '/api/discover') {
        const input = await body(req);
        if (typeof input.path !== 'string' || !input.path.trim()) throw problem('Enter a local folder path.');
        return json(res, 200, await discover(input.path));
      }
      if (req.method === 'POST' && path === '/api/folders') {
        const input = await body(req);
        return json(res, 200, await browse(input.path));
      }
      if (req.method === 'POST' && path === '/api/repos') {
        if (demo) throw problem('Demo repositories are fictional. Start live mode to add your repositories.');
        const input = await body(req);
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
        const repo = await provider.resolveRepository(remote);
        if (remote.localPath) repo.localPath = remote.localPath;
        const existing = store.listRepos().find(item => item.id === repo.id);
        store.saveRepo({ ...repo, disabled: existing?.disabled || false });
        sync.refresh([repo.id]);
        return json(res, 201, repo);
      }
      if (req.method === 'GET' && path === '/api/checkouts') {
        const repos = store.listRepos().filter(repo => !repo.disabled);
        const results = [];
        if (!demo) for (let i = 0; i < repos.length; i += 2) {
          results.push(...await Promise.all(repos.slice(i, i + 2).map(async repo => [repo.id, await checkoutGit.status(repo)])));
        }
        return json(res, 200, Object.fromEntries(results));
      }
      const checkoutRoute = path.match(/^\/api\/repos\/([^/]+)\/checkout$/);
      if (req.method === 'POST' && checkoutRoute) {
        if (demo) throw problem('Demo checkouts cannot be updated.', 403);
        const repo = enabledRepoById(decodeURIComponent(checkoutRoute[1]));
        const input = await body(req) || {};
        const { operation, expected } = input;
        if (isBranchAction(input) && isCheckoutIntent(expected)) {
          return json(res, 200, await checkoutGit.branchAction(repo, input, expected));
        }
        if ((operation !== 'check' && operation !== 'pull') || !isCheckoutIntent(expected)) {
          throw problem('Choose a checkout and Git action.');
        }
        return json(res, 200, await checkoutGit.update(repo, operation, expected));
      }
      const repoRoute = path.match(/^\/api\/repos\/([^/]+)$/);
      if (repoRoute && req.method === 'PATCH') {
        const id = decodeURIComponent(repoRoute[1]);
        const repo = repoById(id);
        const input = await body(req);
        if (typeof input.disabled !== 'boolean') throw problem('disabled must be true or false.');
        store.saveRepo({ ...repo, disabled: input.disabled });
        if (!input.disabled) sync.refresh([id]);
        return json(res, 200, { ok: true });
      }
      if (repoRoute && req.method === 'DELETE') {
        const id = decodeURIComponent(repoRoute[1]);
        repoById(id);
        store.removeRepo(id);
        return json(res, 200, { ok: true });
      }
      if (req.method === 'POST' && path === '/api/refresh') {
        const input = await body(req);
        if (input.repoIds !== undefined && (!Array.isArray(input.repoIds) || input.repoIds.some(id => typeof id !== 'string'))) throw problem('repoIds must be a list.');
        input.repoIds?.forEach(repoById);
        return json(res, 202, { ok: true, status: sync.refresh(input.repoIds) });
      }
      if (req.method === 'POST' && path === '/api/ack') {
        const input = await body(req);
        if (!Array.isArray(input.ids) || input.ids.length > 1000 || input.ids.some(id => typeof id !== 'string')) throw problem('Send up to 1000 explicit event IDs.');
        if (input.seen !== undefined && typeof input.seen !== 'boolean') throw problem('seen must be true or false.');
        store.acknowledge(input.ids, input.seen !== false);
        return json(res, 200, { ok: true });
      }
      if (req.method === 'POST' && path === '/api/settings') {
        const input = await body(req);
        if (typeof input.refreshEnabled !== 'boolean') throw problem('refreshEnabled must be true or false.');
        if (input.refreshEnabled && store.getSetting('refreshEnabled', true) === false) {
          store.setSetting('refreshResumedAt', Date.now());
        }
        store.setSetting('refreshEnabled', input.refreshEnabled);
        return json(res, 200, { ok: true });
      }
      if (req.method === 'POST' && path === '/api/demo/event' && demo) {
        await body(req);
        return json(res, 201, addDemoEvent(store));
      }
      const commitsRoute = path.match(/^\/api\/push\/([^/]+)\/(\d+)\/commits$/);
      if (req.method === 'GET' && commitsRoute) {
        const repo = enabledRepoById(decodeURIComponent(commitsRoute[1]));
        if (!provider.pushCommits) return json(res, 200, { items: [], nextCursor: null, message: 'Open Azure DevOps for commit details.' });
        const skip = Number(url.searchParams.get('skip') || 0);
        if (!Number.isSafeInteger(skip) || skip < 0) throw problem('Invalid page offset.');
        return json(res, 200, await provider.pushCommits(repo, Number(commitsRoute[2]), { skip }));
      }
      return json(res, 404, { message: 'Not found.' });
    } catch (error) {
      // Adapter errors carry already-redacted, actionable text; unexpected errors stay local.
      const status = error.status || (error.code === 'NOT_FOUND' ? 404 : error.code === 'BAD_REQUEST' ? 400 : error.code ? 502 : 500);
      if (status === 500) console.error('Request failed:', error.name);
      return json(res, status, { message: status === 500 ? 'Something went wrong. Try again; cached data is kept.' : error.message, code: error.code });
    }
  });
}

export async function startApp({ demo = false, port = 4317, dataDir = resolve(ROOT, '.repo-pulse') } = {}) {
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const store = createStore(resolve(dataDir, demo ? 'demo.sqlite' : 'live.sqlite'));
  const cli = demo ? null : createAzureCli();
  const provider = demo ? demoProvider : createAzureClient({ cli });
  let lastClientAt = 0;
  let enrichment, backfill;
  const sync = demo ? { start() {}, stop() {}, refresh() { return { demo: true }; }, status() { return { demo: true, running: false }; } } : createSync({
    store, provider, isForeground: () => Date.now() - lastClientAt < 45_000,
    onPrCompleted: (repo, data) => enrichment.reconcilePr(repo, data),
    background: { merge: () => enrichment.tick(), history: () => backfill.tick() },
  });
  if (demo) seedDemo(store);
  else {
    enrichment = createEnrichment({ store, provider });
    backfill = createBackfill({ store, provider, normalize: sync.normalize });
  }
  const app = createApp({ store, provider, sync, cli, backfill, demo, onStateRead: () => { lastClientAt = Date.now(); } });
  await new Promise((resolveListen, reject) => { app.once('error', reject); app.listen(port, '127.0.0.1', resolveListen); });
  sync.start();
  const close = async () => {
    const syncStopped = sync.stop();
    // Abort budget-queued CLI work before waiting for a sync that might be waiting on it.
    await cli?.close();
    await syncStopped;
    await new Promise(resolveClose => app.close(resolveClose));
    store.close();
  };
  return { app, store, sync, provider, close, url: `http://127.0.0.1:${app.address().port}` };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const port = Number(process.env.PORT || 4317);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('PORT must be an integer from 0 to 65535.');
  const runtime = await startApp({ demo: process.argv.includes('--demo'), port, dataDir: process.env.REPO_PULSE_DATA_DIR || undefined });
  console.log(`Repo Pulse${process.argv.includes('--demo') ? ' · demo data, no Azure calls' : ''}: ${runtime.url}`);
  console.log('Local only. Stop with Ctrl+C.');
  let closing = false;
  const stop = async () => { if (!closing) { closing = true; await runtime.close(); } };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
