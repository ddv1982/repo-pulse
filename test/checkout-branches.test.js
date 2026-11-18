import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { createCheckoutGit } from '../server/checkout-git.js';
import { git, squashFixture } from './fixtures/checkout.js';

const exec = promisify(execFile);

async function setup(t, { followup = false, conflict = false, run } = {}) {
  const fixture = squashFixture(t);
  const { local, remote, source, commit, repo, pr } = fixture;
  git(local, 'config', 'user.email', 'test@example.test');
  git(local, 'config', 'user.name', 'Test');
  const first = followup ? commit(local, 'first.txt', 'first local commit') : null;
  const second = followup ? commit(local, 'second.txt', 'second local commit') : null;
  git(local, 'fetch', 'origin', 'release');
  git(local, 'branch', '--track', 'release', 'origin/release');
  const tip = conflict ? commit(source, 'second.txt', 'conflict on target') : commit(source, 'target.txt', 'new target commit');
  git(source, 'push', 'origin', 'release');
  const adapter = createCheckoutGit({ matchesRemote: url => url === remote, findPulls: async () => [pr], run });
  const { checkout } = await adapter.update(repo, 'check', await adapter.status(repo));
  assert.equal(checkout.diagnostic.advice.destination, 'local');
  assert.equal(git(local, 'rev-parse', 'origin/release'), pr.result);
  return { ...fixture, adapter, tip, first, second, checkout,
    switchTarget: () => adapter.branchAction(repo, { operation: 'switch-update', prId: pr.id, result: pr.result }, checkout),
    act: (target, operation, extra) => adapter.branchAction(repo, { operation, planId: target.followup.id, ...extra }, target),
  };
}

test('switch updates a locally current squash PR target and old branch removal is recoverable', async t => {
  const fixture = await setup(t);
  const { local, source, pr, tip, switchTarget, act } = fixture;
  const { checkout, message } = await switchTarget();
  assert.match(message, /Switched to release and updated/);
  assert.equal(checkout.head, tip);
  assert.equal(git(local, 'rev-parse', 'topic'), pr.head);
  assert.equal(git(source, 'rev-parse', 'release'), tip);
  assert.equal((await act(checkout, 'review')).review.kind, 'included');
  git(local, 'pack-refs', '--all');
  const removed = await act(checkout, 'remove');
  assert.match(removed.message, /Removed local branch topic/);
  assert.equal(removed.checkout.followup, undefined);
  assert.throws(() => git(local, 'show-ref', '--verify', 'refs/heads/topic'));
  assert.equal(git(local, 'rev-parse', `refs/repo-pulse/archive/${checkout.followup.id}`), pr.head);
  assert.equal(git(local, 'branch', '--show-current'), 'release');
});

test('switch refuses dirty source and a target occupied after the check', async t => {
  const { local, pr, switchTarget } = await setup(t);
  writeFileSync(join(local, 'topic.txt'), 'dirty');
  await assert.rejects(switchTarget(), /clean checkout/);
  git(local, 'restore', 'topic.txt');
  git(local, 'worktree', 'add', join(local, '..', 'other'), 'release');
  await assert.rejects(switchTarget(), /target or its local checkout changed/);
  assert.equal(git(local, 'rev-parse', 'HEAD'), pr.head);
});

test('a remote source recreated between Check and confirmation blocks the switch', async t => {
  const { local, remote, pr, switchTarget } = await setup(t);
  git(remote, 'update-ref', pr.source, pr.head);
  await assert.rejects(switchTarget(), /target or its local checkout changed/);
  assert.equal(git(local, 'branch', '--show-current'), 'topic');
});

test('a diverged target remains checked out and is reported as a partial success', async t => {
  const { local, pr, switchTarget } = await setup(t);
  git(local, 'switch', 'release');
  const commit = git(local, '-c', 'user.name=Test', '-c', 'user.email=test@example.test', 'commit',
    '--allow-empty', '-m', 'unpublished target commit');
  assert.match(commit, /unpublished/);
  const target = git(local, 'rev-parse', 'HEAD');
  git(local, 'switch', 'topic');
  const result = await switchTarget();
  assert.match(result.message, /Switched to release. The update was blocked/);
  assert.equal(git(local, 'branch', '--show-current'), 'release');
  assert.equal(git(local, 'rev-parse', 'release'), target);
  assert.equal(git(local, 'rev-parse', 'topic'), pr.head);
});

function interceptGit(beforeRun) {
  return async (path, args, options) => {
    beforeRun(path, options);
    const command = exec('git', ['-C', path, ...args], { env: { ...process.env, GIT_OPTIONAL_LOCKS: '0',
      ...options?.guard } });
    if (options?.input) {
      command.child.stdin.on('error', () => {});
      command.child.stdin.end(options.input);
    }
    return (await command).stdout;
  };
}

test('an existing symbolic recovery ref cannot satisfy the archive requirement', async t => {
  const { local, pr, switchTarget, act } = await setup(t);
  const { checkout } = await switchTarget();
  const archive = `refs/repo-pulse/archive/${checkout.followup.id}`;
  git(local, 'symbolic-ref', archive, 'refs/heads/topic');
  await assert.rejects(act(checkout, 'remove'), /recovery reference is symbolic/);
  assert.equal(git(local, 'rev-parse', 'topic'), pr.head);
});

test('a recovery ref made symbolic just before deletion fails under the ref lock', async t => {
  const run = interceptGit((path, options) => {
    const archive = options?.guard?.REPO_PULSE_DELETE_ARCHIVE;
    if (archive) git(path, 'symbolic-ref', archive, 'refs/heads/topic');
  });
  const { local, pr, switchTarget, act } = await setup(t, { run });
  const { checkout } = await switchTarget();
  await assert.rejects(act(checkout, 'remove'), /could not remove/);
  assert.equal(git(local, 'rev-parse', 'topic'), pr.head);
});

test('late change to the source branch is rejected by the ref comparison', async t => {
  let newTip;
  const runner = interceptGit((path, options) => {
    if (options?.guard?.REPO_PULSE_DELETE_REF) git(path, 'update-ref', 'refs/heads/topic', newTip);
  });
  const { local, original, pr, switchTarget, act } = await setup(t, { run: runner });
  newTip = original;
  const { checkout } = await switchTarget();
  await assert.rejects(act(checkout, 'remove'), /could not remove/);
  assert.equal(git(local, 'rev-parse', 'topic'), original);
  assert.equal(git(local, 'rev-parse', `refs/repo-pulse/archive/${checkout.followup.id}`), pr.head);
});

test('old branch in another worktree cannot be removed', async t => {
  const { local, pr, switchTarget, act } = await setup(t);
  const { checkout } = await switchTarget();
  git(local, 'worktree', 'add', join(local, '..', 'other'), 'topic');
  assert.equal((await act(checkout, 'review')).review.kind, 'occupied');
  await assert.rejects(act(checkout, 'remove'), /cannot be removed/);
  assert.equal(git(local, 'rev-parse', 'topic'), pr.head);
});

test('an unrelated detached worktree does not block removing the old branch', async t => {
  const { local, switchTarget, act } = await setup(t);
  const { checkout } = await switchTarget();
  git(local, 'worktree', 'add', '--detach', join(local, '..', 'detached'), 'release');
  assert.equal((await act(checkout, 'review')).review.canRemove, true);
  assert.match((await act(checkout, 'remove')).message, /Removed local branch topic/);
});

test('a detached worktree rebasing the old branch prevents removal', async t => {
  const { local, second, switchTarget, act } = await setup(t, { followup: true, conflict: true });
  const { checkout } = await switchTarget();
  const worktree = join(local, '..', 'rebasing');
  git(local, 'worktree', 'add', worktree, 'topic');
  assert.throws(() => git(worktree, 'rebase', 'release'));
  assert.equal(git(worktree, 'branch', '--show-current'), '');
  assert.equal((await act(checkout, 'review')).review.kind, 'occupied');
  await assert.rejects(act(checkout, 'remove'), /cannot be removed/);
  assert.equal(git(local, 'rev-parse', 'topic'), second);
  git(worktree, 'rebase', '--abort');
});

test('a detached worktree bisecting the old branch prevents removal', async t => {
  const { local, original, second, switchTarget, act } = await setup(t, { followup: true });
  const { checkout } = await switchTarget();
  const worktree = join(local, '..', 'bisecting');
  git(local, 'worktree', 'add', worktree, 'topic');
  git(worktree, 'bisect', 'start', second, original);
  assert.equal(git(worktree, 'branch', '--show-current'), '');
  assert.equal((await act(checkout, 'review')).review.kind, 'occupied');
  await assert.rejects(act(checkout, 'remove'), /cannot be removed/);
  assert.equal(git(local, 'rev-parse', 'topic'), second);
  git(worktree, 'bisect', 'reset');
});

test('carry applies only selected follow-up commits and leaves both original branch refs untouched', async t => {
  const { local, first, second, tip, switchTarget, act } = await setup(t, { followup: true });
  const { checkout } = await switchTarget();
  const { review } = await act(checkout, 'review');
  assert.deepEqual(review.commits.map(commit => commit.id), [first, second]);
  await assert.rejects(act(checkout, 'carry', { commits: [tip] }), /selected commits/);
  const result = await act(checkout, 'carry', { commits: [second] });
  assert.equal(result.checkout.branch, review.branch);
  assert.equal(git(local, 'rev-parse', 'release'), tip);
  assert.equal(git(local, 'rev-parse', 'topic'), second);
  assert.equal(git(local, 'log', '-1', '--format=%s'), 'second local commit');
  assert.equal(git(local, 'log', '-1', '--format=%P'), tip);
  assert.deepEqual(git(local, 'diff', '--name-only', 'release', 'HEAD').split('\n'), ['second.txt']);
});

test('carry conflicts remain in a separate worktree for native Git continue or abort', async t => {
  const { local, second, tip, switchTarget, act } = await setup(t, { followup: true, conflict: true });
  const { checkout } = await switchTarget();
  const result = await act(checkout, 'carry', { commits: [second] });
  assert.match(result.nextStep, /Continue or abort/);
  assert.equal(result.checkout.branch, 'release');
  assert.equal(git(local, 'rev-parse', 'release'), tip);
  assert.equal(git(local, 'rev-parse', 'topic'), second);
  const workspace = result.checkout.followup.workspace;
  assert.ok(workspace);
  assert.equal((await act(checkout, 'review')).checkout.followup.workspace, workspace);
  assert.equal(git(workspace, 'rev-parse', 'CHERRY_PICK_HEAD'), second);
  assert.match(readFileSync(join(workspace, 'second.txt'), 'utf8'), /<<<<<<< HEAD/);
  git(workspace, 'cherry-pick', '--abort');
  assert.equal(git(workspace, 'rev-parse', 'HEAD'), tip);
});
