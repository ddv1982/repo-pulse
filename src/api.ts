export type StateResponse = import('./contract.ts').StateResponse;
export type ActivityResponse = import('./contract.ts').ActivityResponse;
export type EventResponse = import('./contract.ts').EventResponse;
export type CheckoutsResponse = import('./contract.ts').CheckoutsResponse;
export type CheckoutUpdateResponse = import('./contract.ts').CheckoutUpdateResponse;
export type ConnectionResponse = import('./contract.ts').ConnectionResponse;
export type PushCommitsResponse = import('./contract.ts').PushCommitsResponse;
export type PrReviewResponse = import('./contract.ts').PrReviewResponse;
export type ErrorResponse = import('./contract.ts').ErrorResponse;
export type OkResponse = import('./contract.ts').OkResponse;
export type DiscoverResponse = import('./contract.ts').DiscoverResponse;
export type FoldersResponse = import('./contract.ts').FoldersResponse;

/**
 * The response body for a request path, matched on the path's shape. More specific shapes come first.
 */
export type ResponseFor<P extends string> = P extends '/api/state'
  ? StateResponse
  : P extends '/api/activity' | `/api/activity?${string}`
    ? ActivityResponse
    : P extends `/api/activity/unseen?${string}`
      ? { ids: string[] }
      : P extends '/api/activity-filters'
        ? import('./contract.ts').SavedActivityFilter
        : P extends `/api/activity-filters/${string}`
          ? import('./contract.ts').SavedActivityFilter | OkResponse
          : P extends `/api/events/${string}`
            ? EventResponse
            : P extends '/api/checkouts'
              ? CheckoutsResponse
              : P extends `/api/repos/${string}/checkout/branches`
                ? import('./contract.ts').CheckoutBranchesResponse
                : P extends `/api/repos/${string}/checkout/status`
                  ? import('./contract.ts').CheckoutStatusResponse
                  : P extends `/api/repos/${string}/checkout`
                    ? CheckoutUpdateResponse
                    : P extends '/api/repos'
                      ? import('./contract.ts').Repository
                      : P extends `/api/repos/${string}`
                        ? OkResponse
                        : P extends '/api/connection' | `/api/connection?${string}`
                          ? ConnectionResponse
                          : P extends `/api/push/${string}/${string}/commits` | `/api/push/${string}/${string}/commits?${string}`
                            ? PushCommitsResponse
                            : P extends `/api/pr/${string}/${string}/review`
                              ? PrReviewResponse
                              : P extends '/api/backfill'
                                ? import('./contract.ts').BackfillResponse
                                : P extends '/api/refresh'
                                  ? import('./contract.ts').RefreshResponse
                                  : P extends '/api/reset'
                                    ? import('./contract.ts').ResetResponse
                                    : P extends '/api/discover'
                                      ? DiscoverResponse
                                      : P extends '/api/folders'
                                        ? FoldersResponse
                                        : P extends '/api/demo/event'
                                          ? import('./contract.ts').DemoEventResponse
                                          : P extends '/api/ack'
                                            ? OkResponse & { changedIds: string[] }
                                            : P extends '/api/settings'
                                              ? OkResponse
                                              : unknown;
export type RequestOptions = { method?: 'GET' | 'POST' | 'PATCH' | 'DELETE'; body?: Record<string, unknown> };

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

export async function request<P extends string>(path: P, { method = 'GET', body }: RequestOptions = {}): Promise<ResponseFor<P>> {
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
  let value: any;
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
