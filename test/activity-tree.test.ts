import test from 'node:test';
import assert from 'node:assert/strict';
import { buildActivityTree, type ActivityTree } from '../src/activity-tree.ts';
import type { ActivityEvent, ActivityKind, EventData, ForkOrigin } from '../src/activity.ts';
import { present } from './fixtures/typed.ts';

const sha = (letter: string) => letter.repeat(40);
const zero = '0'.repeat(40);
let next = 0;
const event = (kind: ActivityKind, branch: string, extra: Partial<ActivityEvent> = {}): ActivityEvent => ({
  id: `e${next++}`,
  repoId: 'one',
  kind,
  branch,
  time: '',
  ...extra,
});
const push = (branch: string, from = sha('a'), to = sha('b'), extra: Partial<ActivityEvent> = {}) =>
  event('push', branch, { data: { refUpdates: [{ name: `refs/heads/${branch}`, oldObjectId: from, newObjectId: to }] }, ...extra });
const created = (branch: string, tip = sha('c'), extra: EventData = {}) =>
  event('branch-created', branch, {
    data: { name: `refs/heads/${branch}`, oldObjectId: zero, newObjectId: tip, evidence: 'push', ...extra },
  });
const pr = (id: number, source: string, status = 'active', extra: EventData = {}) =>
  event('pr', source, {
    data: { pullRequestId: id, status, sourceRefName: `refs/heads/${source}`, targetRefName: 'refs/heads/main', ...extra },
  });
const slots = (tree: ActivityTree) => tree.rows.map(row => row.node.slot);

test('a branch keeps one lane between its first and last row, and other lanes pass through', () => {
  const tree = buildActivityTree([push('main'), push('feature/a'), push('main'), push('feature/a')]);
  assert.deepEqual(slots(tree), [0, 1, 0, 1]);
  assert.equal(tree.width, 2);
  assert.deepEqual(
    tree.rows.map(row => [row.node.up, row.node.down]),
    [
      [false, true],
      [false, true],
      [true, false],
      [true, false],
    ],
  );
  assert.deepEqual(present(tree.rows[1]).through, [{ slot: 0, color: present(tree.rows[0]).node.color }]);
  assert.deepEqual(present(tree.rows[0]).through, []);
  assert.notEqual(present(tree.rows[0]).node.color, present(tree.rows[1]).node.color);
});

test('a lane is reused once its branch has no more rows', () => {
  const tree = buildActivityTree([push('main'), push('fix/b'), push('fix/b'), push('feature/a'), push('feature/a'), push('main')]);
  assert.deepEqual(slots(tree), [0, 1, 1, 1, 1, 0]);
  assert.equal(tree.width, 2);
});

test('the same branch name in two repositories gives two lanes', () => {
  const tree = buildActivityTree([push('main'), push('main', undefined, undefined, { repoId: 'two' }), push('main')]);
  assert.deepEqual(slots(tree), [0, 1, 0]);
});

test('a new branch with a pull request forks from the PR target as an assumption', () => {
  const tree = buildActivityTree([pr(7, 'feature/a'), created('feature/a')]);
  const { fork, forkFrom, node } = present(tree.rows[1]);
  assert.deepEqual(fork, { evidence: 'pr', parent: 'main', pullRequestId: 7 });
  assert.ok(forkFrom);
  assert.notEqual(forkFrom.slot, node.slot);
  assert.deepEqual([forkFrom.evidence, forkFrom.up, forkFrom.down], ['pr', false, false]);
  assert.deepEqual([present(tree.rows[0]).fork, present(tree.rows[0]).forkFrom], [null, null]);
});

test('a revision shared with an earlier branch does not confirm a fork without a checked origin', () => {
  const tree = buildActivityTree([push('main', sha('x'), sha('y')), created('hotfix/a', sha('x')), push('main', sha('w'), sha('x'))]);
  assert.deepEqual([present(tree.rows[1]).fork, present(tree.rows[1]).forkFrom], [null, null]);
});

test('branches created by the same push at the same revision do not fork from one another', () => {
  const samePush = { pushId: 5 };
  const tree = buildActivityTree([created('hotfix/b', sha('x'), samePush), created('hotfix/a', sha('x'), samePush)]);
  assert.ok(tree.rows.every(row => row.fork === null && row.forkFrom === null));
});

test('a branch discovered in a snapshot never gets a proven fork: its tip is not where it started', () => {
  const found = event('branch-created', 'hotfix/a', { data: { name: 'refs/heads/hotfix/a', objectId: sha('x'), evidence: 'snapshot' } });
  const tree = buildActivityTree([found, push('main', sha('w'), sha('x'))]);
  assert.equal(present(tree.rows[0]).fork, null);
});

test('a new branch with no pull request and no known revision has no fork', () => {
  const tree = buildActivityTree([push('main'), created('spike/a'), push('main')]);
  assert.deepEqual([present(tree.rows[1]).fork, present(tree.rows[1]).forkFrom], [null, null]);
});

test('the push that created a branch may sort below its row: the fork is described above and drawn on the push', () => {
  const samePush = { pushId: 5 };
  const tree = buildActivityTree([
    pr(7, 'feature/a'),
    created('feature/a', sha('c'), samePush),
    push('feature/a', zero, sha('c'), { data: { ...samePush, refUpdates: [] } }),
  ]);
  assert.equal(present(tree.rows[1]).fork?.evidence, 'pr');
  assert.equal(present(tree.rows[1]).forkFrom, null);
  assert.equal(present(tree.rows[2]).forkFrom?.evidence, 'pr');
  assert.deepEqual([present(tree.rows[1]).node.down, present(tree.rows[2]).node.up], [true, true]);
});

test('a pull request that began before a push-created branch belongs to an earlier branch of that name', () => {
  const tree = buildActivityTree([pr(7, 'feature/a', 'abandoned'), created('feature/a'), pr(7, 'feature/a')]);
  assert.equal(present(tree.rows[1]).fork, null);
});

test('a branch found in a snapshot may be discovered after its pull request was opened', () => {
  const found = event('branch-created', 'feature/a', { data: { name: 'refs/heads/feature/a', objectId: sha('x'), evidence: 'snapshot' } });
  const tree = buildActivityTree([found, pr(7, 'feature/a')]);
  assert.deepEqual(present(tree.rows[0]).fork, { evidence: 'pr', parent: 'main', pullRequestId: 7 });
  assert.deepEqual([present(tree.rows[0]).node.down, present(tree.rows[1]).node.up], [true, true]);
});

test('a creation stays with its matching push across interleaved rows', () => {
  const samePush = { pushId: 5 };
  const both = push('feature/a', zero, sha('c'), { data: { ...samePush, refUpdates: [] } });
  const tree = buildActivityTree([
    pr(7, 'feature/a'),
    created('feature/a', sha('c'), samePush),
    created('feature/b', sha('d'), { ...samePush, pushId: 3 }),
    both,
  ]);
  assert.deepEqual([present(tree.rows[1]).forkFrom, present(tree.rows[3]).forkFrom?.evidence], [null, 'pr']);
  assert.deepEqual([present(tree.rows[1]).node.down, present(tree.rows[3]).node.up], [true, true]);
});

test('a recreated branch does not take its fork from a pull request of the deleted one, or of a later one', () => {
  const tree = buildActivityTree([pr(9, 'feature/a'), created('feature/a'), created('feature/a'), pr(7, 'feature/a')]);
  assert.equal(present(tree.rows[1]).fork?.pullRequestId, 9);
  assert.equal(present(tree.rows[2]).fork, null);
});

test('older rows under a reused branch name belong to an earlier branch and stay apart', () => {
  const tree = buildActivityTree([pr(7, 'feature/a'), created('feature/a'), push('feature/a')]);
  assert.equal(present(tree.rows[1]).forkFrom?.evidence, 'pr');
  assert.deepEqual([present(tree.rows[1]).node.down, present(tree.rows[2]).node.up], [false, false]);
});

test('a completed pull request sits on its target lane and takes the source lane in', () => {
  const tree = buildActivityTree([pr(7, 'feature/a', 'completed'), push('main'), push('feature/a'), push('main')]);
  const merge = present(tree.rows[0]);
  const source = present(tree.rows[2]);
  assert.equal(merge.node.shape, 'merge');
  assert.equal(merge.node.slot, present(tree.rows[1]).node.slot);
  assert.deepEqual(merge.mergeFrom, { slot: source.node.slot, color: source.node.color, up: false, down: true });
  assert.deepEqual([source.node.up, source.node.down], [true, false]);
  assert.equal(present(tree.rows[1]).through.length, 1);
});

test('a completed pull request without source rows in the list still shows a short merge', () => {
  const tree = buildActivityTree([pr(7, 'feature/a', 'completed'), push('main')]);
  assert.equal(present(tree.rows[0]).node.shape, 'merge');
  assert.deepEqual([present(tree.rows[0]).mergeFrom?.up, present(tree.rows[0]).mergeFrom?.down], [false, false]);
  assert.notEqual(present(present(tree.rows[0]).mergeFrom).slot, present(tree.rows[0]).node.slot);
});

test('each pull request row uses its own refs, so a retargeted PR merges into the branch it names', () => {
  const tree = buildActivityTree([
    pr(7, 'feature/a', 'completed', { targetRefName: 'refs/heads/release' }),
    push('release'),
    pr(7, 'feature/a'),
    push('main'),
  ]);
  assert.deepEqual([present(tree.rows[0]).node.down, present(tree.rows[1]).node.up, present(tree.rows[3]).node.up], [true, true, false]);
});

test('a pull request from a fork does not join a branch of the same name in this repository', () => {
  const fromFork = pr(7, 'feature/a', 'active', { fork: { repository: 'their-copy' } });
  const tree = buildActivityTree([fromFork, created('feature/a'), push('main')]);
  assert.equal(present(tree.rows[1]).fork, null);
  assert.deepEqual([present(tree.rows[0]).node.down, present(tree.rows[1]).node.up], [false, false]);
});

test('pull request states choose the node shape', () => {
  const tree = buildActivityTree([pr(1, 'a'), pr(2, 'b', 'abandoned'), pr(3, 'c', 'completed'), push('main')]);
  assert.deepEqual(
    tree.rows.map(row => row.node.shape),
    ['ring', 'dot', 'merge', 'dot'],
  );
});

test('a CI run on a pull request ref joins the lane of the PR source branch', () => {
  const tree = buildActivityTree([event('build', 'refs/pull/7/merge'), pr(7, 'feature/a'), event('build', 'refs/pull/9/merge')]);
  assert.equal(present(tree.rows[0]).node.slot, present(tree.rows[1]).node.slot);
  assert.equal(present(tree.rows[0]).node.down, true);
  const lone = buildActivityTree([event('build', 'refs/pull/9/merge'), push('main'), push('main')]);
  assert.deepEqual([present(lone.rows[0]).node.color, present(lone.rows[0]).node.up, present(lone.rows[0]).node.down], [-1, false, false]);
});

test('a CI run carrying its stored pull request joins the source branch without the PR in the list', () => {
  const stored = { pullRequest: { id: 7, sourceRefName: 'refs/heads/feature/a', targetRefName: 'refs/heads/main' } };
  const tree = buildActivityTree([event('build', 'refs/pull/7/merge', { data: stored }), push('main'), push('feature/a')]);
  assert.equal(present(tree.rows[0]).node.slot, present(tree.rows[2]).node.slot);
  assert.deepEqual([present(tree.rows[0]).node.down, present(tree.rows[2]).node.up], [true, true]);
  assert.notEqual(present(tree.rows[0]).node.slot, present(tree.rows[1]).node.slot);
  // The stored pull request wins over the ref name, so a PR from a fork stays off the same-named branch here.
  const fork = { pullRequest: { ...stored.pullRequest, fork: { project: 'Other', repository: 'Fork' } } };
  const apart = buildActivityTree([event('build', 'refs/pull/7/merge', { data: fork }), push('feature/a')]);
  assert.deepEqual([present(apart.rows[0]).node.down, present(apart.rows[1]).node.up], [false, false]);
});

test('a stored pull request without a source ref falls back to the PR row in the list', () => {
  const run = event('build', 'refs/pull/7/merge', { data: { pullRequest: { id: 7, targetRefName: 'refs/heads/main' } } });
  const tree = buildActivityTree([run, pr(7, 'feature/a')]);
  assert.equal(present(tree.rows[0]).node.slot, present(tree.rows[1]).node.slot);
  assert.deepEqual([present(tree.rows[0]).node.down, present(tree.rows[1]).node.up], [true, true]);
});

test('CI runs of one pull request that is stored nowhere share a lane', () => {
  const tree = buildActivityTree([event('build', 'refs/pull/9/merge'), push('main'), event('build', 'refs/pull/9/merge')]);
  assert.equal(present(tree.rows[0]).node.slot, present(tree.rows[2]).node.slot);
  assert.deepEqual([present(tree.rows[0]).node.down, present(tree.rows[2]).node.up], [true, true]);
  assert.notEqual(present(tree.rows[0]).node.color, -1);
});

test('rows without a branch, and tags, stand alone without a lane colour', () => {
  const tree = buildActivityTree([event('tag', 'v1'), event('push', ''), event('tag', 'v1')]);
  for (const row of tree.rows) assert.deepEqual([row.node.color, row.node.up, row.node.down], [-1, false, false]);
});

test('a lone row with nothing attached stays neutral, a lone forked row keeps its lane colour', () => {
  const lone = buildActivityTree([push('feature/a'), push('main'), push('main')]);
  assert.equal(present(lone.rows[0]).node.color, -1);
  assert.notEqual(present(lone.rows[1]).node.color, -1);
  const forked = buildActivityTree(
    [pr(7, 'feature/a', 'abandoned'), push('main'), push('main'), checked('feature/b', { status: 'found', on: ['refs/heads/main'] })],
    { maxGap: 1 },
  );
  assert.equal(present(forked.rows[3]).fork?.evidence, 'recorded');
  assert.notEqual(present(forked.rows[3]).node.color, -1);
});

test('branches beyond the lane limit show a node without lines', () => {
  const branches = ['a', 'b', 'c'];
  const tree = buildActivityTree([...branches.map(name => push(name)), ...branches.map(name => push(name))], { maxLanes: 2 });
  assert.deepEqual(slots(tree), [0, 1, 2, 0, 1, 2]);
  assert.equal(tree.width, 3);
  const overflow = present(tree.rows[2]);
  assert.deepEqual([overflow.node.overflow, overflow.node.up, overflow.node.down, overflow.node.color], [true, false, false, -1]);
  assert.equal(present(tree.rows[1]).node.overflow, false);
  assert.equal(present(tree.rows[2]).through.length, 2);
});

test('a fork or merge that involves an undrawn lane is not drawn but stays described', () => {
  const tree = buildActivityTree([push('main'), pr(7, 'feature/x'), created('feature/x'), push('main')], { maxLanes: 1 });
  const { fork, forkFrom, node, through } = present(tree.rows[2]);
  assert.equal(node.overflow, true);
  assert.equal(fork?.parent, 'main');
  assert.equal(forkFrom, null);
  assert.equal(through.length, 1);
});

test('a hidden join never takes a slot from real lanes or leaves a lane beginning on an unrelated row', () => {
  const branches = ['a', 'b', 'c', 'd'];
  const hotfix = checked('hotfix', { status: 'found', on: ['refs/heads/main'], base: sha('x') });
  const active = branches.map(name => push(name));
  const tree = buildActivityTree([...active, hotfix, ...active, push('main')]);
  const join = present(tree.rows[4]);
  assert.equal(join.node.overflow, true);
  assert.equal(join.forkFrom, null);
  assert.equal(join.through.length, 4);
  assert.equal(present(tree.rows[9]).node.up, false);
});

test('multi-branch pushes and builds on tags do not take an arbitrary branch lane', () => {
  const many = push('main', undefined, undefined, { data: { refUpdates: [{ name: 'refs/heads/main' }, { name: 'refs/heads/release' }] } });
  const tagBuild = event('build', 'refs/tags/v1', { data: { sourceBranch: 'refs/tags/v1' } });
  const tagNamedBranch = push('refs/tags/v1');
  const tree = buildActivityTree([many, tagBuild, push('main'), tagNamedBranch]);
  assert.ok(tree.rows.every(row => !row.node.up && !row.node.down));
});

test('lanes that run side by side never share a colour', () => {
  const names = ['a', 'b', 'c', 'd'];
  const tree = buildActivityTree([...names.map(name => push(name)), ...names.map(name => push(name))]);
  const colors = tree.rows.slice(0, 4).map(row => row.node.color);
  assert.equal(new Set(colors).size, 4);
  assert.deepEqual(
    tree.rows.slice(4).map(row => row.node.color),
    colors,
  );
});

test('a branch that stays quiet for long gives its lane back and starts a new one later', () => {
  const quiet = Array.from({ length: 3 }, () => push('main'));
  const tree = buildActivityTree([push('feature/a'), ...quiet, push('feature/a')], { maxGap: 2 });
  assert.deepEqual([present(tree.rows[0]).node.down, present(tree.rows[4]).node.up], [false, false]);
  assert.deepEqual(present(tree.rows[2]).through, []);
  const near = buildActivityTree([push('feature/a'), ...quiet, push('feature/a')], { maxGap: 3 });
  assert.deepEqual([present(near.rows[0]).node.down, present(near.rows[4]).node.up], [true, true]);
});

test('a merge reaches only source rows that are nearby', () => {
  const quiet = Array.from({ length: 3 }, () => push('main'));
  const far = buildActivityTree([pr(7, 'feature/a', 'completed'), ...quiet, push('feature/a')], { maxGap: 2 });
  assert.deepEqual([present(far.rows[0]).mergeFrom?.down, present(far.rows[4]).node.up], [false, false]);
  const near = buildActivityTree([pr(7, 'feature/a', 'completed'), ...quiet, push('feature/a')], { maxGap: 3 });
  assert.deepEqual([present(near.rows[0]).mergeFrom?.down, present(near.rows[4]).node.up], [true, true]);
});

test('an empty list gives an empty tree', () => {
  assert.deepEqual(buildActivityTree([]), { width: 0, rows: [] });
});

const checked = (branch: string, forkOrigin: ForkOrigin) => created(branch, sha('c'), { forkOrigin });

test('a checked origin draws a solid fork to the one branch that held the base, and the PR target is not used', () => {
  const tree = buildActivityTree([
    pr(7, 'feature/b'),
    checked('feature/b', { status: 'found', base: sha('d'), on: ['refs/heads/feature/a'], via: 'tip' }),
  ]);
  assert.deepEqual(present(tree.rows[1]).fork, { evidence: 'recorded', parent: 'feature/a', base: sha('d') });
  assert.equal(present(tree.rows[1]).forkFrom?.evidence, 'recorded');
  const contained = buildActivityTree([
    checked('feature/c', { status: 'found', base: sha('d'), on: ['refs/heads/main'], via: 'contained', notOn: ['refs/heads/release/x'] }),
  ]);
  assert.deepEqual(present(contained.rows[0]).fork, { evidence: 'contained', parent: 'main', base: sha('d') });
});

test('a checked origin with several branches, none, an orphan or a merge draws no fork', () => {
  const rows = [
    checked('tie', { status: 'found', base: sha('d'), on: ['refs/heads/main', 'refs/heads/release'], via: 'tip' }),
    pr(7, 'refuted'),
    checked('refuted', { status: 'none', base: sha('d'), notOn: ['refs/heads/main'] }),
    checked('unplaced', { status: 'none', base: sha('d'), notOn: [] }),
    checked('orphan', { status: 'orphan' }),
    checked('merge', { status: 'merge' }),
  ];
  const tree = buildActivityTree(rows);
  assert.deepEqual(
    tree.rows.map(row => row.forkFrom),
    rows.map(() => null),
  );
  assert.deepEqual(
    tree.rows.map(row => row.fork),
    [
      { evidence: 'ambiguous', parent: null, base: sha('d'), branches: ['main', 'release'] },
      null,
      { evidence: 'refuted', parent: null, base: sha('d'), pullRequestId: 7, target: 'main' },
      { evidence: 'unplaced', parent: null, base: sha('d') },
      { evidence: 'orphan', parent: null },
      { evidence: 'merge', parent: null },
    ],
  );
});

test('a match while another candidate went unanswered names the branch without drawing a fork', () => {
  const tree = buildActivityTree([
    checked('feature/c', {
      status: 'found',
      base: sha('d'),
      on: ['refs/heads/main'],
      via: 'contained',
      notOn: [],
      unanswered: ['refs/heads/x'],
    }),
  ]);
  assert.deepEqual(present(tree.rows[0]).fork, { evidence: 'ambiguous', parent: null, base: sha('d'), branches: ['main'] });
  assert.equal(present(tree.rows[0]).forkFrom, null);
});

test('a check that failed leaves the unchecked evidence in place', () => {
  const tree = buildActivityTree([pr(7, 'feature/a'), checked('feature/a', { status: 'unknown' })]);
  assert.deepEqual(present(tree.rows[1]).fork, { evidence: 'pr', parent: 'main', pullRequestId: 7 });
});
