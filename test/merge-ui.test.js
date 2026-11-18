import test from 'node:test';
import assert from 'node:assert/strict';
import { renderMergeEvidence, mergeEvidenceBadge } from '../src/ui/merge-evidence.js';
import { renderHistoryButton, renderHistoryProgress } from '../src/ui/history-import.js';

test('merge UI separates graph evidence from PR association and never invents a direct merge', () => {
  const evidence = { status: 'complete', checkedAt: '2026-11-17T10:00:00Z', commits: [{ commitId: 'a'.repeat(40), parents: ['b', 'c'], branches: ['refs/heads/main'] }], prs: [], limitations: ['Source branch unknown'] };
  const html = renderMergeEvidence({ mergeEvidence: evidence });
  assert.match(html, /Merge commit found/); assert.match(html, /2 parents/);
  assert.match(html, /does not prove a push was made outside a PR/);
  assert.doesNotMatch(html, /Merged by|Direct merge/);
  assert.match(mergeEvidenceBadge({ kind: 'push', data: { mergeEvidence: evidence } }), /Merge commit/);
  assert.equal(mergeEvidenceBadge({ kind: 'pr', data: { mergeEvidence: evidence } }), '');
  const linked = renderMergeEvidence({ mergeEvidence: { ...evidence, prs: [{ pullRequestId: 1, targetRefName: 'refs/heads/main', closedBy: { displayName: '<unsafe>' } }] } });
  assert.match(linked, /Completed PR linked/); assert.match(linked, /PR closed by &lt;unsafe&gt;/);
  assert.match(renderMergeEvidence({ mergeEvidence: { status: 'not-applicable', commits: [], prs: [] } }), /Branch lifecycle only/);
});

test('the repository import row shows retry and pause without exposing a second start', () => {
  const repo = { id: 'r', name: 'Repo' };
  const job = { status: 'retrying', pages: 2, error: { message: '<Read denied>' } };
  const markup = renderHistoryProgress(repo, job);
  assert.match(markup, /Import retrying/);
  assert.match(markup, /&lt;Read denied&gt;/);
  assert.match(renderHistoryButton(repo, job), /disabled>Import older activity/);
  assert.doesNotMatch(renderHistoryButton(repo, { status: 'completed' }), /disabled/);
});
