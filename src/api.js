// @ts-check

/** @typedef {import('../server.js').StateResponse} StateResponse */
/** @typedef {import('../server.js').ActivityResponse} ActivityResponse */
/** @typedef {import('../server.js').EventResponse} EventResponse */
/** @typedef {import('../server.js').CheckoutsResponse} CheckoutsResponse */
/** @typedef {import('../server.js').CheckoutUpdateResponse} CheckoutUpdateResponse */
/** @typedef {import('../server.js').ConnectionResponse} ConnectionResponse */
/** @typedef {import('../server.js').PushCommitsResponse} PushCommitsResponse */
/** @typedef {import('../server.js').PrReviewResponse} PrReviewResponse */
/** @typedef {import('../server.js').ErrorResponse} ErrorResponse */
/** @typedef {import('../server.js').OkResponse} OkResponse */
/** @typedef {import('../server.js').DiscoverResponse} DiscoverResponse */
/** @typedef {import('../server.js').FoldersResponse} FoldersResponse */

/**
 * The response body for a request path, matched on the path's shape. More specific shapes come first.
 * @template {string} P
 * @typedef {P extends '/api/state' ? StateResponse
 *   : P extends '/api/activity' | `/api/activity?${string}` ? ActivityResponse
 *   : P extends `/api/activity/unseen?${string}` ? {ids: string[]}
 *   : P extends '/api/activity-filters' ? import('../server/saved-activity-filters.js').SavedActivityFilter
 *   : P extends `/api/activity-filters/${string}` ? import('../server/saved-activity-filters.js').SavedActivityFilter | OkResponse
 *   : P extends `/api/events/${string}` ? EventResponse
 *   : P extends '/api/checkouts' ? CheckoutsResponse
 *   : P extends `/api/repos/${string}/checkout/branches` ? import('../server.js').CheckoutBranchesResponse
 *   : P extends `/api/repos/${string}/checkout/status` ? import('../server.js').CheckoutStatusResponse
 *   : P extends `/api/repos/${string}/checkout` ? CheckoutUpdateResponse
 *   : P extends '/api/repos' ? import('../server.js').Repository
 *   : P extends `/api/repos/${string}` ? OkResponse
 *   : P extends '/api/connection' | `/api/connection?${string}` ? ConnectionResponse
 *   : P extends `/api/push/${string}/${string}/commits` | `/api/push/${string}/${string}/commits?${string}` ? PushCommitsResponse
 *   : P extends `/api/pr/${string}/${string}/review` ? PrReviewResponse
 *   : P extends '/api/backfill' ? import('../server.js').BackfillResponse
 *   : P extends '/api/refresh' ? import('../server.js').RefreshResponse
 *   : P extends '/api/reset' ? import('../server.js').ResetResponse
 *   : P extends '/api/discover' ? DiscoverResponse
 *   : P extends '/api/folders' ? FoldersResponse
 *   : P extends '/api/demo/event' ? import('../server.js').DemoEventResponse
 *   : P extends '/api/ack' ? OkResponse & {changedIds: string[]}
 *   : P extends '/api/settings' ? OkResponse
 *   : unknown} ResponseFor
 */
/** @typedef {{ method?: 'GET'|'POST'|'PATCH'|'DELETE', body?: Record<string, unknown> }} RequestOptions */

const KEY_STORAGE = 'repo-pulse-access-key';

/** @returns {string} */
function storedKey() {
  try {
    return localStorage.getItem(KEY_STORAGE) ?? '';
  } catch {
    return '';
  }
}

/**
 * Exchanges the single-use token from the launch link for this run's key, and clears it from the address bar.
 * The key is stored only when the exchange works, so a stale or forged link cannot replace a working key.
 * @returns {Promise<string>}
 */
async function readAccessKey() {
  const token = /^#launch=([A-Za-z0-9_-]+)$/.exec(location.hash)?.[1];
  if (!token) return storedKey();
  history.replaceState(history.state, '', location.pathname + location.search);
  try {
    const response = await fetch('/api/session', {
      method: 'POST',
      headers: { 'X-Repo-Pulse-Launch': token },
      signal: AbortSignal.timeout(10000),
    });
    /** @type {{ key?: unknown }} */
    const body = response.ok ? await response.json() : {};
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

/**
 * @template {string} P
 * @param {P} path
 * @param {RequestOptions} [options]
 * @returns {Promise<ResponseFor<P>>}
 */
export async function request(path, { method = 'GET', body } = {}) {
  const response = await fetch(path, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      'X-Repo-Pulse-Key': accessKey,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(45000),
  });
  // The body is the route's JSON; ResponseFor names its type, and an error status carries an ErrorResponse.
  /** @type {any} */
  let value;
  try {
    value = await response.json();
  } catch {
    throw new Error(`The local app returned an unreadable response (${response.status}).`);
  }
  if (!response.ok) {
    throw Object.assign(
      new Error(
        value.message || value.error?.message || (typeof value.error === 'string' ? value.error : `Request failed (${response.status}).`),
      ),
      { code: value.code },
    );
  }
  return value;
}
