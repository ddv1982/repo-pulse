import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { TestContext } from 'node:test';
import { createCheckoutGit, runGit, type GitRunner } from '../server/checkout-git.ts';
import type { Observation, Observations } from '../server/checkout-observations.ts';
import type { BranchAction, CheckoutStatus } from '../src/contract.ts';
import {
  actions,
  adviceOf,
  branchReviewOf,
  checkoutFixture,
  comparisonOf,
  diagnosticOf,
  expectedOf,
  followupOf,
  git,
  linked,
  outcome,
  squashFixture,
  switchReviewOf,
} from './fixtures/checkout.ts';
import { present } from './fixtures/typed.ts';

const exec = promisify(execFile);

test('an in-flight Check locks its checkout and linked worktrees while allowing independent repositories to update', async t => {
  const { source, local, remote, repo, original } = checkoutFixture(t);
  git(source, 'switch', '-c', 'topic');
  git(source, 'push', 'origin', 'topic');
  const worktreePath = join(local, '..', 'linked-worktree');
  git(local, 'worktree', 'add', '-b', 'wt-branch', worktreePath);
  const worktreeRepo = { ...repo, id: 'worktree', localPath: worktreePath };
  const otherPath = join(local, '..', 'other-checkout');
  git(source, 'clone', '--no-local', remote, otherPath);
  const other = { ...repo, id: 'other', localPath: otherPath };
  const fetching = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const checkoutGit = createCheckoutGit({
    matchesRemote: url => url === remote,
    run: async (path, args, options) => {
      if (path === local && args[2] === 'fetch') {
        fetching.resolve();
        await release.promise;
      }
      return runGit(path, args, options);
    },
  });
  const repoStatus = await checkoutGit.status(repo);
  const worktreeStatus = await checkoutGit.status(worktreeRepo);
  const otherStatus = await checkoutGit.status(other);
  const check = checkoutGit.update(repo, 'check', expectedOf(repoStatus));
  try {
    await Promise.race([fetching.promise, check.then(() => assert.fail('Check did not reach fetch.'))]);
    await assert.rejects(checkoutGit.switchToActivityBranch(repo, 'topic', expectedOf(repoStatus)), /already updating/);
    await assert.rejects(
      checkoutGit.switchToActivityBranch(worktreeRepo, 'topic', expectedOf(worktreeStatus)),
      /Another checkout sharing this Git repository is updating/,
    );
    assert.equal(git(worktreePath, 'branch', '--show-current'), 'wt-branch');
    const switched = await checkoutGit.switchToActivityBranch(other, 'topic', expectedOf(otherStatus));
    assert.equal(linked(switched.checkout).branch, 'topic');
  } finally {
    release.resolve();
    await check;
  }
  const worktreeSwitched = await checkoutGit.switchToActivityBranch(
    worktreeRepo,
    'topic',
    expectedOf(await checkoutGit.status(worktreeRepo)),
  );
  assert.equal(linked(worktreeSwitched.checkout).branch, 'topic');
  assert.equal(git(local, 'rev-parse', 'HEAD'), original);
});

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
  const { checkout } = await checkoutGit.switchToActivityBranch(repo, branch, expectedOf(await checkoutGit.status(repo)));
  assert.equal(linked(checkout).branch, branch);
  assert.equal(linked(checkout).head, localTip);
  assert.equal(linked(checkout).upstream, `origin/${branch}`);
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
  const switchBranch = () => checkoutGit.switchToActivityBranch(repo, branch, expectedOf(expected));

  writeFileSync(join(local, 'feature.txt'), 'unsaved');
  await assert.rejects(switchBranch(), /conflicting files/i);
  assert.equal(git(local, 'branch', '--show-current'), 'main');
  assert.equal(readFileSync(join(local, 'feature.txt'), 'utf8'), 'unsaved');
  git(local, 'restore', 'feature.txt');
  await assert.rejects(
    checkoutGit.switchToActivityBranch(repo, branch, { ...expectedOf(expected), head: 'a'.repeat(40) }),
    /checkout changed/i,
  );

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
  const switchBranch = () => checkoutGit.switchToActivityBranch(repo, 'topic', expectedOf(expected));
  await assert.rejects(switchBranch(), /does not map this branch/);
  assert.throws(() => git(local, 'show-ref', '--verify', 'refs/remotes/origin/topic'));

  git(local, 'config', '--unset-all', 'remote.origin.fetch');
  git(local, 'config', 'remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*');
  git(local, 'symbolic-ref', 'refs/remotes/origin/topic', 'refs/remotes/origin/absent');
  await assert.rejects(switchBranch(), /tracking ref is symbolic/);
  assert.throws(() => git(local, 'show-ref', '--verify', 'refs/remotes/origin/absent'));
  assert.equal(git(local, 'branch', '--show-current'), 'main');
});

test('Activity confirms a rewrite before switching and preserves protection for another worktree', async t => {
  const { source, local, remote, repo, checkoutGit, commit, original } = checkoutFixture(t);
  git(source, 'switch', '-c', 'topic');
  const oldTip = commit(source, 'topic.txt', 'old topic');
  git(source, 'push', 'origin', 'topic');
  git(local, 'fetch', 'origin', 'topic');
  git(local, 'branch', 'alternate');
  git(local, 'branch', '--set-upstream-to=origin/topic', 'alternate');
  git(source, 'reset', '--hard', original);
  const newTip = commit(source, 'topic.txt', 'rewritten topic');
  git(source, 'push', '--force-with-lease', 'origin', 'topic');

  const expected = await checkoutGit.status(repo);
  const paused = await checkoutGit.switchToActivityBranch(repo, 'topic', expectedOf(expected), { eventId: 'rewrite' });
  assert.equal(switchReviewOf(paused).previous, oldTip);
  assert.equal(switchReviewOf(paused).tip, newTip);
  assert.equal(git(local, 'branch', '--show-current'), 'main');
  assert.equal(git(local, 'rev-parse', 'origin/topic'), oldTip);
  assert.equal(git(local, 'for-each-ref', 'refs/repo-pulse/upstream-rewrites'), '');
  const otherAdapter = createCheckoutGit({ matchesRemote: url => url === remote });
  await assert.rejects(
    otherAdapter.switchToActivityBranch(repo, 'topic', expectedOf(expected), {
      eventId: 'rewrite',
      confirmation: switchReviewOf(paused).token,
    }),
    /changed since confirmation/,
  );
  assert.equal(git(local, 'branch', '--show-current'), 'main');
  assert.equal(git(local, 'rev-parse', 'origin/topic'), oldTip);
  const switched = await checkoutGit.switchToActivityBranch(repo, 'topic', expectedOf(expected), {
    eventId: 'rewrite',
    confirmation: switchReviewOf(paused).token,
  });
  assert.equal(linked(switched.checkout).branch, 'topic');
  assert.equal(linked(switched.checkout).head, newTip);
  assert.equal(git(local, 'rev-list', '--left-right', '--count', 'HEAD...@{upstream}'), '0\t0');
  assert.equal(git(local, 'for-each-ref', '--format=%(objectname)', 'refs/repo-pulse/upstream-rewrites'), oldTip);
  await checkoutGit.update(repo, 'check', expectedOf(await checkoutGit.status(repo)));
  git(local, 'switch', 'main');
  await checkoutGit.update(repo, 'check', expectedOf(await checkoutGit.status(repo)));
  const other = join(local, '..', 'alternate-worktree');
  git(local, 'worktree', 'add', other, 'alternate');
  const restarted = createCheckoutGit({ matchesRemote: url => url === remote });
  const otherRepo = { ...repo, localPath: other };
  const status = await restarted.status(otherRepo);
  assert.equal(status.state, 'upstream-rewritten');
  assert.equal(comparisonOf(status).previous, oldTip);
  assert.equal(actions(status).canPull, false);
  await assert.rejects(restarted.update(otherRepo, 'pull', expectedOf(status)), /no longer eligible/);
  assert.equal(git(other, 'rev-parse', 'HEAD'), original);
});

test('Activity refuses to overwrite a tracking ref also used by another source', async t => {
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

  await assert.rejects(
    checkoutGit.switchToActivityBranch(repo, 'topic', expectedOf(await checkoutGit.status(repo))),
    /does not map this branch/,
  );
  assert.notEqual(git(local, 'rev-parse', 'HEAD'), topic);
  assert.equal(git(local, 'rev-parse', 'origin/topic'), other);
});

test('Activity verifies the remote tip again after fetching the new branch objects', async t => {
  const { source, remote, local, repo, commit } = checkoutFixture(t);
  git(source, 'switch', '-c', 'topic');
  commit(source, 'topic.txt', 'advertised tip');
  git(source, 'push', 'origin', 'topic');
  let latest: string | undefined;
  const checkoutGit = createCheckoutGit({
    matchesRemote: url => url === remote,
    run: async (path, args, options) => {
      if (args[2] === 'fetch' && !latest) {
        latest = commit(source, 'topic.txt', 'tip at fetch');
        git(source, 'push', 'origin', 'topic');
      }
      return runGit(path, args, options);
    },
  });
  const result = await checkoutGit.switchToActivityBranch(repo, 'topic', expectedOf(await checkoutGit.status(repo)));
  assert.ok(latest);
  assert.equal(outcome(result).message, undefined);
  assert.equal(git(local, 'rev-parse', 'HEAD'), latest);
  assert.equal(git(local, 'rev-parse', '@{upstream}'), latest);
});

test('Activity refuses stale confirmation and keeps the local tip when refreshing a diverged target', async t => {
  const { source, local, repo, checkoutGit, commit } = checkoutFixture(t);
  git(source, 'switch', '-c', 'topic');
  const previous = commit(source, 'topic.txt', 'common topic');
  git(source, 'push', 'origin', 'topic');
  git(local, 'fetch', 'origin', 'topic');
  git(local, 'switch', '--track', 'origin/topic');
  const localTip = commit(local, 'local.txt', 'local work');
  git(local, 'switch', 'main');
  commit(source, 'topic.txt', 'first remote advance');
  git(source, 'push', 'origin', 'topic');

  const expected = await checkoutGit.status(repo);
  const first = await checkoutGit.switchToActivityBranch(repo, 'topic', expectedOf(expected), { eventId: 'topic-event' });
  assert.equal(switchReviewOf(first).previous, null);
  assert.equal(switchReviewOf(first).ahead, 1);
  assert.equal(switchReviewOf(first).behind, 1);
  const latest = commit(source, 'topic.txt', 'second remote advance');
  git(source, 'push', 'origin', 'topic');
  await assert.rejects(
    checkoutGit.switchToActivityBranch(repo, 'topic', expectedOf(expected), {
      eventId: 'topic-event',
      confirmation: switchReviewOf(first).token,
    }),
    /changed since confirmation/,
  );
  assert.equal(git(local, 'branch', '--show-current'), 'main');
  assert.equal(git(local, 'rev-parse', 'origin/topic'), previous);
  const switchReview = switchReviewOf(
    await checkoutGit.switchToActivityBranch(repo, 'topic', expectedOf(expected), { eventId: 'topic-event' }),
  );
  await assert.rejects(
    checkoutGit.switchToActivityBranch(repo, 'topic', expectedOf(expected), { eventId: 'other-event', confirmation: switchReview.token }),
    /changed since confirmation/,
  );
  await assert.rejects(
    checkoutGit.switchToActivityBranch(repo, 'topic', expectedOf(expected), { confirmation: switchReview.token }),
    /changed since confirmation/,
    'a review from Activity cannot confirm a switch chosen in Repositories',
  );
  const { checkout } = await checkoutGit.switchToActivityBranch(repo, 'topic', expectedOf(expected), {
    eventId: 'topic-event',
    confirmation: switchReview.token,
  });
  assert.equal(checkout.state, 'diverged');
  assert.equal(checkout.head, localTip);
  assert.equal(git(local, 'rev-parse', 'origin/topic'), latest);
});

test('Activity rejects a dangling symbolic tracking ref introduced when Git begins the transaction', async t => {
  const { source, remote, local, repo } = checkoutFixture(t);
  git(source, 'switch', '-c', 'topic');
  git(source, 'push', 'origin', 'topic');
  const tracking = 'refs/remotes/origin/topic';
  const absent = 'refs/remotes/origin/absent';
  const checkoutGit = createCheckoutGit({
    matchesRemote: url => url === remote,
    run: async (path, args, options) => {
      if (args[2] === 'update-ref' && options?.input?.includes(`create ${tracking} `)) git(local, 'symbolic-ref', tracking, absent);
      return runGit(path, args, options);
    },
  });
  await assert.rejects(
    checkoutGit.switchToActivityBranch(repo, 'topic', expectedOf(await checkoutGit.status(repo))),
    /could not verify and refresh/,
  );
  assert.equal(git(local, 'symbolic-ref', tracking), absent);
  assert.equal(git(local, 'branch', '--show-current'), 'main');
});

test('Activity keeps the old tracker if Git cannot create the rewrite archive', async t => {
  const { source, remote, local, repo, commit, original } = checkoutFixture(t);
  git(source, 'switch', '-c', 'topic');
  const previous = commit(source, 'topic.txt', 'old history');
  git(source, 'push', 'origin', 'topic');
  git(local, 'fetch', 'origin', 'topic');
  git(source, 'reset', '--hard', original);
  commit(source, 'topic.txt', 'rewritten history');
  git(source, 'push', '--force-with-lease', 'origin', 'topic');
  const checkoutGit = createCheckoutGit({
    matchesRemote: url => url === remote,
    run: async (path, args, options) => {
      const archive = options?.input?.match(/^create (refs\/repo-pulse\/upstream-rewrites\/\S+) /m)?.[1];
      if (args[2] === 'update-ref' && archive) {
        const reflog = join(local, '.git', 'logs', archive);
        mkdirSync(reflog, { recursive: true });
        writeFileSync(join(reflog, 'block'), 'Keep the conflicting directory present.');
      }
      return runGit(path, args, options);
    },
  });
  const expected = await checkoutGit.status(repo);
  const switchReview = switchReviewOf(await checkoutGit.switchToActivityBranch(repo, 'topic', expectedOf(expected)));
  await assert.rejects(
    checkoutGit.switchToActivityBranch(repo, 'topic', expectedOf(expected), { confirmation: switchReview.token }),
    /could not verify and refresh/,
  );
  assert.equal(git(local, 'rev-parse', 'origin/topic'), previous);
  assert.equal(git(local, 'branch', '--show-current'), 'main');
});

async function checkedTopicRewrite(t: TestContext) {
  const fixture = checkoutFixture(t);
  const { source, local, repo, checkoutGit, commit, original } = fixture;
  git(source, 'switch', '-c', 'topic');
  const oldTip = commit(source, 'topic.txt', 'old history');
  git(source, 'push', 'origin', 'topic');
  git(local, 'fetch', 'origin', 'topic');
  git(local, 'switch', '--track', 'origin/topic');
  git(source, 'reset', '--hard', original);
  const newTip = commit(source, 'topic.txt', 'rewritten history');
  git(source, 'push', '--force-with-lease', 'origin', 'topic');
  const checked = await checkoutGit.update(repo, 'check', expectedOf(await checkoutGit.status(repo)));
  assert.equal(checked.checkout.state, 'upstream-rewritten');
  return { ...fixture, oldTip, newTip };
}

for (const remoteAdvances of [false, true]) {
  test(`Activity keeps the original rewrite baseline when the reconciled branch ${remoteAdvances ? 'can fast-forward' : 'is current'}`, async t => {
    const { source, local, repo, checkoutGit, commit, oldTip, newTip } = await checkedTopicRewrite(t);
    git(local, 'reset', '--hard', newTip);
    git(local, 'switch', 'main');
    if (remoteAdvances) {
      commit(source, 'topic.txt', 'normal advance');
      git(source, 'push', 'origin', 'topic');
    }
    const { checkout, switchReview, message } = outcome(
      await checkoutGit.switchToActivityBranch(repo, 'topic', expectedOf(await checkoutGit.status(repo))),
    );
    assert.equal(switchReview, undefined);
    assert.equal(message, undefined);
    assert.equal(checkout.state, remoteAdvances ? 'behind' : 'current');
    assert.equal(actions(checkout).canPull, remoteAdvances);
    const archive = present(git(local, 'for-each-ref', '--format=%(refname)', 'refs/repo-pulse/upstream-rewrites').split('\n')[0]);
    assert.ok(archive.endsWith(`/${newTip}/${oldTip}`));
  });
}

test('Activity ignores saved upstream observations from a replaced clone', async t => {
  const { source, remote, local, repo, checkoutGit, newTip } = await checkedTopicRewrite(t);
  renameSync(local, `${local}-previous`);
  git(source, 'clone', '--no-local', remote, local);
  const finished = await checkoutGit.switchToActivityBranch(repo, 'topic', expectedOf(await checkoutGit.status(repo)));
  assert.equal(outcome(finished).message, undefined);
  assert.equal(outcome(finished).switchReview, undefined);
  assert.equal(linked(finished.checkout).head, newTip);
  assert.equal(finished.checkout.state, 'current');
});

test('Activity never switches a replacement clone after refreshing the tracker', async t => {
  const { source, remote, local, repo } = checkoutFixture(t);
  git(source, 'switch', '-c', 'topic');
  git(source, 'push', 'origin', 'topic');
  const checkoutGit = createCheckoutGit({
    matchesRemote: url => url === remote,
    run: async (path, args, options) => {
      const output = await runGit(path, args, options);
      if (args[2] === 'update-ref' && options?.input?.includes('create refs/remotes/origin/topic ')) {
        renameSync(local, `${local}-previous`);
        git(source, 'clone', '--no-local', remote, local);
      }
      return output;
    },
  });
  const result = await checkoutGit.switchToActivityBranch(repo, 'topic', expectedOf(await checkoutGit.status(repo)));
  assert.match(present(outcome(result).message), /tracking ref was refreshed, but the checkout was not switched/);
  assert.equal(git(local, 'branch', '--show-current'), 'main');
  assert.equal(git(`${local}-previous`, 'branch', '--show-current'), 'main');
});

for (const afterSwitch of [false, true]) {
  test(`Activity detects checkout replacement during the ${afterSwitch ? 'final status read' : 'last pre-switch status read'}`, async t => {
    const { source, remote, local, repo } = checkoutFixture(t);
    git(source, 'switch', '-c', 'topic');
    git(source, 'push', 'origin', 'topic');
    const observations = new Map();
    let armed = false;
    const checkoutGit = createCheckoutGit({
      matchesRemote: url => url === remote,
      observations: {
        get: (id, identity) => observations.get(identity),
        save: (id, value) => {
          observations.set(value.identity, value);
          if (afterSwitch) armed = true;
        },
      },
      run: async (path, args, options) => {
        if (armed && args[0] === 'for-each-ref' && args.at(-1)?.startsWith('refs/repo-pulse/upstream-rewrites/')) {
          armed = false;
          renameSync(local, `${local}-previous`);
          git(source, 'clone', '--no-local', remote, local);
        }
        const output = await runGit(path, args, options);
        if (!afterSwitch && args[2] === 'update-ref' && options?.input?.includes('create refs/remotes/origin/topic ')) armed = true;
        return output;
      },
    });
    const result = await checkoutGit.switchToActivityBranch(repo, 'topic', expectedOf(await checkoutGit.status(repo)));
    assert.match(present(outcome(result).message), afterSwitch ? /could not be verified/ : /checkout was not switched/);
    assert.equal(linked(result.checkout).branch, 'main');
    assert.equal(git(local, 'branch', '--show-current'), 'main');
    assert.equal(git(`${local}-previous`, 'branch', '--show-current'), afterSwitch ? 'topic' : 'main');
  });
}

test('An existing branch follow-up retains its pre-upgrade checkout identity', async t => {
  const { local, remote, repo, pr } = squashFixture(t);
  git(local, 'fetch', 'origin', 'release');
  git(local, 'switch', '--track', 'origin/release');
  const plan = {
    id: 'saved-followup',
    path: local,
    source: 'topic',
    sourceHead: pr.head,
    targetRef: pr.target,
    result: pr.result,
    recordedSource: pr.head,
    targetIdentity: createHash('sha256')
      .update(
        JSON.stringify([
          local,
          {
            remote: 'origin',
            source: pr.target,
            tracking: 'refs/remotes/origin/release',
            url: remote,
          },
        ]),
      )
      .digest('hex'),
  };
  const checkoutGit = createCheckoutGit({
    matchesRemote: url => url === remote,
    followups: { get: () => plan, save: () => {} },
  });
  const checkout = await checkoutGit.status(repo);
  assert.equal(followupOf(checkout).id, plan.id);
  const reviewed = await checkoutGit.branchAction(repo, { operation: 'review', planId: plan.id }, expectedOf(checkout));
  assert.equal(branchReviewOf(reviewed).kind, 'included');
});

test('Activity reports an invalid symbolic tracker alongside the checkout even with a rewrite archive', async t => {
  const { source, remote, local, repo, original, commit } = checkoutFixture(t);
  git(source, 'switch', '-c', 'topic');
  commit(source, 'topic.txt', 'old topic');
  git(source, 'push', 'origin', 'topic');
  git(local, 'fetch', 'origin', 'topic');
  git(source, 'reset', '--hard', original);
  const tip = commit(source, 'topic.txt', 'remote topic');
  git(source, 'push', '--force-with-lease', 'origin', 'topic');
  const tracking = 'refs/remotes/origin/topic';
  const observations = new Map<string, Observation>();
  const observationStorage: Observations = {
    get: (id, identity) => observations.get(identity),
    save: (id, value) => observations.set(value.identity, value),
  };
  let inject = true;
  let sample = false;
  const checkoutGit = createCheckoutGit({
    matchesRemote: url => url === remote,
    observations: observationStorage,
    run: async (path, args, options) => {
      if (inject && observations.size && args[0] === 'for-each-ref' && args.at(-1)?.startsWith('refs/repo-pulse/upstream-rewrites/')) {
        inject = false;
        git(local, 'update-ref', tracking, original);
        sample = true;
      }
      if (sample && args[0] === 'for-each-ref' && args.at(-1) === tracking) {
        sample = false;
        git(local, 'symbolic-ref', tracking, 'refs/heads/topic');
      }
      return runGit(path, args, options);
    },
  });
  const expected = await checkoutGit.status(repo);
  const switchReview = switchReviewOf(await checkoutGit.switchToActivityBranch(repo, 'topic', expectedOf(expected)));
  const result = await checkoutGit.switchToActivityBranch(repo, 'topic', expectedOf(expected), { confirmation: switchReview.token });
  assert.match(present(outcome(result).message), /could not be verified/);
  assert.equal(present(linked(result.checkout).lastBranchCheck).matchesFetchedTip, false);
  const restarted = createCheckoutGit({ matchesRemote: url => url === remote, observations: observationStorage });
  const latest = await restarted.status(repo);
  assert.equal(linked(latest).branch, 'topic');
  assert.equal(diagnosticOf(latest).title, 'Upstream ref needs review');
  assert.equal(present(linked(latest).lastBranchCheck).matchesFetchedTip, false);
  assert.equal(actions(latest).canPull, false);
  assert.equal(git(local, 'rev-parse', tracking), tip);
});

test('Activity reports a refreshed tracker if Git refuses to switch over a local edit', async t => {
  const { source, local, repo, checkoutGit, commit, original } = checkoutFixture(t);
  git(source, 'switch', '-c', 'topic');
  const tip = commit(source, 'feature.txt', 'changed on the remote');
  git(source, 'push', 'origin', 'topic');
  writeFileSync(join(local, 'feature.txt'), 'unsaved edit');
  const result = await checkoutGit.switchToActivityBranch(repo, 'topic', expectedOf(await checkoutGit.status(repo)));
  assert.match(present(outcome(result).message), /tracking ref was refreshed, but the checkout was not switched/);
  assert.equal(linked(result.checkout).head, original);
  assert.equal(git(local, 'rev-parse', 'origin/topic'), tip);
  assert.equal(git(local, 'branch', '--show-current'), 'main');
  assert.equal(readFileSync(join(local, 'feature.txt'), 'utf8'), 'unsaved edit');
});

test('Activity confirmation belongs to the Git directory that was shown', async t => {
  const { source, remote, local, repo, checkoutGit } = checkoutFixture(t);
  git(source, 'switch', '-c', 'topic');
  git(source, 'push', 'origin', 'topic');
  const expected = await checkoutGit.status(repo);
  renameSync(local, `${local}-previous`);
  git(source, 'clone', '--no-local', remote, local);

  await assert.rejects(checkoutGit.switchToActivityBranch(repo, 'topic', expectedOf(expected)), /checkout changed/i);
  assert.equal(git(local, 'branch', '--show-current'), 'main');
  assert.equal(git(`${local}-previous`, 'branch', '--show-current'), 'main');
});

test('Activity reports a partial switch if a conflicting fetch mapping appears during the switch', async t => {
  const { source, remote, local, repo } = checkoutFixture(t);
  const name = 'group/topic';
  git(source, 'switch', '-c', name);
  git(source, 'push', 'origin', name);
  const checkoutGit = createCheckoutGit({
    matchesRemote: url => url === remote,
    run: async (path, args, options) => {
      if (args[2] === 'switch') {
        // Older Git versions allowed these overlapping remote names through `remote add`.
        git(local, 'config', 'remote.origin/group.url', remote);
        git(local, 'config', 'remote.origin/group.fetch', '+refs/heads/*:refs/remotes/origin/group/*');
      }
      return runGit(path, args, options);
    },
  });
  const result = await checkoutGit.switchToActivityBranch(repo, name, expectedOf(await checkoutGit.status(repo)));
  assert.match(present(outcome(result).message), /could not be verified/);
  assert.equal(linked(result.checkout).branch, name);
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
    run: async (path, args, options) => {
      if (args[0] === 'config' && args[3] === 'branch.topic.merge') git(local, 'symbolic-ref', tracking, absent);
      return runGit(path, args, options);
    },
  });
  const result = await checkoutGit.switchToActivityBranch(repo, 'topic', expectedOf(await checkoutGit.status(repo)));
  assert.match(present(outcome(result).message), /could not be verified/);
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
    run: async (path, args, options) => {
      if (args[0] === 'ls-remote' && args[1] === '--get-url' && ++validations === 2) {
        renameSync(local, `${local}-previous`);
        git(source, 'clone', '--no-local', remote, local);
      }
      return runGit(path, args, options);
    },
  });
  await assert.rejects(checkoutGit.switchToActivityBranch(repo, 'topic', expectedOf(await checkoutGit.status(repo))), /checkout changed/i);
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
    run: async (path, args, options) => {
      if (args[0] === 'ls-remote' && args[1] === '--get-url' && ++validations === 5) {
        renameSync(local, `${local}-previous`);
        git(source, 'clone', '--no-local', remote, local);
      }
      return runGit(path, args, options);
    },
  });
  const result = await checkoutGit.switchToActivityBranch(repo, 'topic', expectedOf(await checkoutGit.status(repo)));
  assert.match(present(outcome(result).message), /could not be verified/);
  assert.equal(linked(result.checkout).branch, 'main');
  assert.equal(git(`${local}-previous`, 'branch', '--show-current'), 'topic');
});

async function setup(
  t: TestContext,
  { followup = false, conflict = false, run }: { followup?: boolean; conflict?: boolean; run?: GitRunner } = {},
) {
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
  const { checkout } = await adapter.update(repo, 'check', expectedOf(await adapter.status(repo)));
  assert.equal(adviceOf(checkout).destination, 'local');
  assert.equal(git(local, 'rev-parse', 'origin/release'), pr.result);
  return {
    ...fixture,
    adapter,
    tip,
    first,
    second,
    checkout,
    switchTarget: () => adapter.branchAction(repo, { operation: 'switch-update', prId: pr.id, result: pr.result }, expectedOf(checkout)),
    // The tests pass commits only with carry, so each call makes one of the BranchAction variants.
    act: (target: CheckoutStatus, operation: 'review' | 'remove' | 'carry', extra?: { commits: string[] }) =>
      adapter.branchAction(repo, { operation, planId: followupOf(target).id, ...extra } as BranchAction, expectedOf(target)),
  };
}

test('switch updates a locally current squash PR target and old branch removal is recoverable', async t => {
  const fixture = await setup(t);
  const { local, source, pr, tip, switchTarget, act } = fixture;
  const { checkout, message } = outcome(await switchTarget());
  assert.match(present(message), /Switched to release and updated/);
  assert.equal(linked(checkout).head, tip);
  assert.equal(git(local, 'rev-parse', 'topic'), pr.head);
  assert.equal(git(source, 'rev-parse', 'release'), tip);
  assert.equal(branchReviewOf(await act(checkout, 'review')).kind, 'included');
  git(local, 'pack-refs', '--all');
  const removed = await act(checkout, 'remove');
  assert.match(present(outcome(removed).message), /Removed local branch topic/);
  assert.equal(linked(removed.checkout).followup, undefined);
  assert.throws(() => git(local, 'show-ref', '--verify', 'refs/heads/topic'));
  assert.equal(git(local, 'rev-parse', `refs/repo-pulse/archive/${followupOf(checkout).id}`), pr.head);
  assert.equal(git(local, 'branch', '--show-current'), 'release');
});

test('a branch switch just before the target update merges is reported as unclear, not as blocked', async t => {
  const run: GitRunner = async (path, args, options) => {
    // A terminal switch after the final check, to a new branch already at the upstream tip.
    if (args.includes('merge') && args.includes('--ff-only')) git(path, 'switch', '--quiet', '-c', 'other', present(args.at(-1)));
    return runGit(path, args, options);
  };
  const { switchTarget } = await setup(t, { run });
  const { message } = outcome(await switchTarget());
  assert.equal(
    message,
    'Switched to release. The checkout is no longer on release, so it is unclear which branch moved. Review the checkout in Git.',
  );
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
  assert.match(present(outcome(result).message), /Switched to release. The update was blocked/);
  assert.equal(git(local, 'branch', '--show-current'), 'release');
  assert.equal(git(local, 'rev-parse', 'release'), target);
  assert.equal(git(local, 'rev-parse', 'topic'), pr.head);
});

function interceptGit(beforeRun: (path: string, options: Parameters<GitRunner>[2]) => void): GitRunner {
  return async (path, args, options) => {
    beforeRun(path, options);
    const command = exec('git', ['-C', path, ...args], { env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', ...options?.guard } });
    if (options?.input) {
      const stdin = present(command.child.stdin);
      stdin.on('error', () => {});
      stdin.end(options.input);
    }
    return (await command).stdout;
  };
}

test('an existing symbolic recovery ref cannot satisfy the archive requirement', async t => {
  const { local, pr, switchTarget, act } = await setup(t);
  const { checkout } = await switchTarget();
  const archive = `refs/repo-pulse/archive/${followupOf(checkout).id}`;
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
  let newTip: string | undefined;
  const runner = interceptGit((path, options) => {
    if (options?.guard?.REPO_PULSE_DELETE_REF) git(path, 'update-ref', 'refs/heads/topic', present(newTip));
  });
  const { local, original, pr, switchTarget, act } = await setup(t, { run: runner });
  newTip = original;
  const { checkout } = await switchTarget();
  await assert.rejects(act(checkout, 'remove'), /could not remove/);
  assert.equal(git(local, 'rev-parse', 'topic'), original);
  assert.equal(git(local, 'rev-parse', `refs/repo-pulse/archive/${followupOf(checkout).id}`), pr.head);
});

test('old branch in another worktree cannot be removed', async t => {
  const { local, pr, switchTarget, act } = await setup(t);
  const { checkout } = await switchTarget();
  git(local, 'worktree', 'add', join(local, '..', 'other'), 'topic');
  assert.equal(branchReviewOf(await act(checkout, 'review')).kind, 'occupied');
  await assert.rejects(act(checkout, 'remove'), /cannot be removed/);
  assert.equal(git(local, 'rev-parse', 'topic'), pr.head);
});

test('an unrelated detached worktree does not block removing the old branch', async t => {
  const { local, switchTarget, act } = await setup(t);
  const { checkout } = await switchTarget();
  git(local, 'worktree', 'add', '--detach', join(local, '..', 'detached'), 'release');
  assert.equal(branchReviewOf(await act(checkout, 'review')).canRemove, true);
  assert.match(present(outcome(await act(checkout, 'remove')).message), /Removed local branch topic/);
});

test('a detached worktree rebasing the old branch prevents removal', async t => {
  const { local, second, switchTarget, act } = await setup(t, { followup: true, conflict: true });
  const { checkout } = await switchTarget();
  const worktree = join(local, '..', 'rebasing');
  git(local, 'worktree', 'add', worktree, 'topic');
  assert.throws(() => git(worktree, 'rebase', 'release'));
  assert.equal(git(worktree, 'branch', '--show-current'), '');
  assert.equal(branchReviewOf(await act(checkout, 'review')).kind, 'occupied');
  await assert.rejects(act(checkout, 'remove'), /cannot be removed/);
  assert.equal(git(local, 'rev-parse', 'topic'), second);
  git(worktree, 'rebase', '--abort');
});

test('a detached worktree bisecting the old branch prevents removal', async t => {
  const { local, original, second, switchTarget, act } = await setup(t, { followup: true });
  const { checkout } = await switchTarget();
  const worktree = join(local, '..', 'bisecting');
  git(local, 'worktree', 'add', worktree, 'topic');
  git(worktree, 'bisect', 'start', present(second), original);
  assert.equal(git(worktree, 'branch', '--show-current'), '');
  assert.equal(branchReviewOf(await act(checkout, 'review')).kind, 'occupied');
  await assert.rejects(act(checkout, 'remove'), /cannot be removed/);
  assert.equal(git(local, 'rev-parse', 'topic'), second);
  git(worktree, 'bisect', 'reset');
});

test('carry applies only selected follow-up commits and leaves both original branch refs untouched', async t => {
  const { local, first, second, tip, switchTarget, act } = await setup(t, { followup: true });
  const { checkout } = await switchTarget();
  const review = branchReviewOf(await act(checkout, 'review'));
  assert.deepEqual(
    present(review.commits).map(commit => commit.id),
    [first, second],
  );
  await assert.rejects(act(checkout, 'carry', { commits: [tip] }), /selected commits/);
  const result = await act(checkout, 'carry', { commits: [present(second)] });
  assert.equal(linked(result.checkout).branch, review.branch);
  assert.equal(git(local, 'rev-parse', 'release'), tip);
  assert.equal(git(local, 'rev-parse', 'topic'), second);
  assert.equal(git(local, 'log', '-1', '--format=%s'), 'second local commit');
  assert.equal(git(local, 'log', '-1', '--format=%P'), tip);
  assert.deepEqual(git(local, 'diff', '--name-only', 'release', 'HEAD').split('\n'), ['second.txt']);
});

test('carry turns off submodule recursion for its worktree and cherry-pick, as Pull does', async t => {
  const calls: string[][] = [];
  const run: GitRunner = async (path, args, options) => {
    calls.push(args);
    return runGit(path, args, options);
  };
  const { local, second, switchTarget, act } = await setup(t, { followup: true, run });
  git(local, 'config', 'submodule.recurse', 'true');
  const { checkout } = await switchTarget();
  await act(checkout, 'review');
  await act(checkout, 'carry', { commits: [present(second)] });
  const configs = (args: string[]) => args.flatMap((arg, index) => (args[index - 1] === '-c' ? [arg] : []));
  const worktree = present(calls.find(args => args.includes('worktree') && args.includes('add')));
  const pick = present(calls.find(args => args.includes('cherry-pick')));
  assert.ok(configs(worktree).includes('submodule.recurse=false'), `worktree add: ${worktree.join(' ')}`);
  assert.ok(configs(pick).includes('submodule.recurse=false'), `cherry-pick: ${pick.join(' ')}`);
});

test('carry conflicts remain in a separate worktree for native Git continue or abort', async t => {
  const { local, second, tip, switchTarget, act } = await setup(t, { followup: true, conflict: true });
  const { checkout } = await switchTarget();
  const result = await act(checkout, 'carry', { commits: [present(second)] });
  assert.match(present(outcome(result).nextStep), /Continue or abort/);
  assert.equal(linked(result.checkout).branch, 'release');
  assert.equal(git(local, 'rev-parse', 'release'), tip);
  assert.equal(git(local, 'rev-parse', 'topic'), second);
  const workspace = followupOf(result.checkout).workspace;
  assert.ok(workspace);
  assert.equal(followupOf((await act(checkout, 'review')).checkout).workspace, workspace);
  assert.equal(git(workspace, 'rev-parse', 'CHERRY_PICK_HEAD'), second);
  assert.match(readFileSync(join(workspace, 'second.txt'), 'utf8'), /<<<<<<< HEAD/);
  git(workspace, 'cherry-pick', '--abort');
  assert.equal(git(workspace, 'rev-parse', 'HEAD'), tip);
});

test('local branches lists the checkout heads without switching', async t => {
  const { local, repo, checkoutGit } = checkoutFixture(t);
  git(local, 'branch', 'feature/local');
  assert.deepEqual((await checkoutGit.localBranches(repo)).sort(), ['feature/local', 'main']);
  assert.equal(git(local, 'branch', '--show-current'), 'main');
  await assert.rejects(checkoutGit.localBranches({ ...repo, localPath: undefined }), /No local checkout linked/);
});
