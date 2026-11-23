// @ts-check

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, realpath, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { hasRemoteCredentials, parseRemote } from './repositories.ts';
import { adviseMissingUpstream, isCommit } from './checkout-advice.js';
import { branchFollowups, branchProblem, memoryFollowups } from './checkout-branches.js';
import { isSymbolicRef } from './checkout-delete-guard.cjs';
import { checkoutDiagnostic, memoryObservations, observedRewrite } from './checkout-observations.js';
import { createActivitySwitch } from './checkout-activity-switch.js';
import { createCheckoutUpdater } from './checkout-update.js';
import { archivedSwitchRewrite, readDirectCommit } from './checkout-switch-refs.js';

/**
 * Checkouts belong to watched repositories, so their Azure identity is always present.
 * @typedef {import('./store.js').Repository} LinkedRepo
 * @typedef {import('../src/contract.ts').GitStatus} GitStatus
 * @typedef {import('../src/contract.ts').CheckoutSelection} CheckoutSelection
 * @typedef {import('../src/contract.ts').SwitchIntent} SwitchIntent
 * @typedef {import('../src/contract.ts').CheckoutIntent} CheckoutIntent
 * @typedef {import('../src/contract.ts').CheckoutReading} CheckoutReading
 * @typedef {{ remote: string, source: string, tracking: string, url: string }} Upstream
 * @typedef {import('../src/contract.ts').ActivitySwitchReview} ActivitySwitchReview
 * @typedef {import('../src/contract.ts').BlockedState} BlockedState
 * @typedef {(path: string, repo: LinkedRepo) => Promise<{ snapshot: ActiveCheckout, target: Upstream|null, gitDirectory: string|null }>} ReadCheckoutStatus
 * @typedef {import('../src/contract.ts').ActiveCheckout} ActiveCheckout
 * @typedef {import('../src/contract.ts').DecoratedCheckout} DecoratedCheckout
 * @typedef {import('../src/contract.ts').CheckoutStatus} CheckoutStatus
 * @typedef {(path: string, args: string[], options?: { guard?: NodeJS.ProcessEnv, input?: string, prepare?: () => Promise<void>, maxBuffer?: number }) => Promise<string>} GitRunner
 */

const exec = promisify(execFile);
/** @param {string} message */
const problem = (message, status = 409) => Object.assign(new Error(message), { status });
const operations = [
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
/** @param {string} path @param {Upstream|null} target @param {string|null} [gitDirectory] */
const upstreamIdentity = (path, target, gitDirectory) =>
  createHash('sha256')
    .update(JSON.stringify(gitDirectory === undefined ? [path, target] : [path, target, gitDirectory]))
    .digest('hex');
/** @param {string} path */
const directoryIdentity = path =>
  stat(path).then(
    info => `${info.dev}:${info.ino}:${info.birthtimeMs}`,
    () => null,
  );
/** @param {string|null} directory */
const opaqueDirectory = directory => directory && createHash('sha256').update(directory).digest('hex');
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
  /** @type {NodeJS.ProcessEnv} */
  const env = {
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

/** @type {GitRunner} */
export const runGit = async (path, args, { guard, input, prepare, maxBuffer = 2 * 1024 * 1024 } = {}) => {
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

/** @param {unknown} failure */
function fetchFailure(failure) {
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

/** @param {string} url @param {LinkedRepo} repo */
function matchesWatchedRemote(url, repo) {
  try {
    const target = parseRemote(url);
    return /** @type {const} */ (['organization', 'project', 'name']).every(key => target[key].toLowerCase() === repo[key]?.toLowerCase());
  } catch {
    return false;
  }
}

/** @param {string} output */
function readStatus(output) {
  /** @type {GitStatus} */
  const result = { branch: null, head: null, upstream: null, ahead: null, behind: null, dirty: false };
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
 * @param {GitStatus & { operation: string|undefined, observation: import('./checkout-observations.js').Observation|undefined, rewrite: unknown, target: Upstream|null }} facts
 * @returns {BlockedState|'behind'}
 */
function checkoutState({ operation, observation, rewrite, target, branch, head, upstream, ahead, behind, dirty }) {
  if (operation) return 'in-progress';
  if (!branch) return 'detached';
  if (!head) return 'unborn';
  if (observation?.missing) return 'upstream-missing';
  if (rewrite) return 'upstream-rewritten';
  if (observation?.failure) return 'fetch-failed';
  if (dirty && !(target && ahead === 0 && behind !== null && behind > 0)) return 'dirty';
  if (!upstream) return 'no-upstream';
  if (!target) return 'different-remote';
  if (ahead === null) return 'unknown';
  if (ahead && behind) return 'diverged';
  if (ahead) return 'ahead';
  if (behind) return 'behind';
  return 'current';
}

/** @param {unknown} value @returns {value is CheckoutIntent} */
export function isCheckoutIntent(value) {
  return hasCheckoutSelection(value) && typeof value.upstream === 'string';
}

/** @param {unknown} value @returns {value is SwitchIntent} */
export function isSwitchIntent(value) {
  return hasCheckoutSelection(value) && 'switchIdentity' in value && typeof value.switchIdentity === 'string';
}

/** @param {unknown} value @returns {value is CheckoutSelection} */
function hasCheckoutSelection(value) {
  if (!value || typeof value !== 'object') return false;
  const candidate = /** @type {Record<string, unknown>} */ (value);
  return (
    ['branch', 'head', 'identity'].every(key => typeof candidate[key] === 'string') &&
    (candidate.upstream === null || typeof candidate.upstream === 'string')
  );
}

/**
 * @param {{ run?: GitRunner, matchesRemote?: typeof matchesWatchedRemote, now?: () => number,
 *   followups?: import('./checkout-branches.js').Followups, findPulls?: import('./checkout-advice.js').FindCheckoutPulls, observations?: import('./checkout-observations.js').Observations }} [options]
 */
export function createCheckoutGit({
  run = runGit,
  matchesRemote = matchesWatchedRemote,
  now = Date.now,
  findPulls = async () => [],
  observations = memoryObservations(),
  followups = memoryFollowups(),
} = {}) {
  /** @type {Map<string, { path: string, until: number, value: Promise<CheckoutStatus> }>} */
  const readings = new Map();
  /** Active checkout write locks: repo IDs and canonical Git common directories currently updating. @type {Set<string>} */
  const updatingRepos = new Set();
  /** @type {Set<string>} */
  const updatingGitDirs = new Set();
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

  /** @param {LinkedRepo} repo @param {string} path @param {Upstream|null} target @param {string|null} gitDirectory */
  function observedAt(repo, path, target, gitDirectory) {
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

  /** Config keys the checkout or one of its submodules sets itself that would make Git run a command. @param {string} path */
  async function configuredCommands(path) {
    const keys = new Set();
    // Nothing in this scan needs the network; no transport may run while the config is still untrusted.
    const offline = { GIT_ALLOW_PROTOCOL: '' };
    const visited = new Set();
    /** @param {string} folder */
    const visit = async folder => {
      visited.add(await realpath(folder));
      // NUL-separated pairs of scope and key, so a subsection with a tab or newline stays one key.
      const listing = await run(folder, ['config', '--show-scope', '--includes', '--name-only', '--null', '--list'], { guard: offline });
      const fields = listing.split('\0');
      for (let i = 0; i + 1 < fields.length; i += 2)
        if ((fields[i] === 'local' || fields[i] === 'worktree') && commandKeys.test(fields[i + 1])) keys.add(fields[i + 1]);
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

  /** @param {LinkedRepo} repo */
  async function checkoutPath(repo) {
    if (!repo.localPath) throw problem('No local checkout linked.', 404);
    let path, keys;
    try {
      path = await realpath(repo.localPath);
      const root = (await run(path, ['rev-parse', '--show-toplevel'])).trimEnd();
      if ((await realpath(root)) === path) keys = await configuredCommands(path);
    } catch (error) {
      // The linked folder may have moved or Git may not be available; keep a reason this module gave itself.
      if (/** @type {{ status?: number }} */ (error).status) throw error;
    }
    if (!path || !keys) throw problem('The linked checkout is unavailable.', 404);
    refuseConfiguredCommands(keys);
    return path;
  }

  /** @param {string[]} keys */
  function refuseConfiguredCommands(keys) {
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

  /**
   * @param {string} path @param {LinkedRepo} repo @param {string|null} branch
   * @returns {Promise<{ target: Upstream|null, passwordInUrl?: boolean }>}
   */
  async function upstreamFor(path, repo, branch) {
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

  /** @param {string} path @param {LinkedRepo} repo @param {string} remote @param {string} source */
  async function remoteTarget(path, repo, remote, source) {
    const urls = (await run(path, ['remote', 'get-url', '--all', '--', remote])).trimEnd().split('\n');
    // Git would receive the URL on its command line, where other local users can read it.
    if (urls.some(hasRemoteCredentials)) return { target: null, passwordInUrl: true };
    const tracking = `refs/remotes/${remote}/${source.slice(11)}`;
    return { target: urls.length === 1 && matchesRemote(urls[0], repo) ? { remote, source, tracking, url: urls[0] } : null };
  }

  /** Finds an in-progress Git operation and a stable identity for the Git directory. @param {string} path */
  async function gitMarkers(path) {
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

  /** @param {string} path @param {LinkedRepo} repo @param {{ configChecked?: boolean }} [options] @returns {ReturnType<ReadCheckoutStatus>} */
  async function statusAt(path, repo, { configChecked = false } = {}) {
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

  /** @param {string} path @param {Upstream|null} target @param {import('./checkout-observations.js').Observation|undefined} observation */
  async function pendingRewrite(path, target, observation) {
    if (!target || observation?.rewrite || !observation?.pending?.length) return undefined;
    const tracked = await trackingTip(path, target.tracking, true);
    return tracked ? (await observedRewrite(run, path, observation.pending, tracked)).rewrite : undefined;
  }

  /** @param {string} path @param {string} tracking @param {boolean} [before] */
  async function trackingTip(path, tracking, before = false) {
    const args = before ? ['rev-parse', '--quiet', '--verify'] : ['rev-parse', '--verify'];
    const hash = (await run(path, [...args, `${tracking}^{commit}`]).catch(() => '')).trim();
    return isCommit(hash) ? hash : null;
  }

  /** @param {string} path @param {LinkedRepo} repo @param {{ configChecked?: boolean }} [options] @returns {Promise<CheckoutStatus>} */
  async function inspect(path, repo, { configChecked = false } = {}) {
    try {
      const { snapshot } = await statusAt(path, repo, { configChecked });
      return await branches.decorate(repo, path, snapshot);
    } catch {
      return { state: 'unavailable' };
    }
  }

  /** @param {LinkedRepo} repo @returns {Promise<CheckoutStatus>} */
  function status(repo) {
    if (!repo.localPath) return Promise.resolve({ state: 'not-linked' });
    const previous = readings.get(repo.id);
    if (previous?.path === repo.localPath && previous.until > now()) return previous.value;
    const value = checkoutPath(repo).then(
      path => inspect(path, repo, { configChecked: true }),
      /** @param {{ diagnostic?: import('./checkout-observations.js').CheckoutDiagnostic }} error @returns {CheckoutStatus} */
      error => (error.diagnostic ? { state: 'unavailable', diagnostic: error.diagnostic } : { state: 'unavailable' }),
    );
    readings.set(repo.id, { path: repo.localPath, until: now() + 5000, value });
    return value;
  }

  /** @param {string} path @param {LinkedRepo} repo @param {Upstream} target @param {ActiveCheckout} snapshot */
  async function readMissing(path, repo, target, snapshot) {
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

  /** @param {CheckoutReading} snapshot @param {Pick<CheckoutReading, 'branch'|'head'|'upstream'|'identity'>} expected */
  function matchesIntent(snapshot, expected) {
    return /** @type {const} */ (['branch', 'head', 'upstream', 'identity']).every(key => snapshot[key] === expected[key]);
  }

  /** @param {string} path @param {string|null} expected */
  async function verifyCheckoutDirectory(path, expected) {
    const gitDir = (await run(path, ['rev-parse', '--absolute-git-dir'])).trimEnd();
    if (!expected || !gitDir || opaqueDirectory(await directoryIdentity(gitDir)) !== expected)
      throw problem('The checkout changed. Review the current branch and try again.');
  }

  /** @template T @param {LinkedRepo} repo @param {(path: string) => Promise<T>} action */
  async function exclusively(repo, action) {
    if (updatingRepos.has(repo.id)) throw problem('This checkout is already updating. Try again in a moment.');
    updatingRepos.add(repo.id);
    readings.delete(repo.id);
    /** @type {string | null} */
    let commonDir = null;
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
      if (commonDir) updatingGitDirs.delete(commonDir);
    }
  }

  /** @param {string} path @param {Upstream} target */
  async function validateUpstream(path, target) {
    await run(path, ['check-ref-format', target.source]);
    await run(path, ['check-ref-format', target.tracking]);
    // Use the already validated URL, independent of a later remote-name edit.
    const effective = (await run(path, ['ls-remote', '--get-url', '--', target.url])).trimEnd();
    if (effective !== target.url) throw problem('Git rewrites this upstream. Review the configured remote in Git.');
    if (await isSymbolicRef(run, path, target.tracking)) throw problem('The upstream tracking ref is symbolic. Review it in Git.');
  }

  /** @param {string} path @param {Upstream} target @param {string|null} [destination] */
  async function fetchUpstream(path, target, destination = target.tracking) {
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

  /**
   * @param {LinkedRepo} repo @param {'check'|'pull'} operation @param {CheckoutIntent} expected
   * @returns {Promise<import('../src/contract.ts').CheckoutUpdateResult>}
   */
  function update(repo, operation, expected) {
    return exclusively(repo, async path => {
      const result = await updateAt(path, repo, operation, expected);
      return { ...result, checkout: await inspect(path, repo) };
    });
  }

  /**
   * @param {LinkedRepo} repo @param {import('./checkout-branches.js').BranchAction} action @param {CheckoutIntent} expected
   * @returns {Promise<import('../src/contract.ts').BranchActionResult>}
   */
  function branchAction(repo, action, expected) {
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

  /** @param {LinkedRepo} repo @param {string} name @param {SwitchIntent} expected
   * @param {{ eventId?: string, confirmation?: string }} [options]
   * @returns {Promise<import('../src/contract.ts').ActivitySwitchResult>}
   */
  function switchToActivityBranch(repo, name, expected, { eventId, confirmation } = {}) {
    return exclusively(repo, path => switchAt(path, repo, name, expected, { eventId, confirmation }));
  }

  /** Local branch names, read without the update lock. @param {LinkedRepo} repo */
  async function localBranches(repo) {
    const path = await checkoutPath(repo);
    const refs = await run(path, ['for-each-ref', '--format=%(refname)', 'refs/heads/']);
    return refs
      .split('\n')
      .filter(ref => ref.startsWith('refs/heads/'))
      .map(ref => ref.slice(11));
  }

  return { status, update, branchAction, switchToActivityBranch, localBranches };
}
