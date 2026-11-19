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
