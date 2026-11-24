import test from 'node:test';
import assert from 'node:assert/strict';
import {
  renderMergeEvidence as renderMergeEvidenceHtml,
  mergeEvidenceBadge as mergeEvidenceBadgeHtml,
} from '../../src/ui/merge-evidence.ts';
import {
  renderHistoryButton as renderHistoryButtonHtml,
  renderHistoryProgress as renderHistoryProgressHtml,
} from '../../src/ui/history-import.ts';
import type { ActivityEvent, EventData, MergeEvidenceData } from '../../src/activity.ts';
import type { HistoryJob, JobError } from '../../src/contract.d.ts';
import { parse, one, all, text } from '../fixtures/dom.ts';
import { stub } from '../../test/fixtures/typed.ts';

const renderMergeEvidence = (...args: Parameters<typeof renderMergeEvidenceHtml>) => String(renderMergeEvidenceHtml(...args));
const mergeEvidenceBadge = (event: Partial<ActivityEvent>) => String(mergeEvidenceBadgeHtml(stub<ActivityEvent>(event)));
const renderHistoryButton = (repo: { id: string }, job: Partial<HistoryJob>) =>
  String(renderHistoryButtonHtml(repo, stub<HistoryJob>(job)));
const renderHistoryProgress = (repo: { id: string }, job: Partial<HistoryJob>) =>
  String(renderHistoryProgressHtml(repo, stub<HistoryJob>(job)));

test('saved graph evidence stays readable in the detail without a row badge, and no direct merge is invented', async () => {
  const evidence: MergeEvidenceData = {
    status: 'complete',
    checkedAt: '2026-11-17T10:00:00Z',
    commits: [{ commitId: 'a'.repeat(40), parents: ['b', 'c'], branches: ['refs/heads/main'] }],
    prs: [],
    limitations: ['Source branch unknown'],
  };
  const doc = parse(renderMergeEvidence({ mergeEvidence: evidence }));
  assert.equal(await text(one(doc, 'h2')), 'Push evidence');
  assert.equal(await text(one(doc, '.status-chip.info')), 'Merge commit found');
  assert.match(await text(doc), /aaaaaaaa · 2 parents · main/);
  assert.match(await text(doc), /does not prove a push was made outside a PR/);
  assert.doesNotMatch(await text(doc), /Merged by|Direct merge/);
  assert.equal(mergeEvidenceBadge({ kind: 'push', data: { mergeEvidence: evidence } }), '', 'the Merge commit badge is retired');
  assert.equal(mergeEvidenceBadge({ kind: 'pr', data: { mergeEvidence: evidence } }), '');
  const linked = renderMergeEvidence({
    mergeEvidence: { ...evidence, prs: [{ pullRequestId: 1, targetRefName: 'refs/heads/main', closedBy: { displayName: '<unsafe>' } }] },
  });
  assert.equal(await text(one(parse(linked), '.status-chip')), 'Related PR evidence');
  assert.equal(
    await text(
      one(parse(mergeEvidenceBadge({ kind: 'push', data: { mergeEvidence: { prs: [{ pullRequestId: 1 }] } } })), '.status-chip.ok'),
    ),
    'Related PR evidence',
  );
  // The closer's name is text, not markup.
  assert.match(await text(parse(linked)), /PR closed by <unsafe>/);
  assert.match(linked, /PR closed by &lt;unsafe&gt;/);
  const lifecycle = parse(renderMergeEvidence({ mergeEvidence: { status: 'not-applicable', commits: [], prs: [] } }));
  assert.equal(await text(one(lifecycle, '.status-chip')), 'Branch lifecycle only');
});

test('the rewrite check result shows on the row and in the detail without a merge verdict', async () => {
  const rewritten: EventData = { mergeEvidence: { rewrite: [{ ref: 'refs/heads/main', status: 'rewrite', dropped: 2, more: true }] } };
  const badge = parse(mergeEvidenceBadge({ kind: 'push', data: rewritten }));
  assert.equal((await all(badge, '.status-chip')).length, 1);
  const chip = one(badge, '.status-chip');
  assert.equal(await text(chip), 'History rewritten · 2+ commits dropped');
  assert.deepEqual((await chip.classes()).sort(), ['chip', 'status-chip', 'warn']);
  const detail = parse(renderMergeEvidence(rewritten));
  assert.equal(await text(one(detail, 'li')), 'main · history rewritten, 2+ commits dropped from the old tip');
  assert.doesNotMatch(await text(detail), /Evidence incomplete|No completed PR association/);
  const fastForward: EventData = { mergeEvidence: { rewrite: [{ ref: 'refs/heads/main', status: 'fast-forward' }] } };
  assert.equal(mergeEvidenceBadge({ kind: 'push', data: fastForward }), '');
  assert.equal(await text(one(parse(renderMergeEvidence(fastForward)), 'li')), 'main · fast-forward, no history dropped');
  const unknown: EventData = { mergeEvidence: { rewrite: [{ ref: 'refs/heads/main', status: 'unknown' }] } };
  assert.equal(mergeEvidenceBadge({ kind: 'push', data: unknown }), '');
  assert.equal(await text(one(parse(renderMergeEvidence(unknown)), 'li')), 'main · old tip could not be read; rewrite not established');
});

test('a push without merge evidence shows nothing about analysis', async () => {
  assert.equal(renderMergeEvidence({}), '');
  assert.equal(renderMergeEvidence(), '');
});

test('the repository import row shows retry and pause without exposing a second start', async () => {
  const repo = { id: 'r', name: 'Repo' };
  const job: Partial<HistoryJob> = { status: 'retrying', pages: 2, error: stub<JobError>({ message: '<Read denied>' }) };
  const progress = parse(renderHistoryProgress(repo, job));
  assert.match(await text(progress), /History sync retrying/);
  assert.match(await text(progress), /<Read denied>/);
  const busy = one(parse(renderHistoryButton(repo, job)), 'button[data-action="open-history-import"]');
  assert.equal(await text(busy), 'Sync older activity…');
  assert.ok(await busy.hasAttribute('disabled'), 'a running import offers no second start');
  assert.ok(!(await one(parse(renderHistoryButton(repo, { status: 'completed' })), 'button').hasAttribute('disabled')));
});

test('the repository import row shows the records the import skipped as a warning', async () => {
  const message = 'Skipped 3 records in pushes that Azure returned without a readable value for pushId or date.';
  const job: Partial<HistoryJob> = {
    status: 'completed',
    pages: 4,
    error: null,
    warnings: [{ stream: 'pushes', code: 'UNREADABLE_RECORDS', count: 3, fields: ['pushId', 'date'], message }],
  };
  const progress = parse(renderHistoryProgress({ id: 'r' }, job));
  assert.equal(await text(one(progress, '.status-chip.warn')), 'History sync finished · 3 records skipped');
  assert.deepEqual(await Promise.all((await all(progress, '.history-warning')).map(text)), [message]);
});

test('the repository import chip says how many records the import skipped, since its warnings show only in Details', async () => {
  const warning = (stream: 'pushes' | 'builds', count: number) => ({
    stream,
    code: 'UNREADABLE_RECORDS' as const,
    count,
    fields: ['date'],
    message: `Skipped ${count} in ${stream}.`,
  });
  const chip = (job: Partial<HistoryJob>) => text(one(parse(renderHistoryProgress({ id: 'r' }, job)), '.status-chip'));
  const warnings = [warning('pushes', 1), warning('builds', 1)];
  assert.equal(await chip({ status: 'running', warnings }), 'History sync running · 2 records skipped');
  assert.equal(await chip({ status: 'retrying', warnings }), 'History sync retrying · 2 records skipped');
  assert.equal(await chip({ status: 'completed', warnings: [warning('pushes', 1)] }), 'History sync finished · 1 record skipped');
  assert.equal(await chip({ status: 'completed', warnings: [] }), 'History sync finished', 'a clean import says nothing more');
});

test('legacy merge evidence without an error message shows a generic explanation', async () => {
  const doc = parse(renderMergeEvidence({ mergeEvidence: { status: 'incomplete', error: {} } }));
  assert.equal(await text(one(doc, '.status-text')), 'Merge evidence could not be checked.');
});

test('legacy merge evidence omits a non-text branch name', async () => {
  // @ts-expect-error Old enrichment rows can contain unchecked provider fields.
  const doc = parse(renderMergeEvidence({ mergeEvidence: { prs: [{ pullRequestId: 1, sourceRefName: {} }] } }));
  assert.equal(await text(one(doc, 'li')), 'PR #1 · Related PR evidence');
});
