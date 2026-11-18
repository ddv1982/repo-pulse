import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseRemote, normalizeOrganization, repositoryKey, discoverRepositories } from '../server/repositories.js';

test('Azure remote formats normalize to a credential-free canonical identity', () => {
  const forms = [
    'https://user:secret@dev.azure.com/Org/Project/_git/Repo',
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
  ])
    assert.throws(() => parseRemote(input));
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
        `[core]\n repositoryformatversion = 0\n bare = false\n[remote "origin"]\n url = ${name === 'azure' ? 'https://secret@dev.azure.com/org/Project/_git/Repo' : 'https://github.com/org/repo'}\n`,
      );
    }
    const before = await readFile(join(root, 'azure', '.git', 'config'), 'utf8');
    const found = await discoverRepositories(root);
    assert.equal(found.repositories.length, 1);
    assert.equal(found.repositories[0].remotes[0].name, 'origin');
    assert.equal(found.repositories[0].remotes[0].repoName, 'Repo');
    assert(!JSON.stringify(found).includes('secret'));
    assert.equal(await readFile(join(root, 'azure', '.git', 'config'), 'utf8'), before);
    assert.equal((await discoverRepositories(join(root, 'azure'))).repositories.length, 1);
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
