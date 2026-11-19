// @ts-check

import { setGlobalProxyFromEnv } from 'node:http';
import tls from 'node:tls';
import { normalizeOrganization } from './repositories.js';
import { cliError } from './azure-cli.js';

/**
 * @typedef {import('./azure-cli.js').Executor} Executor
 * @typedef {import('./azure-cli.js').ExecutorOptions} ExecutorOptions
 * @typedef {{ url: URL }} RestRequest
 * @typedef {{ value: string, expiresAt: number }} CachedToken
 */

/** The Microsoft Entra application ID of Azure DevOps, the audience of its access tokens. */
export const AZURE_DEVOPS_RESOURCE = '499b84ac-1321-427f-aa17-267ca6975798';
const RENEW_BEFORE_MS = 5 * 60000;
/** @param {string} message */
const refused = message => Object.assign(new Error(message), { stderr: 'not in the command group' });

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
/** @param {string[]} args */
function flags(args) {
  /** @type {Record<string, string[]>} */
  const values = {};
  /** @type {string | undefined} */
  let current;
  for (const arg of args) {
    if (arg.startsWith('--')) {
      if (Object.hasOwn(values, arg)) throw refused('Repeated Azure CLI flag.');
      values[(current = arg)] = [];
    } else if (current) values[current].push(arg);
  }
  return values;
}

/** @param {string[]} [entries] */
const pairs = (entries = []) =>
  Object.fromEntries(
    entries.map(entry => {
      const split = entry.indexOf('=');
      return [entry.slice(0, split), entry.slice(split + 1)];
    }),
  );

/** A route value must be one non-empty path segment; `.` and `..` would make URL parsing move up the path. */
/** @param {unknown} value */
function segment(value) {
  if (typeof value !== 'string' || !value || value === '.' || value === '..') throw refused('Invalid Azure DevOps route.');
  return encodeURIComponent(value);
}

/**
 * @param {string[]} args
 * @returns {RestRequest}
 */
function requestFor(args) {
  const values = flags(args);
  const organization = normalizeOrganization(values['--organization']?.[0]);
  const area = values['--area']?.[0],
    resource = values['--resource']?.[0]?.toLowerCase();
  const route = pairs(values['--route-parameters']);
  if (values['--http-method']?.[0] !== 'GET' || values['--in-file']) throw refused('Only Azure DevOps reads are allowed.');
  let path;
  if (area === 'git' && resource === 'pullrequestthreads') {
    path = `${segment(route.project)}/_apis/git/repositories/${segment(route.repositoryId)}/pullRequests/${segment(route.pullRequestId)}/threads`;
  } else if (area === 'git' && ['pushes', 'refs', 'pullrequests', 'commits'].includes(resource)) {
    path = `${segment(route.project)}/_apis/git/repositories/${segment(route.repositoryId)}/${resource}${route.commitId !== undefined ? `/${segment(route.commitId)}` : ''}`;
  } else if (area === 'build' && resource === 'builds') path = `${segment(route.project)}/_apis/build/builds`;
  else if (area === 'policy' && resource === 'evaluations') path = `${segment(route.project)}/_apis/policy/evaluations`;
  else if (area === 'location' && resource === 'connectiondata') path = '_apis/connectionData';
  else throw refused('Unsupported Azure DevOps read.');
  const url = new URL(`${organization}/${path}`);
  for (const [key, value] of Object.entries(pairs(values['--query-parameters']))) url.searchParams.set(key, value);
  url.searchParams.set('api-version', values['--api-version']?.[0]);
  return { url };
}

/**
 * Retry-After in milliseconds from delta-seconds or an HTTP date; undefined when absent, unreadable or already past.
 * @param {string | null} value
 * @param {number} time
 */
function retryAfterMs(value, time) {
  const text = value?.trim() ?? '';
  const ms = /^\d+$/.test(text) ? Number(text) * 1000 : /[a-z]/i.test(text) ? Date.parse(text) - time : NaN;
  return ms > 0 ? ms : undefined;
}

/**
 * Maps a failed request or body read onto the errors classifyCliError understands.
 * @param {unknown} error
 */
function transportError(error) {
  // Whatever fetch or the body stream threw.
  const name = /** @type {{ name?: unknown } | null | undefined} */ (error)?.name;
  if (name === 'AbortError') return error;
  if (name === 'TimeoutError') return Object.assign(new Error('Azure DevOps timed out.'), { code: 'ETIMEDOUT' });
  return Object.assign(new Error('Azure DevOps could not be reached.'), { stderr: 'connection failed' });
}

/**
 * Executor for createAzureCli that sends `devops invoke` reads over HTTPS with one Azure CLI token
 * instead of starting az for each read. Other commands still run through az. The token stays in this
 * closure: it is never returned, logged or put in an error, and run() still refuses to request one.
 * @param {{ cliExecutor: Executor, fetch?: typeof globalThis.fetch, now?: () => number }} options
 */
export function createRestExecutor({ cliExecutor, fetch = globalThis.fetch, now = Date.now }) {
  /** @type {CachedToken | undefined} */
  let token,
    /** @type {Promise<string> | undefined} */
    renewal;
  /** @param {ExecutorOptions} options */
  function accessToken(options) {
    if (token && token.expiresAt - RENEW_BEFORE_MS > now()) return Promise.resolve(token.value);
    renewal ||= Promise.resolve()
      .then(() => cliExecutor(['account', 'get-access-token', '--resource', AZURE_DEVOPS_RESOURCE], options))
      .then(stdout => {
        /** @type {any} Untrusted CLI output; each field is checked below before use. */
        let data;
        try {
          data = typeof stdout === 'string' ? JSON.parse(stdout) : stdout;
        } catch {
          data = null;
        }
        const expiresAt = Number.isFinite(data?.expires_on)
          ? data.expires_on * 1000
          : typeof data?.expiresOn === 'string'
            ? Date.parse(data.expiresOn)
            : NaN;
        if (typeof data?.accessToken !== 'string' || !data.accessToken || !Number.isFinite(expiresAt)) {
          throw Object.assign(new Error('Azure CLI did not return a usable token.'), { stderr: 'authentication unavailable' });
        }
        token = { value: data.accessToken, expiresAt };
        return token.value;
      })
      .finally(() => {
        renewal = undefined;
      });
    return renewal;
  }
  /**
   * @param {RestRequest} request
   * @param {ExecutorOptions} options
   * @param {string} bearer
   */
  async function send(request, options, bearer) {
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
  /**
   * @param {string[]} args
   * @param {ExecutorOptions} options
   * @returns {Promise<unknown>}
   */
  return async function restExecutor(args, options) {
    if (args[0] !== 'devops' || args[1] !== 'invoke') return cliExecutor(args, options);
    const request = requestFor(args);
    // Only the rejected token is dropped; a token another request already renewed stays in use.
    /**
     * @param {Response} response
     * @param {string} bearer
     */
    const rejected = (response, bearer) => {
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
      data = await response.json();
    } catch (error) {
      if (error instanceof SyntaxError) throw cliError('INVALID_RESPONSE', 'Azure DevOps returned an invalid JSON response.');
      throw transportError(error);
    }
    const continuation = response.headers.get('x-ms-continuationtoken');
    return continuation && data && typeof data === 'object' && !Array.isArray(data) ? { ...data, continuationToken: continuation } : data;
  };
}
