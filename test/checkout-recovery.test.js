import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createStore } from '../server/store.js';
import { createCheckoutGit } from '../server/checkout-git.js';
import { capturePullOwner } from '../server/pull-owner.js';
import { checkoutFixture, git } from './fixtures/checkout.js';

const crash = `
import { execFileSync } from 'node:child_process';
import { createStore } from './server/store.js';
import { createCheckoutGit } from './server/checkout-git.js';
const { repo, remote, path, checkout, boundary } = JSON.parse(process.argv[1]);
const stop = () => process.kill(process.pid, 'SIGKILL');
const store = createStore(path);
const journal = {
  ...store.pullJournal,
  begin(...args) {
    const started = store.pullJournal.begin(...args);
    if (started && boundary === 'before-files') stop();
    return started;
  },
};
const adapter = createCheckoutGit({
  journal, matchesRemote: url => url === remote,
  run: async (path, args, { indexFile } = {}) => {
    const env = { ...process.env, GIT_OPTIONAL_LOCKS: '0' };
    if (indexFile) env.GIT_INDEX_FILE = indexFile;
    const output = execFileSync('git', ['-C', path, ...args], { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] });
    if (boundary === 'after-files' && args[0] === 'read-tree' && !args.includes('--dry-run')) stop();
    return output;
  },
  ...(boundary === 'after-ref' ? { publishIndex: stop } : {}),
});
await adapter.update(repo, 'pull', checkout);
`;

for (const boundary of ['before-files', 'after-files', 'after-ref']) {
  test(`restart detects Pull interrupted ${boundary} without touching outside edits or locks`, { skip: process.platform === 'win32' }, async t => {
    const { repo, local, remote, checkoutGit, advance, original } = checkoutFixture(t);
    const tip = advance();
    const { checkout } = await checkoutGit.update(repo, 'check', await checkoutGit.status(repo));
    const path = join(local, '..', 'journal.sqlite');
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', crash,
      JSON.stringify({ repo, remote, path, checkout, boundary })], { cwd: new URL('..', import.meta.url), encoding: 'utf8', timeout: 8000 });
    assert.equal(child.signal, 'SIGKILL', child.stderr);
    const store = createStore(path);
    try {
      const adapter = createCheckoutGit({ journal: store.pullJournal, matchesRemote: url => url === remote });
      const lock = join(local, '.git', 'index.lock');
      const file = join(local, 'feature.txt');
      assert.ok(store.pullJournal.get(local));
      if (boundary === 'before-files') {
        assert.equal(git(local, 'rev-parse', 'HEAD'), original);
        assert.equal(readFileSync(file, 'utf8'), 'initial');
        assert.equal(existsSync(lock), false);
        assert.equal((await adapter.status(repo)).state, 'behind');
        assert.equal(store.pullJournal.get(local), undefined);
        assert.equal((await adapter.update(repo, 'pull', checkout)).updated, true);
        assert.equal(git(local, 'rev-parse', 'HEAD'), tip);
        assert.equal(git(local, 'status', '--porcelain'), '');
        return;
      }
      assert.equal(git(local, 'rev-parse', 'HEAD'), boundary === 'after-ref' ? tip : original);
      assert.equal(readFileSync(file, 'utf8'), 'updated');
      assert.ok(existsSync(lock));
      writeFileSync(file, 'my later local edit');
      const blocked = await adapter.status(repo);
      assert.equal(blocked.state, 'pull-interrupted');
      assert.equal(blocked.canPull, false);
      await assert.rejects(adapter.update(repo, 'pull', checkout), /resolved in Git/);
      assert.equal(readFileSync(file, 'utf8'), 'my later local edit');
      unlinkSync(lock);
      writeFileSync(lock, 'another operation owns this lock', { flag: 'wx' });
      assert.equal((await createCheckoutGit({ journal: store.pullJournal }).status(repo)).state, 'pull-interrupted');
      assert.equal(readFileSync(lock, 'utf8'), 'another operation owns this lock');
      assert.ok(store.pullJournal.get(local));
    } finally { store.close(); }
  });
}

for (const [label, pid, skip] of [
  ['the current server PID', process.pid, false],
  ['another live Linux PID', process.ppid, process.platform !== 'linux'],
]) {
  test(`a reused PID does not block a clean checkout when reusing ${label}`, { skip }, async t => {
    const { repo, local, remote, original } = checkoutFixture(t);
    const store = createStore(join(local, '..', 'stale-journal.sqlite'));
    try {
      store.pullJournal.begin(local, { id: 'abandoned', pid, instance: 'previous-server-instance', started: 'previous-os-process',
        branch: 'main', previous: original, tip: 'unused', index: join(local, '.git', 'index') });
      const adapter = createCheckoutGit({ journal: store.pullJournal, matchesRemote: url => url === remote });
      assert.equal((await adapter.status(repo)).state, 'current');
      assert.equal(store.pullJournal.get(local), undefined);
    } finally { store.close(); }
  });
}

test('a journal owned by the running server still prevents another Pull', async t => {
  const { repo, local, remote, original } = checkoutFixture(t);
  const store = createStore(join(local, '..', 'running-journal.sqlite'));
  try {
    store.pullJournal.begin(local, { ...await capturePullOwner(), id: 'running', branch: 'main', previous: original,
      tip: 'unused', index: join(local, '.git', 'index') });
    const adapter = createCheckoutGit({ journal: store.pullJournal, matchesRemote: url => url === remote });
    assert.equal((await adapter.status(repo)).state, 'pull-running');
    assert.ok(store.pullJournal.get(local));
  } finally { store.close(); }
});
