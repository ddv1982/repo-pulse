import { createHmac, randomBytes } from 'node:crypto';
import { ancestry, isCommit } from './checkout-advice.ts';
import { readRef, switchLocalBranch } from './checkout-branches.ts';
import { isSymbolicRef, worktreeUsesBranch } from './checkout-delete-guard.cjs';
import { readDirectCommit, refreshSwitchTracking } from './checkout-switch-refs.ts';
import { verifyTrackingMapping } from './checkout-tracking.ts';

export type ActivitySwitchReview = import('./checkout-git.ts').ActivitySwitchReview;
export type ActiveCheckout = import('./checkout-git.ts').ActiveCheckout;
export type CheckoutReading = import('./checkout-git.ts').CheckoutReading;
export type CheckoutStatus = import('./checkout-git.ts').CheckoutStatus;
export type DecoratedCheckout = import('./checkout-git.ts').DecoratedCheckout;
export type GitRunner = import('./checkout-git.ts').GitRunner;
export type LinkedRepo = import('./checkout-git.ts').LinkedRepo;
export type ReadCheckoutStatus = import('./checkout-git.ts').ReadCheckoutStatus;
export type SwitchIntent = import('./checkout-git.ts').SwitchIntent;
export type Upstream = import('./checkout-git.ts').Upstream;
export type Observation = import('./checkout-observations.ts').Observation;

/**
 * The caller owns the checkout lock and supplies its existing Git runner and scope checks.
 */
export function createActivitySwitch({
  run,
  hooks,
  now,
  observations,
  problem,
  statusAt,
  inspect,
  decorate,
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
}: {
  run: GitRunner;
  hooks: string;
  now: () => number;
  observations: import('./checkout-observations.ts').Observations;
  problem: (message: string, status?: number) => Error & { status: number };
  statusAt: ReadCheckoutStatus;
  inspect: (path: string, repo: LinkedRepo) => Promise<CheckoutStatus>;
  decorate: (repo: LinkedRepo, path: string, snapshot: ActiveCheckout) => Promise<DecoratedCheckout>;
  remoteTarget: (path: string, repo: LinkedRepo, remote: string, source: string) => Promise<{ target: Upstream | null }>;
  upstreamFor: (path: string, repo: LinkedRepo, branch: string | null) => Promise<{ target: Upstream | null }>;
  validateUpstream: (path: string, target: Upstream) => Promise<void>;
  fetchUpstream: (path: string, target: Upstream, destination?: string | null) => Promise<void>;
  trackingTip: (path: string, tracking: string) => Promise<string | null>;
  fetchFailure: (error: unknown) => 'missing-ref' | { title: string; suggestion: string };
  observedAt: (repo: LinkedRepo, path: string, target: Upstream | null, gitDirectory: string | null) => Observation | undefined;
  upstreamIdentity: (path: string, target: Upstream | null, gitDirectory?: string | null) => string;
  matchesIntent: (snapshot: CheckoutReading, expected: Pick<CheckoutReading, 'branch' | 'head' | 'upstream' | 'identity'>) => boolean;
  verifyCheckoutDirectory: (path: string, expected: string | null) => Promise<void>;
}) {
  const switchSecret = randomBytes(32);

  async function newBranchTarget(path: string, repo: LinkedRepo, source: string) {
    const remotes = (await run(path, ['remote'])).trimEnd().split('\n').filter(Boolean);
    const targets = (await Promise.all(remotes.map(remote => remoteTarget(path, repo, remote, source))))
      .map(({ target }) => target)
      .filter(target => target !== null);
    if (targets.length !== 1) throw problem('This checkout needs one matching Git remote for the watched repository.');
    return targets[0];
  }

  async function activityRemoteTip(path: string, target: Upstream) {
    const refs = await run(path, ['ls-remote', '--exit-code', '--refs', '--', target.url, target.source]);
    const [tip] =
      refs
        .split('\n')
        .find(line => line.endsWith(`\t${target.source}`))
        ?.split('\t') ?? [];
    if (!isCommit(tip)) throw problem('The branch no longer exists on the watched remote.');
    return tip;
  }

  async function activityTip(path: string, target: Upstream) {
    try {
      const tip = await activityRemoteTip(path, target);
      if ((await trackingTip(path, tip)) === tip) return tip;
      // Fetch just the objects until the old tracking tip has been classified.
      await fetchUpstream(path, target, null);
      const latest = await activityRemoteTip(path, target);
      if ((await trackingTip(path, latest)) !== latest) throw problem('The branch changed during the fetch. Try switching again.');
      return latest;
    } catch (error) {
      if (error instanceof Error && 'status' in error) throw error;
      const reason = fetchFailure(error);
      if (reason === 'missing-ref' || (error instanceof Error && 'code' in error && error.code === 2))
        throw problem('The branch no longer exists on the watched remote.');
      throw problem(`${reason.title}. ${reason.suggestion}`);
    }
  }

  async function activityTarget(path: string, repo: LinkedRepo, name: string, existingBranch: boolean) {
    const source = `refs/heads/${name}`;
    if (await isSymbolicRef(run, path, source)) throw problem('The local branch ref is symbolic. Review it in Git.');
    const target = existingBranch ? (await upstreamFor(path, repo, name)).target : await newBranchTarget(path, repo, source);
    if (target?.source !== source) throw problem('The local branch tracks a different upstream or has no upstream. Review it in Git.');
    await validateUpstream(path, target);
    await verifyTrackingMapping(run, path, target);
    return target;
  }

  function checkSwitchIntent(snapshot: ActiveCheckout, expected: SwitchIntent) {
    if (!matchesIntent(snapshot, expected) || snapshot.switchIdentity !== expected.switchIdentity) {
      throw problem('The checkout changed. Review the current branch and try again.');
    }
    if (snapshot.state === 'in-progress') throw problem('Finish the Git operation before switching branches.');
  }

  async function planActivitySwitch(
    path: string,
    repo: LinkedRepo,
    target: Upstream,
    localTip: string | null,
    gitDirectory: string | null,
  ) {
    const previous = await readDirectCommit(run, path, target.tracking);
    const tip = await activityTip(path, target);
    const saved = observedAt(repo, path, target, gitDirectory);
    const rewrite = saved?.rewrite;
    const retained =
      rewrite?.verified && (await ancestry(run, path, rewrite.tip, tip)) === true
        ? { previous: rewrite.previous, tip: rewrite.tip }
        : undefined;
    const baselines = new Set(
      [previous, saved?.tracking, retained ? undefined : rewrite?.previous, ...(saved?.pending ?? [])]
        .filter(oid => typeof oid === 'string')
        .filter(isCommit),
    );
    const replaced = [];
    for (const baseline of baselines) {
      const forward = await ancestry(run, path, baseline, tip);
      if (forward === null) throw problem('Git could not verify upstream history. Review the checkout in Git before switching.');
      if (!forward) replaced.push(baseline);
    }
    const counts = localTip ? (await run(path, ['rev-list', '--left-right', '--count', `${localTip}...${tip}`])).trim() : '0\t0';
    if (!/^\d+\s+\d+$/.test(counts)) throw problem('Git could not compare the local branch with the remote tip.');
    const [ahead, behind] = counts.split(/\s+/).map(Number);
    return { previous, tip, replaced, retained, ahead, behind };
  }

  async function finishActivitySwitch(
    path: string,
    repo: LinkedRepo,
    name: string,
    target: Upstream,
    switchIdentity: string,
    localTip: string | null,
    tip: string,
    rewritten: boolean,
  ) {
    try {
      if (!localTip) {
        const { snapshot } = await statusAt(path, repo);
        if (snapshot.branch !== name || snapshot.switchIdentity !== switchIdentity)
          throw problem('The checkout changed during the switch.');
        await run(path, ['config', '--local', '--replace-all', `branch.${name}.remote`, target.remote]);
        await run(path, ['config', '--local', '--replace-all', `branch.${name}.merge`, target.source]);
      }
      await validateUpstream(path, target);
      await verifyTrackingMapping(run, path, target);
      const { snapshot, target: configured, gitDirectory } = await statusAt(path, repo);
      if (
        snapshot.branch === name &&
        snapshot.switchIdentity === switchIdentity &&
        snapshot.head === (localTip ?? tip) &&
        gitDirectory &&
        JSON.stringify(configured) === JSON.stringify(target) &&
        (await readDirectCommit(run, path, target.tracking)) === tip
      ) {
        observations.save(repo.id, {
          identity: upstreamIdentity(path, target, gitDirectory),
          tracking: tip,
          lastCheck: { branch: name, at: new Date(now()).toISOString(), tip, gitDirectory },
        });
        const after = await statusAt(path, repo);
        if (
          after.snapshot.identity === snapshot.identity &&
          after.snapshot.switchIdentity === switchIdentity &&
          after.snapshot.branch === name &&
          after.snapshot.head === snapshot.head &&
          after.snapshot.lastBranchCheck?.matchesFetchedTip
        ) {
          const checkout = await decorate(repo, path, after.snapshot);
          if ((await readDirectCommit(run, path, target.tracking)) !== tip)
            throw problem('The tracking ref changed during final verification.');
          await verifyCheckoutDirectory(path, switchIdentity);
          return {
            checkout,
            notice: rewritten ? 'The previous upstream tip was saved for review.' : undefined,
          };
        }
      }
    } catch {
      // Git already switched. Report that separately from a failed upstream setup or status read.
    }
    return {
      checkout: await inspect(path, repo),
      message: 'Git finished switching, but the new checkout or its upstream could not be verified. Review it in Repositories.',
    };
  }

  async function switchAt(
    path: string,
    repo: LinkedRepo,
    name: string,
    expected: SwitchIntent,
    { eventId, confirmation }: { eventId?: string; confirmation?: string },
  ) {
    const current = await statusAt(path, repo);
    checkSwitchIntent(current.snapshot, expected);
    if (expected.branch === name) return { checkout: await inspect(path, repo) };
    const source = `refs/heads/${name}`;
    try {
      if (name.startsWith('-') || name === 'HEAD' || name === '@') throw new Error();
      await run(path, ['check-ref-format', source]);
    } catch {
      throw problem('The activity branch name cannot be used as a local Git branch.');
    }

    const localTip = await readRef(run, path, source);
    const existingBranch = Boolean(localTip);
    const target = await activityTarget(path, repo, name, existingBranch);
    const plan = await planActivitySwitch(path, repo, target, localTip, current.gitDirectory);
    const { previous, tip, replaced, retained, ahead, behind } = plan;
    const needsReview = Boolean(replaced.length || (ahead && behind));
    const token = createHmac('sha256', switchSecret)
      .update(JSON.stringify([repo.id, eventId, name, expected, target, localTip, plan]))
      .digest('hex');
    if (confirmation !== undefined && (!needsReview || confirmation !== token))
      throw problem('The branch or upstream changed since confirmation. Review the switch again.');

    async function verify() {
      const destination = await activityTarget(path, repo, name, existingBranch);
      if (JSON.stringify(destination) !== JSON.stringify(target) || (await readRef(run, path, source)) !== localTip)
        throw problem('The destination branch or its remote changed. Review it in Git and try again.');
      if (existingBranch && (await worktreeUsesBranch(run, path, source)))
        throw problem('The destination branch is in an occupied worktree. Open that worktree in Git.');
      checkSwitchIntent((await statusAt(path, repo)).snapshot, expected);
      await verifyCheckoutDirectory(path, expected.switchIdentity);
    }
    await verify();
    if (needsReview && confirmation === undefined) {
      const switchReview: ActivitySwitchReview = {
        token,
        upstream: target.tracking.slice('refs/remotes/'.length),
        previous: replaced[0] ?? null,
        tip,
        ahead,
        behind,
      };
      return { checkout: await inspect(path, repo), switchReview };
    }

    const archives = replaced.map(previous => ({ previous, tip }));
    if (retained && !archives.some(archive => archive.previous === retained.previous && archive.tip === retained.tip))
      archives.push(retained);
    await refreshSwitchTracking(run, path, hooks, repo, target, previous, tip, archives, verify);
    try {
      await verify();
      if ((await readDirectCommit(run, path, target.tracking)) !== tip)
        throw problem('The tracking ref changed before Git could switch branches.');
      await verifyCheckoutDirectory(path, expected.switchIdentity);
      await switchLocalBranch(run, path, hooks, name, existingBranch ? undefined : tip);
    } catch (error) {
      if (previous === tip) throw error;
      return {
        checkout: await inspect(path, repo),
        message: `The tracking ref was refreshed, but the checkout was not switched. ${error instanceof Error ? error.message : 'Review the checkout in Git.'}`,
      };
    }
    return finishActivitySwitch(path, repo, name, target, expected.switchIdentity, localTip, tip, Boolean(replaced.length));
  }

  return switchAt;
}
