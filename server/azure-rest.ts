import { setGlobalProxyFromEnv } from 'node:http';
import tls from 'node:tls';
import { normalizeOrganization } from './repositories.ts';
import { cliError } from './azure-cli.ts';
import { isRecord } from './azure-records.ts';
import type { Executor, ExecutorOptions } from './azure-cli.ts';

export type { Executor, ExecutorOptions };

export type RestRequest = { url: URL };

export type CachedToken = { value: string; expiresAt: number };

/** The Microsoft Entra application ID of Azure DevOps, the audience of its access tokens. */
export const AZURE_DEVOPS_RESOURCE = '499b84ac-1321-427f-aa17-267ca6975798';
const RENEW_BEFORE_MS = 5 * 60000;
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const refused = (message: string) => Object.assign(new Error(message), { stderr: 'not in the command group' });

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

/** Collects `--flag value...` groups. A repeated flag is refused, so this agrees with the allowlist, which reads the first one. */
function flags(args: string[]) {
  const values: Record<string, string[]> = {};
  let current: string[] | undefined;
  for (const arg of args) {
    if (arg.startsWith('--')) {
      if (Object.hasOwn(values, arg)) throw refused('Repeated Azure CLI flag.');
      values[arg] = current = [];
    } else if (current) current.push(arg);
  }
  return values;
}

const pairs = (entries: string[] = []) =>
  Object.fromEntries(
    entries.map(entry => {
      const split = entry.indexOf('=');
      return [entry.slice(0, split), entry.slice(split + 1)];
    }),
  );

/** A route value must be one non-empty path segment; `.` and `..` would make URL parsing move up the path. */
function segment(value: unknown) {
  if (typeof value !== 'string' || !value || value === '.' || value === '..') throw refused('Invalid Azure DevOps route.');
  return encodeURIComponent(value);
}

function requestFor(args: string[]): RestRequest {
  const values = flags(args);
  const organization = normalizeOrganization(values['--organization']?.[0]);
  const area = values['--area']?.[0],
    resource = values['--resource']?.[0]?.toLowerCase();
  const route = pairs(values['--route-parameters']);
  if (values['--http-method']?.[0] !== 'GET' || values['--in-file']) throw refused('Only Azure DevOps reads are allowed.');
  let path;
  if (area === 'git' && resource === 'pullrequestthreads') {
    path = `${segment(route.project)}/_apis/git/repositories/${segment(route.repositoryId)}/pullRequests/${segment(route.pullRequestId)}/threads`;
  } else if (area === 'git' && resource !== undefined && ['pushes', 'refs', 'pullrequests', 'commits'].includes(resource)) {
    path = `${segment(route.project)}/_apis/git/repositories/${segment(route.repositoryId)}/${resource}${route.commitId !== undefined ? `/${segment(route.commitId)}` : ''}`;
  } else if (area === 'build' && resource === 'builds') path = `${segment(route.project)}/_apis/build/builds`;
  else if (area === 'policy' && resource === 'evaluations') path = `${segment(route.project)}/_apis/policy/evaluations`;
  else if (area === 'location' && resource === 'connectiondata') path = '_apis/connectionData';
  else throw refused('Unsupported Azure DevOps read.');
  const url = new URL(`${organization}/${path}`);
  for (const [key, value] of Object.entries(pairs(values['--query-parameters']))) url.searchParams.set(key, value);
  // The allowlist requires --api-version; one with no value is refused rather than sent as "undefined".
  const apiVersion = values['--api-version']?.[0];
  if (apiVersion === undefined) throw refused('Unsupported Azure DevOps read.');
  url.searchParams.set('api-version', apiVersion);
  return { url };
}

/**
 * Retry-After in milliseconds from delta-seconds or an HTTP date; undefined when absent, unreadable or already past.
 */
function retryAfterMs(value: string | null, time: number) {
  const text = value?.trim() ?? '';
  const ms = /^\d+$/.test(text) ? Number(text) * 1000 : /[a-z]/i.test(text) ? Date.parse(text) - time : NaN;
  return ms > 0 ? ms : undefined;
}

/**
 * Maps a failed request or body read onto the errors classifyCliError understands.
 */
function transportError(error: unknown) {
  // Whatever fetch or the body stream threw.
  const name = (error as { name?: unknown } | null | undefined)?.name;
  if (name === 'AbortError') return error;
  if (name === 'TimeoutError') return Object.assign(new Error('Azure DevOps timed out.'), { code: 'ETIMEDOUT' });
  return Object.assign(new Error('Azure DevOps could not be reached.'), { stderr: 'connection failed' });
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
 * Executor for createAzureCli that sends `devops invoke` reads over HTTPS with one Azure CLI token
 * instead of starting az for each read. Other commands still run through az. The token stays in this
 * closure: it is never returned, logged or put in an error, and run() still refuses to request one.
 */
export function createRestExecutor({
  cliExecutor,
  fetch = globalThis.fetch,
  now = Date.now,
}: {
  cliExecutor: Executor;
  fetch?: typeof globalThis.fetch;
  now?: () => number;
}) {
  let token: CachedToken | undefined, renewal: Promise<string> | undefined;
  function accessToken(options: ExecutorOptions) {
    if (token && token.expiresAt - RENEW_BEFORE_MS > now()) return Promise.resolve(token.value);
    renewal ||= Promise.resolve()
      .then(() => cliExecutor(['account', 'get-access-token', '--resource', AZURE_DEVOPS_RESOURCE], options))
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
        if (typeof accessToken !== 'string' || !accessToken || !Number.isFinite(expiresAt)) {
          throw Object.assign(new Error('Azure CLI did not return a usable token.'), { stderr: 'authentication unavailable' });
        }
        token = { value: accessToken, expiresAt };
        return token.value;
      })
      .finally(() => {
        renewal = undefined;
      });
    return renewal;
  }
  async function send(request: RestRequest, options: ExecutorOptions, bearer: string) {
    const signal = AbortSignal.any([options.signal, AbortSignal.timeout(options.timeoutMs)].filter(Boolean));
    let response;
    try {
      response = await fetch(request.url, {
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
  return async function restExecutor(args: string[], options: ExecutorOptions): Promise<unknown> {
    if (args[0] !== 'devops' || args[1] !== 'invoke') return cliExecutor(args, options);
    const request = requestFor(args);
    // Only the rejected token is dropped; a token another request already renewed stays in use.
    const rejected = (response: Response, bearer: string) => {
      if (response.status === 401 && token?.value === bearer) token = undefined;
      return response.status === 401;
    };
    // The queue only holds back calls it has not started; another response can start a Retry-After pause while this
    // call waits for a token, so every send checks it and the caller's back-off retries instead.
    const unlessPaused = () => {
      if ((options.throttledUntil?.() ?? 0) > now())
        throw Object.assign(new Error('Azure DevOps asked us to slow down.'), { stderr: 'HTTP 429' });
    };
    let bearer = await accessToken(options);
    unlessPaused();
    let response = await send(request, options, bearer);
    if (rejected(response, bearer)) {
      await response.body?.cancel().catch(() => {});
      unlessPaused();
      bearer = await accessToken(options);
      unlessPaused();
      response = await send(request, options, bearer);
      rejected(response, bearer);
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw Object.assign(new Error(`Azure DevOps returned HTTP ${response.status}.`), { stderr: `HTTP ${response.status}` });
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
