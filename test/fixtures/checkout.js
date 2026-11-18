import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCheckoutGit } from '../../server/checkout-git.js';

// Fixture repositories and the checkout code under test commit; a clean machine or CI runner has no Git identity.
for (const [key, value] of Object.entries({
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.test',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.test',
})) {
  process.env[key] ??= value;
}

export function git(path, ...args) {
  return execFileSync('git', ['-C', path, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

export function checkoutFixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'pulse-checkout-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const remote = join(root, 'repo.git');
  const source = join(root, 'source');
  const local = join(root, 'local');
  git(root, 'init', '--bare', '--initial-branch=main', remote);
  git(root, 'clone', '--no-local', remote, source);
  const commit = (path, file, contents) => {
    writeFileSync(join(path, file), contents);
    git(path, 'add', '--', file);
    git(path, '-c', 'user.email=test@example.test', '-c', 'user.name=Test', 'commit', '-m', contents);
    return git(path, 'rev-parse', 'HEAD');
  };
  const original = commit(source, 'feature.txt', 'initial');
  git(source, 'push', 'origin', 'main');
  git(root, 'clone', '--no-local', remote, local);
  const advance = () => {
    const tip = commit(source, 'feature.txt', 'updated');
    git(source, 'push', 'origin', 'main');
    return tip;
  };
  const repo = { id: 'repo', name: 'Orders', project: 'Testing', organization: 'https://dev.azure.com/example', localPath: local };
  const checkoutGit = createCheckoutGit({ matchesRemote: url => url === remote });
  return { remote, source, local, original, advance, commit, repo, checkoutGit };
}

export function squashFixture(t) {
  const fixture = checkoutFixture(t);
  const { source, remote, local, commit } = fixture;
  git(source, 'switch', '-c', 'topic');
  const head = commit(source, 'topic.txt', 'topic work');
  git(source, 'push', 'origin', 'topic');
  git(local, 'fetch', 'origin', 'topic');
  git(local, 'switch', '--track', 'origin/topic');
  git(source, 'switch', '-c', 'release', 'main');
  commit(source, 'release.txt', 'release base changes');
  git(source, 'merge', '--squash', 'topic');
  const result = commit(source, 'notes.txt', 'squashed result');
  git(source, 'push', 'origin', 'release');
  git(remote, 'update-ref', '-d', 'refs/heads/topic');
  const repo = { ...fixture.repo, azureId: 'azure-repo' };
  const pr = {
    id: 101,
    source: 'refs/heads/topic',
    target: 'refs/heads/release',
    sourceId: repo.azureId,
    targetId: repo.azureId,
    head,
    result,
    strategy: 'squash',
    url: 'https://dev.azure.com/example/Testing/_git/Orders/pullrequest/101',
  };
  return { ...fixture, repo, pr };
}
