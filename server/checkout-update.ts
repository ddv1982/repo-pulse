import { ancestry } from './checkout-advice.ts';
import { observedRewrite } from './checkout-observations.ts';
import { readDirectCommit } from './checkout-switch-refs.ts';
import type { ActiveCheckout, CheckoutReading, GitRunner, LinkedRepo, ReadCheckoutStatus, Upstream } from './checkout-git.ts';
import type { Observation } from './checkout-observations.ts';

export type { ActiveCheckout, CheckoutReading, GitRunner, LinkedRepo, ReadCheckoutStatus, Upstream, Observation };

/**
 * Check, Pull and PR target updates share this workflow. The caller holds the checkout lock.
 */
export function createCheckoutUpdater({
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
}: {
  run: GitRunner;
  hooks: string;
  now: () => number;
  observations: import('./checkout-observations.ts').Observations;
  problem: (message: string, status?: number) => Error & { status: number };
  statusAt: ReadCheckoutStatus;
  validateUpstream: (path: string, target: Upstream) => Promise<void>;
  fetchUpstream: (path: string, target: Upstream) => Promise<void>;
  trackingTip: (path: string, tracking: string, before?: boolean) => Promise<string | null>;
  fetchFailure: (error: unknown) => 'missing-ref' | { title: string; suggestion: string };
  observedAt: (repo: LinkedRepo, path: string, target: Upstream | null, gitDirectory: string | null) => Observation | undefined;
  upstreamIdentity: (path: string, target: Upstream | null, gitDirectory?: string | null) => string;
  readMissing: (
    path: string,
    repo: LinkedRepo,
    target: Upstream,
    snapshot: ActiveCheckout,
  ) => Promise<import('./checkout-advice.ts').PullAdvice | undefined>;
  matchesIntent: (snapshot: CheckoutReading, expected: Pick<CheckoutReading, 'branch' | 'head' | 'upstream' | 'identity'>) => boolean;
  verifyCheckoutDirectory: (path: string, expected: string | null) => Promise<void>;
}) {
  function eligibleTarget(
    { snapshot, target }: { snapshot: ActiveCheckout; target: Upstream | null },
    operation: 'check' | 'pull' | 'update-target',
  ): Upstream {
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

  async function refuseIgnoredOverlap(path: string, head: string, tip: string) {
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

  async function fastForward(path: string, branch: string, tip: string) {
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
    // A terminal switch after the final check makes Git merge into the other branch, or into none if that one is
    // already at the tip. Either way the name of the branch that moved, if any, is unknown.
    const current = (await run(path, ['symbolic-ref', '--quiet', 'HEAD']).catch(() => '')).trim();
    // `unclear` tells callers not to describe this as a blocked update.
    if (current !== `refs/heads/${branch}`)
      throw Object.assign(
        problem(`The checkout is no longer on ${branch}, so it is unclear which branch moved. Review the checkout in Git.`),
        { unclear: true },
      );
    if ((await run(path, ['rev-parse', 'HEAD'])).trim() !== tip)
      throw problem('Git did not move the branch to the upstream commit. Review the checkout in Git.');
  }

  /** Saves the pre-fetch tracking samples and returns what the later observation saves build on.
   */
  async function recordBaseline(
    path: string,
    repo: LinkedRepo,
    { snapshot, gitDirectory }: { snapshot: ActiveCheckout; gitDirectory: string | null },
    target: Upstream,
  ) {
    const trackingBeforeFetch = await trackingTip(path, target.tracking, true);
    const saved = observedAt(repo, path, target, gitDirectory);
    const baselines = [
      ...new Set([trackingBeforeFetch, ...(saved?.pending ?? []), saved?.tracking].filter(value => typeof value === 'string')),
    ];
    const baseline = {
      identity: upstreamIdentity(path, target, gitDirectory),
      tracking: saved?.tracking,
      lastCheck: saved?.lastCheck,
      pending: baselines,
    };
    const canClearRewrite = Boolean(
      !snapshot.dirty && saved?.rewrite && (snapshot.head === saved.rewrite.tip || (snapshot.ahead === 0 && snapshot.behind === 0)),
    );
    // Keep both tracking samples if Git advances the ref before this check completes.
    if (baselines.length) observations.save(repo.id, { ...saved, ...baseline });
    return { saved, baselines, baseline, canClearRewrite, retainedRewrite: saved?.rewrite };
  }

  type Baseline = Awaited<ReturnType<typeof recordBaseline>>;

  async function recordFetchFailure(
    path: string,
    repo: LinkedRepo,
    operation: 'check' | 'pull' | 'update-target',
    snapshot: ActiveCheckout,
    target: Upstream,
    { baseline, retainedRewrite }: Baseline,
    failure: unknown,
  ) {
    const reason = fetchFailure(failure);
    const advice = reason === 'missing-ref' && operation !== 'update-target' ? await readMissing(path, repo, target, snapshot) : undefined;
    const { snapshot: current } = await statusAt(path, repo);
    if (!matchesIntent(snapshot, current) || snapshot.switchIdentity !== current.switchIdentity)
      throw problem('The checkout changed during the check. Review the current branch and try again.');
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
   */
  async function recordFetch(
    path: string,
    repo: LinkedRepo,
    before: { snapshot: ActiveCheckout; gitDirectory: string | null },
    target: Upstream,
    { saved, baselines, baseline, canClearRewrite, retainedRewrite }: Baseline,
  ) {
    const { snapshot } = before;
    await verifyCheckoutDirectory(path, snapshot.switchIdentity);
    const fetchedAt = new Date(now()).toISOString();
    const tip = await readDirectCommit(run, path, target.tracking);
    if (!tip) throw problem('The upstream commit is unavailable.');
    const { pending, rewrite: observed } = await observedRewrite(run, path, baselines, tip);
    const retained = retainedRewrite?.verified && (!canClearRewrite || pending.length) ? retainedRewrite : undefined;
    const rewrite = observed?.verified ? observed : (retained ?? observed);
    const observedAfterFetch = { identity: baseline.identity, tracking: tip, pending, rewrite, lastCheck: saved?.lastCheck };
    await verifyFetchedTip(path, target, tip);
    await verifyCheckoutDirectory(path, snapshot.switchIdentity);
    observations.save(repo.id, observedAfterFetch);
    const after = await statusAt(path, repo);
    if (!matchesIntent(snapshot, after.snapshot) || before.gitDirectory !== after.gitDirectory)
      throw problem('The checkout or its upstream changed during the check. The branch was not updated.');
    await verifyCheckoutDirectory(path, snapshot.switchIdentity);
    if (snapshot.branch && before.gitDirectory && before.gitDirectory === after.gitDirectory) {
      observations.save(repo.id, {
        ...observedAfterFetch,
        lastCheck: { branch: snapshot.branch, at: fetchedAt, tip, gitDirectory: before.gitDirectory },
      });
    }
    return { after: after.snapshot, tip };
  }

  async function verifyFetchedTip(path: string, target: Upstream, tip: string) {
    if ((await readDirectCommit(run, path, target.tracking)) !== tip)
      throw problem('The checkout or its upstream changed during the check. The branch was not updated.');
  }

  /** Decides from the post-fetch reading whether to fast-forward, and does so. */
  async function finishUpdate(
    path: string,
    repo: LinkedRepo,
    operation: 'check' | 'pull' | 'update-target',
    after: ActiveCheckout,
    target: Upstream,
    tip: string,
    result?: string,
  ) {
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
    await verifyFetchedTip(path, target, tip);
    await verifyCheckoutDirectory(path, after.switchIdentity);
    await fastForward(path, after.branch, tip);
    try {
      return { checkout: (await statusAt(path, repo)).snapshot, updated: true };
    } catch (caught) {
      // The branch already moved, so no failure here may read as if Pull did nothing. Unexpected errors keep their text local.
      const error = caught as Error & { status?: number; diagnostic?: unknown };
      const reason = error.status ? error.message : 'Review the checkout in Git.';
      throw Object.assign(problem(`The branch was updated to the upstream commit. ${reason}`, error.status === 404 ? 404 : 409), {
        diagnostic: error.diagnostic,
      });
    }
  }

  async function updateAt(
    path: string,
    repo: LinkedRepo,
    operation: 'check' | 'pull' | 'update-target',
    expected: Pick<CheckoutReading, 'branch' | 'head' | 'upstream' | 'identity'>,
    result?: string,
  ) {
    try {
      const before = await statusAt(path, repo);
      const { snapshot } = before;
      if (!expected || !matchesIntent(snapshot, expected)) throw problem('The checkout changed. Review the current branch and try again.');
      const target = eligibleTarget(before, operation);
      await validateUpstream(path, target);
      const recorded = await recordBaseline(path, repo, before, target);
      await verifyCheckoutDirectory(path, snapshot.switchIdentity);
      try {
        await fetchUpstream(path, target);
      } catch (failure) {
        return await recordFetchFailure(path, repo, operation, snapshot, target, recorded, failure);
      }
      const { after, tip } = await recordFetch(path, repo, before, target, recorded);
      return await finishUpdate(path, repo, operation, after, target, tip, result);
    } catch (error) {
      if (error instanceof Error && 'status' in error && (error.status === 404 || error.status === 409)) throw error;
      throw problem(
        operation === 'check'
          ? 'Could not check the upstream. Check Git access and try again.'
          : 'Git could not finish the update. Review the checkout and try again.',
      );
    }
  }

  return updateAt;
}
