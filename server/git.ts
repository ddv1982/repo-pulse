// The Git runner and the Git primitives every checkout workflow shares. Each primitive runs Git through the runner it is
// given, so a caller (or a test) that wraps the runner sees every command. Nothing here imports a checkout workflow.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { isSymbolicRef } from './checkout-delete-guard.cjs';
import type { Rewrite } from '../src/contract.ts';
import { conflict } from './errors.ts';

export type Upstream = { remote: string; source: string; tracking: string; url: string };

export type GitRunner = (
  path: string,
  args: string[],
  options?: { guard?: NodeJS.ProcessEnv; input?: string; prepare?: () => Promise<void>; maxBuffer?: number },
) => Promise<string>;

const exec = promisify(execFile);
/** A hooks path with no hooks, for every Git command that could otherwise run one from the checkout. */
export const NO_HOOKS = process.platform === 'win32' ? 'NUL' : '/dev/null';

function gitEnvironment() {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    LC_ALL: 'C',
    GIT_TERMINAL_PROMPT: '0',
    GCM_INTERACTIVE: 'Never',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_NO_LAZY_FETCH: '1',
    GIT_NO_REPLACE_OBJECTS: '1',
  };
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_NAMESPACE']) delete env[key];
  return env;
}

export const runGit: GitRunner = async (path, args, { guard, input, prepare, maxBuffer = 2 * 1024 * 1024 } = {}) => {
  const env = { ...gitEnvironment(), ...guard };
  const command = exec('git', ['-C', path, '-c', 'core.fsmonitor=false', ...args], {
    env,
    timeout: 45_000,
    maxBuffer,
    windowsHide: true,
  });
  if (prepare && input !== undefined) {
    let reply = '';
    let received = false;
    let rejected;
    command.child.stdin?.on('error', () => {});
    command.child.stdout?.on('data', chunk => {
      if (received) return;
      reply += chunk;
      if (!/^prepare: ok\r?$/m.test(reply)) return;
      received = true;
      void prepare().then(
        () => command.child.stdin?.end('commit\n'),
        error => {
          rejected = error;
          command.child.stdin?.end('abort\n');
        },
      );
    });
    command.child.stdin?.write(input);
    const { stdout } = await command;
    if (rejected) throw rejected;
    if (!/^commit: ok\r?$/m.test(stdout)) throw conflict('Git did not commit the verified ref transaction.');
    return stdout;
  }
  if (input !== undefined) {
    command.child.stdin?.on('error', () => {});
    command.child.stdin?.end(input);
  }
  return (await command).stdout;
};

export const isCommit = (value: unknown) =>
  typeof value === 'string' && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(value) && !/^0+$/.test(value);

export async function ancestry(run: GitRunner, path: string, ancestor: string, tip: string) {
  if (ancestor === tip) return true;
  try {
    await run(path, ['merge-base', '--is-ancestor', ancestor, tip]);
    return true;
  } catch (error) {
    if (error instanceof Error && (('code' in error && error.code === 1) || ('status' in error && error.status === 1))) {
      return (await run(path, ['rev-parse', '--is-shallow-repository']).catch(() => '')).trim() === 'false' ? false : null;
    }
    return null;
  }
}

export async function readRef(run: GitRunner, path: string, ref: string) {
  try {
    const tip = (await run(path, ['show-ref', '--hash', '--verify', '--', ref])).trim();
    if (isCommit(tip)) return tip;
  } catch (error) {
    // Exit 1 from the quiet query distinguishes an absent ref from a failed read.
    const code = error instanceof Error && ('code' in error ? error.code : 'status' in error ? error.status : null);
    if (code === 1 || code === 128) {
      try {
        await run(path, ['show-ref', '--quiet', '--verify', '--', ref]);
      } catch (quietError) {
        if (
          quietError instanceof Error &&
          (('code' in quietError && quietError.code === 1) || ('status' in quietError && quietError.status === 1))
        )
          return null;
      }
    }
  }
  throw conflict('Git could not verify the local branch or its recovery reference.');
}

export async function switchLocalBranch(run: GitRunner, path: string, hooks: string, name: string, start?: string) {
  try {
    await run(path, [
      '-c',
      `core.hooksPath=${hooks}`,
      'switch',
      '--no-guess',
      '--no-overwrite-ignore',
      '--no-recurse-submodules',
      ...(start ? ['--no-track', '-c', name, '--', start] : ['--', name]),
    ]);
  } catch {
    throw conflict(
      `Git could not switch to ${name}. Check for an occupied worktree, conflicting files, or an unsupported tracking configuration.`,
    );
  }
}

export async function readDirectCommit(run: GitRunner, path: string, ref: string) {
  const output = await run(path, ['for-each-ref', '--format=%(refname)%00%(objectname)%00%(symref)%00%(objecttype)', '--', ref]);
  const sample = output
    .split('\n')
    .map(line => line.trimEnd().split('\0'))
    .find(([name]) => name === ref);
  if (!sample) {
    if (await isSymbolicRef(run, path, ref)) throw conflict('The tracking ref is symbolic. Review it in Git.');
    if (await readRef(run, path, ref)) throw conflict('The Git ref changed while it was being read. Try again.');
    return null;
  }
  // isCommit refuses '' as it refuses a missing field.
  const [, oid = '', symbolic, type] = sample;
  if (symbolic) throw conflict('The tracking ref is symbolic. Review it in Git.');
  if (!isCommit(oid) || type !== 'commit') {
    throw conflict('The tracking ref does not point to a commit. Review it in Git.');
  }
  return oid;
}

export async function compareUpstream(run: GitRunner, path: string, previous: string, tip: string, verified: boolean) {
  const output = await run(path, [
    'log',
    '--no-show-signature',
    '--left-right',
    '--max-count=12',
    '--format=%m%x00%h%x00%s',
    '-z',
    `${previous}...${tip}`,
    '--',
  ]).catch(() => '');
  const parts = output.split('\0');
  const commits: Rewrite['commits'] = [];
  for (let i = 0; i + 2 < parts.length && commits.length < 12; i += 3) {
    // The loop bound leaves three fields, so the defaults never apply.
    const [side, id = '', subject = ''] = parts.slice(i, i + 3);
    if ((side === '<' || side === '>') && /^[0-9a-f]{4,64}$/.test(id)) {
      commits.push({ side: side === '<' ? 'old' : 'new', id, subject: subject.slice(0, 160) });
    }
  }
  return { previous, tip, verified, commits };
}

function matchRef(pattern: string, ref: string) {
  if (pattern === ref) return '';
  const star = pattern.indexOf('*');
  if (star < 0) return null;
  const prefix = pattern.slice(0, star);
  const suffix = pattern.slice(star + 1);
  if (!ref.startsWith(prefix) || !ref.endsWith(suffix) || ref.length < prefix.length + suffix.length) return null;
  return ref.slice(prefix.length, ref.length - suffix.length);
}

/**
 * Check the mapping in both directions before writing a shared tracking ref.
 */
export async function verifyTrackingMapping(run: GitRunner, path: string, target: Upstream) {
  const config = await run(path, ['config', '--null', '--get-regexp', '^remote\\..*\\.fetch$']).catch(error => {
    if (error?.code === 1 || error?.status === 1) return '';
    throw error;
  });
  const mappings = config.split('\0').flatMap(entry => {
    const newline = entry.indexOf('\n');
    if (newline < 0) return [];
    const remote = entry.slice(7, newline - 6);
    // split always returns at least one part.
    const [source = '', destination] = entry
      .slice(newline + 1)
      .replace(/^\+/, '')
      .split(':');
    return [{ remote, source, destination }];
  });
  const forwards = mappings.flatMap(({ remote, source, destination }) =>
    remote === target.remote && destination && matchRef(source, target.source) !== null ? [{ source, destination }] : [],
  );
  const excluded = mappings.some(
    ({ remote, source }) => remote === target.remote && source.startsWith('^') && matchRef(source.slice(1), target.source) !== null,
  );
  const collision = mappings.some(({ remote, source, destination }) => {
    const match = destination ? matchRef(destination, target.tracking) : null;
    return match !== null && (remote !== target.remote || source.replace('*', () => match) !== target.source);
  });
  if (
    excluded ||
    collision ||
    !forwards.length ||
    forwards.some(({ source, destination }) => destination.replace('*', () => matchRef(source, target.source) ?? '') !== target.tracking)
  ) {
    throw conflict('The Git fetch configuration does not map this branch to the watched remote. Review the remote in Git.');
  }
}

/** What a failed fetch means: the source ref is gone, or a reason a person can act on. */
export function fetchFailure(failure: unknown) {
  const stderr = failure instanceof Error && 'stderr' in failure ? String(failure.stderr) : '';
  if (/could(?:n't| not) find remote ref/i.test(stderr)) return 'missing-ref';
  if (
    /authentication failed|could not read (username|password)|terminal prompts disabled|permission denied \(publickey\)|returned error: 401/i.test(
      stderr,
    )
  ) {
    return { title: 'Git authentication failed', suggestion: 'Check Git credentials for this checkout and try again.' };
  }
  if (/returned error: 403|access denied|repository.*not found|TF401019/i.test(stderr)) {
    return { title: 'Git could not access the repository', suggestion: 'Check your permissions and configured remote.' };
  }
  if (
    /could not resolve|failed to connect|timed out|network is unreachable/i.test(stderr) ||
    (failure instanceof Error && 'killed' in failure && failure.killed)
  ) {
    return { title: 'Git could not reach the remote', suggestion: 'Check your connection and try again.' };
  }
  return { title: 'Git could not fetch the tracked branch', suggestion: 'Check the upstream from your terminal and try again.' };
}

/** The commit the tracking ref names, or null. `before` reads quietly, as a check before a fetch does. */
export async function trackingTip(run: GitRunner, path: string, tracking: string, before: boolean = false) {
  const args = before ? ['rev-parse', '--quiet', '--verify'] : ['rev-parse', '--verify'];
  const hash = (await run(path, [...args, `${tracking}^{commit}`]).catch(() => '')).trim();
  return isCommit(hash) ? hash : null;
}

/** Refuses an upstream whose refs are malformed, whose URL Git rewrites, or whose tracking ref is symbolic. */
export async function validateUpstream(run: GitRunner, path: string, target: Upstream) {
  await run(path, ['check-ref-format', target.source]);
  await run(path, ['check-ref-format', target.tracking]);
  // Use the already validated URL, independent of a later remote-name edit.
  const effective = (await run(path, ['ls-remote', '--get-url', '--', target.url])).trimEnd();
  if (effective !== target.url) throw conflict('Git rewrites this upstream. Review the configured remote in Git.');
  if (await isSymbolicRef(run, path, target.tracking)) throw conflict('The upstream tracking ref is symbolic. Review it in Git.');
}

/** Fetches the upstream branch from its verified URL into `destination`, or only into the object store when it is null. */
export async function fetchUpstream(run: GitRunner, path: string, target: Upstream, destination: string | null = target.tracking) {
  await run(path, [
    '-c',
    `core.hooksPath=${NO_HOOKS}`,
    'fetch',
    '--no-prune',
    '--no-prune-tags',
    '--no-tags',
    '--no-recurse-submodules',
    '--no-write-fetch-head',
    '--no-auto-maintenance',
    '--refmap=',
    '--',
    target.url,
    destination ? `+${target.source}:${destination}` : target.source,
  ]);
}
