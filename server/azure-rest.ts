import { setGlobalProxyFromEnv } from 'node:http';
import tls from 'node:tls';
import { classifyCliError, cliError, failure, type FailureCode } from './azure-cli.ts';
import { InvalidRoute, readUrl, type AzureRead } from './azure-reads.ts';
import { isRecord } from './azure-records.ts';
import type { Executor, ExecutorOptions, Reader } from './azure-cli.ts';

type CachedToken = { value: string; expiresAt: number };

/** The Microsoft Entra application ID of Azure DevOps, the audience of its access tokens. */
export const AZURE_DEVOPS_RESOURCE = '499b84ac-1321-427f-aa17-267ca6975798';
const RENEW_BEFORE_MS = 5 * 60000;
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;

/**
 * Node's fetch ignores HTTP(S)_PROXY and the operating system's certificate store unless told otherwise,
 * while az honours both, so REST reads would fail behind a corporate proxy or TLS inspection where az works.
 */
export function useSystemNetworkSettings(env = process.env) {
  // Python Requests accepts a proxy without a scheme; Node refuses one at startup.
  const proxyEnv = Object.fromEntries(
    Object.entries(env)
      .filter(([key]) => /^(https?|no)_proxy$/i.test(key))
      .map(([key, value]) => [key, /^no_proxy$/i.test(key) || !value || value.includes('://') ? value : `http://${value}`]),
  );
  setGlobalProxyFromEnv(proxyEnv);
  tls.setDefaultCACertificates([...new Set([...tls.getCACertificates('default'), ...tls.getCACertificates('system')])]);
}

/**
 * Retry-After in milliseconds from delta-seconds or an HTTP date; undefined when absent, unreadable or already past.
 */
function retryAfterMs(value: string | null, time: number) {
  const text = value?.trim() ?? '';
  const ms = /^\d+$/.test(text) ? Number(text) * 1000 : /[a-z]/i.test(text) ? Date.parse(text) - time : NaN;
  return ms > 0 ? ms : undefined;
}

/** The failure an HTTP status reports, by number. */
export function statusFailure(status: number): FailureCode {
  if (status === 401) return 'AUTH_REQUIRED';
  if (status === 403) return 'FORBIDDEN';
  if (status === 404) return 'NOT_FOUND';
  if (status === 429) return 'THROTTLED';
  if (status >= 500 && status <= 599) return 'UNAVAILABLE';
  return 'CLI_ERROR';
}

/**
 * The failure of a request or body read that got no HTTP answer: closed by the queue, timed out, or not reached.
 */
function transportError(error: unknown) {
  // Whatever fetch or the body stream threw.
  const name = (error as { name?: unknown } | null | undefined)?.name;
  if (name === 'AbortError') return failure('CLOSED');
  if (name === 'TimeoutError') return failure('TIMEOUT');
  return failure('UNAVAILABLE');
}

/**
 * Reads a JSON response up to `maxBytes` so REST reads match `defaultExecutor`'s 16 MiB cap.
 */
async function readJsonBody(response: Response, maxBytes: number) {
  const declared = Number(response.headers?.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel().catch(() => {});
    throw cliError('INVALID_RESPONSE', 'Azure DevOps returned an unexpectedly large response.');
  }
  if (!response.body) return response.json();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw cliError('INVALID_RESPONSE', 'Azure DevOps returned an unexpectedly large response.');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  // TextDecoder drops a UTF-8 BOM, as Response.json() did.
  return JSON.parse(new TextDecoder().decode(Buffer.concat(chunks, total)));
}

/**
 * Reader for createAzureCli that sends each typed Azure DevOps read over HTTPS with one Azure CLI token. The token
 * stays in this closure: it is never returned, logged or put in an error, and run() still refuses to request one.
 * Every failure leaves here already classified: an HTTP status by its number, a token az could not give by az's own
 * output, and a request that got no answer as closed, timed out or unavailable.
 */
export function createRestReader({
  cliExecutor,
  fetch = globalThis.fetch,
  now = Date.now,
}: {
  cliExecutor: Executor;
  fetch?: typeof globalThis.fetch;
  now?: () => number;
}): Reader {
  let token: CachedToken | undefined, renewal: Promise<string> | undefined;
  function accessToken(options: ExecutorOptions) {
    if (token && token.expiresAt - RENEW_BEFORE_MS > now()) return Promise.resolve(token.value);
    renewal ||= Promise.resolve()
      .then(() =>
        cliExecutor(['account', 'get-access-token', '--resource', AZURE_DEVOPS_RESOURCE], options).catch((error: unknown) => {
          throw classifyCliError(error as Parameters<typeof classifyCliError>[0]);
        }),
      )
      .then(stdout => {
        /** Untrusted CLI output; each field is checked below before use. */
        let parsed: unknown;
        try {
          parsed = typeof stdout === 'string' ? JSON.parse(stdout) : stdout;
        } catch {
          parsed = null;
        }
        const data = isRecord(parsed) ? parsed : {};
        const { expires_on: expiresOnSeconds, expiresOn, accessToken } = data;
        const expiresAt =
          typeof expiresOnSeconds === 'number' && Number.isFinite(expiresOnSeconds)
            ? expiresOnSeconds * 1000
            : typeof expiresOn === 'string'
              ? Date.parse(expiresOn)
              : NaN;
        if (typeof accessToken !== 'string' || !accessToken || !Number.isFinite(expiresAt)) throw failure('AUTH_REQUIRED');
        token = { value: accessToken, expiresAt };
        return token.value;
      })
      .finally(() => {
        renewal = undefined;
      });
    return renewal;
  }
  async function send(url: URL, options: ExecutorOptions, bearer: string) {
    const signal = AbortSignal.any([options.signal, AbortSignal.timeout(options.timeoutMs)].filter(Boolean));
    let response;
    try {
      response = await fetch(url, {
        method: 'GET',
        signal,
        redirect: 'error',
        // Without this header Azure DevOps answers a rejected token with a 302 to its sign-in page instead of a 401.
        headers: {
          authorization: `Bearer ${bearer}`,
          accept: 'application/json',
          'x-tfs-fedauthredirect': 'Suppress',
        },
      });
    } catch (error) {
      throw transportError(error);
    }
    // Measuring an HTTP-date from Azure's own Date keeps a skewed local clock from shortening or erasing the wait.
    const sent = Date.parse(response.headers.get('date') ?? '');
    const wait = retryAfterMs(response.headers.get('retry-after'), Number.isFinite(sent) ? sent : now());
    if (wait) options.retryAfter?.(wait);
    return response;
  }
  return async function restReader(read: AzureRead, options: ExecutorOptions): Promise<unknown> {
    let url;
    try {
      url = readUrl(read);
    } catch (error) {
      // A route value that is not one path segment is refused as an unsupported read; any other URL failure is generic.
      throw failure(error instanceof InvalidRoute ? 'CLI_SETUP' : 'CLI_ERROR');
    }
    // Only the rejected token is dropped; a token another request already renewed stays in use.
    const rejected = (response: Response, bearer: string) => {
      if (response.status === 401 && token?.value === bearer) token = undefined;
      return response.status === 401;
    };
    // The queue only holds back calls it has not started; another response can start a Retry-After pause while this
    // call waits for a token, so every send checks it and the caller's back-off retries instead.
    const unlessPaused = () => {
      if ((options.throttledUntil?.() ?? 0) > now()) throw failure('THROTTLED');
    };
    let bearer = await accessToken(options);
    unlessPaused();
    let response = await send(url, options, bearer);
    if (rejected(response, bearer)) {
      await response.body?.cancel().catch(() => {});
      unlessPaused();
      bearer = await accessToken(options);
      unlessPaused();
      response = await send(url, options, bearer);
      rejected(response, bearer);
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw failure(statusFailure(response.status));
    }
    let data;
    try {
      data = await readJsonBody(response, MAX_RESPONSE_BYTES);
    } catch (error) {
      if ((error as { code?: unknown })?.code === 'INVALID_RESPONSE') throw error;
      if (error instanceof SyntaxError) throw cliError('INVALID_RESPONSE', 'Azure DevOps returned an invalid JSON response.');
      throw transportError(error);
    }
    const continuation = response.headers.get('x-ms-continuationtoken');
    return continuation && data && typeof data === 'object' && !Array.isArray(data) ? { ...data, continuationToken: continuation } : data;
  };
}
