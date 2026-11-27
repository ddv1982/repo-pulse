import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseRemote, normalizeOrganization, repositoryKey, discoverRepositories, hasRemoteCredentials } from '../server/repositories.ts';
import type { Thrown } from './fixtures/typed.ts';
import { present } from './fixtures/typed.ts';
import { isAppError } from '../server/errors.ts';

test('Azure remote formats normalize to a credential-free canonical identity', () => {
  const forms = [
    'https://Org@dev.azure.com/Org/Project/_git/Repo',
    'git@ssh.dev.azure.com:v3/Org/Project/Repo',
    'ssh://git@ssh.dev.azure.com/v3/Org/Project/Repo',
    'Org@vs-ssh.visualstudio.com:v3/Org/Project/Repo',
    'https://Org.visualstudio.com/DefaultCollection/Project/_git/Repo',
  ];
  for (const input of forms)
    assert.deepEqual(parseRemote(input), {
      organization: 'https://dev.azure.com/org',
      project: 'Project',
      name: 'Repo',
      repoName: 'Repo',
      url: 'https://dev.azure.com/org/Project/_git/Repo',
    });
  assert.equal(repositoryKey('https://dev.azure.com/Org', 'ABCD'), repositoryKey('https://org.visualstudio.com', 'abcd'));
  assert.equal(parseRemote('https://dev.azure.com/org/My%20Project/_git/My%20Repo').project, 'My Project');
});

test('unapproved hosts, path injection and organization credentials are rejected', () => {
  for (const input of [
    'https://github.com/org/repo',
    'https://dev.azure.com.evil/org/P/_git/R',
    'http://dev.azure.com/org/P/_git/R',
    'https://dev.azure.com/org/P/_git/%2Fetc',
    'git@ssh.dev.azure.com:v3/org/P/-option',
    'https://dev.azure.com/org/P/_git/R?token=secret',
    'https://dev.azure.com/org/P/_git/@notes.txt',
    'git@ssh.dev.azure.com:v3/org/@P/R',
  ])
    assert.throws(() => parseRemote(input));
  assert.throws(() => parseRemote('https://user:secret@dev.azure.com/Org/Project/_git/Repo'), { code: 'REMOTE_PASSWORD' });
  // A token in the user name is a credential too; Azure's clone URLs put the organization there.
  assert.throws(() => parseRemote('https://tokenvalue@dev.azure.com/Org/Project/_git/Repo'), { code: 'REMOTE_PASSWORD' });
  assert.throws(() => parseRemote('ssh://git:secret@ssh.dev.azure.com/v3/Org/Project/Repo'), { code: 'REMOTE_PASSWORD' });
  assert.equal(parseRemote('https://O%72g@dev.azure.com/%4Frg/Project/_git/Repo').organization, 'https://dev.azure.com/org');
  assert.throws(
    () => parseRemote('https://%E0%A4%A@dev.azure.com/Org/Project/_git/Repo'),
    (error: Thrown) => error.code === 'INVALID_REPOSITORY',
  );
  assert.equal(hasRemoteCredentials('https://user:secret@example.test/repo.git'), true);
  assert.equal(hasRemoteCredentials('https://Org@dev.azure.com/Org/Project/_git/Repo'), false);
  for (const input of [
    '-oProxyCommand=x@ssh.dev.azure.com:v3/Org/Project/Repo',
    'ssh://-oProxyCommand=x@ssh.dev.azure.com/v3/Org/Project/Repo',
  ])
    assert.throws(
      () => parseRemote(input),
      (error: Thrown) => error.code !== 'REMOTE_PASSWORD',
    );
  assert.throws(
    () => parseRemote('https://user:secret@github.com/org/repo'),
    (error: Thrown) => error.code !== 'REMOTE_PASSWORD',
  );
  assert.throws(() => normalizeOrganization('https://secret@dev.azure.com/org'));
});

test('explicit discovery reads local Azure remotes without modifying config and ignores other providers', async () => {
  const root = await mkdtemp(join(tmpdir(), 'repo-pulse-discovery-'));
  try {
    for (const name of ['azure', 'github']) {
      const git = join(root, name, '.git');
      await mkdir(join(git, 'objects'), { recursive: true });
      await mkdir(join(git, 'refs'), { recursive: true });
      await writeFile(join(git, 'HEAD'), 'ref: refs/heads/main\n');
      await writeFile(
        join(git, 'config'),
        `[core]\n repositoryformatversion = 0\n bare = false\n[remote "origin"]\n url = ${name === 'azure' ? 'https://org@dev.azure.com/org/Project/_git/Repo' : 'https://github.com/org/repo'}\n`,
      );
    }
    const before = await readFile(join(root, 'azure', '.git', 'config'), 'utf8');
    const found = await discoverRepositories(root);
    assert.equal(found.repositories.length, 1);
    assert.equal(present(present(found.repositories[0]).remotes[0]).name, 'origin');
    assert.equal(present(present(found.repositories[0]).remotes[0]).repoName, 'Repo');
    assert(!JSON.stringify(found).includes('secret'));
    assert.equal(await readFile(join(root, 'azure', '.git', 'config'), 'utf8'), before);
    assert.equal((await discoverRepositories(join(root, 'azure'))).repositories.length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('discovery skips a remote with a password in its URL and says why', async () => {
  const root = await mkdtemp(join(tmpdir(), 'repo-pulse-password-'));
  try {
    const git = join(root, '.git');
    await mkdir(join(git, 'objects'), { recursive: true });
    await mkdir(join(git, 'refs'), { recursive: true });
    await writeFile(join(git, 'HEAD'), 'ref: refs/heads/main\n');
    await writeFile(
      join(git, 'config'),
      '[core]\n repositoryformatversion = 0\n bare = false\n[remote "origin"]\n url = https://user:hunter2@dev.azure.com/org/Project/_git/Repo\n',
    );
    const found = await discoverRepositories(root);
    assert.equal(found.repositories.length, 0);
    assert.equal(found.warnings.length, 1);
    assert.match(present(found.warnings[0]), /\(origin\): Remove the credentials/);
    assert(!JSON.stringify(found).includes('hunter2'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('discovery finds checkouts reached through a symlinked folder and keeps the path as entered', async () => {
  const { symlink } = await import('node:fs/promises');
  const root = await mkdtemp(join(tmpdir(), 'repo-pulse-symlink-'));
  try {
    const git = join(root, 'real', 'azure', '.git');
    await mkdir(join(git, 'objects'), { recursive: true });
    await mkdir(join(git, 'refs'), { recursive: true });
    await writeFile(join(git, 'HEAD'), 'ref: refs/heads/main\n');
    await writeFile(
      join(git, 'config'),
      '[core]\n repositoryformatversion = 0\n bare = false\n[remote "origin"]\n url = https://dev.azure.com/org/Project/_git/Repo\n',
    );
    await symlink(join(root, 'real'), join(root, 'linked'), 'dir');
    const viaParent = await discoverRepositories(join(root, 'linked'));
    assert.deepEqual(
      viaParent.repositories.map(item => item.localPath),
      [join(root, 'linked', 'azure')],
    );
    const direct = await discoverRepositories(join(root, 'linked', 'azure'));
    assert.deepEqual(
      direct.repositories.map(item => item.localPath),
      [join(root, 'linked', 'azure')],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('discovery refuses a missing path or a file with a message the person can act on', async t => {
  const root = await mkdtemp(join(tmpdir(), 'repo-pulse-discover-input-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'file.txt'), 'not a folder');
  for (const path of ['', join(root, 'missing'), join(root, 'file.txt')])
    await assert.rejects(discoverRepositories(path), (error: unknown) => isAppError(error, 'invalid'), path || 'empty');
});
