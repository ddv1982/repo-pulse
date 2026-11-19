import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { stat, readdir, realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { homedir } from 'node:os';

/** @typedef {ReturnType<typeof parseRemote>} ParsedRemote */
/** A Git remote keeps the parsed Azure identity, but `name` is the remote's name and `repoName` the Azure repository. */
/** @typedef {ParsedRemote} DiscoveredRemote */
/** @typedef {{ localPath: string, remotes: DiscoveredRemote[] }} DiscoveredCheckout */
/** @typedef {{ repositories: DiscoveredCheckout[], warnings: string[] }} Discovery */

const exec = promisify(execFile);
const invalid = () => Object.assign(new Error('Use an Azure DevOps Services HTTPS or SSH repository URL.'), { code: 'INVALID_REPOSITORY' });
/** @param {string} value */
const component = value => {
  let decoded;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    throw invalid();
  }
  if (!decoded || /[\x00-\x1f/\\?#]/.test(decoded) || decoded === '.' || decoded === '..' || /^[-@]/.test(decoded)) throw invalid();
  return decoded;
};

/** @param {unknown} value Anything that is not an Azure DevOps organization URL is refused. */
export function normalizeOrganization(value) {
  let url;
  try {
    url = new URL(String(value));
  } catch {
    throw invalid();
  }
  const parts = url.pathname.split('/').filter(Boolean);
  if (url.protocol !== 'https:' || url.port || url.search || url.hash || url.username || url.password) throw invalid();
  if (url.hostname.toLowerCase() === 'dev.azure.com' && parts.length === 1)
    return `https://dev.azure.com/${encodeURIComponent(component(parts[0]).toLowerCase())}`;
  const legacy = url.hostname.match(/^([a-z0-9][a-z0-9-]*)\.visualstudio\.com$/i);
  if (legacy && (!parts.length || (parts.length === 1 && parts[0].toLowerCase() === 'defaultcollection')))
    return `https://dev.azure.com/${legacy[1].toLowerCase()}`;
  throw invalid();
}

/** @param {unknown} value */
export function parseRemote(value) {
  if (typeof value !== 'string' || value.length > 4096 || /[\x00-\x1f]/.test(value)) throw invalid();
  let organization, project, name;
  const ssh = value.match(/^(?:[^@/:]+@)?(?:ssh\.dev\.azure\.com|vs-ssh\.visualstudio\.com):v3\/([^/]+)\/([^/]+)\/([^/]+)\/?$/i);
  if (ssh) [, organization, project, name] = ssh;
  else {
    let url;
    try {
      url = new URL(value);
    } catch {
      throw invalid();
    }
    if (!['https:', 'ssh:'].includes(url.protocol) || url.port || url.search || url.hash) throw invalid();
    // Git would receive the URL on its command line, where other local users can read it.
    if (url.password)
      throw Object.assign(new Error('Remove the password from this remote URL and let a Git credential helper sign in.'), {
        code: 'REMOTE_PASSWORD',
      });
    const parts = url.pathname.split('/').filter(Boolean);
    const host = url.hostname.toLowerCase();
    if (
      ['ssh.dev.azure.com', 'vs-ssh.visualstudio.com'].includes(host) &&
      url.protocol === 'ssh:' &&
      parts.length === 4 &&
      parts[0] === 'v3'
    )
      [, organization, project, name] = parts;
    else if (host === 'dev.azure.com' && url.protocol === 'https:' && parts.length === 4 && parts[2] === '_git')
      [organization, project, , name] = parts;
    else {
      const legacy = host.match(/^([a-z0-9][a-z0-9-]*)\.visualstudio\.com$/i);
      if (!legacy || url.protocol !== 'https:') throw invalid();
      organization = legacy[1];
      if (parts[0]?.toLowerCase() === 'defaultcollection') parts.shift();
      if (parts.length !== 3 || parts[1] !== '_git') throw invalid();
      [project, , name] = parts;
    }
  }
  organization = `https://dev.azure.com/${encodeURIComponent(component(organization).toLowerCase())}`;
  project = component(project);
  name = component(name);
  return {
    organization,
    project,
    name,
    repoName: name,
    url: `${organization}/${encodeURIComponent(project)}/_git/${encodeURIComponent(name)}`,
  };
}

/** @param {unknown} organization @param {unknown} azureId */
export function repositoryKey(organization, azureId) {
  return createHash('sha256')
    .update(`${normalizeOrganization(organization)}\0${String(azureId).toLowerCase()}`)
    .digest('hex')
    .slice(0, 24);
}

/** Explicit bounded discovery; Git reads worktree/linked configs without fetching. */
/** @param {unknown} inputPath @returns {Promise<Discovery>} */
export async function discoverRepositories(inputPath) {
  if (typeof inputPath !== 'string' || !inputPath.trim() || inputPath.includes('\0'))
    throw new Error('Choose a local checkout or its parent folder.');
  const path = resolve(inputPath.startsWith('~/') ? `${homedir()}/${inputPath.slice(2)}` : inputPath);
  if (!(await stat(path)).isDirectory()) throw new Error('Choose a folder.');
  /** @type {Discovery} */
  const result = { repositories: [], warnings: [] };
  /** @param {string} localPath */
  async function readCheckout(localPath) {
    try {
      const { stdout } = await exec('git', ['-C', localPath, 'rev-parse', '--show-toplevel'], {
        timeout: 3000,
        maxBuffer: 64 * 1024,
        windowsHide: true,
      });
      // Git prints the symlink-free top level; compare canonical forms but report the path as entered.
      if ((await realpath(stdout.trim())) !== (await realpath(localPath))) return false;
      let output = '';
      try {
        output = (
          await exec('git', ['-C', localPath, 'config', '--local', '--get-regexp', '^remote\\..*\\.url$'], {
            timeout: 3000,
            maxBuffer: 256 * 1024,
            windowsHide: true,
          })
        ).stdout;
      } catch (error) {
        if (/** @type {{ code?: unknown }} */ (error).code !== 1) throw error;
      }
      /** @type {DiscoveredRemote[]} */
      const remotes = [];
      for (const line of output.split('\n').filter(Boolean)) {
        const match = line.match(/^remote\.(.+)\.url\s+(.+)$/);
        if (!match) continue;
        try {
          const remote = parseRemote(match[2]);
          remotes.push({ ...remote, name: match[1], repoName: remote.name });
        } catch (error) {
          // Other hosting providers are outside this watch list.
          if (/** @type {{ code?: unknown }} */ (error).code === 'REMOTE_PASSWORD')
            result.warnings.push(`${localPath} (${match[1]}): ${/** @type {Error} */ (error).message}`);
        }
      }
      if (remotes.length) result.repositories.push({ localPath, remotes });
      return true;
    } catch (error) {
      if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT') throw new Error('Git is not installed.');
      return false;
    }
  }
  if (await readCheckout(path)) return result;
  const children = (await readdir(path, { withFileTypes: true }))
    .filter(entry => entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules')
    .sort((a, b) => a.name.localeCompare(b.name));
  if (children.length > 200) result.warnings.push('Only the first 200 folders were scanned. Choose a narrower folder for the rest.');
  for (let i = 0; i < Math.min(children.length, 200); i += 2)
    await Promise.all(children.slice(i, Math.min(i + 2, 200)).map(entry => readCheckout(resolve(path, entry.name))));
  return result;
}
