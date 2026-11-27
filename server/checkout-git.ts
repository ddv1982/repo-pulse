// The checkout adapter the routes use: it builds one CheckoutContext over the Git runner and hands it to the Check and
// Pull, PR branch follow-up and Activity switch workflows, holds the per-repository and shared Git directory write
// locks, and caches status reads for five seconds. Git primitives are in server/git.ts and status reading in
// server/checkout-status.ts.
import { branchName } from '../src/events.ts';
import { realpath } from 'node:fs/promises';
import { NO_HOOKS, fetchFailure, fetchUpstream, runGit, trackingTip, validateUpstream, type GitRunner, type Upstream } from './git.ts';
import { adviseMissingUpstream, type FindCheckoutPulls } from './checkout-advice.ts';
import { branchFollowups, memoryFollowups, type Followups } from './checkout-branches.ts';
import { memoryObservations, type Observations } from './checkout-observations.ts';
import { createCheckoutStatus, matchesWatchedRemote } from './checkout-status.ts';
import { gitHistorySnapshot, readGitHistory } from './git-history.ts';
import { createActivitySwitch } from './checkout-activity-switch.ts';
import { createCheckoutUpdater } from './checkout-update.ts';
import type { CheckoutContext } from './checkout-context.ts';
import type {
  CheckoutSelection,
  SwitchIntent,
  CheckoutIntent,
  ActiveCheckout,
  CheckoutStatus,
  Repository as LinkedRepo,
} from '../src/contract.ts';
import { conflict, isAppError } from './errors.ts';

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
  followups?: Followups;
  findPulls?: FindCheckoutPulls;
  observations?: Observations;
} = {}) {
  const readings: Map<string, { path: string; until: number; value: Promise<CheckoutStatus> }> = new Map();
  /** Active checkout write locks: repo IDs and canonical Git common directories currently updating. */
  const updatingRepos: Set<string> = new Set();
  const updatingGitDirs: Set<string> = new Set();
  const { checkoutPath, statusAt, upstreamFor, remoteTarget, observedAt, upstreamIdentity, matchesIntent, verifyCheckoutDirectory } =
    createCheckoutStatus({ run, matchesRemote, observations });
  const context: CheckoutContext = {
    run,
    hooks: NO_HOOKS,
    now,
    observations,
    statusAt,
    inspect,
    decorate: (repo, path, snapshot) => branches.decorate(repo, path, snapshot),
    remoteTarget,
    upstreamFor,
    validateUpstream: (path, target) => validateUpstream(run, path, target),
    fetchUpstream: (path, target, destination) => fetchUpstream(run, path, target, destination),
    trackingTip: (path, tracking, before) => trackingTip(run, path, tracking, before),
    fetchFailure,
    observedAt,
    upstreamIdentity,
    readMissing,
    matchesIntent,
    verifyCheckoutDirectory,
  };
  const updateAt = createCheckoutUpdater(context);
  const branches = branchFollowups(context, { followups, updateAt });
  const switchAt = createActivitySwitch(context);

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
      (error: { diagnostic?: import('../src/contract.ts').CheckoutDiagnostic }): CheckoutStatus =>
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

  async function exclusively<T>(repo: LinkedRepo, action: (path: string) => Promise<T>) {
    if (updatingRepos.has(repo.id)) throw conflict('This checkout is already updating. Try again in a moment.');
    updatingRepos.add(repo.id);
    readings.delete(repo.id);
    let commonDir: string | null = null;
    try {
      const path = await checkoutPath(repo);
      const rawCommonDir = (await run(path, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).trimEnd();
      const resolvedCommonDir = await realpath(rawCommonDir).catch(() => rawCommonDir);
      if (updatingGitDirs.has(resolvedCommonDir)) {
        throw conflict('Another checkout sharing this Git repository is updating. Try again in a moment.');
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

  function update(
    repo: LinkedRepo,
    operation: 'check' | 'pull',
    expected: CheckoutIntent,
  ): Promise<import('../src/contract.ts').CheckoutUpdateResult> {
    return exclusively(repo, async path => {
      const result = await updateAt(path, repo, operation, expected);
      return { ...result, checkout: await inspect(path, repo) };
    });
  }

  function branchAction(
    repo: LinkedRepo,
    action: import('../src/contract.ts').BranchAction,
    expected: CheckoutIntent,
  ): Promise<import('../src/contract.ts').BranchActionResult> {
    return exclusively(repo, async path => {
      const current = await statusAt(path, repo);
      if (!matchesIntent(current.snapshot, expected)) {
        throw conflict('The checkout changed. Review the current branch and try again.');
      }
      try {
        const result = await branches.act(repo, path, current, action);
        return { ...result, checkout: await inspect(path, repo) };
      } catch (error) {
        if (isAppError(error, 'conflict')) throw error;
        throw conflict('Git could not finish this branch action. Check the checkout in Git and try again.');
      }
    });
  }

  function switchToActivityBranch(
    repo: LinkedRepo,
    name: string,
    expected: SwitchIntent,
    { eventId, confirmation }: { eventId?: string | undefined; confirmation?: string | undefined } = {},
  ): Promise<import('../src/contract.ts').ActivitySwitchResult> {
    return exclusively(repo, path => switchAt(path, repo, name, expected, { eventId, confirmation }));
  }

  /** Local branch names, read without the update lock. */
  async function localBranches(repo: LinkedRepo) {
    const path = await checkoutPath(repo);
    const refs = await run(path, ['for-each-ref', '--format=%(refname)', 'refs/heads/']);
    return refs
      .split('\n')
      .filter(ref => ref.startsWith('refs/heads/'))
      .map(ref => branchName(ref));
  }

  async function history(repo: LinkedRepo, cursor: string | null) {
    const path = await checkoutPath(repo);
    try {
      return await readGitHistory(run, path, repo.defaultBranch, cursor);
    } catch (error) {
      if (isAppError(error)) throw error;
      throw conflict('Git could not read commit history for this checkout.');
    }
  }

  async function historySnapshot(repo: LinkedRepo) {
    const path = await checkoutPath(repo);
    try {
      return await gitHistorySnapshot(run, path, repo.defaultBranch);
    } catch {
      throw conflict('Git could not read commit refs for this checkout.');
    }
  }

  return { status, update, branchAction, switchToActivityBranch, localBranches, history, historySnapshot };
}
