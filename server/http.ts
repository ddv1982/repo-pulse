import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, dirname, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { timingSafeEqual } from 'node:crypto';
import { AppError, forbidden, invalid, type ErrorKind } from './errors.ts';
import { ROUTES } from '../src/contract.ts';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ErrorResponse, RouteKey, RouteParams, RouteResponse, SessionResponse } from '../src/contract.ts';

/** A matched request: its decoded path parameters, its query, and for POST and PATCH its JSON object body. */
export type RouteRequest<K extends RouteKey> = { params: RouteParams<K>; query: URLSearchParams; body: Record<string, unknown> };
/** Each handler returns the response the route map names, so a handler and the browser read the same type. */
type Handler<K extends RouteKey> = (request: RouteRequest<K>) => RouteResponse<K> | Promise<RouteResponse<K>>;
export type Handlers = { [K in RouteKey]: Handler<K> };

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TYPES: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
const HEADERS = {
  'content-security-policy':
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'cache-control': 'no-store',
};

/** The HTTP status each kind of AppError answers with. Any other error is unexpected and answers 500. */
const STATUS: Record<ErrorKind, number> = {
  invalid: 400,
  unauthorized: 401,
  forbidden: 403,
  'not-found': 404,
  'method-not-allowed': 405,
  conflict: 409,
  'too-large': 413,
  'unsupported-media': 415,
  corrupt: 500,
  upstream: 502,
};

/** Every route group is required, so a matched route always supplies its parameters. */
function decodeParam(value: string | undefined) {
  if (value === undefined) throw invalid('Invalid request path.');
  try {
    return decodeURIComponent(value);
  } catch {
    throw invalid('Invalid request path.');
  }
}

/**
 * Parses a JSON object body. Its fields stay unknown until each route validates them.
 */
async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  if (!req.headers['content-type']?.startsWith('application/json')) throw new AppError('unsupported-media', 'Send application/json.');
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 64 * 1024) throw new AppError('too-large', 'Request is too large.');
    chunks.push(chunk);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString());
    if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error();
    return value;
  } catch {
    throw invalid('Expected a JSON object.');
  }
}

/** One route compiled from its key: the method, a pattern for the path, and how to run its handler. */
function compile<K extends RouteKey>(key: K, handler: Handler<K>, refuse: (key: RouteKey) => void) {
  const [method = '', path = ''] = key.split(' ');
  const names: string[] = [];
  const pattern = new RegExp(
    `^${path.replace(/:([A-Za-z]+)/g, (_, name: string) => {
      names.push(name);
      return '([^/]+)';
    })}$`,
  );
  const run = async (match: RegExpExecArray, req: IncomingMessage, query: URLSearchParams) => {
    // Every parameter is decoded before the body is read, so a malformed path is refused first.
    const params = Object.fromEntries(names.map((name, index) => [name, decodeParam(match[index + 1])])) as RouteParams<K>;
    // A route this mode cannot serve is refused before the body is read, so a missing body does not hide the reason.
    refuse(key);
    const body = method === 'POST' || method === 'PATCH' ? await readBody(req) : {};
    return handler({ params, query, body });
  };
  return { key, method, pattern, literal: names.length === 0, run };
}

/**
 * Matches a request to its route. The handlers must cover the route map exactly. Literal paths are tried before paths
 * with parameters, so GET /api/activity/unseen is not read as an activity ID.
 */
export function createRouter(handlers: Handlers, refuse: (key: RouteKey) => void = () => {}) {
  const keys = Object.keys(ROUTES) as RouteKey[];
  const missing = keys.filter(key => typeof handlers[key] !== 'function');
  const extra = Object.keys(handlers).filter(key => !Object.hasOwn(ROUTES, key));
  if (missing.length || extra.length)
    throw new Error(
      `The route handlers do not match the route map. Missing: ${missing.join(', ') || 'none'}. Not in the map: ${extra.join(', ') || 'none'}.`,
    );
  // Each key is compiled with its own handler; the mapped type pairs them, which a loop over the union cannot show.
  const routes = keys
    .map(key => compile(key, handlers[key] as Handler<typeof key>, refuse))
    .sort((a, b) => Number(b.literal) - Number(a.literal));
  return (method: string, path: string) => {
    for (const route of routes) {
      if (route.method !== method) continue;
      const match = route.pattern.exec(path);
      if (match) return { key: route.key, run: (req: IncomingMessage, query: URLSearchParams) => route.run(match, req, query) };
    }
    return undefined;
  };
}

function checkLocalRequest(req: IncomingMessage) {
  // Compare the actual bound port too: other localhost apps are different origins.
  const port = req.socket.localPort;
  const hosts = new Set([`localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`]);
  const host = req.headers.host;
  if (!host || !hosts.has(host)) throw forbidden('Open Repo Pulse through its localhost address.');
  if (req.headers.origin && req.headers.origin !== `http://${host}`) throw forbidden('Origin is not allowed.');
  // A top-level load of the app page from elsewhere, such as the launch page the browser opens from a file, is allowed;
  // nothing can frame or read it, and every API request still has to be same-site and carry the key.
  const pageLoad =
    req.method === 'GET' && req.headers['sec-fetch-mode'] === 'navigate' && new URL(String(req.url), 'http://local').pathname === '/';
  if (req.headers['sec-fetch-site'] === 'cross-site' && !pageLoad) throw forbidden('Cross-site requests are not allowed.');
}

async function staticFile(pathname: string, res: ServerResponse) {
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
 * Narrow loopback HTTP boundary: local-request checks, the access key and the single-use launch token, static files,
 * dispatch to the route handlers, and the one mapping from errors to statuses. Azure commands, sync and persistence
 * live in separate modules.
 */
export function createHttpServer({
  handlers,
  refuse,
  accessKey,
  launchToken,
}: {
  handlers: Handlers;
  /** Throws for a route this mode cannot serve. */
  refuse?: (key: RouteKey) => void;
  accessKey: string;
  launchToken?: string | undefined;
}) {
  if (typeof accessKey !== 'string' || accessKey.length < 32) throw new Error('createApp needs an access key of at least 32 characters.');
  const expectedKey = Buffer.from(accessKey);
  const router = createRouter(handlers, refuse);
  const matches = (value: string | string[] | undefined, expected: Buffer) => {
    const given = Buffer.from(Array.isArray(value) ? value.join(',') : (value ?? ''));
    return given.length === expected.length && timingSafeEqual(given, expected);
  };
  const hasAccessKey = (req: IncomingMessage) => matches(req.headers['x-repo-pulse-key'], expectedKey);
  // The launch link carries this token instead of the key. It works once, so a copied or recorded link is spent.
  let launch = launchToken ? Buffer.from(launchToken) : null;
  const json = (res: ServerResponse, status: number, data: unknown) =>
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' }).end(JSON.stringify(data));
  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    Object.entries(HEADERS).forEach(([key, value]) => res.setHeader(key, value));
    try {
      checkLocalRequest(req);
      const url = new URL(String(req.url), `http://${req.headers.host}`);
      const path = url.pathname;
      if (req.method === 'GET' && (await staticFile(path, res))) return;
      if (!path.startsWith('/api/')) return json(res, 404, { message: 'Not found.' } satisfies ErrorResponse);
      if (path === '/api/session' && req.method === 'POST') {
        if (!launch || !matches(req.headers['x-repo-pulse-launch'], launch))
          throw new AppError(
            'unauthorized',
            'This launch link was already used. Open the newest link printed in the terminal.',
            'LAUNCH_USED',
          );
        launch = null;
        return json(res, 200, { key: accessKey } satisfies SessionResponse);
      }
      // Every API request, reads included, carries the key. A browser on another origin cannot add the header.
      if (!hasAccessKey(req))
        throw new AppError(
          'unauthorized',
          'Open the newest link printed in the terminal where Repo Pulse runs. Each link works once; restart Repo Pulse for a new one.',
          'ACCESS_KEY',
        );
      if (!['GET', 'POST', 'PATCH', 'DELETE'].includes(req.method ?? '')) throw new AppError('method-not-allowed', 'Method not allowed.');
      const route = router(req.method ?? '', path);
      if (!route) return json(res, 404, { message: 'Not found.' } satisfies ErrorResponse);
      return json(res, ROUTES[route.key].status, await route.run(req, url.searchParams));
    } catch (caught) {
      // An AppError carries already-redacted, actionable text; unexpected errors stay local.
      const known = caught instanceof AppError ? caught : null;
      const status = known ? STATUS[known.kind] : 500;
      if (status === 500) console.error('Request failed:', (caught as Error | null)?.name);
      return json(res, status, {
        message: known?.message ?? 'Something went wrong. Try again; cached data is kept.',
        code: known?.code,
      } satisfies ErrorResponse);
    }
  };
  // handle answers every failure itself; only a throw while writing that answer rejects, and Node's unhandled-rejection
  // handling then prints it and stops the server, as an async listener's rejection did before.
  return createServer((req, res) => void handle(req, res));
}
