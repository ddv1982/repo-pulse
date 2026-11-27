// Reading a linked checkout: the config guard that refuses a checkout whose own Git config runs commands, the branch
// and upstream status with the state it names, and the identities later steps compare against. All Git runs through
// the runner the facade was given.
import { branchName } from '../src/events.ts';
import { createHash } from 'node:crypto';
import { access, realpath, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { hasRemoteCredentials, parseRemote } from './repositories.ts';
import { readDirectCommit, trackingTip, type GitRunner, type Upstream } from './git.ts';
import { checkoutDiagnostic, observedRewrite, type Observation, type Observations } from './checkout-observations.ts';
import { archivedSwitchRewrite } from './checkout-switch-refs.ts';
import type { ReadCheckoutStatus } from './checkout-context.ts';
import type { GitStatus, CheckoutReading, BlockedState, Repository as LinkedRepo } from '../src/contract.ts';
import { conflict, isAppError, notFound } from './errors.ts';

const operations: [marker: string, label: string][] = [
  ['rebase-merge', 'Rebase'],
  ['rebase-apply/applying', 'Patch apply'],
  ['rebase-apply', 'Rebase'],
  ['MERGE_HEAD', 'Merge'],
  ['CHERRY_PICK_HEAD', 'Cherry-pick'],
  ['REVERT_HEAD', 'Revert'],
  ['BISECT_START', 'Bisect'],
  ['sequencer', 'Git operation'],
];
const upstreamIdentity = (path: string, target: Upstream | null, gitDirectory?: string | null) =>
  createHash('sha256')
    .update(JSON.stringify(gitDirectory === undefined ? [path, target] : [path, target, gitDirectory]))
    .digest('hex');
const directoryIdentity = (path: string) =>
  stat(path).then(
    info => `${info.dev}:${info.ino}:${info.birthtimeMs}`,
    () => null,
  );
const opaqueDirectory = (directory: string | null) => directory && createHash('sha256').update(directory).digest('hex');
// Keys in a checkout's own config that make Git run a command, change where or how it connects, or load more config
// later (conditional includes can switch on after a branch switch).
const commandKeys = new RegExp(
  [
    'filter\\..*\\.(?:clean|smudge|process)',
    'merge\\..*\\.driver',
    'core\\.(?:sshcommand|askpass|gitproxy|alternaterefscommand|unsetenvvars)',
    'credential\\..*',
    'url\\..*\\.(?:push)?insteadof',
    'http\\..*',
    'remote\\..*\\.(?:uploadpack|proxy|vcs)',
    'fetch\\.bundleuri',
    'gpg\\.(?:.*\\.)?program',
    'include\\.path',
    'includeif\\..*\\.path',
    'ssh\\.variant',
    'protocol\\.version',
    // A globally installed Git LFS reads these: transfer agents and extensions run programs, the URLs move the endpoint.
    // Keys LFS writes itself, such as lfs.repositoryformatversion and lfs.<url>.access, stay allowed.
    'lfs\\.(?:customtransfer\\..*|(?:.*\\.)?standalonetransferagent|extension\\..*|url|storage)',
    'remote\\..*\\.lfsurl',
    // Git 2.54+ can define hooks in config; core.hooksPath does not turn those off.
    'hook\\..*',
  ]
    .map(key => `^${key}$`)
    .join('|'),
  'is',
);

export function matchesWatchedRemote(url: string, repo: LinkedRepo) {
  try {
    const target = parseRemote(url);
    return (['organization', 'project', 'name'] as const).every(key => target[key].toLowerCase() === repo[key]?.toLowerCase());
  } catch {
    return false;
  }
}

function readStatus(output: string) {
  const result: GitStatus = { branch: null, head: null, upstream: null, ahead: null, behind: null, dirty: false };
  for (const record of output.split('\0')) {
    if (!record) continue;
    if (!record.startsWith('# ')) {
      result.dirty = true;
      break;
    }
    const space = record.indexOf(' ', 2);
    const key = record.slice(2, space),
      value = record.slice(space + 1);
    if (key === 'branch.head' && value !== '(detached)') result.branch = value;
    if (key === 'branch.oid' && value !== '(initial)') result.head = value;
    if (key === 'branch.upstream') result.upstream = value;
    if (key === 'branch.ab') {
      const counts = /^\+(\d+) -(\d+)$/.exec(value);
      if (counts) {
        result.ahead = Number(counts[1]);
        result.behind = Number(counts[2]);
      }
    }
  }
  return result;
}

/**
 * The first matching check names the checkout state; order is significant, and later facts are read only if needed.
 */
function checkoutState({
  operation,
  observation,
  rewrite,
  target,
  branch,
  head,
  upstream,
  ahead,
  behind,
  dirty,
}: GitStatus & {
  operation: string | undefined;
  observation: Observation | undefined;
  rewrite: unknown;
  target: Upstream | null;
}): BlockedState | 'behind' {
  if (operation) return 'in-progress';
  if (!branch) return 'detached';
  if (!head) return 'unborn';
  if (observation?.missing) return 'upstream-missing';
  if (rewrite) return 'upstream-rewritten';
  if (observation?.failure) return 'fetch-failed';
  if (!upstream) return 'no-upstream';
  if (!target) return 'different-remote';
  if (ahead === null) return 'unknown';
  if (ahead && behind) return 'diverged';
  if (dirty && !behind) return 'dirty';
  if (ahead) return 'ahead';
  if (behind) return 'behind';
  return 'current';
}

/**
 * The status reader over one Git runner. `matchesRemote` decides whether a remote URL is the watched repository, and
 * `observations` holds what earlier checks saw.
 */
export function createCheckoutStatus({
  run,
  matchesRemote,
  observations,
}: {
  run: GitRunner;
  matchesRemote: (url: string, repo: LinkedRepo) => boolean;
  observations: Observations;
}) {
  function observedAt(repo: LinkedRepo, path: string, target: Upstream | null, gitDirectory: string | null) {
    if (!gitDirectory) return undefined;
    const identity = upstreamIdentity(path, target, gitDirectory);
    const saved = observations.get(repo.id, identity);
    if (saved?.identity === identity) return saved;
    const legacyIdentity = upstreamIdentity(path, target);
    const legacy = observations.get(repo.id, legacyIdentity);
    // An interrupted legacy fetch may have changed the tracker before saving a directory or check time.
    if (
      legacy?.identity === legacyIdentity &&
      (legacy.lastCheck?.gitDirectory === gitDirectory || (!legacy.lastCheck && (legacy.pending?.length || legacy.rewrite)))
    )
      return { ...legacy, identity };
    return undefined;
  }

  /** Config keys the checkout or one of its submodules sets itself that would make Git run a command. */
  async function configuredCommands(path: string) {
    const keys = new Set<string>();
    // Nothing in this scan needs the network; no transport may run while the config is still untrusted.
    const offline = { GIT_ALLOW_PROTOCOL: '' };
    const visited = new Set();
    const visit = async (folder: string) => {
      visited.add(await realpath(folder));
      // NUL-separated pairs of scope and key, so a subsection with a tab or newline stays one key.
      const listing = await run(folder, ['config', '--show-scope', '--includes', '--name-only', '--null', '--list'], { guard: offline });
      const fields = listing.split('\0');
      for (let i = 0; i + 1 < fields.length; i += 2) {
        // The loop bound leaves two fields, so the default never applies.
        const [scope, key = ''] = fields.slice(i, i + 2);
        if ((scope === 'local' || scope === 'worktree') && commandKeys.test(key)) keys.add(key);
      }
      if (keys.size) return;
      // Gitlinks come from the index, like the ones status descends into; .gitmodules may not list them all.
      const index = await run(folder, ['ls-files', '--stage', '-z'], { guard: offline, maxBuffer: 256 * 1024 * 1024 });
      const gitlinks = new Set(index.split('\0').flatMap(entry => entry.match(/^160000 [0-9a-f]+ \d\t([^]+)$/)?.[1] ?? []));
      for (const gitlink of gitlinks) {
        // A path that is not valid UTF-8 cannot be followed exactly, so the checkout is not read at all.
        if (gitlink.includes('\uFFFD')) throw notFound('A submodule path is not valid UTF-8. Rename it to read this checkout.');
        const submodule = resolve(folder, gitlink);
        // Git follows a gitlink that is a symlink, so the scan does too; each folder is read once, so links cannot loop.
        const real = await realpath(submodule).catch(() => null);
        if (real?.includes('\uFFFD')) throw notFound('A submodule path is not valid UTF-8. Rename it to read this checkout.');
        if (!real || visited.has(real)) continue;
        const populated = await access(resolve(submodule, '.git')).then(
          () => true,
          () => false,
        );
        if (populated && !keys.size) await visit(submodule);
      }
    };
    await visit(path);
    return [...keys];
  }

  async function checkoutPath(repo: LinkedRepo) {
    if (!repo.localPath) throw notFound('No local checkout linked.');
    let path, keys;
    try {
      path = await realpath(repo.localPath);
      const root = (await run(path, ['rev-parse', '--show-toplevel'])).trimEnd();
      if ((await realpath(root)) === path) keys = await configuredCommands(path);
    } catch (error) {
      // The linked folder may have moved or Git may not be available; keep a reason this module gave itself.
      if (isAppError(error)) throw error;
    }
    if (!path || !keys) throw notFound('The linked checkout is unavailable.');
    refuseConfiguredCommands(keys);
    return path;
  }

  function refuseConfiguredCommands(keys: string[]) {
    if (!keys.length) return;
    // Subsections of these families can hold a URL with a token (url.<base>, includeIf.hasconfig:remote.*.url:<url>), so
    // they are not shown.
    const shown = [...new Set(keys.map(key => key.replace(/^(url|http|credential|lfs|includeif)\.[^]+\.([^.]+)$/i, '$1.<…>.$2')))];
    const message = `This checkout's own Git config sets ${shown.join(', ')}.`;
    const suggestion = 'Repo Pulse does not run commands from a checkout. Move these settings to your global Git config or remove them.';
    throw Object.assign(conflict(`${message} ${suggestion}`), {
      diagnostic: { title: 'Checkout Git config runs commands', message, suggestion },
    });
  }

  async function upstreamFor(
    path: string,
    repo: LinkedRepo,
    branch: string | null,
  ): Promise<{ target: Upstream | null; passwordInUrl?: boolean }> {
    if (!branch) return { target: null };
    const raw = await run(path, [
      'for-each-ref',
      '--format=%(upstream:remotename)%00%(upstream:remoteref)%00%(upstream)',
      '--',
      `refs/heads/${branch}`,
    ]);
    const [remote, source, tracking] = raw.trimEnd().split('\0');
    if (!remote || !source?.startsWith('refs/heads/') || tracking !== `refs/remotes/${remote}/${branchName(source)}`)
      return { target: null };
    return remoteTarget(path, repo, remote, source);
  }

  async function remoteTarget(path: string, repo: LinkedRepo, remote: string, source: string) {
    const urls = (await run(path, ['remote', 'get-url', '--all', '--', remote])).trimEnd().split('\n');
    // Git would receive the URL on its command line, where other local users can read it.
    if (urls.some(hasRemoteCredentials)) return { target: null, passwordInUrl: true };
    const tracking = `refs/remotes/${remote}/${branchName(source)}`;
    const [url, ...others] = urls;
    return { target: url !== undefined && !others.length && matchesRemote(url, repo) ? { remote, source, tracking, url } : null };
  }

  /** Finds an in-progress Git operation and a stable identity for the Git directory. */
  async function gitMarkers(path: string) {
    const markers = (await run(path, ['rev-parse', ...operations.flatMap(([marker]) => ['--git-path', marker]), '--git-dir']))
      .trimEnd()
      .split('\n');
    const gitDir = markers.pop();
    const gitDirectory = gitDir ? await directoryIdentity(resolve(path, gitDir)) : null;
    const found = await Promise.all(
      markers.map(marker =>
        access(resolve(path, marker)).then(
          () => true,
          () => false,
        ),
      ),
    );
    return { operation: operations[found.indexOf(true)]?.[1], gitDirectory };
  }

  async function statusAt(
    path: string,
    repo: LinkedRepo,
    { configChecked = false }: { configChecked?: boolean } = {},
  ): ReturnType<ReadCheckoutStatus> {
    // Checked again here because a Pull or branch switch can bring in a gitlink over a nested checkout.
    // Callers that just verified the checkout in checkoutPath without mutating it can skip the duplicate scan.
    if (!configChecked) refuseConfiguredCommands(await configuredCommands(path));
    const snapshot = readStatus(
      await run(path, ['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=normal', '--ignore-submodules=none']),
    );
    const { branch, head, upstream } = snapshot;
    const { target, passwordInUrl } = await upstreamFor(path, repo, upstream ? branch : null);
    const { operation, gitDirectory } = await gitMarkers(path);
    const identity = upstreamIdentity(path, target);
    const switchIdentity = opaqueDirectory(gitDirectory);
    const observation = observedAt(repo, path, target, gitDirectory);
    const last = observation?.lastCheck;
    let invalidTracking = false;
    const trackingFailure = () => {
      invalidTracking = true;
      return undefined;
    };
    const archive = target && head ? await archivedSwitchRewrite(run, path, repo, target, head).catch(trackingFailure) : undefined;
    const lastBranchCheck =
      last && gitDirectory && last.gitDirectory === gitDirectory && last.branch === branch && target
        ? {
            at: last.at,
            matchesFetchedTip: !invalidTracking && (await readDirectCommit(run, path, target.tracking).catch(trackingFailure)) === last.tip,
          }
        : undefined;
    const validTarget = invalidTracking ? null : target;
    const pending = await pendingRewrite(path, validTarget, archive ? undefined : observation);
    const rewrite = archive ?? observation?.rewrite ?? pending;
    const state = checkoutState({ ...snapshot, operation, observation, rewrite, target: validTarget });
    if (state === 'behind') {
      if (!branch || !head || !upstream || !validTarget) throw conflict('The upstream changed during the status check.');
      return {
        snapshot: { ...snapshot, branch, head, upstream, identity, switchIdentity, lastBranchCheck, state, canCheck: true, canPull: true },
        target: validTarget,
        gitDirectory,
      };
    }
    const diagnostic = invalidTracking
      ? {
          title: 'Upstream ref needs review',
          suggestion: 'Check that the local tracking ref directly names the expected upstream commit.',
        }
      : passwordInUrl
        ? {
            title: 'Remote URL contains credentials',
            suggestion: 'Remove the credentials from the remote URL and let a Git credential helper sign in.',
          }
        : checkoutDiagnostic(state, snapshot, observation, operation, rewrite);
    return {
      snapshot: {
        ...snapshot,
        identity,
        switchIdentity,
        lastBranchCheck,
        state,
        canCheck: Boolean(validTarget && head && !operation),
        canPull: false,
        diagnostic,
      },
      target: validTarget,
      gitDirectory,
    };
  }

  async function pendingRewrite(path: string, target: Upstream | null, observation: Observation | undefined) {
    if (!target || observation?.rewrite || !observation?.pending?.length) return undefined;
    const tracked = await trackingTip(run, path, target.tracking, true);
    return tracked ? (await observedRewrite(run, path, observation.pending, tracked)).rewrite : undefined;
  }

  function matchesIntent(snapshot: CheckoutReading, expected: Pick<CheckoutReading, 'branch' | 'head' | 'upstream' | 'identity'>) {
    return (['branch', 'head', 'upstream', 'identity'] as const).every(key => snapshot[key] === expected[key]);
  }

  async function verifyCheckoutDirectory(path: string, expected: string | null) {
    const gitDir = (await run(path, ['rev-parse', '--absolute-git-dir'])).trimEnd();
    if (!expected || !gitDir || opaqueDirectory(await directoryIdentity(gitDir)) !== expected)
      throw conflict('The checkout changed. Review the current branch and try again.');
  }

  return {
    checkoutPath,
    statusAt,
    upstreamFor,
    remoteTarget,
    observedAt,
    upstreamIdentity,
    matchesIntent,
    verifyCheckoutDirectory,
  };
}
