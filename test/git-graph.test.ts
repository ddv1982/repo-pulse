import test from 'node:test';
import assert from 'node:assert/strict';
import { checkoutFixture, git } from './fixtures/checkout.ts';
import { present } from './fixtures/typed.ts';
import { layoutGitGraph } from '../src/git-graph.ts';
import { createGitGraph } from '../src/ui/git-graph.ts';
import type { GitHistoryPage } from '../src/contract.d.ts';
import { stub } from './fixtures/typed.ts';

test('checkout history preserves Git order and all parents across pages', async t => {
  const { local, repo, checkoutGit, commit, original } = checkoutFixture(t);
  git(local, 'switch', '-c', 'feature');
  const feature = commit(local, 'topic.txt', 'feature');
  git(local, 'switch', 'main');
  for (let i = 0; i < 49; i++) git(local, 'commit', '--allow-empty', '-m', `main ${i}`);
  const main = git(local, 'rev-parse', 'HEAD');
  git(local, 'merge', '--no-ff', 'feature', '-m', 'Merge feature');
  const head = git(local, 'rev-parse', 'HEAD');
  git(local, 'tag', '-a', 'v1', '-m', 'release', head);
  git(local, 'branch', '-D', 'feature');
  const first = await checkoutGit.history(repo, null);
  const cursor = present(first.nextCursor);
  const more = await checkoutGit.history(repo, cursor);
  const expected = git(local, 'log', '--topo-order', '--format=%H %P', 'main', 'origin/main').split('\n');
  const seen = [...first.commits, ...more.commits];
  assert.deepEqual(
    seen.map(row => [row.id, ...row.parents].join(' ')),
    expected.map(row => row.trimEnd()),
  );
  assert.equal(first.head, head);
  assert.equal(first.upstream, 'origin/main');
  assert.deepEqual(first.commits[0]?.parents, [main, feature]);
  assert.deepEqual(first.commits[0]?.refs, ['main', 'v1']);
  assert.deepEqual(seen.find(row => row.id === original)?.refs, ['origin/main']);
  assert.equal(more.nextCursor, null);
  assert.deepEqual(await checkoutGit.historySnapshot(repo), { snapshot: first.snapshot });
  git(local, 'switch', '-c', 'same-tip');
  assert.notEqual((await checkoutGit.historySnapshot(repo)).snapshot, first.snapshot);
  await assert.rejects(checkoutGit.history(repo, cursor), /references changed/);
  git(local, 'switch', 'main');
  git(local, 'branch', '-D', 'same-tip');
  git(local, 'commit', '--allow-empty', '-m', 'new tip');
  await assert.rejects(checkoutGit.history(repo, cursor), /references changed/);
});

test('merge lanes pass independent commits and reconnect at the exact shared parent', () => {
  const { rows, width } = layoutGitGraph([
    { id: 'merge', parents: ['main', 'topic', 'other'] },
    { id: 'topic', parents: ['base'] },
    { id: 'other', parents: ['base'] },
    { id: 'main', parents: ['base'] },
    { id: 'base', parents: [] },
  ]);
  assert.equal(width, 3);
  assert.deepEqual(
    rows[0]?.outgoing.map(edge => edge.to),
    [0, 1, 2],
  );
  assert.deepEqual(
    rows[1]?.through.map(edge => [edge.from, edge.to]),
    [
      [0, 0],
      [2, 2],
    ],
  );
  assert.deepEqual(
    rows[4]?.incoming.map(edge => [edge.from, edge.to]),
    [
      [0, 0],
      [1, 0],
      [2, 0],
    ],
  );
  assert.deepEqual(rows[4]?.outgoing, []);
});

test('reloading Git Graph supersedes an in-flight older page', async t => {
  const { repo } = checkoutFixture(t);
  const first = stub<GitHistoryPage>({ snapshot: 'before', nextCursor: 'older', commits: [] });
  const newer = stub<GitHistoryPage>({ snapshot: 'after', nextCursor: null, commits: [] });
  const older = Promise.withResolvers<GitHistoryPage>();
  let latestPage = first;
  const graph = createGitGraph({
    read: async (_id, cursor) => (cursor ? older.promise : latestPage),
    render: () => {},
  });
  graph.select(repo);
  await Promise.resolve();
  const pending = graph.more();
  latestPage = newer;
  await graph.reload();
  older.resolve(stub<GitHistoryPage>({ snapshot: 'before', nextCursor: null, commits: [] }));
  await pending;
  assert.equal(graph.state.page?.snapshot, 'after');
});
