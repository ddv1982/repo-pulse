import test from 'node:test';
import assert from 'node:assert/strict';
import { buildActivityTree } from '../src/activity-tree.js';

const sha = letter => letter.repeat(40);
const zero = '0'.repeat(40);
let next = 0;
const event = (kind, branch, extra = {}) => ({ id: `e${next++}`, repoId: 'one', kind, branch, time: '', ...extra });
const push = (branch, from = sha('a'), to = sha('b'), extra = {}) =>
  event('push', branch, { data: { refUpdates: [{ name: `refs/heads/${branch}`, oldObjectId: from, newObjectId: to }] }, ...extra });
const created = (branch, tip = sha('c'), extra = {}) =>
  event('branch-created', branch, { data: { name: `refs/heads/${branch}`, oldObjectId: zero, newObjectId: tip }, ...extra });
const pr = (id, source, status = 'active', extra = {}) =>
  event('pr', source, {
    data: { pullRequestId: id, status, sourceRefName: `refs/heads/${source}`, targetRefName: 'refs/heads/main', ...extra },
  });
const slots = tree => tree.rows.map(row => row.node.slot);

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
  assert.deepEqual(tree.rows[1].through, [{ slot: 0, color: tree.rows[0].node.color }]);
  assert.deepEqual(tree.rows[0].through, []);
  assert.notEqual(tree.rows[0].node.color, tree.rows[1].node.color);
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
  const { fork, node } = tree.rows[1];
  assert.equal(fork.evidence, 'pr');
  assert.equal(fork.parent, 'main');
  assert.equal(fork.pullRequestId, 7);
  assert.notEqual(fork.line.slot, node.slot);
  assert.deepEqual([fork.line.up, fork.line.down], [false, false]);
  assert.equal(tree.rows[0].fork, null);
});

test('a new branch at a revision seen earlier on another branch forks from it as a fact', () => {
  const tree = buildActivityTree([push('main', sha('x'), sha('y')), created('hotfix/a', sha('x')), push('main', sha('w'), sha('x'))]);
  const { fork } = tree.rows[1];
  assert.equal(fork.evidence, 'tip');
  assert.equal(fork.parent, 'main');
  assert.deepEqual([fork.line.up, fork.line.down], [true, true]);
  assert.deepEqual(tree.rows[1].through, []);
});

test('a revision that reaches another branch only later is not a fork origin', () => {
  const tree = buildActivityTree([push('main', sha('w'), sha('x')), created('hotfix/a', sha('x'))]);
  assert.equal(tree.rows[1].fork, null);
});

test('a new branch with no pull request and no known revision has no fork', () => {
  const tree = buildActivityTree([push('main'), created('spike/a'), push('main')]);
  assert.equal(tree.rows[1].fork, null);
});

test('a fork is drawn only on the oldest row of the branch', () => {
  const tree = buildActivityTree([pr(7, 'feature/a'), created('feature/a'), push('feature/a')]);
  assert.equal(tree.rows[1].fork, null);
});

test('a completed pull request sits on its target lane and takes the source lane in', () => {
  const tree = buildActivityTree([pr(7, 'feature/a', 'completed'), push('main'), push('feature/a'), push('main')]);
  const [merge, , source] = tree.rows;
  assert.equal(merge.node.shape, 'merge');
  assert.equal(merge.node.slot, tree.rows[1].node.slot);
  assert.deepEqual(merge.mergeFrom, { slot: source.node.slot, color: source.node.color, up: false, down: true });
  assert.deepEqual([source.node.up, source.node.down], [true, false]);
  assert.equal(tree.rows[1].through.length, 1);
});

test('a completed pull request with no source rows below it draws no merge', () => {
  const tree = buildActivityTree([push('feature/a'), pr(7, 'feature/a', 'completed'), push('main')]);
  assert.equal(tree.rows[1].mergeFrom, null);
  assert.equal(tree.rows[1].node.shape, 'merge');
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
  assert.equal(tree.rows[0].node.slot, tree.rows[1].node.slot);
  assert.equal(tree.rows[0].node.down, true);
  assert.notEqual(tree.rows[2].node.slot, -1);
  assert.deepEqual([tree.rows[2].node.up, tree.rows[2].node.down], [false, false]);
});

test('rows without a branch, and tags, stand alone without a lane colour', () => {
  const tree = buildActivityTree([event('tag', 'v1'), event('push', ''), event('tag', 'v1')]);
  for (const row of tree.rows) assert.deepEqual([row.node.color, row.node.up, row.node.down], [-1, false, false]);
});

test('a lone row with nothing attached stays neutral, a lone forked row keeps its lane colour', () => {
  const lone = buildActivityTree([push('feature/a'), push('main'), push('main')]);
  assert.equal(lone.rows[0].node.color, -1);
  assert.notEqual(lone.rows[1].node.color, -1);
  const forked = buildActivityTree(
    [pr(7, 'feature/a', 'abandoned'), push('main'), push('main'), created('feature/b', sha('x')), push('main', sha('w'), sha('x'))],
    { maxGap: 1 },
  );
  assert.equal(forked.rows[3].fork.evidence, 'tip');
  assert.notEqual(forked.rows[3].node.color, -1);
});

test('branches beyond the lane limit show a node without lines', () => {
  const branches = ['a', 'b', 'c'];
  const tree = buildActivityTree([...branches.map(name => push(name)), ...branches.map(name => push(name))], { maxLanes: 2 });
  assert.deepEqual(slots(tree), [0, 1, 2, 0, 1, 2]);
  assert.equal(tree.width, 3);
  const overflow = tree.rows[2];
  assert.deepEqual([overflow.node.overflow, overflow.node.up, overflow.node.down], [true, false, false]);
  assert.equal(tree.rows[1].node.overflow, false);
  assert.equal(tree.rows[2].through.length, 2);
});

test('a fork or merge that involves an undrawn lane is not drawn but stays described', () => {
  const tree = buildActivityTree([push('main'), pr(7, 'feature/x'), created('feature/x'), push('main')], { maxLanes: 1 });
  const { fork, node, through } = tree.rows[2];
  assert.equal(node.overflow, true);
  assert.equal(fork.parent, 'main');
  assert.equal(fork.line, null);
  assert.equal(through.length, 1);
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
  assert.deepEqual([tree.rows[0].node.down, tree.rows[4].node.up], [false, false]);
  assert.deepEqual(tree.rows[2].through, []);
  const near = buildActivityTree([push('feature/a'), ...quiet, push('feature/a')], { maxGap: 4 });
  assert.deepEqual([near.rows[0].node.down, near.rows[4].node.up], [true, true]);
});

test('a merge is drawn only when the source branch has a row nearby', () => {
  const quiet = Array.from({ length: 3 }, () => push('main'));
  const tree = buildActivityTree([pr(7, 'feature/a', 'completed'), ...quiet, push('feature/a')], { maxGap: 2 });
  assert.equal(tree.rows[0].mergeFrom, null);
  assert.equal(tree.rows[4].node.up, false);
});

test('an empty list gives an empty tree', () => {
  assert.deepEqual(buildActivityTree([]), { width: 0, rows: [] });
});
