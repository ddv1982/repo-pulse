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
  event('branch-created', branch, {
    data: { name: `refs/heads/${branch}`, oldObjectId: zero, newObjectId: tip, evidence: 'push', ...extra },
  });
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
  const { fork, forkFrom, node } = tree.rows[1];
  assert.deepEqual(fork, { evidence: 'pr', parent: 'main', pullRequestId: 7 });
  assert.notEqual(forkFrom.slot, node.slot);
  assert.deepEqual([forkFrom.evidence, forkFrom.up, forkFrom.down], ['pr', false, false]);
  assert.deepEqual([tree.rows[0].fork, tree.rows[0].forkFrom], [null, null]);
});

test('a new branch at a revision seen earlier on another branch forks from it as a fact', () => {
  const tree = buildActivityTree([push('main', sha('x'), sha('y')), created('hotfix/a', sha('x')), push('main', sha('w'), sha('x'))]);
  assert.deepEqual(tree.rows[1].fork, { evidence: 'tip', parent: 'main' });
  const { evidence, up, down } = tree.rows[1].forkFrom;
  assert.deepEqual([evidence, up, down], ['tip', true, true]);
  assert.deepEqual(tree.rows[1].through, []);
});

test('an older new-branch row at the same revision counts as a sighting', () => {
  const tree = buildActivityTree([created('hotfix/b', sha('x')), created('hotfix/a', sha('x'))]);
  assert.deepEqual(tree.rows[0].fork, { evidence: 'tip', parent: 'hotfix/a' });
});

test('a revision that reaches another branch only later is not a fork origin', () => {
  const tree = buildActivityTree([push('main', sha('w'), sha('x')), created('hotfix/a', sha('x'))]);
  assert.equal(tree.rows[1].fork, null);
});

test('a branch discovered in a snapshot never gets a proven fork: its tip is not where it started', () => {
  const found = event('branch-created', 'hotfix/a', { data: { name: 'refs/heads/hotfix/a', objectId: sha('x'), evidence: 'snapshot' } });
  const tree = buildActivityTree([found, push('main', sha('w'), sha('x'))]);
  assert.equal(tree.rows[0].fork, null);
});

test('a new branch with no pull request and no known revision has no fork', () => {
  const tree = buildActivityTree([push('main'), created('spike/a'), push('main')]);
  assert.deepEqual([tree.rows[1].fork, tree.rows[1].forkFrom], [null, null]);
});

test('the push that created a branch may sort below its row: the fork is described above and drawn on the push', () => {
  const samePush = { pushId: 5 };
  const tree = buildActivityTree([
    pr(7, 'feature/a'),
    created('feature/a', sha('c'), samePush),
    push('feature/a', zero, sha('c'), { data: { ...samePush, refUpdates: [] } }),
  ]);
  assert.equal(tree.rows[1].fork.evidence, 'pr');
  assert.equal(tree.rows[1].forkFrom, null);
  assert.equal(tree.rows[2].forkFrom.evidence, 'pr');
  assert.deepEqual([tree.rows[1].node.down, tree.rows[2].node.up], [true, true]);
});

test('older rows under a reused branch name belong to an earlier branch and stay apart', () => {
  const tree = buildActivityTree([pr(7, 'feature/a'), created('feature/a'), push('feature/a')]);
  assert.equal(tree.rows[1].forkFrom.evidence, 'pr');
  assert.deepEqual([tree.rows[1].node.down, tree.rows[2].node.up], [false, false]);
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

test('a completed pull request without source rows in the list still shows a short merge', () => {
  const tree = buildActivityTree([pr(7, 'feature/a', 'completed'), push('main')]);
  assert.equal(tree.rows[0].node.shape, 'merge');
  assert.deepEqual([tree.rows[0].mergeFrom.up, tree.rows[0].mergeFrom.down], [false, false]);
  assert.notEqual(tree.rows[0].mergeFrom.slot, tree.rows[0].node.slot);
});

test('each pull request row uses its own refs, so a retargeted PR merges into the branch it names', () => {
  const tree = buildActivityTree([
    pr(7, 'feature/a', 'completed', { targetRefName: 'refs/heads/release' }),
    push('release'),
    pr(7, 'feature/a'),
    push('main'),
  ]);
  assert.deepEqual([tree.rows[0].node.down, tree.rows[1].node.up, tree.rows[3].node.up], [true, true, false]);
});

test('a pull request from a fork does not join a branch of the same name in this repository', () => {
  const fromFork = pr(7, 'feature/a', 'active', { fork: { repository: 'their-copy' } });
  const tree = buildActivityTree([fromFork, created('feature/a'), push('main')]);
  assert.equal(tree.rows[1].fork, null);
  assert.deepEqual([tree.rows[0].node.down, tree.rows[1].node.up], [false, false]);
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
  const unresolved = buildActivityTree([event('build', 'refs/pull/9/merge'), push('main'), event('build', 'refs/pull/9/merge')]);
  for (const row of [unresolved.rows[0], unresolved.rows[2]])
    assert.deepEqual([row.node.color, row.node.up, row.node.down], [-1, false, false]);
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
  const { fork, forkFrom, node, through } = tree.rows[2];
  assert.equal(node.overflow, true);
  assert.equal(fork.parent, 'main');
  assert.equal(forkFrom, null);
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
  const near = buildActivityTree([push('feature/a'), ...quiet, push('feature/a')], { maxGap: 3 });
  assert.deepEqual([near.rows[0].node.down, near.rows[4].node.up], [true, true]);
});

test('a merge reaches only source rows that are nearby', () => {
  const quiet = Array.from({ length: 3 }, () => push('main'));
  const far = buildActivityTree([pr(7, 'feature/a', 'completed'), ...quiet, push('feature/a')], { maxGap: 2 });
  assert.deepEqual([far.rows[0].mergeFrom.down, far.rows[4].node.up], [false, false]);
  const near = buildActivityTree([pr(7, 'feature/a', 'completed'), ...quiet, push('feature/a')], { maxGap: 3 });
  assert.deepEqual([near.rows[0].mergeFrom.down, near.rows[4].node.up], [true, true]);
});

test('an empty list gives an empty tree', () => {
  assert.deepEqual(buildActivityTree([]), { width: 0, rows: [] });
});
