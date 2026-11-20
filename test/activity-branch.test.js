import test from 'node:test';
import assert from 'node:assert/strict';
import { activityBranch } from '../src/activity-branch.js';

test('only explicit branch creation and single-branch pushes produce a checkout target', () => {
  const name = 'refs/heads/feature/topic';
  const update = { name, newObjectId: 'a'.repeat(40) };
  const branchFor = (kind, data) => activityBranch({ kind, branch: 'feature/topic', data });
  assert.equal(branchFor('branch-created', { name }), 'feature/topic');
  assert.equal(branchFor('push', { refUpdates: [update] }), 'feature/topic');
  assert.equal(branchFor('push', { refUpdates: [update, { ...update, name: 'refs/heads/other' }] }), null);
  assert.equal(branchFor('push', { refUpdates: [{ ...update, newObjectId: '0'.repeat(40) }] }), null);
  assert.equal(branchFor('push', {}), null);
  assert.equal(branchFor('branch-deleted', { name }), null);
  assert.equal(branchFor('pr', { sourceRefName: name }), null);
  assert.equal(branchFor('tag', { name: 'refs/tags/topic' }), null);
});

test('pull requests, builds and merge pushes name the branch they leave behind', () => {
  const live = 'a'.repeat(40);
  const gone = '0'.repeat(40);
  const branchFor = (kind, data) => activityBranch({ kind, data });
  const pr = { sourceRefName: 'refs/heads/feature/topic', targetRefName: 'refs/heads/main' };
  assert.equal(branchFor('pr', { ...pr, status: 'completed' }), 'main');
  assert.equal(branchFor('pr', { ...pr, status: 'active' }), 'feature/topic');
  assert.equal(branchFor('pr', { ...pr, status: 'active', fork: { repository: 'other' } }), null);
  assert.equal(branchFor('pr', { ...pr, status: 'abandoned' }), null);
  assert.equal(branchFor('pr', { ...pr, status: 'completed', targetRefName: 'refs/tags/v1' }), null);
  assert.equal(branchFor('build', { sourceBranch: 'refs/heads/main' }), 'main');
  assert.equal(branchFor('build', { sourceBranch: 'refs/pull/7/merge' }), null);
  assert.equal(branchFor('build', {}), null);
  const merge = [
    { name: 'refs/heads/main', newObjectId: live },
    { name: 'refs/heads/feature/topic', newObjectId: gone },
  ];
  assert.equal(branchFor('push', { refUpdates: merge }), 'main');
  assert.equal(branchFor('push', { refUpdates: [...merge, { name: 'refs/heads/other', newObjectId: live }] }), null);
  assert.equal(branchFor('push', { refUpdates: [{ name: 'refs/tags/v1', newObjectId: live }, merge[1]] }), null);
});
