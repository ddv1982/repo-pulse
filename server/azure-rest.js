import { readFile } from 'node:fs/promises';
import { normalizeOrganization } from './repositories.js';
import { cliError } from './azure-cli.js';

/** The Microsoft Entra application ID of Azure DevOps, the audience of its access tokens. */
export const AZURE_DEVOPS_RESOURCE = '499b84ac-1321-427f-aa17-267ca6975798';
const RENEW_BEFORE_MS = 5 * 60000;
const READ_QUERIES = new Set(['commitsbatch', 'pullrequestquery']);
const refused = message => Object.assign(new Error(message), { stderr: 'not in the command group' });

/** Collects `--flag value...` groups. A repeated flag is refused, so this agrees with the allowlist, which reads the first one. */
function flags(args) {
  const values = {};
  let current;
  for (const arg of args) {
    if (arg.startsWith('--')) {
      if (Object.hasOwn(values, arg)) throw refused('Repeated Azure CLI flag.');
      values[current = arg] = [];
    } else if (current) values[current].push(arg);
  }
  return values;
}

const pairs = (entries = []) => Object.fromEntries(entries.map(entry => {
  const split = entry.indexOf('=');
  return [entry.slice(0, split), entry.slice(split + 1)];
}));

/** A route value must be one non-empty path segment; `.` and `..` would make URL parsing move up the path. */
function segment(value) {
  if (typeof value !== 'string' || !value || value === '.' || value === '..') throw refused('Invalid Azure DevOps route.');
  return encodeURIComponent(value);
}

function requestFor(args) {
  const values = flags(args);
  const organization = normalizeOrganization(values['--organization']?.[0]);
  const area = values['--area']?.[0], resource = values['--resource']?.[0]?.toLowerCase();
  const method = values['--http-method']?.[0], inFile = values['--in-file']?.[0];
  const route = pairs(values['--route-parameters']);
  const readQuery = area === 'git' && READ_QUERIES.has(resource);
  if (readQuery ? method !== 'POST' || !inFile : method !== 'GET' || inFile) throw refused('Only Azure DevOps reads are allowed.');
  let path;
  if (area === 'git' && ['pushes', 'refs', 'pullrequests', 'commits', ...READ_QUERIES].includes(resource)) {
    path = `${segment(route.project)}/_apis/git/repositories/${segment(route.repositoryId)}/${resource}${route.commitId !== undefined ? `/${segment(route.commitId)}` : ''}`;
  } else if (area === 'build' && resource === 'builds') path = `${segment(route.project)}/_apis/build/builds`;
  else if (area === 'location' && resource === 'connectiondata') path = '_apis/connectionData';
  else throw refused('Unsupported Azure DevOps read.');
  const url = new URL(`${organization}/${path}`);
  for (const [key, value] of Object.entries(pairs(values['--query-parameters']))) url.searchParams.set(key, value);
  url.searchParams.set('api-version', values['--api-version']?.[0]);
  return { url, method, inFile };
}

/** Maps a failed request or body read onto the errors classifyCliError understands. */
function transportError(error) {
  if (error?.name === 'AbortError') return error;
  if (error?.name === 'TimeoutError') return Object.assign(new Error('Azure DevOps timed out.'), { code: 'ETIMEDOUT' });
  return Object.assign(new Error('Azure DevOps could not be reached.'), { stderr: 'connection failed' });
}

/**
 * Executor for createAzureCli that sends `devops invoke` reads over HTTPS with one Azure CLI token
 * instead of starting az for each read. Other commands still run through az. The token stays in this
 * closure: it is never returned, logged or put in an error, and run() still refuses to request one.
 */
export function createRestExecutor({ cliExecutor, fetch = globalThis.fetch, now = Date.now } = {}) {
  let token, renewal;
  function accessToken(options) {
    if (token && token.expiresAt - RENEW_BEFORE_MS > now()) return Promise.resolve(token.value);
    renewal ||= Promise.resolve()
      .then(() => cliExecutor(['account', 'get-access-token', '--resource', AZURE_DEVOPS_RESOURCE], options))
      .then(stdout => {
        let data;
        try { data = typeof stdout === 'string' ? JSON.parse(stdout) : stdout; } catch { data = null; }
        const expiresAt = Number.isFinite(data?.expires_on) ? data.expires_on * 1000 : Date.parse(data?.expiresOn);
        if (typeof data?.accessToken !== 'string' || !data.accessToken || !Number.isFinite(expiresAt)) {
          throw Object.assign(new Error('Azure CLI did not return a usable token.'), { stderr: 'authentication unavailable' });
        }
        token = { value: data.accessToken, expiresAt };
        return token.value;
      })
      .finally(() => { renewal = undefined; });
    return renewal;
  }
  async function send(request, body, options, bearer) {
    const signal = AbortSignal.any([options.signal, AbortSignal.timeout(options.timeoutMs)].filter(Boolean));
    try {
      return await fetch(request.url, { method: request.method, signal, redirect: 'error', body,
        headers: { authorization: `Bearer ${bearer}`, accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) } });
    } catch (error) {
      throw transportError(error);
    }
  }
  return async function restExecutor(args, options) {
    if (args[0] !== 'devops' || args[1] !== 'invoke') return cliExecutor(args, options);
    const request = requestFor(args);
    const body = request.inFile ? await readFile(request.inFile, 'utf8') : undefined;
    let bearer = await accessToken(options);
    let response = await send(request, body, options, bearer);
    if (response.status === 401) {
      // Only the rejected token is dropped; a token another request already renewed stays in use.
      if (token?.value === bearer) token = undefined;
      bearer = await accessToken(options);
      response = await send(request, body, options, bearer);
    }
    if (!response.ok) {
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
