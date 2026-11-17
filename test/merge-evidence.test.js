import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyMergeEvidence } from '../server/merge-evidence.js';

const sha = value => value.repeat(40);
const old = sha('1'), merge = sha('2'), feature = sha('3'), tip = sha('4'), other = sha('5');
const repo = { id: 'local', azureId: 'repo' };
const event = { kind: 'push', repoId: repo.id, data: { pushId: 9, refUpdates: [{ name: 'refs/heads/main', oldObjectId: old, newObjectId: tip }] } };
const commits = [{ commitId: merge, parents: [old, feature] }, { commitId: tip, parents: [merge] }];
const boundary = { commitId: old, parents: [] };
const pr = { pullRequestId: 7, status: 'completed', repository: { id: 'repo' }, sourceRefName: 'refs/heads/hotfix/fix', targetRefName: 'refs/heads/main',
  lastMergeCommit: { commitId: merge }, completionOptions: { mergeStrategy: 'noFastForward' }, createdBy: { displayName: 'Creator' }, closedBy: { displayName: 'Closer' } };

test('interior merge objects are found through the introduced graph without inventing source branches', () => {
  const result = classifyMergeEvidence(repo, event, commits, [], { graphRecords: [...commits, boundary] });
  assert.equal(result.status, 'complete');
  assert.equal(result.commits.length, 1);
  assert.equal(result.commits[0].commitId, merge);
  assert.deepEqual(result.commits[0].branches, ['refs/heads/main']);
  assert.equal(result.commits[0].oldBoundaryVerified, true);
  assert.equal(result.commits[0].sourceRefName, undefined);
  assert.match(result.limitations.join(' '), /source branch and integration intent remain unknown/);
});

test('unknown parents and old ancestry boundaries stay partial rather than becoming direct-merge proof', () => {
  const missing = classifyMergeEvidence(repo, event, [{ commitId: merge }, commits[1]]);
  assert.equal(missing.status, 'partial'); assert.equal(missing.commits.length, 0);
  const oldUnknown = classifyMergeEvidence(repo, event, commits);
  assert.equal(oldUnknown.status, 'partial'); assert.equal(oldUnknown.commits[0].oldBoundaryVerified, false);
  assert.match(oldUnknown.limitations.join(' '), /do not prove a merge operation performed/);
});

test('known merge objects already reachable from the old tip are not reported as introduced again', () => {
  const records = [{ commitId: merge, parents: [feature, other] }, { commitId: tip, parents: [old] }];
  const graphRecords = [...records, { commitId: old, parents: [merge] }, { commitId: feature, parents: [] }, { commitId: other, parents: [] }];
  const result = classifyMergeEvidence(repo, event, records, [], { graphRecords });
  assert.equal(result.status, 'complete'); assert.deepEqual(result.commits, []);
});

test('a completed per-ref range excludes historical merge candidates even when old graph objects are unavailable', () => {
  const result = classifyMergeEvidence(repo, event, commits, [], { refRanges: [{ ...event.data.refUpdates[0], commitIds: [tip], complete: true }] });
  assert.equal(result.status, 'complete'); assert.deepEqual(result.commits, []);
  assert.deepEqual(result.candidateCommitIds, [merge, tip]);
  assert.deepEqual(result.introducedCommitIds, [tip]);
});

test('creation and deletion do not announce historical merge commits as newly performed merges', () => {
  for (const ref of [{ name: 'refs/heads/new', oldObjectId: sha('0'), newObjectId: merge }, { name: 'refs/heads/old', oldObjectId: merge, newObjectId: sha('0') }]) {
    const result = classifyMergeEvidence(repo, { ...event, data: { refUpdates: [ref] } }, commits);
    assert.equal(result.status, 'not-applicable'); assert.deepEqual(result.commits, []); assert.deepEqual(result.prs, []);
  }
});

test('completed same-repo target associations retain actual PR strategy and identity provenance', () => {
  const result = classifyMergeEvidence(repo, event, commits, [{ commitId: merge, queryType: 'lastMergeCommit', pullRequest: pr }], { graphRecords: [...commits, boundary] });
  assert.equal(result.prs.length, 1); assert.equal(result.prs[0].relationship, 'result-introduced');
  assert.equal(result.prs[0].mergeStrategy, 'noFastForward'); assert.equal(result.prs[0].sourceRefName, pr.sourceRefName);
  assert.equal(result.prs[0].createdBy.displayName, 'Creator'); assert.equal(result.prs[0].closedBy.displayName, 'Closer');
  const ignored = ['active', 'abandoned'].flatMap(status => [{ commitId: merge, queryType: 'lastMergeCommit', pullRequest: { ...pr, status, mergeStatus: 'succeeded' } }]);
  ignored.push({ commitId: merge, queryType: 'lastMergeCommit', pullRequest: { ...pr, repository: { id: 'another' } } });
  ignored.push({ commitId: merge, queryType: 'lastMergeCommit', pullRequest: { ...pr, targetRefName: 'refs/heads/release' } });
  assert.equal(classifyMergeEvidence(repo, event, commits, ignored).prs.length, 0);
});

test('squash and fast-forward PR evidence does not require a two-parent graph merge', () => {
  for (const mergeStrategy of ['squash', 'rebase']) {
    const record = { commitId: tip, parents: [old] };
    const result = classifyMergeEvidence(repo, event, [record], [{ commitId: tip, queryType: 'lastMergeCommit', pullRequest: { ...pr, lastMergeCommit: { commitId: tip }, completionOptions: { mergeStrategy } } }]);
    assert.equal(result.prs[0].mergeStrategy, mergeStrategy); assert.equal(result.prs[0].relationship, 'result-introduced'); assert.equal(result.commits.length, 0);
  }
});

test('constituent-only PR matches and unrelated multi-ref history never become target merge-result claims', () => {
  const records = [...commits, { commitId: feature, parents: [] }, { commitId: other, parents: [feature, old] }];
  const multi = { ...event, data: { refUpdates: [...event.data.refUpdates, { name: 'refs/heads/new', oldObjectId: sha('0'), newObjectId: other }] } };
  const result = classifyMergeEvidence(repo, multi, records, [{ commitId: feature, queryType: 'commit', pullRequest: { ...pr, lastMergeCommit: { commitId: sha('6') } } }], { graphRecords: [...records, boundary] });
  assert.deepEqual(result.commits.map(item => item.commitId), [merge]);
  assert.equal(result.prs[0].relationship, 'constituent-related');
  assert.match(result.limitations.join(' '), /resulting revision was not established/);
});
