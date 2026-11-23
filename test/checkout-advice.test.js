import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createCheckoutGit } from '../server/checkout-git.ts';
import { createCheckoutLookup } from '../server/checkout-advice.ts';
import { createStore } from '../server/store.ts';
import { checkoutFixture, git, squashFixture } from './fixtures/checkout.ts';

test('missing upstream gives verified squash target advice without changing the checkout', async t => {
  const { repo, pr, remote, local } = squashFixture(t);
  const adapter = createCheckoutGit({
    matchesRemote: url => url === remote,
    findPulls: async () => [pr],
  });
  const status = await adapter.status(repo);
  const { checkout, updated } = await adapter.update(repo, 'check', status);
  assert.equal(checkout.state, 'upstream-missing');
  assert.equal(checkout.canPull, false);
  assert.equal(updated, false);
  assert.equal(checkout.diagnostic.advice.verified, true);
  assert.match(checkout.diagnostic.suggestion, /Fetch and check out release/);
  git(local, 'fetch', 'origin', 'release');
  git(local, 'branch', '--track', 'release', 'origin/release');
  const { checkout: localTarget } = await adapter.update(repo, 'check', checkout);
  assert.match(localTarget.diagnostic.suggestion, /Switch to release/);
  git(local, 'worktree', 'add', join(local, '..', 'release-worktree'), 'release');
  const { checkout: worktreeTarget } = await adapter.update(repo, 'check', localTarget);
  assert.match(worktreeTarget.diagnostic.suggestion, /existing worktree for release/);
  assert.equal(git(local, 'branch', '--show-current'), 'topic');
  assert.equal(git(local, 'rev-parse', 'HEAD'), pr.head);
});

test('same branch name, foreign source identity, dirty checkout and missing target never give unsafe switch advice', async t => {
  const { repo, pr, remote, local, original } = squashFixture(t);
  git(local, 'fetch', 'origin', 'release');
  git(local, 'branch', '--track', 'release', 'origin/release');
  for (const [candidate, targetVerified] of [
    [{ ...pr, head: original }, true],
    [{ ...pr, sourceId: 'fork' }, false],
  ]) {
    const adapter = createCheckoutGit({ matchesRemote: url => url === remote, findPulls: async () => [candidate] });
    const { checkout } = await adapter.update(repo, 'check', await adapter.status(repo));
    assert.equal(checkout.diagnostic.advice.verified, false);
    assert.match(checkout.diagnostic.suggestion, /Keep your local branch/);
    assert.equal(Boolean(checkout.diagnostic.advice.targetVerified), targetVerified);
    if (targetVerified) assert.match(checkout.diagnostic.suggestion, /To test the merged PR: Switch to release/);
    else assert.doesNotMatch(checkout.diagnostic.suggestion, /Switch to release/);
  }
  const adapter = createCheckoutGit({ matchesRemote: url => url === remote, findPulls: async () => [pr] });
  const { checkout: suggested } = await adapter.update(repo, 'check', await adapter.status(repo));
  assert.equal(suggested.diagnostic.advice.verified, true);
  writeFileSync(join(local, 'uncommitted.txt'), 'keep my local edits');
  const dirty = await adapter.update(repo, 'check', suggested);
  assert.match(dirty.checkout.diagnostic.suggestion, /Save your local changes/);
  git(remote, 'update-ref', '-d', 'refs/heads/release');
  const { checkout: missingTarget } = await adapter.update(repo, 'check', dirty.checkout);
  assert.equal(missingTarget.diagnostic.advice.verified, false);
  assert.doesNotMatch(missingTarget.diagnostic.suggestion, /Switch to release/);
  assert.equal(git(local, 'rev-parse', 'HEAD'), pr.head);
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
  t.after(() => store.close());
  const options = {
    matchesRemote: url => url === remote,
    observations: { get: id => store.getSetting('checkout:' + id), save: (id, value) => store.setSetting('checkout:' + id, value) },
  };
  const adapter = createCheckoutGit(options);
  const before = await adapter.update(repo, 'check', await adapter.status(repo));
  assert.equal(before.checkout.canPull, true);
  git(source, 'switch', '--detach', original);
  const tip = commit(source, 'different.txt', 'rewritten commit');
  git(source, 'push', '--force', 'origin', 'HEAD:refs/heads/main');
  const { checkout, updated } = await adapter.update(repo, 'pull', before.checkout);
  assert.equal(updated, false);
  assert.equal(checkout.state, 'upstream-rewritten');
  assert.equal(checkout.canPull, false);
  assert.equal(checkout.diagnostic.comparison.previous, previous);
  assert.equal(checkout.diagnostic.comparison.tip, tip);
  assert.deepEqual(new Set(checkout.diagnostic.comparison.commits.map(commit => commit.side)), new Set(['old', 'new']));
  assert.equal(git(local, 'rev-parse', 'HEAD'), original);
  const restarted = createCheckoutGit(options);
  assert.equal((await restarted.status(repo)).state, 'upstream-rewritten');
  assert.equal((await restarted.update(repo, 'check', checkout)).checkout.state, 'upstream-rewritten');
  await assert.rejects(restarted.update(repo, 'pull', checkout), /no longer eligible/);
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
    error => error.status === 1,
  );
  const checkout = await checkoutGit.status(repo);
  assert.equal(checkout.state, 'in-progress');
  assert.equal(checkout.diagnostic.title, 'Rebase in progress');
  assert.match(checkout.diagnostic.suggestion, /Finish or abort/);
  assert.equal(checkout.canCheck, false);
  assert.equal(checkout.canPull, false);
});

test('a rewrite fetched outside Repo Pulse still compares to the saved baseline', async t => {
  const { repo, local, original, remote, advance } = checkoutFixture(t);
  const previous = advance();
  const rows = new Map();
  const options = {
    matchesRemote: url => url === remote,
    observations: {
      get: id => rows.get(id),
      save: (id, value) => {
        rows.set(id, value);
      },
    },
  };
  const adapter = createCheckoutGit(options);
  await adapter.update(repo, 'check', await adapter.status(repo));
  git(remote, 'update-ref', 'refs/heads/main', original);
  git(local, 'fetch', 'origin', 'main');
  const restarted = createCheckoutGit(options);
  const { checkout } = await restarted.update(repo, 'check', await restarted.status(repo));
  assert.equal(checkout.state, 'upstream-rewritten');
  assert.equal(checkout.diagnostic.comparison.previous, previous);
  assert.equal(checkout.diagnostic.comparison.tip, original);
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
  const { checkout } = await adapter.update(repo, 'check', await adapter.status(repo));
  assert.equal(checkout.state, 'fetch-failed');
  assert.equal(checkout.diagnostic.title, 'Git authentication failed');
  assert.equal(checkout.canCheck, true);
  assert.equal(checkout.canPull, false);
  assert.doesNotMatch(JSON.stringify(checkout), /credential-bearing fixture/);
});

test('an external advance followed by a rewrite of that tip cannot fast-forward the checkout', async t => {
  const { repo, local, original, remote, source, advance, commit } = checkoutFixture(t);
  const a = advance();
  const adapter = createCheckoutGit({ matchesRemote: url => url === remote });
  const { checkout: atA } = await adapter.update(repo, 'check', await adapter.status(repo));
  const b = commit(source, 'external.txt', 'external advance');
  git(source, 'push', 'origin', 'main');
  git(local, 'fetch', 'origin', 'main');
  assert.equal(git(local, 'rev-parse', 'origin/main'), b);
  git(source, 'switch', '--detach', a);
  const c = commit(source, 'replacement.txt', 'replacement after A');
  git(source, 'push', '--force', 'origin', 'HEAD:refs/heads/main');
  const { checkout, updated } = await adapter.update(repo, 'pull', atA);
  assert.equal(updated, false);
  assert.equal(checkout.state, 'upstream-rewritten');
  assert.equal(checkout.diagnostic.comparison.previous, b);
  assert.equal(checkout.diagnostic.comparison.tip, c);
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
    const { checkout } = await adapter.update(repo, 'check', await adapter.status(repo));
    assert.equal(checkout.diagnostic.advice.verified, true);
    assert.match(checkout.diagnostic.suggestion, /Review the upstream of your local release branch/);
    assert.doesNotMatch(checkout.diagnostic.suggestion, /Switch to release/);
  }
});

test('an unresolved ancestor check survives repeated checks even when HEAD matches the fetched tip', async t => {
  const { repo, local, original, remote, advance } = checkoutFixture(t);
  const previous = advance();
  let unavailable = true;
  let attempts = 0;
  const rows = new Map();
  const options = {
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
  await adapter.update(repo, 'check', await adapter.status(repo));
  git(remote, 'update-ref', 'refs/heads/main', original);
  const first = await adapter.update(repo, 'check', await adapter.status(repo));
  assert.equal(first.checkout.state, 'upstream-rewritten');
  assert.equal(first.checkout.diagnostic.comparison.verified, false);
  assert.equal(git(local, 'rev-parse', 'HEAD'), original);
  const restarted = createCheckoutGit(options);
  const repeated = await restarted.update(repo, 'check', first.checkout);
  assert.equal(repeated.checkout.state, 'upstream-rewritten');
  assert.equal(repeated.checkout.canPull, false);
  assert.equal(repeated.checkout.diagnostic.comparison.verified, false);
  assert.equal(attempts, 2);
  unavailable = false;
  const resolved = await restarted.update(repo, 'check', repeated.checkout);
  assert.equal(attempts, 3);
  assert.equal(resolved.checkout.diagnostic.comparison.verified, true);
  assert.equal(resolved.checkout.canPull, false);
  const acknowledged = await restarted.update(repo, 'check', resolved.checkout);
  assert.equal(acknowledged.checkout.state, 'current');
});
