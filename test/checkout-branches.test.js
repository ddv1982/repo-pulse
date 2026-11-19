import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { createCheckoutGit } from '../server/checkout-git.js';
import { checkoutFixture, git, squashFixture } from './fixtures/checkout.js';

const exec = promisify(execFile);

test('Activity switch keeps the commits, upstream and compatible local edits of an existing feature branch', async t => {
  const { source, local, repo, checkoutGit, original, commit } = checkoutFixture(t);
  const branch = 'feature/topic';
  git(source, 'switch', '-c', branch);
  git(source, 'push', 'origin', branch);
  git(local, 'fetch', 'origin', branch);
  git(local, 'switch', '--track', `origin/${branch}`);
  const localTip = commit(local, 'draft.txt', 'local draft');
  git(local, 'switch', 'main');
  writeFileSync(join(local, 'feature.txt'), 'staged edit');
  git(local, 'add', 'feature.txt');
  writeFileSync(join(local, 'feature.txt'), 'unstaged edit');
  writeFileSync(join(local, 'notes.txt'), 'untracked notes');
  const { checkout } = await checkoutGit.switchToActivityBranch(repo, branch, await checkoutGit.status(repo));
  assert.equal(checkout.branch, branch);
  assert.equal(checkout.head, localTip);
  assert.equal(checkout.upstream, `origin/${branch}`);
  assert.equal(git(local, 'rev-parse', 'main'), original);
  assert.equal(git(local, 'show', ':feature.txt'), 'staged edit');
  assert.equal(readFileSync(join(local, 'feature.txt'), 'utf8'), 'unstaged edit');
  assert.equal(git(local, 'ls-files', '--others', '--exclude-standard'), 'notes.txt');
  assert.equal(readFileSync(join(local, 'notes.txt'), 'utf8'), 'untracked notes');
});

test('Activity switch refuses conflicting edits, stale intent, occupied worktrees and missing destinations', async t => {
  const { source, local, remote, repo, checkoutGit, commit } = checkoutFixture(t);
  const branch = 'feature/topic';
  git(source, 'switch', '-c', branch);
  commit(source, 'feature.txt', 'changed on the feature branch');
  git(source, 'push', 'origin', branch);
  git(local, 'fetch', 'origin', branch);
  git(local, 'branch', '--track', branch, `origin/${branch}`);
  const expected = await checkoutGit.status(repo);
  const switchBranch = () => checkoutGit.switchToActivityBranch(repo, branch, expected);

  writeFileSync(join(local, 'feature.txt'), 'unsaved');
  await assert.rejects(switchBranch(), /conflicting files/i);
  assert.equal(git(local, 'branch', '--show-current'), 'main');
  assert.equal(readFileSync(join(local, 'feature.txt'), 'utf8'), 'unsaved');
  git(local, 'restore', 'feature.txt');
  await assert.rejects(checkoutGit.switchToActivityBranch(repo, branch, { ...expected, head: 'a'.repeat(40) }), /checkout changed/i);

  const worktree = join(local, '..', 'occupied');
  git(local, 'worktree', 'add', worktree, branch);
  await assert.rejects(switchBranch(), /occupied worktree/);
  git(local, 'worktree', 'remove', worktree);

  git(local, 'branch', '--set-upstream-to=origin/main', branch);
  await assert.rejects(switchBranch(), /different upstream/);
  git(local, 'branch', `--set-upstream-to=origin/${branch}`, branch);
  git(remote, 'update-ref', '-d', `refs/heads/${branch}`);
  await assert.rejects(switchBranch(), /no longer exists/);
  assert.equal(git(local, 'branch', '--show-current'), 'main');
});

test('Activity switch rejects misrouted fetch mappings and dangling symbolic tracking refs before fetching', async t => {
  const { source, local, repo, checkoutGit } = checkoutFixture(t);
  git(source, 'switch', '-c', 'topic');
  git(source, 'push', 'origin', 'topic');
  git(local, 'config', 'remote.origin.fetch', '+refs/heads/main:refs/remotes/origin/main');
  git(local, 'config', '--add', 'remote.origin.fetch', '+refs/heads/other:refs/remotes/origin/topic');
  const expected = await checkoutGit.status(repo);
  const switchBranch = () => checkoutGit.switchToActivityBranch(repo, 'topic', expected);
  await assert.rejects(switchBranch(), /does not map this branch/);
  assert.throws(() => git(local, 'show-ref', '--verify', 'refs/remotes/origin/topic'));

  git(local, 'config', '--unset-all', 'remote.origin.fetch');
  git(local, 'config', 'remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*');
  git(local, 'symbolic-ref', 'refs/remotes/origin/topic', 'refs/remotes/origin/absent');
  await assert.rejects(switchBranch(), /tracking ref is symbolic/);
  assert.throws(() => git(local, 'show-ref', '--verify', 'refs/remotes/origin/absent'));
  assert.equal(git(local, 'branch', '--show-current'), 'main');
});

test('Activity switch preserves an existing tracking tip for later rewrite detection', async t => {
  const { source, local, repo, checkoutGit, commit, original } = checkoutFixture(t);
  git(source, 'switch', '-c', 'topic');
  const oldTip = commit(source, 'topic.txt', 'old topic');
  git(source, 'push', 'origin', 'topic');
  git(local, 'fetch', 'origin', 'topic');
  git(local, 'branch', 'alternate');
  git(local, 'branch', '--set-upstream-to=origin/topic', 'alternate');
  git(source, 'reset', '--hard', original);
  const newTip = commit(source, 'topic.txt', 'rewritten topic');
  git(source, 'push', '--force-with-lease', 'origin', 'topic');

  const switched = await checkoutGit.switchToActivityBranch(repo, 'topic', await checkoutGit.status(repo));
  assert.equal(switched.checkout.branch, 'topic');
  assert.equal(switched.checkout.head, newTip);
  assert.equal(git(local, 'rev-parse', 'origin/topic'), oldTip);
  git(local, 'switch', 'alternate');
  const pulled = await checkoutGit.update(repo, 'pull', await checkoutGit.status(repo));
  assert.equal(pulled.checkout.state, 'upstream-rewritten');
  assert.equal(git(local, 'rev-parse', 'HEAD'), original);
});

test('Activity creates a branch at its verified remote tip even when the tracking cache contains another branch', async t => {
  const { source, local, repo, checkoutGit, commit } = checkoutFixture(t);
  git(source, 'switch', '-c', 'topic');
  const topic = commit(source, 'topic.txt', 'correct topic');
  git(source, 'push', 'origin', 'topic');
  git(source, 'switch', '-c', 'other', 'main');
  const other = commit(source, 'other.txt', 'unrelated branch');
  git(source, 'push', 'origin', 'other');
  git(local, 'config', '--add', 'remote.origin.fetch', '+refs/heads/other:refs/remotes/origin/topic');
  git(local, 'fetch', 'origin', 'other');
  assert.equal(git(local, 'rev-parse', 'origin/topic'), other);

  const result = await checkoutGit.switchToActivityBranch(repo, 'topic', await checkoutGit.status(repo));
  assert.equal(result.message, undefined);
  assert.equal(result.checkout.head, topic);
  assert.equal(git(local, 'rev-parse', 'origin/topic'), other);
});

test('Activity verifies the remote tip again after fetching the new branch objects', async t => {
  const { source, remote, local, repo, commit } = checkoutFixture(t);
  git(source, 'switch', '-c', 'topic');
  commit(source, 'topic.txt', 'advertised tip');
  git(source, 'push', 'origin', 'topic');
  let latest;
  const checkoutGit = createCheckoutGit({
    matchesRemote: url => url === remote,
    run: async (path, args) => {
      if (args[2] === 'fetch' && !latest) {
        latest = commit(source, 'topic.txt', 'tip at fetch');
        git(source, 'push', 'origin', 'topic');
      }
      return git(path, ...args);
    },
  });
  const result = await checkoutGit.switchToActivityBranch(repo, 'topic', await checkoutGit.status(repo));
  assert.ok(latest);
  assert.equal(result.message, undefined);
  assert.equal(git(local, 'rev-parse', 'HEAD'), latest);
});

test('Activity confirmation belongs to the Git directory that was shown', async t => {
  const { source, remote, local, repo, checkoutGit } = checkoutFixture(t);
  git(source, 'switch', '-c', 'topic');
  git(source, 'push', 'origin', 'topic');
  const expected = await checkoutGit.status(repo);
  renameSync(local, `${local}-previous`);
  git(source, 'clone', '--no-local', remote, local);

  await assert.rejects(checkoutGit.switchToActivityBranch(repo, 'topic', expected), /checkout changed/i);
  assert.equal(git(local, 'branch', '--show-current'), 'main');
  assert.equal(git(`${local}-previous`, 'branch', '--show-current'), 'main');
});

test('Activity creates the explicit upstream even if another fetch mapping appears before Git switches', async t => {
  const { source, remote, local, repo } = checkoutFixture(t);
  const name = 'group/topic';
  git(source, 'switch', '-c', name);
  git(source, 'push', 'origin', name);
  const checkoutGit = createCheckoutGit({
    matchesRemote: url => url === remote,
    run: async (path, args) => {
      if (args[2] === 'switch') {
        // Older Git versions allowed these overlapping remote names through `remote add`.
        git(local, 'config', 'remote.origin/group.url', remote);
        git(local, 'config', 'remote.origin/group.fetch', '+refs/heads/*:refs/remotes/origin/group/*');
      }
      return git(path, ...args);
    },
  });
  const result = await checkoutGit.switchToActivityBranch(repo, name, await checkoutGit.status(repo));
  assert.equal(result.message, undefined);
  assert.equal(result.checkout.branch, name);
  assert.equal(git(local, 'config', 'branch.group/topic.remote'), 'origin');
  assert.equal(git(local, 'config', 'branch.group/topic.merge'), 'refs/heads/group/topic');
});

test('Activity switch catches a symbolic tracking ref introduced during upstream setup', async t => {
  const { source, remote, local, repo } = checkoutFixture(t);
  git(source, 'switch', '-c', 'topic');
  git(source, 'push', 'origin', 'topic');
  const tracking = 'refs/remotes/origin/topic';
  const absent = 'refs/remotes/origin/absent';
  const checkoutGit = createCheckoutGit({
    matchesRemote: url => url === remote,
    run: async (path, args) => {
      if (args[0] === 'config' && args[3] === 'branch.topic.merge') git(local, 'symbolic-ref', tracking, absent);
      return git(path, ...args);
    },
  });
  const result = await checkoutGit.switchToActivityBranch(repo, 'topic', await checkoutGit.status(repo));
  assert.match(result.message, /could not be verified/);
  assert.equal(git(local, 'symbolic-ref', tracking), absent);
  assert.throws(() => git(local, 'show-ref', '--verify', absent));
});

test('Activity rechecks the Git directory after validating the destination', async t => {
  const { source, remote, local, repo } = checkoutFixture(t);
  git(source, 'switch', '-c', 'topic');
  git(source, 'push', 'origin', 'topic');
  let validations = 0;
  const checkoutGit = createCheckoutGit({
    matchesRemote: url => url === remote,
    run: async (path, args) => {
      if (args[0] === 'ls-remote' && args[1] === '--get-url' && ++validations === 2) {
        renameSync(local, `${local}-previous`);
        git(source, 'clone', '--no-local', remote, local);
      }
      return git(path, ...args);
    },
  });
  await assert.rejects(checkoutGit.switchToActivityBranch(repo, 'topic', await checkoutGit.status(repo)), /checkout changed/i);
  assert.equal(git(local, 'branch', '--show-current'), 'main');
  assert.equal(git(`${local}-previous`, 'branch', '--show-current'), 'main');
});

test('Activity reports a partial switch if the checkout is replaced during final verification', async t => {
  const { source, remote, local, repo } = checkoutFixture(t);
  git(source, 'switch', '-c', 'topic');
  git(source, 'push', 'origin', 'topic');
  let validations = 0;
  const checkoutGit = createCheckoutGit({
    matchesRemote: url => url === remote,
    run: async (path, args) => {
      if (args[0] === 'ls-remote' && args[1] === '--get-url' && ++validations === 3) {
        renameSync(local, `${local}-previous`);
        git(source, 'clone', '--no-local', remote, local);
      }
      return git(path, ...args);
    },
  });
  const result = await checkoutGit.switchToActivityBranch(repo, 'topic', await checkoutGit.status(repo));
  assert.match(result.message, /could not be verified/);
  assert.equal(result.checkout.branch, 'main');
  assert.equal(git(`${local}-previous`, 'branch', '--show-current'), 'topic');
});

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
  return {
    ...fixture,
    adapter,
    tip,
    first,
    second,
    checkout,
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
  const commit = git(
    local,
    '-c',
    'user.name=Test',
    '-c',
    'user.email=test@example.test',
    'commit',
    '--allow-empty',
    '-m',
    'unpublished target commit',
  );
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
    const command = exec('git', ['-C', path, ...args], { env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', ...options?.guard } });
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
  assert.deepEqual(
    review.commits.map(commit => commit.id),
    [first, second],
  );
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
