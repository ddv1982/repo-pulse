import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, renameSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkoutFixture, git } from './fixtures/checkout.js';
import { createCheckoutGit } from '../server/checkout-git.js';

test('status reads the last fetched upstream; Check changes refs and Pull fast-forwards the checkout', async t => {
  const fixture = checkoutFixture(t);
  const { repo, checkoutGit, original, local } = fixture;
  const tip = fixture.advance();
  const initial = await checkoutGit.status(repo);
  assert.equal(initial.branch, 'main');
  assert.equal(initial.state, 'current');
  assert.equal(initial.upstream, 'origin/main');
  assert.equal(git(local, 'rev-parse', 'origin/main'), original);
  const checked = await checkoutGit.update(repo, 'check', initial);
  assert.equal(checked.checkout.behind, 1);
  assert.equal(checked.checkout.canPull, true);
  assert.equal(git(local, 'rev-parse', 'HEAD'), original);
  assert.equal(readFileSync(join(local, 'feature.txt'), 'utf8'), 'initial');
  const pulled = await checkoutGit.update(repo, 'pull', checked.checkout);
  assert.equal(pulled.updated, true);
  assert.equal(pulled.checkout.state, 'current');
  assert.equal(git(local, 'rev-parse', 'HEAD'), tip);
  assert.equal(readFileSync(join(local, 'feature.txt'), 'utf8'), 'updated');
});

test('Pull rechecks working files, checkout identity, branch and upstream instead of trusting the request', async t => {
  const { repo, checkoutGit, original, local, advance, commit } = checkoutFixture(t);
  advance();
  const { checkout: behind } = await checkoutGit.update(repo, 'check', await checkoutGit.status(repo));
  writeFileSync(join(local, 'feature.txt'), 'my uncommitted work');
  await assert.rejects(checkoutGit.update(repo, 'pull', behind), /Git could not preserve the local checkout/);
  assert.equal(readFileSync(join(local, 'feature.txt'), 'utf8'), 'my uncommitted work');
  writeFileSync(join(local, 'feature.txt'), 'initial');
  const localCommit = commit(local, 'local.txt', 'my unpushed commit');
  await assert.rejects(checkoutGit.update(repo, 'pull', behind), /checkout changed/);
  const diverged = await checkoutGit.status(repo);
  assert.equal(diverged.state, 'diverged');
  await assert.rejects(checkoutGit.update(repo, 'pull', diverged), /no longer eligible/);
  git(local, 'switch', '--detach', original);
  await assert.rejects(checkoutGit.update(repo, 'pull', diverged), /checkout changed/);
  assert.equal((await checkoutGit.status(repo)).state, 'detached');
  git(local, 'switch', 'main');
  git(local, 'remote', 'set-url', 'origin', 'https://dev.azure.com/other/Testing/_git/Orders');
  await assert.rejects(checkoutGit.update(repo, 'check', behind), /checkout changed/);
  const wrongRemote = await checkoutGit.status(repo);
  assert.equal(wrongRemote.state, 'different-remote');
  assert.equal(wrongRemote.canCheck, false);
  await assert.rejects(checkoutGit.update(repo, 'check', wrongRemote), /no longer eligible/);
  git(local, 'remote', 'set-url', 'origin', 'https://user:hunter2@dev.azure.com/other/Testing/_git/Orders');
  const passwordRemote = await checkoutGit.status(repo);
  assert.equal(passwordRemote.state, 'different-remote');
  assert.equal(passwordRemote.canCheck, false);
  assert.equal(passwordRemote.diagnostic?.title, 'Remote URL contains credentials');
  assert(!JSON.stringify(passwordRemote).includes('hunter2'));
  await assert.rejects(checkoutGit.update(repo, 'check', passwordRemote), /no longer eligible/);
  writeFileSync(join(local, 'feature.txt'), 'uncommitted');
  const dirtyPasswordRemote = await checkoutGit.status(repo);
  assert.equal(dirtyPasswordRemote.state, 'dirty');
  assert.equal(dirtyPasswordRemote.diagnostic?.title, 'Remote URL contains credentials');
  writeFileSync(join(local, 'feature.txt'), 'initial');
  assert.equal(git(local, 'rev-parse', 'HEAD'), localCommit);
});

test('a snapshot for one clone cannot update another linked clone with the same branch and commit', async t => {
  const { repo, checkoutGit, local, remote, original } = checkoutFixture(t);
  const old = await checkoutGit.status(repo);
  const another = join(local, '..', 'another');
  git(local, 'clone', '--no-local', remote, another);
  const moved = { ...repo, localPath: another };
  await assert.rejects(checkoutGit.update(moved, 'check', old), /checkout changed/);
  assert.equal(git(another, 'rev-parse', 'HEAD'), original);
});

test('Pull refuses a replacement clone after fetching a rewritten upstream', async t => {
  const { repo, local, source, remote, original, advance, commit } = checkoutFixture(t);
  advance();
  let replace = false;
  const checkoutGit = createCheckoutGit({
    matchesRemote: url => url === remote,
    run: async (path, args) => {
      const result = git(path, ...args);
      if (replace && args[2] === 'fetch') {
        replace = false;
        renameSync(local, `${local}-previous`);
        git(source, 'clone', '--no-local', remote, local);
        git(local, 'reset', '--hard', original);
      }
      return result;
    },
  });
  const checked = (await checkoutGit.update(repo, 'check', await checkoutGit.status(repo))).checkout;
  git(source, 'reset', '--hard', original);
  commit(source, 'feature.txt', 'rewritten main');
  git(source, 'push', '--force-with-lease', 'origin', 'main');
  replace = true;
  await assert.rejects(checkoutGit.update(repo, 'pull', checked), /checkout changed/i);
  assert.equal(git(local, 'rev-parse', 'HEAD'), original);
  assert.equal(git(`${local}-previous`, 'rev-parse', 'HEAD'), original);
});

for (const restoreDuringSample of [false, true]) {
  test(`Pull rejects ref samples from a replacement clone ${restoreDuringSample ? 'even after restoring the original' : 'before saving the comparison'}`, async t => {
    const { repo, local, source, remote, original, advance, commit } = checkoutFixture(t);
    const baseline = advance();
    git(source, 'switch', '-c', 'other', restoreDuringSample ? baseline : original);
    commit(source, 'other.txt', 'unrelated branch');
    git(source, 'push', 'origin', 'other');
    git(source, 'switch', 'main');
    let replace = false;
    let fetched = false;
    const checkoutGit = createCheckoutGit({
      matchesRemote: url => url === remote,
      run: async (path, args) => {
        const swap =
          replace && fetched && args[0] === 'for-each-ref' && args.at(-1) === 'refs/remotes/origin/main' && args[1].includes('%(symref)');
        if (swap) {
          replace = false;
          renameSync(local, `${local}-previous`);
          git(source, 'clone', '--no-local', remote, local);
          git(local, 'reset', '--hard', original);
          git(local, 'update-ref', 'refs/remotes/origin/main', 'origin/other');
        }
        const output = git(path, ...args);
        if (swap && restoreDuringSample) {
          renameSync(local, `${local}-replacement`);
          renameSync(`${local}-previous`, local);
        }
        if (args[2] === 'fetch') fetched = true;
        return output;
      },
    });
    const checked = (await checkoutGit.update(repo, 'check', await checkoutGit.status(repo))).checkout;
    const tip = commit(source, 'feature.txt', 'second upstream update');
    git(source, 'push', 'origin', 'main');
    replace = true;
    fetched = false;
    await assert.rejects(checkoutGit.update(repo, 'pull', checked), /checkout.*changed/i);
    if (!restoreDuringSample) {
      renameSync(local, `${local}-replacement`);
      renameSync(`${local}-previous`, local);
    }
    const status = await checkoutGit.status(repo);
    assert.equal(status.state, 'behind');
    const { checkout } = await checkoutGit.update(repo, 'check', status);
    assert.equal(checkout.canPull, true);
    assert.equal(git(local, 'rev-parse', 'origin/main'), tip);
    assert.equal(git(local, 'rev-parse', 'HEAD'), original);
  });
}

for (const verified of [false, true]) {
  test(`An interrupted pre-upgrade Check still protects its ${verified ? 'verified rewrite' : 'pending baseline'}`, async t => {
    const { repo, checkoutGit, local, source, remote, original, advance, commit } = checkoutFixture(t);
    const previous = advance();
    git(local, 'fetch', 'origin', 'main');
    const { identity } = await checkoutGit.status(repo);
    git(source, 'reset', '--hard', original);
    const tip = commit(source, 'feature.txt', 'rewritten main');
    git(source, 'push', '--force-with-lease', 'origin', 'main');
    git(local, 'fetch', 'origin', 'main');
    const legacy = verified
      ? { identity, tracking: tip, pending: [], rewrite: { previous, tip, verified: true, commits: [] } }
      : { identity, pending: [previous] };
    const values = new Map([[identity, legacy]]);
    const restarted = createCheckoutGit({
      matchesRemote: url => url === remote,
      observations: { get: (id, key) => values.get(key), save: (id, observation) => values.set(observation.identity, observation) },
    });
    const status = await restarted.status(repo);
    assert.equal(status.state, 'upstream-rewritten');
    assert.equal(status.canPull, false);
    await assert.rejects(restarted.update(repo, 'pull', status), /no longer eligible/);
    const { checkout } = await restarted.update(repo, 'check', status);
    assert.equal(checkout.diagnostic.comparison.previous, previous);
    assert.equal(git(local, 'rev-parse', 'HEAD'), original);
  });
}

test('Pull cannot overwrite an ignored local file', async t => {
  const { repo, checkoutGit, original, local, source, commit } = checkoutFixture(t);
  writeFileSync(join(local, '.git', 'info', 'exclude'), 'local.env\n');
  writeFileSync(join(local, 'local.env'), 'local private settings');
  commit(source, 'local.env', 'new upstream file');
  git(source, 'push', 'origin', 'main');
  const { checkout } = await checkoutGit.update(repo, 'check', await checkoutGit.status(repo));
  await assert.rejects(checkoutGit.update(repo, 'pull', checkout), /ignored local files/);
  assert.equal(git(local, 'rev-parse', 'HEAD'), original);
  assert.equal(readFileSync(join(local, 'local.env'), 'utf8'), 'local private settings');
});

test('a local edit made during the fetch blocks the fast-forward', async t => {
  const { repo, remote, original, local, advance } = checkoutFixture(t);
  advance();
  let editAfterFetch = false;
  const checkoutGit = createCheckoutGit({
    matchesRemote: url => url === remote,
    run: async (path, args) => {
      const output = execFileSync('git', ['-C', path, ...args], {
        encoding: 'utf8',
        env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      if (editAfterFetch && args[2] === 'fetch') writeFileSync(join(local, 'feature.txt'), 'edited during fetch');
      return output;
    },
  });
  const { checkout } = await checkoutGit.update(repo, 'check', await checkoutGit.status(repo));
  editAfterFetch = true;
  await assert.rejects(checkoutGit.update(repo, 'pull', checkout), /Git could not preserve the local checkout/);
  assert.equal(git(local, 'rev-parse', 'HEAD'), original);
  assert.equal(readFileSync(join(local, 'feature.txt'), 'utf8'), 'edited during fetch');
});

test('a branch switch after fetch validation cannot advance either branch', async t => {
  const { repo, remote, original, local, advance } = checkoutFixture(t);
  advance();
  git(local, 'branch', 'other');
  let switchAtTipRead = false;
  let fetched = false;
  const checkoutGit = createCheckoutGit({
    matchesRemote: url => url === remote,
    run: async (path, args) => {
      if (
        switchAtTipRead &&
        fetched &&
        args[0] === 'for-each-ref' &&
        args.at(-1) === 'refs/remotes/origin/main' &&
        args[1].includes('%(symref)')
      ) {
        switchAtTipRead = false;
        git(local, 'switch', 'other');
      }
      const output = git(path, ...args);
      if (args[2] === 'fetch') fetched = true;
      return output;
    },
  });
  const { checkout } = await checkoutGit.update(repo, 'check', await checkoutGit.status(repo));
  switchAtTipRead = true;
  fetched = false;
  await assert.rejects(checkoutGit.update(repo, 'pull', checkout), /(?:checkout|upstream) changed/);
  assert.equal(git(local, 'branch', '--show-current'), 'other');
  assert.equal(git(local, 'rev-parse', 'main'), original);
  assert.equal(git(local, 'rev-parse', 'other'), original);
  assert.equal(readFileSync(join(local, 'feature.txt'), 'utf8'), 'initial');
});

test('changing the remote URL during Check cannot redirect the fetch', async t => {
  const { repo, remote, original, local, advance } = checkoutFixture(t);
  const fallback = join(remote, '..', 'other.git');
  git(local, 'clone', '--bare', '--no-local', remote, fallback);
  const tip = advance();
  const checkoutGit = createCheckoutGit({
    matchesRemote: url => url === remote,
    run: async (path, args) => {
      if (args[2] === 'fetch') git(local, 'remote', 'set-url', 'origin', fallback);
      return git(path, ...args);
    },
  });
  await assert.rejects(checkoutGit.update(repo, 'check', await checkoutGit.status(repo)), /upstream changed/);
  assert.equal(git(local, 'rev-parse', 'origin/main'), tip);
  assert.equal(git(local, 'rev-parse', 'HEAD'), original);
});

test('Check reports a missing upstream and restores Pull when the branch is available again', async t => {
  const { checkoutGit, repo, local, original, remote, source, advance } = checkoutFixture(t);
  const tip = advance();
  const behind = await checkoutGit.update(repo, 'check', await checkoutGit.status(repo));
  assert.equal(behind.checkout.canPull, true);
  git(remote, 'update-ref', '-d', 'refs/heads/main');
  const missing = await checkoutGit.update(repo, 'check', behind.checkout);
  assert.equal(missing.checkout.state, 'upstream-missing');
  assert.equal(missing.checkout.canPull, false);
  assert.equal(missing.checkout.canCheck, true);
  assert.equal((await checkoutGit.status(repo)).state, 'upstream-missing');
  assert.equal(git(local, 'rev-parse', 'HEAD'), original);
  assert.equal(git(local, 'rev-parse', 'origin/main'), tip);
  git(source, 'push', 'origin', 'main');
  const restored = await checkoutGit.update(repo, 'check', missing.checkout);
  assert.equal(restored.checkout.canPull, true);
});

test('a verified Git check time survives restart and identifies an externally fetched tip', async t => {
  const { repo, remote, local, advance, original } = checkoutFixture(t);
  const values = new Map();
  let now = Date.parse('2026-11-17T20:25:00Z');
  const options = {
    now: () => now,
    matchesRemote: url => url === remote,
    observations: { get: id => values.get(id), save: (id, observation) => values.set(id, observation) },
  };
  const adapter = createCheckoutGit(options);
  const initial = await adapter.status(repo);
  assert.equal(initial.lastBranchCheck, undefined);
  const at = new Date(now).toISOString();
  const checked = (await adapter.update(repo, 'check', initial)).checkout;
  assert.deepEqual(checked.lastBranchCheck, { at, matchesFetchedTip: true });
  assert.equal(git(local, 'rev-parse', 'HEAD'), original);
  advance();
  git(local, 'fetch', 'origin', 'main');
  now += 60_000;
  const restarted = createCheckoutGit(options);
  const after = await restarted.status(repo);
  assert.deepEqual(after.lastBranchCheck, { at, matchesFetchedTip: false });
  assert.equal(after.behind, 1);
  git(remote, 'update-ref', '-d', 'refs/heads/main');
  const failed = (await restarted.update(repo, 'check', after)).checkout;
  assert.equal(failed.state, 'upstream-missing');
  assert.deepEqual(failed.lastBranchCheck, { at, matchesFetchedTip: false });
});

test('a new clone at the same path needs its own successful check', async t => {
  const { repo, remote, local, original } = checkoutFixture(t);
  const values = new Map();
  const options = {
    matchesRemote: url => url === remote,
    observations: { get: id => values.get(id), save: (id, observation) => values.set(id, observation) },
  };
  const adapter = createCheckoutGit(options);
  const result = await adapter.update(repo, 'check', await adapter.status(repo));
  assert.ok(result.checkout.lastBranchCheck);
  renameSync(local, join(local, '..', 'previous-clone'));
  git(join(local, '..'), 'clone', '--no-local', remote, local);
  const replaced = await createCheckoutGit(options).status(repo);
  assert.equal(replaced.head, original);
  assert.equal(replaced.upstream, 'origin/main');
  assert.equal(replaced.lastBranchCheck, undefined);
});

test('Pull fast-forwards and keeps unrelated staged, unstaged and untracked work', async t => {
  const { repo, checkoutGit, local, source, commit } = checkoutFixture(t);
  commit(source, 'notes.txt', 'shared notes');
  git(source, 'push', 'origin', 'main');
  git(local, 'pull', '--ff-only');
  writeFileSync(join(local, 'notes.txt'), 'staged notes');
  git(local, 'add', 'notes.txt');
  writeFileSync(join(local, 'notes.txt'), 'unstaged notes');
  writeFileSync(join(local, 'scratch.txt'), 'untracked work');
  const tip = commit(source, 'feature.txt', 'incoming edits');
  git(source, 'push', 'origin', 'main');
  const { checkout } = await checkoutGit.update(repo, 'check', await checkoutGit.status(repo));
  assert.equal(checkout.canPull, true);
  assert.equal(checkout.dirty, true);
  const result = await checkoutGit.update(repo, 'pull', checkout);
  assert.equal(result.updated, true);
  assert.equal(result.checkout.dirty, true);
  assert.equal(git(local, 'rev-parse', 'HEAD'), tip);
  assert.equal(git(local, 'show', ':notes.txt'), 'staged notes');
  assert.equal(readFileSync(join(local, 'notes.txt'), 'utf8'), 'unstaged notes');
  assert.equal(readFileSync(join(local, 'scratch.txt'), 'utf8'), 'untracked work');
  assert.equal(readFileSync(join(local, 'feature.txt'), 'utf8'), 'incoming edits');
});

test('Pull advances the branch even when local Git config asks merges to squash', async t => {
  const fixture = checkoutFixture(t);
  const { repo, checkoutGit, local } = fixture;
  git(local, 'config', 'branch.main.mergeOptions', '--squash');
  const tip = fixture.advance();
  const { checkout } = await checkoutGit.update(repo, 'check', await checkoutGit.status(repo));
  const pulled = await checkoutGit.update(repo, 'pull', checkout);
  assert.equal(git(local, 'rev-parse', 'HEAD'), tip, 'the branch moved to the upstream tip');
  assert.equal(pulled.updated, true);
  assert.equal(git(local, 'status', '--porcelain'), '', 'nothing was left staged');
});

test('Pull still fast-forwards when local Git config picks a merge strategy', async t => {
  for (const [key, value] of [
    ['branch.main.mergeOptions', '-s ours'],
    ['pull.twohead', 'ours'],
  ]) {
    const fixture = checkoutFixture(t);
    const { repo, checkoutGit, local, original } = fixture;
    git(local, 'config', key, value);
    const tip = fixture.advance();
    const { checkout } = await checkoutGit.update(repo, 'check', await checkoutGit.status(repo));
    await checkoutGit.update(repo, 'pull', checkout);
    assert.equal(git(local, 'rev-parse', 'HEAD'), tip, key);
    assert.equal(git(local, 'rev-parse', 'HEAD^'), original, key);
  }
});

test('Pull fast-forwards a branch whose name contains an equals sign', async t => {
  const { repo, checkoutGit, local, source, commit } = checkoutFixture(t);
  git(source, 'switch', '-c', 'feature/a=b');
  git(source, 'push', 'origin', 'feature/a=b');
  git(local, 'fetch', 'origin');
  git(local, 'switch', '--track', 'origin/feature/a=b');
  git(local, 'config', 'branch.feature/a=b.mergeOptions', '-s ours');
  const tip = commit(source, 'feature.txt', 'on a=b');
  git(source, 'push', 'origin', 'feature/a=b');
  const { checkout } = await checkoutGit.update(repo, 'check', await checkoutGit.status(repo));
  await checkoutGit.update(repo, 'pull', checkout);
  assert.equal(git(local, 'rev-parse', 'HEAD'), tip);
});

test('a checkout whose own Git config runs commands is refused before Git reads it', async t => {
  const { repo, checkoutGit, local, root = join(local, '..') } = checkoutFixture(t);
  const marker = join(root, 'filter-ran');
  // A clean filter runs when status refreshes a tracked file whose timestamp changed.
  git(local, 'config', 'filter.probe.clean', `sh -c 'touch "${marker}"; cat'`);
  writeFileSync(join(local, '.git', 'info', 'attributes'), '* filter=probe\n');
  utimesSync(join(local, 'feature.txt'), new Date(), new Date(Date.now() + 5000));
  const status = await checkoutGit.status(repo);
  assert.equal(existsSync(marker), false);
  assert.equal(status.state, 'unavailable');
  assert.equal(status.diagnostic?.title, 'Checkout Git config runs commands');
  assert.match(status.diagnostic?.message ?? '', /filter\.probe\.clean/);
  await assert.rejects(checkoutGit.update(repo, 'check', status), /filter\.probe\.clean/);
  assert.equal(existsSync(marker), false);
});

test('a submodule whose Git config runs commands is refused too', async t => {
  const { repo, checkoutGit, local, commit, remote } = checkoutFixture(t);
  const root = join(local, '..');
  const library = join(root, 'library');
  git(root, 'init', '--initial-branch=main', library);
  commit(library, 'lib.txt', 'library');
  git(local, '-c', 'protocol.file.allow=always', 'submodule', 'add', '--quiet', library, 'lib');
  assert.equal((await checkoutGit.status(repo)).state !== 'unavailable', true);
  git(join(local, 'lib'), 'config', 'core.sshCommand', 'ssh -o ProxyCommand=true');
  await assert.rejects(checkoutGit.update(repo, 'check', await checkoutGit.status(repo)), /core\.sshcommand/i);
  const fresh = await createCheckoutGit({ matchesRemote: url => url === remote }).status(repo);
  assert.equal(fresh.state, 'unavailable');
  assert.match(fresh.diagnostic?.message ?? '', /core\.sshcommand/);
});

test('a nested repository committed without .gitmodules is read like a submodule', async t => {
  const { repo, local, remote, commit } = checkoutFixture(t);
  const nested = join(local, 'nested');
  git(local, 'init', '--initial-branch=main', nested);
  commit(nested, 'n.txt', 'nested');
  git(local, 'add', 'nested');
  git(local, '-c', 'user.email=test@example.test', '-c', 'user.name=Test', 'commit', '-m', 'nested repository');
  const fresh = () => createCheckoutGit({ matchesRemote: url => url === remote }).status(repo);
  assert.notEqual((await fresh()).state, 'unavailable');
  git(nested, 'config', 'filter.probe.clean', 'cat');
  const refused = await fresh();
  assert.equal(refused.state, 'unavailable');
  assert.match(refused.diagnostic?.message ?? '', /filter\.probe\.clean/);
});

test('a Pull that adds a gitlink over a nested checkout checks that checkout before reading status', async t => {
  const fixture = checkoutFixture(t);
  const { repo, checkoutGit, local, source, commit, root = join(local, '..') } = fixture;
  const marker = join(root, 'filter-ran');
  const nested = join(local, 'nested');
  git(local, 'init', '--initial-branch=main', nested);
  commit(nested, 'n.txt', 'nested');
  git(nested, 'config', 'filter.probe.clean', `sh -c 'touch "${marker}"; cat'`);
  writeFileSync(join(nested, '.git', 'info', 'attributes'), '* filter=probe\n');
  git(source, 'update-index', '--add', '--cacheinfo', `160000,${git(nested, 'rev-parse', 'HEAD')},nested`);
  git(source, '-c', 'user.email=test@example.test', '-c', 'user.name=Test', 'commit', '-m', 'add gitlink');
  git(source, 'push', 'origin', 'main');
  const { checkout } = await checkoutGit.update(repo, 'check', await checkoutGit.status(repo));
  utimesSync(join(nested, 'n.txt'), new Date(), new Date(Date.now() + 5000));
  await assert.rejects(
    checkoutGit.update(repo, 'pull', checkout),
    /^Error: The branch was updated to the upstream commit\. .*filter\.probe\.clean/,
  );
  assert.equal(git(local, 'rev-parse', 'HEAD'), git(source, 'rev-parse', 'HEAD'));
  assert.equal(existsSync(marker), false);
});

test('a gitlink that is a symlink to another repository has that repository checked', async t => {
  const { repo, local, remote, commit } = checkoutFixture(t);
  const outside = join(local, '..', 'outside');
  git(local, 'init', '--initial-branch=main', outside);
  commit(outside, 'o.txt', 'outside');
  git(outside, 'config', 'filter.probe.clean', 'cat');
  git(local, 'update-index', '--add', '--cacheinfo', `160000,${git(outside, 'rev-parse', 'HEAD')},linked`);
  symlinkSync(outside, join(local, 'linked'));
  const status = await createCheckoutGit({ matchesRemote: url => url === remote }).status(repo);
  assert.equal(status.state, 'unavailable');
  assert.match(status.diagnostic?.message ?? '', /filter\.probe\.clean/);
});

test('conditional includes, transport and signing keys in checkout config are refused', async t => {
  const { repo, local, remote } = checkoutFixture(t);
  for (const [key, value] of [
    ['includeIf.onbranch:release.path', 'other.cfg'],
    ['includeIf.hasconfig:remote.*.url:https://token@example.test/**.path', 'other.cfg'],
    ['http.curloptResolve', 'dev.azure.com:443:127.0.0.1'],
    ['gpg.ssh.program', 'sign'],
    ['fetch.bundleURI', 'https://example.test/bundle'],
    ['filter..clean', 'cat'],
    ['include.path', 'shared.cfg'],
    ['ssh.variant', 'plink'],
    ['hook.audit.command', 'touch ran'],
    ['lfs.customtransfer.agent.path', 'agent'],
    ['lfs.https://example.test.standalonetransferagent', 'agent'],
    ['lfs.storage', '/elsewhere'],
    ['core.unsetenvvars', 'GIT_CONFIG_PARAMETERS'],
    ['credential.trace', '/tmp/trace'],
    ['url.https://example.test/.insteadOf', 'https://dev.azure.com/'],
    ['remote.origin.lfsurl', 'https://example.test/lfs'],
  ]) {
    git(local, 'config', key, value);
    const status = await createCheckoutGit({ matchesRemote: url => url === remote }).status(repo);
    assert.equal(status.state, 'unavailable', key);
    const shown = key.toLowerCase().replace(/^(url|http|credential|lfs|includeif)\.[^]+\.([^.]+)$/, '$1.<…>.$2');
    assert.ok(status.diagnostic?.message?.includes(shown), key);
    assert.equal(status.diagnostic?.message?.includes('example.test'), false, key);
    git(local, 'config', '--unset', key);
  }
  // Keys Git LFS writes itself during normal use stay allowed.
  git(local, 'config', 'lfs.repositoryformatversion', '0');
  git(local, 'config', 'lfs.https://dev.azure.com/example/Testing/_git/Orders/info/lfs.access', 'basic');
  assert.notEqual((await createCheckoutGit({ matchesRemote: url => url === remote }).status(repo)).state, 'unavailable');
});
