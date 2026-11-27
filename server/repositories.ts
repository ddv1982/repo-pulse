import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { stat, readdir, realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import type { DiscoveredRemote as ParsedRemote, DiscoveredRemote, Discovery } from '../src/contract.ts';
import { invalid } from './errors.ts';

const exec = promisify(execFile);
const invalidUrl = () => invalid('Use an Azure DevOps Services HTTPS or SSH repository URL.', 'INVALID_REPOSITORY');
const component = (value: string | undefined) => {
  if (value === undefined) throw invalidUrl();
  let decoded;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    throw invalidUrl();
  }
  // These bytes are forbidden within decoded repository URL segments.
  // oxlint-disable-next-line no-control-regex
  if (!decoded || /[\x00-\x1f/\\?#]/.test(decoded) || decoded === '.' || decoded === '..' || /^[-@]/.test(decoded)) throw invalidUrl();
  return decoded;
};

/** @param value Anything that is not an Azure DevOps organization URL is refused. */
export function normalizeOrganization(value: unknown) {
  let url;
  try {
    url = new URL(String(value));
  } catch {
    throw invalidUrl();
  }
  const parts = url.pathname.split('/').filter(Boolean);
  if (url.protocol !== 'https:' || url.port || url.search || url.hash || url.username || url.password) throw invalidUrl();
  if (url.hostname.toLowerCase() === 'dev.azure.com' && parts.length === 1)
    return `https://dev.azure.com/${encodeURIComponent(component(parts[0]).toLowerCase())}`;
  const [, account] = url.hostname.match(/^([a-z0-9][a-z0-9-]*)\.visualstudio\.com$/i) ?? [];
  if (account !== undefined && (!parts.length || (parts.length === 1 && parts[0]?.toLowerCase() === 'defaultcollection')))
    return `https://dev.azure.com/${account.toLowerCase()}`;
  throw invalidUrl();
}

/**
 * Git would receive the URL on its command line, where other local users can read it. A token can sit in the user name
 * too; Azure's own clone URLs use the organization name there, or no user name.
 * @param organization the organization as it appears in the URL
 */
function refuseCredentials(url: URL, organization: string) {
  let user, org;
  try {
    user = decodeURIComponent(url.username);
    org = decodeURIComponent(organization);
  } catch {
    throw invalidUrl();
  }
  if (url.protocol === 'ssh:' && user.startsWith('-')) throw invalidUrl();
  if (url.password || (url.protocol === 'https:' && user && user.toLowerCase() !== org.toLowerCase()))
    throw invalid('Remove the credentials from this remote URL and let a Git credential helper sign in.', 'REMOTE_PASSWORD');
}

export function parseRemote(value: unknown): ParsedRemote {
  // Reject control characters before the URL parser can trim them.
  // oxlint-disable-next-line no-control-regex
  if (typeof value !== 'string' || value.length > 4096 || /[\x00-\x1f]/.test(value)) throw invalidUrl();
  let organization, project, name;
  const ssh = value.match(/^(?:[^-@/:][^@/:]*@)?(?:ssh\.dev\.azure\.com|vs-ssh\.visualstudio\.com):v3\/([^/]+)\/([^/]+)\/([^/]+)\/?$/i);
  if (ssh) [, organization, project, name] = ssh;
  else {
    let url;
    try {
      url = new URL(value);
    } catch {
      throw invalidUrl();
    }
    if (!['https:', 'ssh:'].includes(url.protocol) || url.port || url.search || url.hash) throw invalidUrl();
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
      const [, account] = host.match(/^([a-z0-9][a-z0-9-]*)\.visualstudio\.com$/i) ?? [];
      if (account === undefined || url.protocol !== 'https:') throw invalidUrl();
      organization = account;
      if (parts[0]?.toLowerCase() === 'defaultcollection') parts.shift();
      if (parts.length !== 3 || parts[1] !== '_git') throw invalidUrl();
      [project, , name] = parts;
    }
    // Each branch above checked the part count, so this never refuses a parsed URL.
    if (organization === undefined) throw invalidUrl();
    refuseCredentials(url, organization);
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

/** Whether Git would see credentials in this Azure remote URL. */
export function hasRemoteCredentials(url: string) {
  try {
    if (new URL(url).password) return true;
  } catch {
    /* scp-like SSH remotes are not URLs; parseRemote reads them. */
  }
  try {
    parseRemote(url);
    return false;
  } catch (error) {
    return (error as { code?: unknown }).code === 'REMOTE_PASSWORD';
  }
}

export function repositoryKey(organization: unknown, azureId: unknown) {
  return createHash('sha256')
    .update(`${normalizeOrganization(organization)}\0${String(azureId).toLowerCase()}`)
    .digest('hex')
    .slice(0, 24);
}

/** Explicit bounded discovery; Git reads worktree/linked configs without fetching. */
export async function discoverRepositories(inputPath: unknown): Promise<Discovery> {
  if (typeof inputPath !== 'string' || !inputPath.trim() || inputPath.includes('\0'))
    throw new Error('Choose a local checkout or its parent folder.');
  const path = resolve(inputPath.startsWith('~/') ? `${homedir()}/${inputPath.slice(2)}` : inputPath);
  if (!(await stat(path)).isDirectory()) throw new Error('Choose a folder.');
  const result: Discovery = { repositories: [], warnings: [] };
  async function readCheckout(localPath: string) {
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
        if ((error as { code?: unknown }).code !== 1) throw error;
      }
      const remotes: DiscoveredRemote[] = [];
      for (const line of output.split('\n').filter(Boolean)) {
        const [, remoteName, remoteUrl] = line.match(/^remote\.(.+)\.url\s+(.+)$/) ?? [];
        if (remoteName === undefined) continue;
        try {
          const remote = parseRemote(remoteUrl);
          remotes.push({ ...remote, name: remoteName, repoName: remote.name });
        } catch (error) {
          // Other hosting providers are outside this watch list.
          if ((error as { code?: unknown }).code === 'REMOTE_PASSWORD')
            result.warnings.push(`${localPath} (${remoteName}): ${(error as Error).message}`);
        }
      }
      if (remotes.length) result.repositories.push({ localPath, remotes });
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('Git is not installed.');
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
