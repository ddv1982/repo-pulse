import { readFile } from 'node:fs/promises';
import { normalizeOrganization } from './repositories.js';

/** The Microsoft Entra application ID of Azure DevOps, the audience of its access tokens. */
export const AZURE_DEVOPS_RESOURCE = '499b84ac-1321-427f-aa17-267ca6975798';
const RENEW_BEFORE_MS = 5 * 60000;

/** Collects `--flag value...` groups from CLI arguments the queue has already validated. */
function flags(args) {
  const values = {};
  let current;
  for (const arg of args) {
    if (arg.startsWith('--')) values[current = arg] = [];
    else if (current) values[current].push(arg);
  }
  return values;
}

const pairs = (entries = []) => Object.fromEntries(entries.map(entry => {
  const split = entry.indexOf('=');
  return [entry.slice(0, split), entry.slice(split + 1)];
}));

function requestUrl(args) {
  const values = flags(args);
  const organization = normalizeOrganization(values['--organization']?.[0]);
  const area = values['--area']?.[0], resource = values['--resource']?.[0]?.toLowerCase();
  const route = pairs(values['--route-parameters']);
  const part = value => encodeURIComponent(value);
  let path;
  if (area === 'git') path = `${part(route.project)}/_apis/git/repositories/${part(route.repositoryId)}/${resource}${route.commitId ? `/${part(route.commitId)}` : ''}`;
  else if (area === 'build' && resource === 'builds') path = `${part(route.project)}/_apis/build/builds`;
  else if (area === 'location' && resource === 'connectiondata') path = '_apis/connectionData';
  else throw Object.assign(new Error('Unsupported Azure DevOps read.'), { stderr: 'not in the command group' });
  const url = new URL(`${organization}/${path}`);
  for (const [key, value] of Object.entries(pairs(values['--query-parameters']))) url.searchParams.set(key, value);
  url.searchParams.set('api-version', values['--api-version']?.[0]);
  return { url, method: values['--http-method']?.[0], inFile: values['--in-file']?.[0] };
}

/**
 * Executor for createAzureCli that sends `devops invoke` reads over HTTPS with one Azure CLI token
 * instead of starting az for each read. Other commands still run through az. The token stays in this
 * closure: it is never returned, logged or put in an error, and run() still refuses to request one.
 */
export function createRestExecutor({ cliExecutor, fetch = globalThis.fetch, now = Date.now } = {}) {
  let token;
  async function accessToken(options) {
    if (token && token.expiresAt - RENEW_BEFORE_MS > now()) return token.value;
    token ||= {};
    token.pending ||= cliExecutor(['account', 'get-access-token', '--resource', AZURE_DEVOPS_RESOURCE], options).then(stdout => {
      const data = typeof stdout === 'string' ? JSON.parse(stdout) : stdout;
      const expiresAt = Number.isFinite(data.expires_on) ? data.expires_on * 1000 : Date.parse(data.expiresOn);
      if (typeof data.accessToken !== 'string' || !data.accessToken || !Number.isFinite(expiresAt)) {
        throw Object.assign(new Error('Azure CLI did not return a usable token.'), { stderr: 'authentication unavailable' });
      }
      token = { value: data.accessToken, expiresAt };
      return token.value;
    }, error => { token = undefined; throw error; });
    return token.pending;
  }
  async function send(request, body, options) {
    const signal = AbortSignal.any([options.signal, AbortSignal.timeout(options.timeoutMs)].filter(Boolean));
    const authorization = `Bearer ${await accessToken(options)}`;
    let response;
    try {
      response = await fetch(request.url, { method: request.method, signal, redirect: 'error', body,
        headers: { authorization, accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) } });
    } catch (error) {
      if (error?.name === 'AbortError') throw error;
      if (error?.name === 'TimeoutError') throw Object.assign(new Error('Azure DevOps timed out.'), { code: 'ETIMEDOUT' });
      throw Object.assign(new Error('Azure DevOps could not be reached.'), { stderr: 'connection failed' });
    }
    return response;
  }
  return async function restExecutor(args, options) {
    if (args[0] !== 'devops' || args[1] !== 'invoke') return cliExecutor(args, options);
    const request = requestUrl(args);
    const body = request.inFile ? await readFile(request.inFile, 'utf8') : undefined;
    let response = await send(request, body, options);
    if (response.status === 401) {
      token = undefined;
      response = await send(request, body, options);
    }
    if (!response.ok) {
      throw Object.assign(new Error(`Azure DevOps returned HTTP ${response.status}.`), { stderr: `HTTP ${response.status}` });
    }
    const data = await response.json();
    const continuation = response.headers.get('x-ms-continuationtoken');
    return continuation && data && typeof data === 'object' && !Array.isArray(data) ? { ...data, continuationToken: continuation } : data;
  };
}
