import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { browseFolders } from '../server/folders.ts';
import type { Discovery } from '../src/contract.ts';
import type { Thrown } from './fixtures/typed.ts';

test('file-picker defaults to projects and returns immediate folders, breadcrumbs and local checkouts', async t => {
  const home = await mkdtemp(join(tmpdir(), 'repo-pulse-picker-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const projects = join(home, 'projects');
  for (const name of ['zeta', 'alpha', '.hidden', 'node_modules']) await mkdir(join(projects, name), { recursive: true });
  await writeFile(join(projects, 'private.txt'), 'never returned');
  const calls: unknown[] = [];
  const discover = async (path: unknown): Promise<Discovery> => {
    calls.push(path);
    return { repositories: [{ localPath: join(String(path), 'alpha'), remotes: [] }], warnings: [] };
  };
  const result = await browseFolders(undefined, { home, discover });
  assert.equal(result.path, projects);
  assert.equal(result.parent, home);
  assert.deepEqual(
    result.folders.map(folder => folder.name),
    ['alpha', 'zeta'],
  );
  assert.equal(result.breadcrumbs.at(-1)?.path, projects);
  assert.deepEqual(calls, [projects]);
  assert.equal(JSON.stringify(result).includes('private.txt'), false);
  assert.equal((await browseFolders('~', { home, discover })).path, home);
});

test('missing projects falls back home; unavailable folders return actionable safe errors', async t => {
  const home = await mkdtemp(join(tmpdir(), 'repo-pulse-picker-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const discover = async () => ({ repositories: [], warnings: [] });
  assert.equal((await browseFolders(undefined, { home, discover })).path, home);
  await assert.rejects(
    browseFolders(join(home, 'missing'), { home, discover }),
    (error: Thrown) => error.status === 400 && /cannot be opened/.test(error.message),
  );
  await assert.rejects(browseFolders({}, { home, discover }), { status: 400 });
});
