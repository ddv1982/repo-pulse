import { routeUrl, type RouteTarget } from './route-url.ts';
import type { RouteBody, RouteKey, RouteParams, RouteQuery, RouteResponse } from './contract.ts';

/** A route's path parameters, query and body, each required only when the route has them. */
type RequestInput<K extends RouteKey> = ([keyof RouteParams<K>] extends [never] ? {} : { params: RouteParams<K> }) &
  ([keyof RouteQuery<K>] extends [never] ? {} : { query?: RouteQuery<K> | URLSearchParams }) &
  (RouteBody<K> extends undefined ? {} : { body: RouteBody<K> });

const KEY_STORAGE = 'repo-pulse-access-key';

function storedKey(): string {
  try {
    return localStorage.getItem(KEY_STORAGE) ?? '';
  } catch {
    return '';
  }
}

/**
 * Exchanges the single-use token from the launch link for this run's key, and clears it from the address bar.
 * The key is stored only when the exchange works, so a stale or forged link cannot replace a working key.
 */
async function readAccessKey(): Promise<string> {
  const token = /^#launch=([A-Za-z0-9_-]+)$/.exec(location.hash)?.[1];
  if (!token) return storedKey();
  history.replaceState(history.state, '', location.pathname + location.search);
  try {
    const response = await fetch('/api/session', {
      method: 'POST',
      headers: { 'X-Repo-Pulse-Launch': token },
      signal: AbortSignal.timeout(10000),
    });
    const body: { key?: unknown } = response.ok ? await response.json() : {};
    if (typeof body.key !== 'string' || !body.key) return storedKey();
    try {
      localStorage.setItem(KEY_STORAGE, body.key);
    } catch {
      /* Without storage the key still works until the page is closed. */
    }
    return body.key;
  } catch {
    return storedKey();
  }
}

const accessKey = await readAccessKey();

// A new launch link opened in a tab that already shows Repo Pulse changes only the fragment, so this module would not run
// again. Reload instead, before the hash router sees it.
window.addEventListener('hashchange', event => {
  if (!location.hash.startsWith('#launch=')) return;
  event.stopImmediatePropagation();
  location.reload();
});

export async function request<K extends RouteKey>(
  route: K,
  ...[input]: {} extends RequestInput<K> ? [input?: RequestInput<K>] : [input: RequestInput<K>]
): Promise<RouteResponse<K>> {
  const given: RouteTarget & { body?: unknown } = input ?? {};
  const { method, url } = routeUrl(route, given);
  const body = given.body;
  const response = await fetch(url, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      'X-Repo-Pulse-Key': accessKey,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(45000),
  });
  // The body is the route's JSON, typed by the route map in src/contract.ts; an error status carries an ErrorResponse.
  let value: unknown;
  try {
    value = await response.json();
  } catch {
    throw new Error(`The local app returned an unreadable response (${response.status}).`);
  }
  if (!response.ok) {
    const body: Partial<Record<string, unknown>> = typeof value === 'object' && value !== null ? value : {};
    const message = typeof body.message === 'string' && body.message ? body.message : `Request failed (${response.status}).`;
    throw Object.assign(new Error(message), { code: body.code });
  }
  // The server registers each route from the same map and checks each handler's return type against it; validating
  // the body at runtime is not done.
  return value as RouteResponse<K>;
}
