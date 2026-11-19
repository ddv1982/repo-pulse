import test from 'node:test';
import assert from 'node:assert/strict';
import { renderMergeEvidence as renderMergeEvidenceHtml, mergeEvidenceBadge as mergeEvidenceBadgeHtml } from '../src/ui/merge-evidence.js';
import {
  renderHistoryButton as renderHistoryButtonHtml,
  renderHistoryProgress as renderHistoryProgressHtml,
} from '../src/ui/history-import.js';

const renderMergeEvidence = (...args) => String(renderMergeEvidenceHtml(...args));
const mergeEvidenceBadge = (...args) => String(mergeEvidenceBadgeHtml(...args));
const renderHistoryButton = (...args) => String(renderHistoryButtonHtml(...args));
const renderHistoryProgress = (...args) => String(renderHistoryProgressHtml(...args));

test('saved graph evidence stays readable in the detail without a row badge, and no direct merge is invented', () => {
  const evidence = {
    status: 'complete',
    checkedAt: '2026-11-17T10:00:00Z',
    commits: [{ commitId: 'a'.repeat(40), parents: ['b', 'c'], branches: ['refs/heads/main'] }],
    prs: [],
    limitations: ['Source branch unknown'],
  };
  const html = renderMergeEvidence({ mergeEvidence: evidence });
  assert.match(html, /<h2>Push evidence<\/h2>/);
  assert.match(html, /Merge commit found/);
  assert.match(html, /2 parents/);
  assert.match(html, /does not prove a push was made outside a PR/);
  assert.doesNotMatch(html, /Merged by|Direct merge/);
  assert.equal(mergeEvidenceBadge({ kind: 'push', data: { mergeEvidence: evidence } }), '', 'the Merge commit badge is retired');
  assert.equal(mergeEvidenceBadge({ kind: 'pr', data: { mergeEvidence: evidence } }), '');
  const linked = renderMergeEvidence({
    mergeEvidence: { ...evidence, prs: [{ pullRequestId: 1, targetRefName: 'refs/heads/main', closedBy: { displayName: '<unsafe>' } }] },
  });
  assert.match(linked, /Completed PR linked/);
  assert.match(mergeEvidenceBadge({ kind: 'push', data: { mergeEvidence: { prs: [{ pullRequestId: 1 }] } } }), /Completed PR linked/);
  assert.match(linked, /PR closed by &lt;unsafe&gt;/);
  assert.match(renderMergeEvidence({ mergeEvidence: { status: 'not-applicable', commits: [], prs: [] } }), /Branch lifecycle only/);
});

test('the rewrite check result shows on the row and in the detail without a merge verdict', () => {
  const rewritten = { mergeEvidence: { rewrite: [{ ref: 'refs/heads/main', status: 'rewrite', dropped: 2, more: true }] } };
  assert.equal(
    mergeEvidenceBadge({ kind: 'push', data: rewritten }),
    '<span class="chip status-chip warn">History rewritten · 2+ commits dropped</span>',
  );
  const html = renderMergeEvidence(rewritten);
  assert.match(html, /main · history rewritten, 2\+ commits dropped from the old tip/);
  assert.doesNotMatch(html, /Evidence incomplete|No completed PR association/);
  const fastForward = { mergeEvidence: { rewrite: [{ ref: 'refs/heads/main', status: 'fast-forward' }] } };
  assert.equal(mergeEvidenceBadge({ kind: 'push', data: fastForward }), '');
  assert.match(renderMergeEvidence(fastForward), /main · fast-forward, no history dropped/);
  const unknown = { mergeEvidence: { rewrite: [{ ref: 'refs/heads/main', status: 'unknown' }] } };
  assert.equal(mergeEvidenceBadge({ kind: 'push', data: unknown }), '');
  assert.match(renderMergeEvidence(unknown), /main · old tip could not be read; rewrite not established/);
});

test('a push without merge evidence shows nothing about analysis', () => {
  assert.equal(renderMergeEvidence({}), '');
  assert.equal(renderMergeEvidence(), '');
});

test('the repository import row shows retry and pause without exposing a second start', () => {
  const repo = { id: 'r', name: 'Repo' };
  const job = { status: 'retrying', pages: 2, error: { message: '<Read denied>' } };
  const markup = renderHistoryProgress(repo, job);
  assert.match(markup, /History sync retrying/);
  assert.match(markup, /&lt;Read denied&gt;/);
  assert.match(renderHistoryButton(repo, job), /disabled>Sync older activity/);
  assert.doesNotMatch(renderHistoryButton(repo, { status: 'completed' }), /disabled/);
});
