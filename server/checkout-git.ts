import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, realpath, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { hasRemoteCredentials, parseRemote } from './repositories.ts';
import { adviseMissingUpstream, isCommit } from './checkout-advice.ts';
import { branchFollowups, branchProblem, memoryFollowups } from './checkout-branches.ts';
import { isSymbolicRef } from './checkout-delete-guard.cjs';
import { checkoutDiagnostic, memoryObservations, observedRewrite } from './checkout-observations.ts';
import { gitHistorySnapshot, readGitHistory } from './git-history.ts';
import { createActivitySwitch } from './checkout-activity-switch.ts';
import { createCheckoutUpdater } from './checkout-update.ts';
import { archivedSwitchRewrite, readDirectCommit } from './checkout-switch-refs.ts';
import type { Repository as LinkedRepo } from './store.ts';
import type {
  GitStatus,
  CheckoutSelection,
  SwitchIntent,
  CheckoutIntent,
  CheckoutReading,
  BlockedState,
  ActiveCheckout,
  CheckoutStatus,
} from '../src/contract.d.ts';

/**
 * Checkouts belong to watched repositories, so their Azure identity is always present.
 */
export type { LinkedRepo };

export type { GitStatus, CheckoutSelection, SwitchIntent, CheckoutIntent, CheckoutReading, BlockedState, ActiveCheckout, CheckoutStatus };

export type Upstream = { remote: string; source: string; tracking: string; url: string };

export type { ActivitySwitchReview, DecoratedCheckout } from '../src/contract.d.ts';

export type ReadCheckoutStatus = (
  path: string,
  repo: LinkedRepo,
) => Promise<{ snapshot: ActiveCheckout; target: Upstream | null; gitDirectory: string | null }>;

export type GitRunner = (
  path: string,
  args: string[],
  options?: { guard?: NodeJS.ProcessEnv; input?: string; prepare?: () => Promise<void>; maxBuffer?: number },
) => Promise<string>;

const exec = promisify(execFile);
const problem = (message: string, status = 409) => Object.assign(new Error(message), { status });
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
const hooks = process.platform === 'win32' ? 'NUL' : '/dev/null';
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
    if (!/^commit: ok\r?$/m.test(stdout)) throw problem('Git did not commit the verified ref transaction.');
    return stdout;
  }
  if (input !== undefined) {
    command.child.stdin?.on('error', () => {});
    command.child.stdin?.end(input);
  }
  return (await command).stdout;
};

function fetchFailure(failure: unknown) {
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

function matchesWatchedRemote(url: string, repo: LinkedRepo) {
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
  observation: import('./checkout-observations.ts').Observation | undefined;
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

export function isCheckoutIntent(value: unknown): value is CheckoutIntent {
  return hasCheckoutSelection(value) && typeof value.upstream === 'string';
}

export function isSwitchIntent(value: unknown): value is SwitchIntent {
  return hasCheckoutSelection(value) && 'switchIdentity' in value && typeof value.switchIdentity === 'string';
}

function hasCheckoutSelection(value: unknown): value is CheckoutSelection {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  return (
    ['branch', 'head', 'identity'].every(key => typeof candidate[key] === 'string') &&
    (candidate.upstream === null || typeof candidate.upstream === 'string')
  );
}

export function createCheckoutGit({
  run = runGit,
  matchesRemote = matchesWatchedRemote,
  now = Date.now,
  findPulls = async () => [],
  observations = memoryObservations(),
  followups = memoryFollowups(),
}: {
  run?: GitRunner | undefined;
  matchesRemote?: typeof matchesWatchedRemote;
  now?: () => number;
  followups?: import('./checkout-branches.ts').Followups;
  findPulls?: import('./checkout-advice.ts').FindCheckoutPulls;
  observations?: import('./checkout-observations.ts').Observations;
} = {}) {
  const readings: Map<string, { path: string; until: number; value: Promise<CheckoutStatus> }> = new Map();
  /** Active checkout write locks: repo IDs and canonical Git common directories currently updating. */
  const updatingRepos: Set<string> = new Set();
  const updatingGitDirs: Set<string> = new Set();
  const updateAt = createCheckoutUpdater({
    run,
    hooks,
    now,
    observations,
    problem,
    statusAt,
    validateUpstream,
    fetchUpstream,
    trackingTip,
    fetchFailure,
    observedAt,
    upstreamIdentity,
    readMissing,
    matchesIntent,
    verifyCheckoutDirectory,
  });
  const branches = branchFollowups({ run, hooks, followups, statusAt, updateAt, readMissing, matchesIntent });
  const switchAt = createActivitySwitch({
    run,
    hooks,
    now,
    observations,
    problem,
    statusAt,
    inspect,
    decorate: branches.decorate,
    remoteTarget,
    upstreamFor,
    validateUpstream,
    fetchUpstream,
    trackingTip,
    fetchFailure,
    observedAt,
    upstreamIdentity,
    matchesIntent,
    verifyCheckoutDirectory,
  });

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
        if (gitlink.includes('\uFFFD')) throw problem('A submodule path is not valid UTF-8. Rename it to read this checkout.', 404);
        const submodule = resolve(folder, gitlink);
        // Git follows a gitlink that is a symlink, so the scan does too; each folder is read once, so links cannot loop.
        const real = await realpath(submodule).catch(() => null);
        if (real?.includes('\uFFFD')) throw problem('A submodule path is not valid UTF-8. Rename it to read this checkout.', 404);
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
    if (!repo.localPath) throw problem('No local checkout linked.', 404);
    let path, keys;
    try {
      path = await realpath(repo.localPath);
      const root = (await run(path, ['rev-parse', '--show-toplevel'])).trimEnd();
      if ((await realpath(root)) === path) keys = await configuredCommands(path);
    } catch (error) {
      // The linked folder may have moved or Git may not be available; keep a reason this module gave itself.
      if ((error as { status?: number }).status) throw error;
    }
    if (!path || !keys) throw problem('The linked checkout is unavailable.', 404);
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
    throw Object.assign(problem(`${message} ${suggestion}`), {
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
    if (!remote || !source?.startsWith('refs/heads/') || tracking !== `refs/remotes/${remote}/${source.slice(11)}`) return { target: null };
    return remoteTarget(path, repo, remote, source);
  }

  async function remoteTarget(path: string, repo: LinkedRepo, remote: string, source: string) {
    const urls = (await run(path, ['remote', 'get-url', '--all', '--', remote])).trimEnd().split('\n');
    // Git would receive the URL on its command line, where other local users can read it.
    if (urls.some(hasRemoteCredentials)) return { target: null, passwordInUrl: true };
    const tracking = `refs/remotes/${remote}/${source.slice(11)}`;
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
      if (!branch || !head || !upstream || !validTarget) throw problem('The upstream changed during the status check.');
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

  async function pendingRewrite(
    path: string,
    target: Upstream | null,
    observation: import('./checkout-observations.ts').Observation | undefined,
  ) {
    if (!target || observation?.rewrite || !observation?.pending?.length) return undefined;
    const tracked = await trackingTip(path, target.tracking, true);
    return tracked ? (await observedRewrite(run, path, observation.pending, tracked)).rewrite : undefined;
  }

  async function trackingTip(path: string, tracking: string, before: boolean = false) {
    const args = before ? ['rev-parse', '--quiet', '--verify'] : ['rev-parse', '--verify'];
    const hash = (await run(path, [...args, `${tracking}^{commit}`]).catch(() => '')).trim();
    return isCommit(hash) ? hash : null;
  }

  async function inspect(
    path: string,
    repo: LinkedRepo,
    { configChecked = false }: { configChecked?: boolean } = {},
  ): Promise<CheckoutStatus> {
    try {
      const { snapshot } = await statusAt(path, repo, { configChecked });
      return await branches.decorate(repo, path, snapshot);
    } catch {
      return { state: 'unavailable' };
    }
  }

  function status(repo: LinkedRepo, { fresh = false } = {}): Promise<CheckoutStatus> {
    if (!repo.localPath) return Promise.resolve({ state: 'not-linked' });
    const previous = readings.get(repo.id);
    if (!fresh && previous?.path === repo.localPath && previous.until > now()) return previous.value;
    const value = checkoutPath(repo).then(
      path => inspect(path, repo, { configChecked: true }),
      (error: { diagnostic?: import('./checkout-observations.ts').CheckoutDiagnostic }): CheckoutStatus =>
        error.diagnostic ? { state: 'unavailable', diagnostic: error.diagnostic } : { state: 'unavailable' },
    );
    readings.set(repo.id, { path: repo.localPath, until: now() + 5000, value });
    return value;
  }

  async function readMissing(path: string, repo: LinkedRepo, target: Upstream, snapshot: ActiveCheckout) {
    return snapshot.head
      ? adviseMissingUpstream({
          run,
          find: findPulls,
          path,
          repo,
          url: target.url,
          source: target.source,
          head: snapshot.head,
          branch: snapshot.branch,
        }).catch(() => undefined)
      : undefined;
  }

  function matchesIntent(snapshot: CheckoutReading, expected: Pick<CheckoutReading, 'branch' | 'head' | 'upstream' | 'identity'>) {
    return (['branch', 'head', 'upstream', 'identity'] as const).every(key => snapshot[key] === expected[key]);
  }

  async function verifyCheckoutDirectory(path: string, expected: string | null) {
    const gitDir = (await run(path, ['rev-parse', '--absolute-git-dir'])).trimEnd();
    if (!expected || !gitDir || opaqueDirectory(await directoryIdentity(gitDir)) !== expected)
      throw problem('The checkout changed. Review the current branch and try again.');
  }

  async function exclusively<T>(repo: LinkedRepo, action: (path: string) => Promise<T>) {
    if (updatingRepos.has(repo.id)) throw problem('This checkout is already updating. Try again in a moment.');
    updatingRepos.add(repo.id);
    readings.delete(repo.id);
    let commonDir: string | null = null;
    try {
      const path = await checkoutPath(repo);
      const rawCommonDir = (await run(path, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).trimEnd();
      const resolvedCommonDir = await realpath(rawCommonDir).catch(() => rawCommonDir);
      if (updatingGitDirs.has(resolvedCommonDir)) {
        throw problem('Another checkout sharing this Git repository is updating. Try again in a moment.');
      }
      updatingGitDirs.add(resolvedCommonDir);
      commonDir = resolvedCommonDir;
      return await action(path);
    } finally {
      readings.delete(repo.id);
      updatingRepos.delete(repo.id);
      if (commonDir) {
        // Other watched worktrees can share tracking refs with this checkout.
        readings.clear();
        updatingGitDirs.delete(commonDir);
      }
    }
  }

  async function validateUpstream(path: string, target: Upstream) {
    await run(path, ['check-ref-format', target.source]);
    await run(path, ['check-ref-format', target.tracking]);
    // Use the already validated URL, independent of a later remote-name edit.
    const effective = (await run(path, ['ls-remote', '--get-url', '--', target.url])).trimEnd();
    if (effective !== target.url) throw problem('Git rewrites this upstream. Review the configured remote in Git.');
    if (await isSymbolicRef(run, path, target.tracking)) throw problem('The upstream tracking ref is symbolic. Review it in Git.');
  }

  async function fetchUpstream(path: string, target: Upstream, destination: string | null = target.tracking) {
    await run(path, [
      '-c',
      `core.hooksPath=${hooks}`,
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

  function update(
    repo: LinkedRepo,
    operation: 'check' | 'pull',
    expected: CheckoutIntent,
  ): Promise<import('../src/contract.d.ts').CheckoutUpdateResult> {
    return exclusively(repo, async path => {
      const result = await updateAt(path, repo, operation, expected);
      return { ...result, checkout: await inspect(path, repo) };
    });
  }

  function branchAction(
    repo: LinkedRepo,
    action: import('./checkout-branches.ts').BranchAction,
    expected: CheckoutIntent,
  ): Promise<import('../src/contract.d.ts').BranchActionResult> {
    return exclusively(repo, async path => {
      const current = await statusAt(path, repo);
      if (!matchesIntent(current.snapshot, expected)) {
        throw branchProblem('The checkout changed. Review the current branch and try again.');
      }
      try {
        const result = await branches.act(repo, path, current, action);
        return { ...result, checkout: await inspect(path, repo) };
      } catch (error) {
        if (error instanceof Error && 'status' in error && error.status === 409) throw error;
        throw branchProblem('Git could not finish this branch action. Check the checkout in Git and try again.');
      }
    });
  }

  function switchToActivityBranch(
    repo: LinkedRepo,
    name: string,
    expected: SwitchIntent,
    { eventId, confirmation }: { eventId?: string | undefined; confirmation?: string | undefined } = {},
  ): Promise<import('../src/contract.d.ts').ActivitySwitchResult> {
    return exclusively(repo, path => switchAt(path, repo, name, expected, { eventId, confirmation }));
  }

  /** Local branch names, read without the update lock. */
  async function localBranches(repo: LinkedRepo) {
    const path = await checkoutPath(repo);
    const refs = await run(path, ['for-each-ref', '--format=%(refname)', 'refs/heads/']);
    return refs
      .split('\n')
      .filter(ref => ref.startsWith('refs/heads/'))
      .map(ref => ref.slice(11));
  }

  async function history(repo: LinkedRepo, cursor: string | null) {
    const path = await checkoutPath(repo);
    try {
      return await readGitHistory(run, path, repo.defaultBranch, cursor);
    } catch (error) {
      if (error instanceof Error && 'status' in error) throw error;
      throw problem('Git could not read commit history for this checkout.');
    }
  }

  async function historySnapshot(repo: LinkedRepo) {
    const path = await checkoutPath(repo);
    try {
      return await gitHistorySnapshot(run, path, repo.defaultBranch);
    } catch {
      throw problem('Git could not read commit refs for this checkout.');
    }
  }

  return { status, update, branchAction, switchToActivityBranch, localBranches, history, historySnapshot };
}
