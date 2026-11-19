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
 *   : P extends `/api/events/${string}` ? EventResponse
 *   : P extends '/api/checkouts' ? CheckoutsResponse
 *   : P extends `/api/repos/${string}/checkout` ? CheckoutUpdateResponse
 *   : P extends '/api/repos' ? import('../server.js').Repository
 *   : P extends `/api/repos/${string}` ? OkResponse
 *   : P extends '/api/connection' | `/api/connection?${string}` ? ConnectionResponse
 *   : P extends `/api/push/${string}/${string}/commits` | `/api/push/${string}/${string}/commits?${string}` ? PushCommitsResponse
 *   : P extends `/api/pr/${string}/${string}/review` ? PrReviewResponse
 *   : P extends '/api/backfill' ? import('../server.js').BackfillResponse
 *   : P extends '/api/refresh' ? import('../server.js').RefreshResponse
 *   : P extends '/api/discover' ? DiscoverResponse
 *   : P extends '/api/folders' ? FoldersResponse
 *   : P extends '/api/demo/event' ? import('../server.js').DemoEventResponse
 *   : P extends '/api/ack' | '/api/settings' ? OkResponse
 *   : unknown} ResponseFor
 */
/** @typedef {{ method?: 'GET'|'POST'|'PATCH'|'DELETE', body?: Record<string, unknown> }} RequestOptions */

const KEY_STORAGE = 'repo-pulse-access-key';

/** Takes the key from the launch link once, keeps it for later visits and removes it from the address bar. */
function readAccessKey() {
  const url = new URL(location.href);
  const fromLink = url.searchParams.get('key');
  if (fromLink) {
    url.searchParams.delete('key');
    history.replaceState(history.state, '', url.pathname + url.search + url.hash);
    try {
      localStorage.setItem(KEY_STORAGE, fromLink);
    } catch {
      /* Without storage the key still works until the page is closed. */
    }
    return fromLink;
  }
  try {
    return localStorage.getItem(KEY_STORAGE) ?? '';
  } catch {
    return '';
  }
}

const accessKey = readAccessKey();

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
  if (!response.ok)
    throw new Error(
      value.message || value.error?.message || (typeof value.error === 'string' ? value.error : `Request failed (${response.status}).`),
    );
  return value;
}
