// @ts-check

import { execFile, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { access, copyFile, open, realpath, rename, stat, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { promisify } from 'node:util';
import { parseRemote } from './repositories.js';
import { capturePullOwner, pullOwnerRunning } from './pull-owner.js';
import { adviseMissingUpstream, ancestry, isCommit } from './checkout-advice.js';
import { branchFollowups, branchProblem, memoryFollowups } from './checkout-branches.js';
import { checkoutDiagnostic, memoryObservations, observedRewrite } from './checkout-observations.js';

/**
 * @typedef {{ id: string, name?: string, organization?: string, project?: string, localPath?: string, azureId?: string }} LinkedRepo
 * @typedef {{ branch: string|null, head: string|null, upstream: string|null, ahead: number|null, behind: number|null, dirty: boolean }} GitStatus
 * @typedef {{ branch: string, head: string, upstream: string, identity: string }} CheckoutIntent
 * @typedef {GitStatus & { identity: string, lastBranchCheck?: { at: string, matchesFetchedTip: boolean } }} CheckoutReading
 * @typedef {{ remote: string, source: string, tracking: string, url: string }} Upstream
 * @typedef {'in-progress'|'detached'|'unborn'|'dirty'|'no-upstream'|'different-remote'|'upstream-missing'|'upstream-rewritten'|'fetch-failed'|'unknown'|'diverged'|'ahead'|'current'} BlockedState
 * @typedef {CheckoutIntent & CheckoutReading & { state: 'behind', canCheck: true, canPull: true }} PullableCheckout
 * @typedef {CheckoutReading & { state: BlockedState, canCheck: boolean, canPull: false, diagnostic?: import('./checkout-observations.js').CheckoutDiagnostic }} BlockedCheckout
 * @typedef {PullableCheckout | BlockedCheckout} ActiveCheckout
 * @typedef {import('./pull-owner.js').PullOwner & {id: string, branch: string, previous: string, tip: string, index: string}} PullOperation
 * @typedef {{ branch: string, previous: string, tip: string, lockPresent: boolean }} Recovery
 * @typedef {(Partial<CheckoutReading> & { state: 'pull-interrupted', canCheck: false, canPull: false, recovery: Recovery })
 *   | (Partial<CheckoutReading> & { state: 'pull-running', canCheck: false, canPull: false })} PendingCheckout
 * @typedef {ActiveCheckout | PendingCheckout | { state: 'unavailable'|'not-linked' }} CheckoutStatus
 * @typedef {{
 *   get: (path: string) => PullOperation|undefined,
 *   begin: (path: string, operation: PullOperation) => boolean,
 *   release: (path: string, operation: PullOperation) => void,
 *   clear: (path: string, operation: PullOperation) => void
 * }} PullJournal
 * @typedef {(path: string, args: string[], options?: { indexFile?: string, guard?: NodeJS.ProcessEnv, input?: string }) => Promise<string>} GitRunner
 */

const exec = promisify(execFile);
/** @param {string} message */
const problem = (message, status = 409) => Object.assign(new Error(message), { status });
const operations = [
  ['rebase-merge', 'Rebase'], ['rebase-apply/applying', 'Patch apply'], ['rebase-apply', 'Rebase'],
  ['MERGE_HEAD', 'Merge'], ['CHERRY_PICK_HEAD', 'Cherry-pick'], ['REVERT_HEAD', 'Revert'],
  ['BISECT_START', 'Bisect'], ['sequencer', 'Git operation'],
];
const hooks = process.platform === 'win32' ? 'NUL' : '/dev/null';

/** @returns {PullJournal} */
function memoryJournal() {
  /** @type {Map<string, PullOperation>} */
  const rows = new Map();
  return {
    get: path => rows.get(path),
    begin(path, operation) {
      if (rows.has(path)) return false;
      rows.set(path, operation);
      return true;
    },
    release: (path, operation) => { rows.set(path, { ...operation, pid: null }); },
    clear: path => { rows.delete(path); },
  };
}

/** @param {string} [indexFile] */
function gitEnvironment(indexFile) {
  /** @type {NodeJS.ProcessEnv} */
  const env = { ...process.env, LC_ALL: 'C', GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'Never',
    GIT_OPTIONAL_LOCKS: '0', GIT_NO_LAZY_FETCH: '1', GIT_NO_REPLACE_OBJECTS: '1' };
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_NAMESPACE']) delete env[key];
  if (indexFile) env.GIT_INDEX_FILE = indexFile;
  return env;
}

/** @type {GitRunner} */
const runGit = async (path, args, { indexFile, guard, input } = {}) => {
  const env = { ...gitEnvironment(indexFile), ...guard };
  const command = exec('git', ['-C', path, '-c', 'core.fsmonitor=false', ...args], { env, timeout: 45_000, maxBuffer: 2 * 1024 * 1024, windowsHide: true });
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
  if (/authentication failed|could not read (username|password)|terminal prompts disabled|permission denied \(publickey\)|returned error: 401/i.test(stderr)) {
    return { title: 'Git authentication failed', suggestion: 'Check Git credentials for this checkout and try again.' };
  }
  if (/returned error: 403|access denied|repository.*not found|TF401019/i.test(stderr)) {
    return { title: 'Git could not access the repository', suggestion: 'Check your permissions and configured remote.' };
  }
  if (/could not resolve|failed to connect|timed out|network is unreachable/i.test(stderr) ||
    (failure instanceof Error && 'killed' in failure && failure.killed)) {
    return { title: 'Git could not reach the remote', suggestion: 'Check your connection and try again.' };
  }
  return { title: 'Git could not fetch the tracked branch', suggestion: 'Check the upstream from your terminal and try again.' };
}

/**
 * @param {string} path @param {string} previous @param {string} tip @param {string} tracking
 * @param {(commit: () => Promise<void>) => Promise<void>} apply
 */
async function withLockedRefs(path, previous, tip, tracking, apply) {
  const child = spawn('git', ['-C', path, '-c', `core.hooksPath=${hooks}`, '-c', 'core.filesRefLockTimeout=1000',
    'update-ref', '-m', 'Repo Pulse: fast-forward', '--stdin'], {
    env: gitEnvironment(), windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'],
  });
  child.stdin.on('error', () => {});
  child.on('error', () => {});
  const closed = new Promise(done => child.once('close', done));
  const replies = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  /** @param {string} line */
  async function expect(line) {
    if ((await replies.next()).value !== line) throw problem('Git refs changed or are locked. Review the checkout and try again.');
  }
  try {
    child.stdin.write(`start\nupdate HEAD ${tip} ${previous}\nverify ${tracking} ${tip}\nprepare\n`);
    await expect('start: ok');
    await expect('prepare: ok');
    await apply(async () => {
      child.stdin.write('commit\n');
      await expect('commit: ok');
    });
  } finally {
    child.stdin.end();
    await closed;
  }
}

/** @param {string} url @param {LinkedRepo} repo */
function matchesWatchedRemote(url, repo) {
  try {
    const target = parseRemote(url);
    return (/** @type {const} */ (['organization', 'project', 'name'])).every(key => target[key].toLowerCase() === repo[key]?.toLowerCase());
  } catch { return false; }
}

/** @param {string} output */
function readStatus(output) {
  /** @type {GitStatus} */
  const result = { branch: null, head: null, upstream: null, ahead: null, behind: null, dirty: false };
  for (const record of output.split('\0')) {
    if (!record) continue;
    if (!record.startsWith('# ')) { result.dirty = true; break; }
    const space = record.indexOf(' ', 2);
    const key = record.slice(2, space), value = record.slice(space + 1);
    if (key === 'branch.head' && value !== '(detached)') result.branch = value;
    if (key === 'branch.oid' && value !== '(initial)') result.head = value;
    if (key === 'branch.upstream') result.upstream = value;
    if (key === 'branch.ab') {
      const counts = /^\+(\d+) -(\d+)$/.exec(value);
      if (counts) { result.ahead = Number(counts[1]); result.behind = Number(counts[2]); }
    }
  }
  return result;
}

/** @param {unknown} value @returns {value is CheckoutIntent} */
export function isCheckoutIntent(value) {
  if (!value || typeof value !== 'object') return false;
  const candidate = /** @type {Record<string, unknown>} */ (value);
  return ['branch', 'head', 'upstream', 'identity'].every(key => typeof candidate[key] === 'string');
}

/**
 * @param {{ run?: GitRunner, matchesRemote?: typeof matchesWatchedRemote, now?: () => number,
 *   journal?: PullJournal, publishIndex?: (lock: string, index: string) => Promise<void>,
 *   followups?: import('./checkout-branches.js').Followups, findPulls?: import('./checkout-advice.js').FindCheckoutPulls, observations?: import('./checkout-observations.js').Observations }} [options]
 */
export function createCheckoutGit({ run = runGit, matchesRemote = matchesWatchedRemote, now = Date.now, journal = memoryJournal(),
  publishIndex = rename, findPulls = async () => [], observations = memoryObservations(), followups = memoryFollowups() } = {}) {
  /** @type {Map<string, { path: string, until: number, value: Promise<CheckoutStatus> }>} */
  const readings = new Map();
  let updating = false;
  const branches = branchFollowups({ run, hooks, followups, statusAt, interrupted, updateAt, readMissing, matchesIntent });

  /** @param {LinkedRepo} repo */
  async function checkoutPath(repo) {
    if (!repo.localPath) throw problem('No local checkout linked.', 404);
    try {
      const path = await realpath(repo.localPath);
      const root = (await run(path, ['rev-parse', '--show-toplevel'])).trimEnd();
      if (await realpath(root) === path) return path;
    } catch { /* The linked folder may have moved or Git may not be available. */ }
    throw problem('The linked checkout is unavailable.', 404);
  }

  /** @param {string} path @param {LinkedRepo} repo @param {string|null} branch @param {string|null} upstream @returns {Promise<Upstream|null>} */
  async function upstreamFor(path, repo, branch, upstream) {
    if (!branch || !upstream) return null;
    const raw = await run(path, ['for-each-ref', '--format=%(upstream:remotename)%00%(upstream:remoteref)%00%(upstream)', '--', `refs/heads/${branch}`]);
    const [remote, source, tracking] = raw.trimEnd().split('\0');
    if (!remote || !source?.startsWith('refs/heads/') || tracking !== `refs/remotes/${remote}/${source.slice(11)}`) return null;
    const urls = (await run(path, ['remote', 'get-url', '--all', '--', remote])).trimEnd().split('\n');
    return urls.length === 1 && matchesRemote(urls[0], repo) ? { remote, source, tracking, url: urls[0] } : null;
  }

  /** @param {string} path @param {LinkedRepo} repo @returns {Promise<{ snapshot: ActiveCheckout, target: Upstream|null, gitDirectory: string|null }>} */
  async function statusAt(path, repo) {
    const snapshot = readStatus(await run(path, ['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=normal', '--ignore-submodules=none']));
    const { branch, head, upstream, ahead, behind, dirty } = snapshot;
    const target = await upstreamFor(path, repo, branch, upstream);
    const markers = (await run(path, ['rev-parse', ...operations.flatMap(([marker]) => ['--git-path', marker]), '--git-dir'])).trimEnd().split('\n');
    const gitDir = markers.pop();
    const gitDirectory = gitDir ? await stat(resolve(path, gitDir))
      .then(info => `${info.dev}:${info.ino}:${info.birthtimeMs}`, () => null) : null;
    const found = await Promise.all(markers.map(marker => access(resolve(path, marker)).then(() => true, () => false)));
    const operation = operations[found.indexOf(true)]?.[1];
    const identity = createHash('sha256').update(JSON.stringify([path, target])).digest('hex');
    const observed = observations.get(repo.id);
    const observation = observed?.identity === identity ? observed : undefined;
    const last = observation?.lastCheck;
    const lastBranchCheck = last && gitDirectory && last.gitDirectory === gitDirectory && last.branch === branch && target
      ? { at: last.at, matchesFetchedTip: await trackingTip(path, target.tracking, true) === last.tip }
      : undefined;
    const rewrite = observation?.rewrite;
    const state = operation ? 'in-progress' : !branch ? 'detached' : !head ? 'unborn'
      : observation?.missing ? 'upstream-missing' : rewrite ? 'upstream-rewritten'
      : observation?.failure ? 'fetch-failed'
        : dirty && !(target && ahead === 0 && behind !== null && behind > 0) ? 'dirty'
        : !upstream ? 'no-upstream' : !target ? 'different-remote' : ahead === null ? 'unknown'
          : ahead && behind ? 'diverged' : ahead ? 'ahead' : behind ? 'behind' : 'current';
    if (state === 'behind') {
      if (!branch || !head || !upstream || !target) throw problem('The upstream changed during the status check.');
      return { snapshot: { ...snapshot, branch, head, upstream, identity, lastBranchCheck, state, canCheck: true, canPull: true }, target, gitDirectory };
    }
    const diagnostic = checkoutDiagnostic(state, snapshot, observation, operation, rewrite);
    return { snapshot: { ...snapshot, identity, lastBranchCheck, state, canCheck: Boolean(target && head && !operation), canPull: false, diagnostic }, target, gitDirectory };
  }

  /** @param {string} path @param {string} tracking @param {boolean} [before] */
  async function trackingTip(path, tracking, before = false) {
    const args = before ? ['rev-parse', '--quiet', '--verify'] : ['rev-parse', '--verify'];
    const hash = (await run(path, [...args, `${tracking}^{commit}`]).catch(() => '')).trim();
    return isCommit(hash) ? hash : null;
  }

  /** @param {string} path @param {ActiveCheckout} [snapshot] @returns {Promise<PendingCheckout|null>} */
  async function interrupted(path, snapshot) {
    const operation = journal.get(path);
    if (!operation) return null;
    const { branch, previous, tip, index } = operation;
    if (await pullOwnerRunning(operation)) return { ...snapshot, state: 'pull-running', canCheck: false, canPull: false };
    const lockPresent = await access(`${index}.lock`).then(() => true, error => error.code !== 'ENOENT');
    const atExpectedCommit = snapshot?.branch === branch && (snapshot.head === previous || snapshot.head === tip);
    if (atExpectedCommit && !snapshot.dirty && snapshot.state !== 'in-progress' && !lockPresent) {
      journal.clear(path, operation);
      return null;
    }
    return {
      ...snapshot, state: 'pull-interrupted', canCheck: false, canPull: false,
      recovery: { branch, previous, tip, lockPresent },
    };
  }

  /** @param {string} path @param {LinkedRepo} repo @returns {Promise<CheckoutStatus>} */
  async function inspect(path, repo) {
    try {
      const { snapshot } = await statusAt(path, repo);
      return await interrupted(path, snapshot) || branches.decorate(repo, path, snapshot);
    } catch {
      return await interrupted(path) || { state: 'unavailable' };
    }
  }

  /** @param {LinkedRepo} repo @returns {Promise<CheckoutStatus>} */
  function status(repo) {
    if (!repo.localPath) return Promise.resolve({ state: 'not-linked' });
    const previous = readings.get(repo.id);
    if (previous?.path === repo.localPath && previous.until > now()) return previous.value;
    const value = checkoutPath(repo).then(path => inspect(path, repo), () => /** @type {const} */ ({ state: 'unavailable' }));
    readings.set(repo.id, { path: repo.localPath, until: now() + 5000, value });
    return value;
  }

  /**
   * @param {string} path @param {LinkedRepo} repo @param {PullableCheckout} snapshot @param {Upstream} target
   * @param {string} tip @param {(current: CheckoutReading) => boolean} sameCheckout @param {boolean} requireClean
   */
  async function fastForward(path, repo, snapshot, target, tip, sameCheckout, requireClean) {
    const index = resolve(path, (await run(path, ['rev-parse', '--git-path', 'index'])).trimEnd());
    const lock = `${index}.lock`;
    const operation = { ...await capturePullOwner(), id: randomUUID(), branch: snapshot.branch, previous: snapshot.head, tip, index };
    if (!journal.begin(path, operation)) throw problem('A previous Pull must be resolved in Git before trying again.');
    let ownLock = false, writing = false, lockIdentity;
    try {
      const handle = await open(lock, 'wx', 0o600);
      ownLock = true;
      try { lockIdentity = await handle.stat(); } finally { await handle.close(); }
      await copyFile(index, lock);
      await withLockedRefs(path, snapshot.head, tip, target.tracking, async commit => {
        const { snapshot: current } = await statusAt(path, repo);
        if (!sameCheckout(current) || !current.canPull || (requireClean && current.dirty)) throw problem('The checkout changed. The branch was not updated.');
        const additions = (await run(path, ['diff', '--no-renames', '--diff-filter=A', '--name-only', '-z', snapshot.head, tip, '--'])).split('\0').filter(Boolean);
        if (additions.length) {
          // Unlike merge --no-overwrite-ignore, read-tree allows ignored paths to be replaced.
          const ignored = (await run(path, ['ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '-z']))
            .split('\0').filter(Boolean).map(name => name.replace(/\/$/, '').toLowerCase());
          if (additions.some(name => {
            const incoming = name.toLowerCase();
            return ignored.some(local => local === incoming || local.startsWith(`${incoming}/`) || incoming.startsWith(`${local}/`));
          })) throw problem('Incoming files overlap ignored local files. Move them before pulling.');
        }
        const updateTree = ['-m', '-u', '--no-recurse-submodules', snapshot.head, tip];
        // Refresh the private index so files restored to their original content pass Git's stat checks.
        await run(path, ['update-index', '-q', '--refresh'], { indexFile: lock });
        lockIdentity = await stat(lock);
        // Check through the locked index before starting worktree writes or retaining a recovery journal.
        try {
          await run(path, ['read-tree', '--dry-run', ...updateTree], { indexFile: lock });
        } catch {
          throw problem('Pull stopped before the branch was updated. Git could not preserve the local checkout. Review overlapping changes in Git and try again.');
        }
        writing = true;
        await run(path, ['read-tree', ...updateTree], { indexFile: lock });
        await commit();
        await publishIndex(lock, index);
        ownLock = false;
      });
    } finally {
      try {
        if (ownLock && !writing) {
          const currentLock = await stat(lock);
          if (!lockIdentity || currentLock.ino !== lockIdentity.ino || currentLock.dev !== lockIdentity.dev) {
            throw problem('The index lock changed. Review the checkout in Git.');
          }
          await unlink(lock);
        }
        if (!ownLock || !writing) journal.clear(path, operation);
        else journal.release(path, operation);
      } catch (error) {
        journal.release(path, operation);
        throw error;
      }
    }
  }

  /** @param {string} path @param {LinkedRepo} repo @param {Upstream} target @param {ActiveCheckout} snapshot */
  async function readMissing(path, repo, target, snapshot) {
    return snapshot.head ? adviseMissingUpstream({ run, find: findPulls, path, repo, url: target.url,
      source: target.source, head: snapshot.head, branch: snapshot.branch }).catch(() => undefined) : undefined;
  }

  /** @param {CheckoutReading} snapshot @param {Pick<CheckoutReading, 'branch'|'head'|'upstream'|'identity'>} expected */
  function matchesIntent(snapshot, expected) {
    return (/** @type {const} */ (['branch', 'head', 'upstream', 'identity'])).every(key => snapshot[key] === expected[key]);
  }

  /** @template T @param {LinkedRepo} repo @param {(path: string) => Promise<T>} action */
  async function exclusively(repo, action) {
    if (updating) throw problem('Another checkout is updating. Try again in a moment.');
    updating = true;
    readings.delete(repo.id);
    try { return await action(await checkoutPath(repo)); }
    finally {
      readings.delete(repo.id);
      updating = false;
    }
  }

  /** @param {string} path @param {LinkedRepo} repo @param {'check'|'pull'|'update-target'} operation
   * @param {Pick<CheckoutReading, 'branch'|'head'|'upstream'|'identity'>} expected @param {string} [result] */
  async function updateAt(path, repo, operation, expected, result) {
    try {
      const before = await statusAt(path, repo);
      const { snapshot, target } = before;
      if (await interrupted(path, snapshot)) throw problem('A previous Pull must be resolved in Git before trying again.');
      /** @param {Pick<CheckoutReading, 'branch'|'head'|'upstream'|'identity'>} current */
      const sameCheckout = current => matchesIntent(snapshot, current);
      if (!expected || !sameCheckout(expected)) throw problem('The checkout changed. Review the current branch and try again.');
      if (!target || !snapshot.canCheck || (operation === 'pull' && !snapshot.canPull) ||
        (operation === 'update-target' && (snapshot.dirty || !['behind', 'current'].includes(snapshot.state)))) {
        throw problem('The checkout is no longer eligible. Review its Git status and try again.');
      }
      await run(path, ['check-ref-format', target.source]);
      await run(path, ['check-ref-format', target.tracking]);
      const symbolicTracking = (await run(path, ['for-each-ref', '--format=%(symref)', '--', target.tracking])).trim();
      if (symbolicTracking) throw problem('The upstream tracking ref is symbolic. Review it in Git.');
      // Use the already validated URL, independent of a later remote-name edit.
      const effective = (await run(path, ['ls-remote', '--get-url', '--', target.url])).trimEnd();
      if (effective !== target.url) throw problem('Git rewrites this upstream. Review the configured remote in Git.');
      const trackingBeforeFetch = await trackingTip(path, target.tracking, true);
      const recorded = observations.get(repo.id);
      const saved = recorded?.identity === snapshot.identity ? recorded : undefined;
      const baselines = [...new Set([trackingBeforeFetch, ...(saved?.pending ?? []), saved?.tracking]
        .filter(value => typeof value === 'string'))];
      const baseline = { identity: snapshot.identity, tracking: saved?.tracking, lastCheck: saved?.lastCheck, pending: baselines };
      const canClearRewrite = Boolean(!snapshot.dirty && saved?.rewrite &&
        (snapshot.head === saved.rewrite.tip || (snapshot.ahead === 0 && snapshot.behind === 0)));
      const retainedRewrite = saved?.rewrite;
      // Keep both tracking samples if Git advances the ref before this check completes.
      if (baselines.length) observations.save(repo.id, { ...saved, ...baseline });
      try {
        await run(path, ['-c', `core.hooksPath=${hooks}`, 'fetch', '--no-tags', '--no-recurse-submodules', '--no-write-fetch-head',
          '--no-auto-maintenance', '--refmap=', '--', target.url, `+${target.source}:${target.tracking}`]);
      } catch (failure) {
        const reason = fetchFailure(failure);
        const advice = reason === 'missing-ref' && operation !== 'update-target' ? await readMissing(path, repo, target, snapshot) : undefined;
        const { snapshot: current } = await statusAt(path, repo);
        if (!sameCheckout(current)) throw problem('The checkout changed during the check. Review the current branch and try again.');
        observations.save(repo.id, { ...baseline, rewrite: retainedRewrite,
          ...(reason === 'missing-ref' && snapshot.head ? { missing: { head: snapshot.head, advice } }
            : reason === 'missing-ref' ? {} : { failure: reason }),
        });
        return { checkout: (await statusAt(path, repo)).snapshot, updated: false };
      }
      const fetchedAt = new Date(now()).toISOString();
      const tip = await trackingTip(path, target.tracking);
      if (!tip) throw problem('The upstream commit is unavailable.');
      const { pending, rewrite: observed } = await observedRewrite(run, path, baselines, tip);
      const retained = retainedRewrite?.verified && (!canClearRewrite || pending.length) ? retainedRewrite : undefined;
      const rewrite = observed?.verified ? observed : retained ?? observed;
      const observedAfterFetch = { identity: snapshot.identity, tracking: tip, pending, rewrite, lastCheck: saved?.lastCheck };
      observations.save(repo.id, observedAfterFetch);
      const after = await statusAt(path, repo);
      if (!sameCheckout(after.snapshot)) throw problem('The checkout or its upstream changed during the check. The branch was not updated.');
      if (snapshot.branch && before.gitDirectory && before.gitDirectory === after.gitDirectory) {
        observations.save(repo.id, { ...observedAfterFetch, lastCheck: { branch: snapshot.branch, at: fetchedAt, tip, gitDirectory: before.gitDirectory } });
      }
      if (operation === 'check' || after.snapshot.state === 'upstream-rewritten') return { checkout: after.snapshot, updated: false };
      if (!['behind', 'current'].includes(after.snapshot.state) || (operation === 'update-target' && after.snapshot.dirty)) {
        throw problem('The checkout or its upstream changed during the check. The branch was not updated.');
      }
      if (result && await ancestry(run, path, result, tip) !== true) {
        throw problem('The latest upstream could not be verified to contain the PR result.');
      }
      if (after.snapshot.state === 'current') return { checkout: after.snapshot, updated: false };
      if (!after.snapshot.canPull) throw problem('The checkout is no longer eligible.');
      await run(path, ['merge-base', '--is-ancestor', after.snapshot.head, tip]);
      await fastForward(path, repo, after.snapshot, target, tip, sameCheckout, operation === 'update-target');
      return { checkout: (await statusAt(path, repo)).snapshot, updated: true };
    } catch (error) {
      if (error instanceof Error && 'status' in error && (error.status === 404 || error.status === 409)) throw error;
      throw problem(operation === 'check' ? 'Could not check the upstream. Check Git access and try again.'
        : 'Git could not finish the update. Review the checkout and try again.');
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
      if (await interrupted(path, current.snapshot) || !matchesIntent(current.snapshot, expected)) {
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
