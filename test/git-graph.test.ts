import test from 'node:test';
import assert from 'node:assert/strict';
import { checkoutFixture, git } from './fixtures/checkout.ts';
import { fakeRequest, present } from './fixtures/typed.ts';
import { layoutGitGraph } from '../src/git-graph.ts';
import { createCheckoutGit } from '../server/checkout-git.ts';
import { runGit } from '../server/git.ts';
import { createGitGraph, createGraphController } from '../src/ui/git-graph.ts';
import type { GitHistoryPage, Repository } from '../src/contract.ts';
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

test('the graph snapshot hides raw Git failures', async t => {
  const { repo } = checkoutFixture(t);
  const checkoutGit = createCheckoutGit({
    run: async (path, args, options) => {
      if (args.includes('--is-shallow-repository')) throw Object.assign(new Error('private Git command output'), { code: 128 });
      return runGit(path, args, options);
    },
  });
  await assert.rejects(checkoutGit.historySnapshot(repo), {
    message: 'Git could not read commit refs for this checkout.',
    kind: 'conflict',
  });
});

test('the graph takes a stored default branch as its base only when it is a full refs/heads/ name', async t => {
  const { local, repo, checkoutGit, advance } = checkoutFixture(t);
  const remoteOnly = advance();
  git(local, 'fetch', 'origin');
  git(local, 'remote', 'set-head', 'origin', '-d');
  git(local, 'switch', '-c', 'topic', '--no-track');
  const ids = async (defaultBranch: string) => (await checkoutGit.history({ ...repo, defaultBranch }, null)).commits.map(row => row.id);
  assert.ok((await ids('refs/heads/main')).includes(remoteOnly));
  assert.ok(!(await ids('main')).includes(remoteOnly));
});

test('rendering Git Graph starts no request; entering it and a state answer that changes its repository do', () => {
  const requested: string[] = [];
  let repos = [stub<Repository>({ id: 'orders', name: 'orders', project: 'Shop', localPath: '/src/orders' })];
  const graph = createGraphController({
    request: fakeRequest(path => {
      requested.push(path);
      return new Promise(() => {});
    }),
    page: stub<HTMLElement>({ addEventListener: () => {} }),
    state: () => ({ repos, activityRevision: '1' }),
    scope: () => null,
    isActive: () => true,
    render: () => {},
    checkout: () => undefined,
    readCheckout: () => {},
    currentView: () => () => true,
    onRepositoryChoice: () => {},
  });
  graph.render();
  assert.deepEqual(requested, []);
  graph.enter('activity');
  assert.deepEqual(requested, ['/api/repos/orders/graph']);
  repos = [stub<Repository>({ id: 'billing', name: 'billing', project: 'Shop', localPath: '/src/billing' }), ...repos];
  graph.render();
  graph.render();
  assert.deepEqual(requested, ['/api/repos/orders/graph'], 'a render with another repository first loads nothing');
  graph.sync();
  assert.deepEqual(requested, ['/api/repos/orders/graph', '/api/repos/billing/graph']);
});
