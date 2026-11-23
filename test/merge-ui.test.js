import test from 'node:test';
import assert from 'node:assert/strict';
import { renderMergeEvidence as renderMergeEvidenceHtml, mergeEvidenceBadge as mergeEvidenceBadgeHtml } from '../src/ui/merge-evidence.ts';
import {
  renderHistoryButton as renderHistoryButtonHtml,
  renderHistoryProgress as renderHistoryProgressHtml,
} from '../src/ui/history-import.ts';
import { parse, one, all, text } from './fixtures/dom.js';

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
  const doc = parse(renderMergeEvidence({ mergeEvidence: evidence }));
  assert.equal(text(one(doc, 'h2')), 'Push evidence');
  assert.equal(text(one(doc, '.status-chip.info')), 'Merge commit found');
  assert.match(text(doc), /aaaaaaaa · 2 parents · main/);
  assert.match(text(doc), /does not prove a push was made outside a PR/);
  assert.doesNotMatch(text(doc), /Merged by|Direct merge/);
  assert.equal(mergeEvidenceBadge({ kind: 'push', data: { mergeEvidence: evidence } }), '', 'the Merge commit badge is retired');
  assert.equal(mergeEvidenceBadge({ kind: 'pr', data: { mergeEvidence: evidence } }), '');
  const linked = renderMergeEvidence({
    mergeEvidence: { ...evidence, prs: [{ pullRequestId: 1, targetRefName: 'refs/heads/main', closedBy: { displayName: '<unsafe>' } }] },
  });
  assert.equal(text(one(parse(linked), '.status-chip')), 'Related PR evidence');
  assert.equal(
    text(one(parse(mergeEvidenceBadge({ kind: 'push', data: { mergeEvidence: { prs: [{ pullRequestId: 1 }] } } })), '.status-chip.ok')),
    'Related PR evidence',
  );
  // The closer's name is text, not markup.
  assert.match(text(parse(linked)), /PR closed by <unsafe>/);
  assert.match(linked, /PR closed by &lt;unsafe&gt;/);
  const lifecycle = parse(renderMergeEvidence({ mergeEvidence: { status: 'not-applicable', commits: [], prs: [] } }));
  assert.equal(text(one(lifecycle, '.status-chip')), 'Branch lifecycle only');
});

test('the rewrite check result shows on the row and in the detail without a merge verdict', () => {
  const rewritten = { mergeEvidence: { rewrite: [{ ref: 'refs/heads/main', status: 'rewrite', dropped: 2, more: true }] } };
  const badge = parse(mergeEvidenceBadge({ kind: 'push', data: rewritten }));
  assert.equal(all(badge, '.status-chip').length, 1);
  const chip = one(badge, '.status-chip');
  assert.equal(text(chip), 'History rewritten · 2+ commits dropped');
  assert.deepEqual([...chip.classList].sort(), ['chip', 'status-chip', 'warn']);
  const detail = parse(renderMergeEvidence(rewritten));
  assert.equal(text(one(detail, 'li')), 'main · history rewritten, 2+ commits dropped from the old tip');
  assert.doesNotMatch(text(detail), /Evidence incomplete|No completed PR association/);
  const fastForward = { mergeEvidence: { rewrite: [{ ref: 'refs/heads/main', status: 'fast-forward' }] } };
  assert.equal(mergeEvidenceBadge({ kind: 'push', data: fastForward }), '');
  assert.equal(text(one(parse(renderMergeEvidence(fastForward)), 'li')), 'main · fast-forward, no history dropped');
  const unknown = { mergeEvidence: { rewrite: [{ ref: 'refs/heads/main', status: 'unknown' }] } };
  assert.equal(mergeEvidenceBadge({ kind: 'push', data: unknown }), '');
  assert.equal(text(one(parse(renderMergeEvidence(unknown)), 'li')), 'main · old tip could not be read; rewrite not established');
});

test('a push without merge evidence shows nothing about analysis', () => {
  assert.equal(renderMergeEvidence({}), '');
  assert.equal(renderMergeEvidence(), '');
});

test('the repository import row shows retry and pause without exposing a second start', () => {
  const repo = { id: 'r', name: 'Repo' };
  const job = { status: 'retrying', pages: 2, error: { message: '<Read denied>' } };
  const progress = parse(renderHistoryProgress(repo, job));
  assert.match(text(progress), /History sync retrying/);
  assert.match(text(progress), /<Read denied>/);
  const busy = one(parse(renderHistoryButton(repo, job)), 'button[data-action="open-history-import"]');
  assert.equal(text(busy), 'Sync older activity…');
  assert.ok(busy.hasAttribute('disabled'), 'a running import offers no second start');
  assert.ok(!one(parse(renderHistoryButton(repo, { status: 'completed' })), 'button').hasAttribute('disabled'));
});
