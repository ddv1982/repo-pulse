import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createCheckoutGit } from '../server/checkout-git.ts';
import { createCheckoutLookup } from '../server/checkout-advice.ts';
import { createStore } from '../server/store.ts';
import { createAzureClient } from '../server/azure-client.ts';
import type { CheckoutPull } from '../server/azure-client.ts';
import type { Observation } from '../server/checkout-observations.ts';
import type { Thrown } from './fixtures/typed.ts';
import { fakeCli } from './fixtures/azure.ts';

type CheckoutGitOptions = Parameters<typeof createCheckoutGit>[0];
import { actions, adviceOf, checkoutFixture, comparisonOf, diagnosticOf, expectedOf, git, squashFixture } from './fixtures/checkout.ts';

test('missing upstream gives verified squash target advice without changing the checkout', async t => {
  const { repo, pr, remote, local } = squashFixture(t);
  const adapter = createCheckoutGit({
    matchesRemote: url => url === remote,
    findPulls: async () => [pr],
  });
  const status = await adapter.status(repo);
  const { checkout, updated } = await adapter.update(repo, 'check', expectedOf(status));
  assert.equal(checkout.state, 'upstream-missing');
  assert.equal(actions(checkout).canPull, false);
  assert.equal(updated, false);
  assert.equal(adviceOf(checkout).verified, true);
  assert.match(diagnosticOf(checkout).suggestion, /Fetch and check out release/);
  git(local, 'fetch', 'origin', 'release');
  git(local, 'branch', '--track', 'release', 'origin/release');
  const { checkout: localTarget } = await adapter.update(repo, 'check', expectedOf(checkout));
  assert.match(diagnosticOf(localTarget).suggestion, /Switch to release/);
  git(local, 'worktree', 'add', join(local, '..', 'release-worktree'), 'release');
  const { checkout: worktreeTarget } = await adapter.update(repo, 'check', expectedOf(localTarget));
  assert.match(diagnosticOf(worktreeTarget).suggestion, /existing worktree for release/);
  assert.equal(git(local, 'branch', '--show-current'), 'topic');
  assert.equal(git(local, 'rev-parse', 'HEAD'), pr.head);
});

test('same branch name, foreign source identity, dirty checkout and missing target never give unsafe switch advice', async t => {
  const { repo, pr, remote, local, original } = squashFixture(t);
  git(local, 'fetch', 'origin', 'release');
  git(local, 'branch', '--track', 'release', 'origin/release');
  const candidates: [CheckoutPull, boolean][] = [
    [{ ...pr, head: original }, true],
    [{ ...pr, sourceId: 'fork' }, false],
  ];
  for (const [candidate, targetVerified] of candidates) {
    const adapter = createCheckoutGit({ matchesRemote: url => url === remote, findPulls: async () => [candidate] });
    const { checkout } = await adapter.update(repo, 'check', expectedOf(await adapter.status(repo)));
    assert.equal(adviceOf(checkout).verified, false);
    assert.match(diagnosticOf(checkout).suggestion, /Keep your local branch/);
    assert.equal(Boolean(adviceOf(checkout).targetVerified), targetVerified);
    if (targetVerified) assert.match(diagnosticOf(checkout).suggestion, /To test the merged PR: Switch to release/);
    else assert.doesNotMatch(diagnosticOf(checkout).suggestion, /Switch to release/);
  }
  const adapter = createCheckoutGit({ matchesRemote: url => url === remote, findPulls: async () => [pr] });
  const { checkout: suggested } = await adapter.update(repo, 'check', expectedOf(await adapter.status(repo)));
  assert.equal(adviceOf(suggested).verified, true);
  writeFileSync(join(local, 'uncommitted.txt'), 'keep my local edits');
  const dirty = await adapter.update(repo, 'check', expectedOf(suggested));
  assert.match(diagnosticOf(dirty.checkout).suggestion, /Save your local changes/);
  git(remote, 'update-ref', '-d', 'refs/heads/release');
  const { checkout: missingTarget } = await adapter.update(repo, 'check', expectedOf(dirty.checkout));
  assert.equal(adviceOf(missingTarget).verified, false);
  assert.doesNotMatch(diagnosticOf(missingTarget).suggestion, /Switch to release/);
  assert.equal(git(local, 'rev-parse', 'HEAD'), pr.head);
});

test('completed PRs from one head into different targets keep the advice unverified, whatever fields checkout does not use', async t => {
  const { repo, pr, remote } = squashFixture(t);
  const azurePr = (id: number, fields: Record<string, unknown> = {}) => ({
    pullRequestId: id,
    status: 'completed',
    repository: { id: repo.azureId },
    sourceRefName: pr.source,
    targetRefName: pr.target,
    lastMergeSourceCommit: { commitId: pr.head },
    lastMergeCommit: { commitId: pr.result },
    completionOptions: { mergeStrategy: 'squash' },
    ...fields,
  });
  const verifiedWith = async (second: Record<string, unknown>) => {
    const client = createAzureClient({ cli: fakeCli(async () => ({ value: [azurePr(101), second] })) });
    const adapter = createCheckoutGit({
      matchesRemote: url => url === remote,
      findPulls: async (linked, source) => client.completedCheckoutPulls(linked, source),
    });
    const { checkout } = await adapter.update(repo, 'check', expectedOf(await adapter.status(repo)));
    return adviceOf(checkout).verified;
  };
  assert.equal(await verifiedWith(azurePr(101)), true, 'one target verifies');
  // Sol's probe: main keeps PR 102, whose reviewers only the activity stream reads, and so sees two targets.
  assert.equal(await verifiedWith(azurePr(102, { targetRefName: 'refs/heads/hotfix', reviewers: 'not a list' })), false);
  // A PR whose target checkout cannot read may be another target, so it is an ambiguity rather than left out.
  assert.equal(await verifiedWith(azurePr(102, { targetRefName: 42 })), false);
  assert.equal(await verifiedWith(azurePr(102, { lastMergeCommit: { commitId: 7 } })), false);
});

test('checkout PR lookup consults the provider only when cache has no exact evidence', async t => {
  const { repo, pr } = squashFixture(t);
  let calls = 0;
  const cached = { ...pr, result: undefined };
  const lookup = createCheckoutLookup({
    cached: () => [cached],
    lookup: async () => {
      calls++;
      return [pr];
    },
  });
  assert.deepEqual(await lookup(repo, pr.source, pr.head), [pr]);
  assert.equal(calls, 1);
  assert.deepEqual(
    await createCheckoutLookup({
      cached: () => [pr],
      lookup: async () => {
        calls++;
        return [];
      },
    })(repo, pr.source, pr.head),
    [pr],
  );
  assert.equal(calls, 1);
  const fallback = createCheckoutLookup({
    cached: () => [cached],
    lookup: async () => {
      throw new Error('Unavailable');
    },
  });
  assert.deepEqual(await fallback(repo, pr.source, pr.head), [cached]);
});

test('Check and Pull detect a rewritten upstream and keep comparison across adapter restart', async t => {
  const { repo, local, original, source, remote, advance, commit } = checkoutFixture(t);
  const previous = advance();
  const store = createStore();
  store.saveRepo(repo);
  t.after(() => store.close());
  const options: CheckoutGitOptions = {
    matchesRemote: url => url === remote,
    // Read back as server/runtime.ts does: the store keeps observations as JSON settings.
    observations: { get: store.getCheckoutObservation, save: store.saveCheckoutObservation },
  };
  const adapter = createCheckoutGit(options);
  const before = await adapter.update(repo, 'check', expectedOf(await adapter.status(repo)));
  assert.equal(actions(before.checkout).canPull, true);
  git(source, 'switch', '--detach', original);
  const tip = commit(source, 'different.txt', 'rewritten commit');
  git(source, 'push', '--force', 'origin', 'HEAD:refs/heads/main');
  const { checkout, updated } = await adapter.update(repo, 'pull', expectedOf(before.checkout));
  assert.equal(updated, false);
  assert.equal(checkout.state, 'upstream-rewritten');
  assert.equal(actions(checkout).canPull, false);
  assert.equal(comparisonOf(checkout).previous, previous);
  assert.equal(comparisonOf(checkout).tip, tip);
  assert.deepEqual(new Set(comparisonOf(checkout).commits.map(commit => commit.side)), new Set(['old', 'new']));
  assert.equal(git(local, 'rev-parse', 'HEAD'), original);
  const restarted = createCheckoutGit(options);
  assert.equal((await restarted.status(repo)).state, 'upstream-rewritten');
  assert.equal((await restarted.update(repo, 'check', expectedOf(checkout))).checkout.state, 'upstream-rewritten');
  await assert.rejects(restarted.update(repo, 'pull', expectedOf(checkout)), /no longer eligible/);
});

test('a local rebase in progress names the operation and blocks update actions', async t => {
  const { repo, local, commit, checkoutGit } = checkoutFixture(t);
  git(local, 'config', 'user.email', 'fixture@example.test');
  git(local, 'config', 'user.name', 'Fixture');
  git(local, 'switch', '-c', 'topic');
  commit(local, 'feature.txt', 'topic edits');
  git(local, 'switch', 'main');
  commit(local, 'feature.txt', 'conflicting main edit');
  git(local, 'switch', 'topic');
  assert.throws(
    () => git(local, 'rebase', 'main'),
    (error: Thrown) => error.status === 1,
  );
  const checkout = await checkoutGit.status(repo);
  assert.equal(checkout.state, 'in-progress');
  assert.equal(diagnosticOf(checkout).title, 'Rebase in progress');
  assert.match(diagnosticOf(checkout).suggestion, /Finish or abort/);
  assert.equal(actions(checkout).canCheck, false);
  assert.equal(actions(checkout).canPull, false);
});

test('a rewrite fetched outside Repo Pulse still compares to the saved baseline', async t => {
  const { repo, local, original, remote, advance } = checkoutFixture(t);
  const previous = advance();
  const rows = new Map<string, Observation>();
  const options: CheckoutGitOptions = {
    matchesRemote: url => url === remote,
    observations: {
      get: id => rows.get(id),
      save: (id, value) => {
        rows.set(id, value);
      },
    },
  };
  const adapter = createCheckoutGit(options);
  await adapter.update(repo, 'check', expectedOf(await adapter.status(repo)));
  git(remote, 'update-ref', 'refs/heads/main', original);
  git(local, 'fetch', 'origin', 'main');
  const restarted = createCheckoutGit(options);
  const { checkout } = await restarted.update(repo, 'check', expectedOf(await restarted.status(repo)));
  assert.equal(checkout.state, 'upstream-rewritten');
  assert.equal(comparisonOf(checkout).previous, previous);
  assert.equal(comparisonOf(checkout).tip, original);
});

test('authentication failures stay distinct from a missing ref and redact Git stderr', async t => {
  const { repo, remote } = checkoutFixture(t);
  const adapter = createCheckoutGit({
    matchesRemote: url => url === remote,
    run: async (path, args) => {
      if (args[2] === 'fetch')
        throw Object.assign(new Error('fetch failure'), { stderr: 'fatal: Authentication failed for credential-bearing fixture' });
      return git(path, ...args);
    },
  });
  const { checkout } = await adapter.update(repo, 'check', expectedOf(await adapter.status(repo)));
  assert.equal(checkout.state, 'fetch-failed');
  assert.equal(diagnosticOf(checkout).title, 'Git authentication failed');
  assert.equal(actions(checkout).canCheck, true);
  assert.equal(actions(checkout).canPull, false);
  assert.doesNotMatch(JSON.stringify(checkout), /credential-bearing fixture/);
});

test('an external advance followed by a rewrite of that tip cannot fast-forward the checkout', async t => {
  const { repo, local, original, remote, source, advance, commit } = checkoutFixture(t);
  const a = advance();
  const adapter = createCheckoutGit({ matchesRemote: url => url === remote });
  const { checkout: atA } = await adapter.update(repo, 'check', expectedOf(await adapter.status(repo)));
  const b = commit(source, 'external.txt', 'external advance');
  git(source, 'push', 'origin', 'main');
  git(local, 'fetch', 'origin', 'main');
  assert.equal(git(local, 'rev-parse', 'origin/main'), b);
  git(source, 'switch', '--detach', a);
  const c = commit(source, 'replacement.txt', 'replacement after A');
  git(source, 'push', '--force', 'origin', 'HEAD:refs/heads/main');
  const { checkout, updated } = await adapter.update(repo, 'pull', expectedOf(atA));
  assert.equal(updated, false);
  assert.equal(checkout.state, 'upstream-rewritten');
  assert.equal(comparisonOf(checkout).previous, b);
  assert.equal(comparisonOf(checkout).tip, c);
  assert.equal(git(local, 'rev-parse', 'HEAD'), original);
});

test('a verified target with the wrong local upstream gets review advice, not a switch suggestion', async t => {
  const { repo, pr, remote, local } = squashFixture(t);
  git(local, 'fetch', 'origin', 'release');
  git(local, 'branch', 'release', 'origin/release');
  const adapter = createCheckoutGit({ matchesRemote: url => url === remote, findPulls: async () => [pr] });
  for (const upstream of ['origin/main', 'other/release']) {
    if (upstream === 'other/release') {
      const other = join(local, '..', 'other.git');
      git(local, 'clone', '--bare', '--no-local', remote, other);
      git(local, 'remote', 'add', 'other', other);
      git(local, 'fetch', 'other', 'release');
    }
    git(local, 'branch', '--set-upstream-to', upstream, 'release');
    const { checkout } = await adapter.update(repo, 'check', expectedOf(await adapter.status(repo)));
    assert.equal(adviceOf(checkout).verified, true);
    assert.match(diagnosticOf(checkout).suggestion, /Review the upstream of your local release branch/);
    assert.doesNotMatch(diagnosticOf(checkout).suggestion, /Switch to release/);
  }
});

test('an unresolved ancestor check survives repeated checks even when HEAD matches the fetched tip', async t => {
  const { repo, local, original, remote, advance } = checkoutFixture(t);
  const previous = advance();
  let unavailable = true;
  let attempts = 0;
  const rows = new Map<string, Observation>();
  const options: CheckoutGitOptions = {
    matchesRemote: url => url === remote,
    observations: {
      get: id => rows.get(id),
      save: (id, value) => {
        rows.set(id, value);
      },
    },
    run: async (path, args) => {
      if (args[0] === 'merge-base' && args[2] === previous && args[3] === original) {
        attempts++;
        if (unavailable) throw new Error('ancestry unavailable');
      }
      return git(path, ...args);
    },
  };
  const adapter = createCheckoutGit(options);
  await adapter.update(repo, 'check', expectedOf(await adapter.status(repo)));
  git(remote, 'update-ref', 'refs/heads/main', original);
  const first = await adapter.update(repo, 'check', expectedOf(await adapter.status(repo)));
  assert.equal(first.checkout.state, 'upstream-rewritten');
  assert.equal(comparisonOf(first.checkout).verified, false);
  assert.equal(git(local, 'rev-parse', 'HEAD'), original);
  const restarted = createCheckoutGit(options);
  const repeated = await restarted.update(repo, 'check', expectedOf(first.checkout));
  assert.equal(repeated.checkout.state, 'upstream-rewritten');
  assert.equal(actions(repeated.checkout).canPull, false);
  assert.equal(comparisonOf(repeated.checkout).verified, false);
  assert.equal(attempts, 2);
  unavailable = false;
  const resolved = await restarted.update(repo, 'check', expectedOf(repeated.checkout));
  assert.equal(attempts, 3);
  assert.equal(comparisonOf(resolved.checkout).verified, true);
  assert.equal(actions(resolved.checkout).canPull, false);
  const acknowledged = await restarted.update(repo, 'check', expectedOf(resolved.checkout));
  assert.equal(acknowledged.checkout.state, 'current');
});
