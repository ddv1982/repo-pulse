import { randomUUID } from 'node:crypto';
import { access, chmod, copyFile, mkdtemp, rm, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { ancestry, isCommit } from './checkout-advice.ts';
import { isSymbolicRef, worktreeUsesBranch } from './checkout-delete-guard.cjs';
import type { GitRunner, Upstream } from './checkout-git.ts';
import type { BranchAction, FollowupSummary, Review, PullAdvice, Repository as LinkedRepo, ActiveCheckout } from '../src/contract.ts';
import { conflict, isAppError } from './errors.ts';

export type Reading = { snapshot: ActiveCheckout; target: Upstream | null };

export type Followup = FollowupSummary & {
  path: string;
  sourceHead: string;
  targetRef: string;
  result: string;
  recordedSource?: string | undefined;
  targetIdentity?: string;
  archive?: string;
};
export type Followups = { get: (id: string) => Followup | undefined; save: (id: string, plan: Followup) => void };

export function memoryFollowups(): Followups {
  const values: Map<string, Followup> = new Map();
  return {
    get: id => values.get(id),
    save: (id, plan) => {
      values.set(id, plan);
    },
  };
}

export function isBranchAction(input: unknown): input is BranchAction {
  if (!input || typeof input !== 'object' || !('operation' in input)) return false;
  if (input.operation === 'switch-update')
    return 'prId' in input && Number.isSafeInteger(input.prId) && 'result' in input && isCommit(input.result);
  if (!('planId' in input) || typeof input.planId !== 'string' || !/^[a-f0-9-]{36}$/.test(input.planId)) return false;
  if (input.operation === 'carry')
    return (
      'commits' in input &&
      Array.isArray(input.commits) &&
      input.commits.length > 0 &&
      input.commits.length <= 30 &&
      input.commits.every(isCommit)
    );
  return input.operation === 'review' || input.operation === 'remove';
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

export function branchFollowups({
  run,
  hooks,
  followups,
  statusAt,
  updateAt,
  readMissing,
  matchesIntent,
}: {
  run: GitRunner;
  hooks: string;
  followups: Followups;
  statusAt: (path: string, repo: LinkedRepo) => Promise<Reading>;
  updateAt: (
    path: string,
    repo: LinkedRepo,
    op: 'update-target',
    expected: ActiveCheckout,
    result: string,
  ) => Promise<{ checkout: ActiveCheckout; updated: boolean }>;
  readMissing: (path: string, repo: LinkedRepo, target: Upstream, snapshot: ActiveCheckout) => Promise<PullAdvice | undefined>;
  matchesIntent: (snapshot: ActiveCheckout, expected: ActiveCheckout) => boolean;
}) {
  function eligiblePlan(repo: LinkedRepo, path: string, snapshot: ActiveCheckout) {
    const plan = followups.get(repo.id);
    return plan?.path === path && plan.targetRef === `refs/heads/${snapshot.branch}` && snapshot.identity === plan.targetIdentity
      ? plan
      : undefined;
  }

  async function decorate(
    repo: LinkedRepo,
    path: string,
    snapshot: ActiveCheckout,
  ): Promise<import('../src/contract.ts').DecoratedCheckout> {
    const plan = eligiblePlan(repo, path, snapshot);
    if (!plan || (plan.archive && (await readRef(run, path, `refs/heads/${plan.source}`).catch(() => undefined)) === null)) return snapshot;
    const workspace =
      plan.workspace &&
      (await access(join(plan.workspace, '.git')).then(
        () => plan.workspace,
        () => undefined,
      ));
    return { ...snapshot, followup: { id: plan.id, source: plan.source, workspace } };
  }

  async function unchangedClean(repo: LinkedRepo, path: string, expected: ActiveCheckout) {
    const { snapshot, target } = await statusAt(path, repo);
    if (!matchesIntent(snapshot, expected) || snapshot.dirty || snapshot.state === 'in-progress' || !target)
      throw conflict('The checkout changed or has local work. Review it in Git and try again.');
    return { snapshot, target };
  }

  async function switchAndUpdate(
    repo: LinkedRepo,
    path: string,
    { snapshot, target }: Reading,
    action: Extract<BranchAction, { operation: 'switch-update' }>,
  ) {
    if (snapshot.state !== 'upstream-missing' || !snapshot.branch || !snapshot.head || snapshot.dirty || !target) {
      throw conflict('Switching requires a clean checkout with a missing upstream.');
    }
    const advice = await readMissing(path, repo, target, snapshot);
    const receipt = advice?.receipt;
    if (!receipt || advice.id !== action.prId || receipt.result !== action.result || advice.destination !== 'local') {
      throw conflict('The PR target or its local checkout changed. Check for updates again.');
    }
    const { branch, head } = snapshot;
    await unchangedClean(repo, path, snapshot);
    const name = advice.branch;
    const plan: Followup = {
      id: randomUUID(),
      path,
      source: branch,
      sourceHead: head,
      targetRef: receipt.target,
      result: receipt.result,
      recordedSource: receipt.sourceHead,
    };
    await switchLocalBranch(run, path, hooks, name);

    const partial = `Switched to ${name}. The update was blocked.`;
    try {
      const selected = await statusAt(path, repo);
      if (selected.snapshot.branch !== name || selected.target?.url !== target.url || selected.target.source !== receipt.target) {
        return { message: `${partial} Review the checkout and its upstream in Git.` };
      }
      plan.targetIdentity = selected.snapshot.identity;
      followups.save(repo.id, plan);
      const result = await updateAt(path, repo, 'update-target', selected.snapshot, plan.result);
      if (result.checkout.state !== 'current') return { message: partial };
      return { message: result.updated ? `Switched to ${name} and updated it.` : `Switched to ${name}. It already matches upstream.` };
    } catch (error) {
      const reason = isAppError(error, 'conflict') ? ` ${error.message}` : '';
      if (reason && error instanceof Error && 'unclear' in error) return { message: `Switched to ${name}.${reason}` };
      return { message: partial + reason };
    }
  }

  async function review(path: string, plan: Followup, snapshot: ActiveCheckout): Promise<Review> {
    const ref = `refs/heads/${plan.source}`;
    const tip = await readRef(run, path, ref);
    if (tip !== plan.sourceHead) return { kind: 'changed' };
    if (await worktreeUsesBranch(run, path, ref)) return { kind: 'occupied' };
    if (!snapshot.head || (await ancestry(run, path, plan.result, snapshot.head)) !== true) return { kind: 'unknown' };
    const canRemove = !snapshot.dirty && snapshot.state !== 'in-progress';
    if ((await ancestry(run, path, tip, snapshot.head)) === true || tip === plan.recordedSource) return { kind: 'included', canRemove };
    if (!plan.recordedSource || (await ancestry(run, path, plan.recordedSource, tip)) !== true) return { kind: 'unknown', canRemove };
    const range = `${plan.recordedSource}..${tip}`;
    const output = await run(path, [
      'log',
      '-z',
      '--no-show-signature',
      '--reverse',
      '--topo-order',
      '--max-count=31',
      '--format=%H%x00%P%x00%s',
      range,
      '--',
    ]);
    const fields = output.split('\0');
    const commits = [];
    // Offer only a linear continuation of the recorded PR source.
    let parent = plan.recordedSource;
    for (let index = 0; index + 2 < fields.length; index += 3) {
      // The loop bound leaves three fields, so the defaults never apply.
      const [id = '', parents, subject = ''] = fields.slice(index, index + 3);
      if (!isCommit(id) || parents !== parent) return { kind: 'local-followup', canRemove };
      commits.push({ id, subject: subject.slice(0, 160) });
      parent = id;
    }
    if (parent !== tip || commits.length > 30) return { kind: 'local-followup', canRemove };
    return { kind: 'local-followup', canRemove, commits, branch: `repo-pulse/follow-up-${plan.id.slice(0, 12)}` };
  }

  async function remove(path: string, plan: Followup & { archive: string }, ref: string) {
    const folder = await mkdtemp(join(tmpdir(), 'repo-pulse-ref-'));
    try {
      const hook = join(folder, 'reference-transaction');
      await copyFile(new URL('./checkout-delete-guard.cjs', import.meta.url), hook);
      await chmod(hook, 0o700);
      await run(path, ['-c', `core.hooksPath=${folder}`, 'update-ref', '--stdin'], {
        input: `start\noption no-deref\nverify ${plan.archive} ${plan.sourceHead}\noption no-deref\ndelete ${ref} ${plan.sourceHead}\nprepare\ncommit\n`,
        guard: { REPO_PULSE_DELETE_REF: ref, REPO_PULSE_DELETE_ARCHIVE: plan.archive },
      });
    } catch {
      throw conflict('Git could not remove the branch. Check whether its tip, worktree, or recovery reference changed.');
    } finally {
      await rm(folder, { recursive: true, force: true }).catch(() => {});
    }
  }

  async function act(repo: LinkedRepo, path: string, current: Reading, action: BranchAction) {
    if (action.operation === 'switch-update') return switchAndUpdate(repo, path, current, action);
    const { snapshot } = current;
    const plan = eligiblePlan(repo, path, snapshot);
    if (!plan || plan.id !== action.planId) throw conflict('The branch review changed. Open it again.');
    const details = await review(path, plan, snapshot);
    if (action.operation === 'review') return { review: details };
    const ref = `refs/heads/${plan.source}`;
    const currentTarget = await unchangedClean(repo, path, snapshot);

    if (action.operation === 'remove') {
      if (!details.canRemove) throw conflict('The old branch cannot be removed from this checkout. Review it in Git.');
      const archive = plan.archive ?? `refs/repo-pulse/archive/${plan.id}`;
      if (await isSymbolicRef(run, path, archive)) throw conflict('The recovery reference is symbolic. Review it in Git.');
      const saved = await readRef(run, path, archive);
      if (saved && saved !== plan.sourceHead) throw conflict('The recovery reference changed. Review the local branches in Git.');
      if (!saved)
        await run(path, [
          '-c',
          `core.hooksPath=${hooks}`,
          'update-ref',
          '--no-deref',
          '--create-reflog',
          '-m',
          `Archive local branch ${plan.source}`,
          archive,
          plan.sourceHead,
          '0'.repeat(plan.sourceHead.length),
        ]);
      const archived = { ...plan, archive };
      followups.save(repo.id, archived);
      await remove(path, archived, ref);
      return { message: `Removed local branch ${plan.source}.` };
    }

    if (action.operation !== 'carry' || !details.branch || currentTarget.snapshot.state !== 'current' || !snapshot.head) {
      throw conflict('Check that the target is up to date and review the available commits first.');
    }
    const selected = new Set(action.commits);
    const commits = details.commits?.filter(commit => selected.has(commit.id)) ?? [];
    if (
      selected.size !== action.commits.length ||
      commits.length !== selected.size ||
      !commits.length ||
      (await readRef(run, path, ref)) !== plan.sourceHead
    )
      throw conflict('The selected commits or old branch changed. Review the branch again.');
    const branch = details.branch;
    const workspace = await mkdtemp(join(dirname(path), '.repo-pulse-follow-up-'));
    try {
      await run(path, [
        '-c',
        `core.hooksPath=${hooks}`,
        '-c',
        'submodule.recurse=false',
        'worktree',
        'add',
        '--no-track',
        '-b',
        branch,
        workspace,
        snapshot.head,
      ]);
    } catch {
      await rmdir(workspace).catch(() => {});
      throw conflict('Git could not create the follow-up worktree. Check the checkout and branch name in Git.');
    }
    followups.save(repo.id, { ...plan, workspace });
    try {
      await run(workspace, [
        '-c',
        `core.hooksPath=${hooks}`,
        '-c',
        'rerere.enabled=false',
        '-c',
        'submodule.recurse=false',
        'cherry-pick',
        '--no-gpg-sign',
        ...commits.map(commit => commit.id),
      ]);
    } catch {
      const operation = await statusAt(workspace, repo).catch(() => null);
      const guidance =
        operation?.snapshot.state === 'in-progress'
          ? 'Continue or abort the cherry-pick in this worktree'
          : 'Review the Git status and commit configuration in this worktree';
      return { message: `Git could not finish applying the selected commits on ${branch}.`, nextStep: `${guidance}: ${workspace}` };
    }
    const applied = `Applied ${commits.length} selected ${commits.length === 1 ? 'commit' : 'commits'} on ${branch}.`;
    try {
      await run(path, ['-c', `core.hooksPath=${hooks}`, 'worktree', 'remove', '--', workspace]);
      followups.save(repo.id, { ...plan, workspace: undefined });
    } catch {
      return { message: applied, nextStep: `The branch is checked out in this worktree: ${workspace}` };
    }
    try {
      await unchangedClean(repo, path, snapshot);
      await run(path, [
        '-c',
        `core.hooksPath=${hooks}`,
        'switch',
        '--no-guess',
        '--no-overwrite-ignore',
        '--no-recurse-submodules',
        '--',
        branch,
      ]);
      return { message: applied };
    } catch {
      return { message: applied, nextStep: `Switch to ${branch} in Git when this checkout is ready.` };
    }
  }

  return { decorate, act };
}
