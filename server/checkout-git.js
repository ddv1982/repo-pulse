// @ts-check

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, realpath, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { parseRemote } from './repositories.js';
import { adviseMissingUpstream, ancestry, isCommit } from './checkout-advice.js';
import { branchFollowups, branchProblem, memoryFollowups } from './checkout-branches.js';
import { checkoutDiagnostic, memoryObservations, observedRewrite } from './checkout-observations.js';

/**
 * Checkouts belong to watched repositories, so their Azure identity is always present.
 * @typedef {import('./store.js').Repository} LinkedRepo
 * @typedef {{ branch: string|null, head: string|null, upstream: string|null, ahead: number|null, behind: number|null, dirty: boolean }} GitStatus
 * @typedef {{ branch: string, head: string, upstream: string, identity: string }} CheckoutIntent
 * @typedef {GitStatus & { identity: string, lastBranchCheck?: { at: string, matchesFetchedTip: boolean } }} CheckoutReading
 * @typedef {{ remote: string, source: string, tracking: string, url: string }} Upstream
 * @typedef {'in-progress'|'detached'|'unborn'|'dirty'|'no-upstream'|'different-remote'|'upstream-missing'|'upstream-rewritten'|'fetch-failed'|'unknown'|'diverged'|'ahead'|'current'} BlockedState
 * @typedef {CheckoutIntent & CheckoutReading & { state: 'behind', canCheck: true, canPull: true }} PullableCheckout
 * @typedef {CheckoutReading & { state: BlockedState, canCheck: boolean, canPull: false, diagnostic?: import('./checkout-observations.js').CheckoutDiagnostic }} BlockedCheckout
 * @typedef {PullableCheckout | BlockedCheckout} ActiveCheckout
 * @typedef {ActiveCheckout & { followup?: import('./checkout-branches.js').FollowupSummary }} DecoratedCheckout
 *   A checkout with an open branch follow-up names it, so the page can offer to review or remove the old branch.
 * @typedef {DecoratedCheckout | { state: 'unavailable'|'not-linked', diagnostic?: import('./checkout-observations.js').CheckoutDiagnostic }} CheckoutStatus
 * @typedef {(path: string, args: string[], options?: { guard?: NodeJS.ProcessEnv, input?: string, maxBuffer?: number }) => Promise<string>} GitRunner
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
// Keys in a checkout's own config that make Git run a command, change where or how it connects, or load more config
// later (conditional includes can switch on after a branch switch).
const commandKeys = new RegExp(
  [
    'filter\\..*\\.(?:clean|smudge|process)',
    'merge\\..*\\.driver',
    'core\\.(?:sshcommand|askpass|gitproxy|alternaterefscommand)',
    'credential\\.(?:.*\\.)?helper',
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
    'lfs\\.(?:customtransfer\\..*|standalonetransferagent|extension\\..*|url)',
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
const runGit = async (path, args, { guard, input, maxBuffer = 2 * 1024 * 1024 } = {}) => {
  const env = { ...gitEnvironment(), ...guard };
  const command = exec('git', ['-C', path, '-c', 'core.fsmonitor=false', ...args], {
    env,
    timeout: 45_000,
    maxBuffer,
    windowsHide: true,
  });
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

/** @param {string} url */
function hasPassword(url) {
  try {
    return Boolean(new URL(url).password);
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

/**
 * @param {{ snapshot: ActiveCheckout, target: Upstream|null }} reading @param {'check'|'pull'|'update-target'} operation
 * @returns {Upstream}
 */
function eligibleTarget({ snapshot, target }, operation) {
  if (
    !target ||
    !snapshot.canCheck ||
    (operation === 'pull' && !snapshot.canPull) ||
    (operation === 'update-target' && (snapshot.dirty || !['behind', 'current'].includes(snapshot.state)))
  ) {
    throw problem('The checkout is no longer eligible. Review its Git status and try again.');
  }
  return target;
}

/** @param {unknown} value @returns {value is CheckoutIntent} */
export function isCheckoutIntent(value) {
  if (!value || typeof value !== 'object') return false;
  const candidate = /** @type {Record<string, unknown>} */ (value);
  return ['branch', 'head', 'upstream', 'identity'].every(key => typeof candidate[key] === 'string');
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
  let updating = false;
  const branches = branchFollowups({ run, hooks, followups, statusAt, updateAt, readMissing, matchesIntent });

  /** Config keys the checkout or one of its submodules sets itself that would make Git run a command. @param {string} path */
  async function configuredCommands(path) {
    const keys = new Set();
    // Nothing in this scan needs the network; no transport may run while the config is still untrusted.
    const offline = { GIT_ALLOW_PROTOCOL: '' };
    /** @param {string} folder */
    const visit = async folder => {
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
    const message = `This checkout's own Git config sets ${keys.join(', ')}.`;
    const suggestion = 'Repo Pulse does not run commands from a checkout. Move these settings to your global Git config or remove them.';
    throw Object.assign(problem(`${message} ${suggestion}`), {
      diagnostic: { title: 'Checkout Git config runs commands', message, suggestion },
    });
  }

  /**
   * @param {string} path @param {LinkedRepo} repo @param {string|null} branch @param {string|null} upstream
   * @returns {Promise<{ target: Upstream|null, passwordInUrl?: boolean }>}
   */
  async function upstreamFor(path, repo, branch, upstream) {
    if (!branch || !upstream) return { target: null };
    const raw = await run(path, [
      'for-each-ref',
      '--format=%(upstream:remotename)%00%(upstream:remoteref)%00%(upstream)',
      '--',
      `refs/heads/${branch}`,
    ]);
    const [remote, source, tracking] = raw.trimEnd().split('\0');
    if (!remote || !source?.startsWith('refs/heads/') || tracking !== `refs/remotes/${remote}/${source.slice(11)}`) return { target: null };
    const urls = (await run(path, ['remote', 'get-url', '--all', '--', remote])).trimEnd().split('\n');
    // Git would receive the URL on its command line, where other local users can read it.
    if (urls.some(hasPassword)) return { target: null, passwordInUrl: true };
    return { target: urls.length === 1 && matchesRemote(urls[0], repo) ? { remote, source, tracking, url: urls[0] } : null };
  }

  /** Finds an in-progress Git operation and a stable identity for the Git directory. @param {string} path */
  async function gitMarkers(path) {
    const markers = (await run(path, ['rev-parse', ...operations.flatMap(([marker]) => ['--git-path', marker]), '--git-dir']))
      .trimEnd()
      .split('\n');
    const gitDir = markers.pop();
    const gitDirectory = gitDir
      ? await stat(resolve(path, gitDir)).then(
          info => `${info.dev}:${info.ino}:${info.birthtimeMs}`,
          () => null,
        )
      : null;
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

  /** @param {string} path @param {LinkedRepo} repo @returns {Promise<{ snapshot: ActiveCheckout, target: Upstream|null, gitDirectory: string|null }>} */
  async function statusAt(path, repo) {
    // Checked again here because a Pull or branch switch can bring in a gitlink over a nested checkout.
    refuseConfiguredCommands(await configuredCommands(path));
    const snapshot = readStatus(
      await run(path, ['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=normal', '--ignore-submodules=none']),
    );
    const { branch, head, upstream } = snapshot;
    const { target, passwordInUrl } = await upstreamFor(path, repo, branch, upstream);
    const { operation, gitDirectory } = await gitMarkers(path);
    const identity = createHash('sha256')
      .update(JSON.stringify([path, target]))
      .digest('hex');
    const observed = observations.get(repo.id);
    const observation = observed?.identity === identity ? observed : undefined;
    const last = observation?.lastCheck;
    const lastBranchCheck =
      last && gitDirectory && last.gitDirectory === gitDirectory && last.branch === branch && target
        ? { at: last.at, matchesFetchedTip: (await trackingTip(path, target.tracking, true)) === last.tip }
        : undefined;
    const rewrite = observation?.rewrite;
    const state = checkoutState({ ...snapshot, operation, observation, rewrite, target });
    if (state === 'behind') {
      if (!branch || !head || !upstream || !target) throw problem('The upstream changed during the status check.');
      return {
        snapshot: { ...snapshot, branch, head, upstream, identity, lastBranchCheck, state, canCheck: true, canPull: true },
        target,
        gitDirectory,
      };
    }
    const diagnostic = passwordInUrl
      ? {
          title: 'Remote URL contains a password',
          suggestion: 'Remove the password from the remote URL and let a Git credential helper sign in.',
        }
      : checkoutDiagnostic(state, snapshot, observation, operation, rewrite);
    return {
      snapshot: {
        ...snapshot,
        identity,
        lastBranchCheck,
        state,
        canCheck: Boolean(target && head && !operation),
        canPull: false,
        diagnostic,
      },
      target,
      gitDirectory,
    };
  }

  /** @param {string} path @param {string} tracking @param {boolean} [before] */
  async function trackingTip(path, tracking, before = false) {
    const args = before ? ['rev-parse', '--quiet', '--verify'] : ['rev-parse', '--verify'];
    const hash = (await run(path, [...args, `${tracking}^{commit}`]).catch(() => '')).trim();
    return isCommit(hash) ? hash : null;
  }

  /** @param {string} path @param {LinkedRepo} repo @returns {Promise<CheckoutStatus>} */
  async function inspect(path, repo) {
    try {
      const { snapshot } = await statusAt(path, repo);
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
      path => inspect(path, repo),
      /** @param {{ diagnostic?: import('./checkout-observations.js').CheckoutDiagnostic }} error @returns {CheckoutStatus} */
      error => (error.diagnostic ? { state: 'unavailable', diagnostic: error.diagnostic } : { state: 'unavailable' }),
    );
    readings.set(repo.id, { path: repo.localPath, until: now() + 5000, value });
    return value;
  }

  /** @param {string} path @param {string} head @param {string} tip */
  async function refuseIgnoredOverlap(path, head, tip) {
    const additions = (await run(path, ['diff', '--no-renames', '--diff-filter=A', '--name-only', '-z', head, tip, '--']))
      .split('\0')
      .filter(Boolean);
    if (!additions.length) return;
    // Git reports an ignored-file overlap like any untracked one, so name it before merging.
    const ignored = (await run(path, ['ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '-z']))
      .split('\0')
      .filter(Boolean)
      .map(name => name.replace(/\/$/, '').toLowerCase());
    if (
      additions.some(name => {
        const incoming = name.toLowerCase();
        return ignored.some(local => local === incoming || local.startsWith(`${incoming}/`) || incoming.startsWith(`${local}/`));
      })
    )
      throw problem('Incoming files overlap ignored local files. Move them before pulling.');
  }

  /** @param {string} path @param {string} branch @param {string} tip */
  async function fastForward(path, branch, tip) {
    try {
      // A strategy from branch.<name>.mergeOptions or pull.twohead makes even --ff-only create a merge commit,
      // so both are cleared for this merge. --no-squash keeps the earlier guard against a configured --squash.
      // The branch name goes through the config environment, because a name may contain '=', which -c splits on.
      const count = Number(process.env.GIT_CONFIG_COUNT) || 0;
      const clearMergeOptions = {
        GIT_CONFIG_COUNT: String(count + 1),
        [`GIT_CONFIG_KEY_${count}`]: `branch.${branch}.mergeOptions`,
        [`GIT_CONFIG_VALUE_${count}`]: '',
      };
      await run(
        path,
        [
          '-c',
          'pull.twohead=ort',
          '-c',
          `core.hooksPath=${hooks}`,
          '-c',
          'maintenance.auto=false',
          '-c',
          'submodule.recurse=false',
          'merge',
          '--ff-only',
          '--no-squash',
          '--no-autostash',
          '--no-overwrite-ignore',
          '--no-stat',
          tip,
        ],
        { guard: clearMergeOptions },
      );
    } catch {
      throw problem(
        'Pull stopped before the branch was updated. Git could not preserve the local checkout. Review overlapping changes in Git and try again.',
      );
    }
    if ((await run(path, ['rev-parse', 'HEAD'])).trim() !== tip)
      throw problem('Git did not move the branch to the upstream commit. Review the checkout in Git.');
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

  /** @template T @param {LinkedRepo} repo @param {(path: string) => Promise<T>} action */
  async function exclusively(repo, action) {
    if (updating) throw problem('Another checkout is updating. Try again in a moment.');
    updating = true;
    readings.delete(repo.id);
    try {
      return await action(await checkoutPath(repo));
    } finally {
      readings.delete(repo.id);
      updating = false;
    }
  }

  /** @param {string} path @param {Upstream} target */
  async function validateUpstream(path, target) {
    await run(path, ['check-ref-format', target.source]);
    await run(path, ['check-ref-format', target.tracking]);
    const symbolicTracking = (await run(path, ['for-each-ref', '--format=%(symref)', '--', target.tracking])).trim();
    if (symbolicTracking) throw problem('The upstream tracking ref is symbolic. Review it in Git.');
    // Use the already validated URL, independent of a later remote-name edit.
    const effective = (await run(path, ['ls-remote', '--get-url', '--', target.url])).trimEnd();
    if (effective !== target.url) throw problem('Git rewrites this upstream. Review the configured remote in Git.');
  }

  /** Saves the pre-fetch tracking samples and returns what the later observation saves build on.
   * @param {string} path @param {LinkedRepo} repo @param {ActiveCheckout} snapshot @param {Upstream} target */
  async function recordBaseline(path, repo, snapshot, target) {
    const trackingBeforeFetch = await trackingTip(path, target.tracking, true);
    const recorded = observations.get(repo.id);
    const saved = recorded?.identity === snapshot.identity ? recorded : undefined;
    const baselines = [
      ...new Set([trackingBeforeFetch, ...(saved?.pending ?? []), saved?.tracking].filter(value => typeof value === 'string')),
    ];
    const baseline = { identity: snapshot.identity, tracking: saved?.tracking, lastCheck: saved?.lastCheck, pending: baselines };
    const canClearRewrite = Boolean(
      !snapshot.dirty && saved?.rewrite && (snapshot.head === saved.rewrite.tip || (snapshot.ahead === 0 && snapshot.behind === 0)),
    );
    // Keep both tracking samples if Git advances the ref before this check completes.
    if (baselines.length) observations.save(repo.id, { ...saved, ...baseline });
    return { saved, baselines, baseline, canClearRewrite, retainedRewrite: saved?.rewrite };
  }

  /** @typedef {Awaited<ReturnType<typeof recordBaseline>>} Baseline */

  /** @param {string} path @param {Upstream} target */
  async function fetchUpstream(path, target) {
    await run(path, [
      '-c',
      `core.hooksPath=${hooks}`,
      'fetch',
      '--no-tags',
      '--no-recurse-submodules',
      '--no-write-fetch-head',
      '--no-auto-maintenance',
      '--refmap=',
      '--',
      target.url,
      `+${target.source}:${target.tracking}`,
    ]);
  }

  /** @param {string} path @param {LinkedRepo} repo @param {'check'|'pull'|'update-target'} operation
   * @param {ActiveCheckout} snapshot @param {Upstream} target @param {Baseline} recorded @param {unknown} failure */
  async function recordFetchFailure(path, repo, operation, snapshot, target, { baseline, retainedRewrite }, failure) {
    const reason = fetchFailure(failure);
    const advice = reason === 'missing-ref' && operation !== 'update-target' ? await readMissing(path, repo, target, snapshot) : undefined;
    const { snapshot: current } = await statusAt(path, repo);
    if (!matchesIntent(snapshot, current)) throw problem('The checkout changed during the check. Review the current branch and try again.');
    observations.save(repo.id, {
      ...baseline,
      rewrite: retainedRewrite,
      ...(reason === 'missing-ref' && snapshot.head
        ? { missing: { head: snapshot.head, advice } }
        : reason === 'missing-ref'
          ? {}
          : { failure: reason }),
    });
    return { checkout: (await statusAt(path, repo)).snapshot, updated: false };
  }

  /** Records the fetched tip and any rewrite, then rereads the checkout and records the branch check.
   * @param {string} path @param {LinkedRepo} repo @param {{ snapshot: ActiveCheckout, gitDirectory: string|null }} before
   * @param {Upstream} target @param {Baseline} recorded */
  async function recordFetch(path, repo, before, target, { saved, baselines, canClearRewrite, retainedRewrite }) {
    const { snapshot } = before;
    const fetchedAt = new Date(now()).toISOString();
    const tip = await trackingTip(path, target.tracking);
    if (!tip) throw problem('The upstream commit is unavailable.');
    const { pending, rewrite: observed } = await observedRewrite(run, path, baselines, tip);
    const retained = retainedRewrite?.verified && (!canClearRewrite || pending.length) ? retainedRewrite : undefined;
    const rewrite = observed?.verified ? observed : (retained ?? observed);
    const observedAfterFetch = { identity: snapshot.identity, tracking: tip, pending, rewrite, lastCheck: saved?.lastCheck };
    observations.save(repo.id, observedAfterFetch);
    const after = await statusAt(path, repo);
    if (!matchesIntent(snapshot, after.snapshot))
      throw problem('The checkout or its upstream changed during the check. The branch was not updated.');
    if (snapshot.branch && before.gitDirectory && before.gitDirectory === after.gitDirectory) {
      observations.save(repo.id, {
        ...observedAfterFetch,
        lastCheck: { branch: snapshot.branch, at: fetchedAt, tip, gitDirectory: before.gitDirectory },
      });
    }
    return { after: after.snapshot, tip };
  }

  /** Decides from the post-fetch reading whether to fast-forward, and does so.
   * @param {string} path @param {LinkedRepo} repo @param {'check'|'pull'|'update-target'} operation
   * @param {ActiveCheckout} after @param {string} tip @param {string} [result] */
  async function finishUpdate(path, repo, operation, after, tip, result) {
    if (operation === 'check' || after.state === 'upstream-rewritten') return { checkout: after, updated: false };
    if (!['behind', 'current'].includes(after.state) || (operation === 'update-target' && after.dirty)) {
      throw problem('The checkout or its upstream changed during the check. The branch was not updated.');
    }
    if (result && (await ancestry(run, path, result, tip)) !== true) {
      throw problem('The latest upstream could not be verified to contain the PR result.');
    }
    if (after.state === 'current') return { checkout: after, updated: false };
    if (!after.canPull) throw problem('The checkout is no longer eligible.');
    // Checked after identity and eligibility so a rewritten upstream or changed checkout is reported first.
    await refuseIgnoredOverlap(path, after.head, tip);
    await run(path, ['merge-base', '--is-ancestor', after.head, tip]);
    await fastForward(path, after.branch, tip);
    try {
      return { checkout: (await statusAt(path, repo)).snapshot, updated: true };
    } catch (caught) {
      // The branch already moved, so no failure here may read as if Pull did nothing. Unexpected errors keep their text local.
      const error = /** @type {Error & { status?: number, diagnostic?: unknown }} */ (caught);
      const reason = error.status ? error.message : 'Review the checkout in Git.';
      throw Object.assign(problem(`The branch was updated to the upstream commit. ${reason}`, error.status === 404 ? 404 : 409), {
        diagnostic: error.diagnostic,
      });
    }
  }

  /** @param {string} path @param {LinkedRepo} repo @param {'check'|'pull'|'update-target'} operation
   * @param {Pick<CheckoutReading, 'branch'|'head'|'upstream'|'identity'>} expected @param {string} [result] */
  async function updateAt(path, repo, operation, expected, result) {
    try {
      const before = await statusAt(path, repo);
      const { snapshot } = before;
      if (!expected || !matchesIntent(snapshot, expected)) throw problem('The checkout changed. Review the current branch and try again.');
      const target = eligibleTarget(before, operation);
      await validateUpstream(path, target);
      const recorded = await recordBaseline(path, repo, snapshot, target);
      try {
        await fetchUpstream(path, target);
      } catch (failure) {
        return await recordFetchFailure(path, repo, operation, snapshot, target, recorded, failure);
      }
      const { after, tip } = await recordFetch(path, repo, before, target, recorded);
      return await finishUpdate(path, repo, operation, after, tip, result);
    } catch (error) {
      if (error instanceof Error && 'status' in error && (error.status === 404 || error.status === 409)) throw error;
      throw problem(
        operation === 'check'
          ? 'Could not check the upstream. Check Git access and try again.'
          : 'Git could not finish the update. Review the checkout and try again.',
      );
    }
  }

  /** @param {LinkedRepo} repo @param {'check'|'pull'} operation @param {CheckoutIntent} expected */
  function update(repo, operation, expected) {
    return exclusively(repo, async path => {
      const result = await updateAt(path, repo, operation, expected);
      return { ...result, checkout: await inspect(path, repo) };
    });
  }

  /** @param {LinkedRepo} repo @param {import('./checkout-branches.js').BranchAction} action @param {CheckoutIntent} expected */
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

  return { status, update, branchAction };
}
