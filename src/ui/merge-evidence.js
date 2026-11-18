// @ts-check

import { activityMergeBadge } from '../activity-text.js';
import { escape as e, dateTime, branchName, azureLink } from './format.js';

/** @typedef {import('../activity.js').EventData} EventData */
/** @typedef {import('../activity.js').EvidencePr} EvidencePr */

/** Evidence is supplemental metadata, never an inferred actor or merge operation. @param {EventData} [data] */
export function renderMergeEvidence(data = {}) {
  const evidence = data.mergeEvidence;
  if (!evidence) return '<p class="help">Merge evidence: waiting for background inspection.</p>';
  const prs = evidence.prs || [];
  const commits = evidence.commits || [];
  return `<section class="activity-history stack-gap" aria-label="Merge evidence"><h2>Merge evidence</h2>
    <p><span class="chip status-chip ${prs.length ? 'ok' : commits.length ? 'info' : evidence.status === 'not-applicable' ? 'neutral' : 'unk'}">${prs.length ? 'Completed PR linked' : commits.length ? 'Merge commit found' : evidence.status === 'not-applicable' ? 'Branch lifecycle only' : evidence.status === 'enriching' ? 'Checking merge evidence' : evidence.status === 'complete' ? 'No merge established' : 'Evidence incomplete'}</span>${evidence.checkedAt ? ` <span class="help">Checked ${e(dateTime(evidence.checkedAt))}</span>` : ''}</p>
    ${prs.length ? `<ul>${prs.map(renderPr).join('')}</ul>` : evidence.status === 'not-applicable' ? '' : '<p class="help">No completed PR association established. This does not prove a push was made outside a PR.</p>'}
    ${commits.length ? `<ul>${commits.map(item => `<li><code>${e((item.commitId || '').slice(0, 8))}</code> · ${e(item.parents?.length || 0)} parents${item.branches?.length ? ` · ${e(item.branches.map(branchName).join(', '))}` : ''}</li>`).join('')}</ul><p class="help">Multiple parents establish a graph merge; they do not identify the original branch name or Git command.</p>` : ''}
    ${renderHistory(data)}
    ${(evidence.limitations || []).map(item => `<p class="help">${e(item)}</p>`).join('')}
    ${evidence.error ? `<p class="status-text warn">${e((typeof evidence.error === 'object' && evidence.error.message) || evidence.error)}</p>` : ''}
  </section>`;
}

/** @param {{ dropped?: number, more?: boolean }} update */
const droppedText = update => `${update.dropped}${update.more ? '+' : ''} commit${update.dropped === 1 && !update.more ? '' : 's'} dropped`;

/** Branch updates whose old tip the new tip no longer reaches. @param {EventData} [data] */
const rewrites = data => (data?.mergeEvidence?.refRanges || []).filter(range => range.update?.status === 'rewrite');

/** @param {import('../activity.js').ActivityEvent} event */
export function mergeEvidenceBadge(event) {
  const label = activityMergeBadge(event);
  const rewritten = event.kind === 'push' ? rewrites(event.data) : [];
  const history = rewritten.length
    ? `<span class="chip status-chip warn">History rewritten · ${e(rewritten.map(range => droppedText(range.update || {})).join(', '))}</span>`
    : '';
  if (!label) return history;
  return `<span class="chip status-chip ${label === 'Completed PR linked' ? 'ok' : 'info'}">${e(label)}</span>${history}`;
}

/** @param {EventData} [data] */
function renderHistory(data) {
  const ranges = (data?.mergeEvidence?.refRanges || []).filter(range => range.update);
  if (!ranges.length) return '';
  /** @type {Record<string, string>} */
  const text = { 'fast-forward': 'fast-forward, no history dropped', unknown: 'old tip unavailable; rewrite not established' };
  const line = (/** @type {import('../activity.js').EvidenceRange} */ range) =>
    `<li>${e(branchName(range.name))} · ${range.update?.status === 'rewrite' ? `history rewritten, ${e(droppedText(range.update))} from the old tip` : e(text[range.update?.status ?? ''] || 'not checked')}</li>`;
  return `<ul>${ranges.map(line).join('')}</ul>`;
}

/** @type {Record<string, string | undefined>} */
const prStrategies = {
  noFastForward: 'Merge commit',
  squash: 'Squash',
  rebase: 'Rebase and fast-forward',
  rebaseMerge: 'Rebase with merge commit',
};

/** @param {EvidencePr} pr */
function renderPr(pr) {
  const id = pr.pullRequestId || pr.id;
  const source = branchName(pr.sourceRefName);
  const target = branchName(pr.targetRefName);
  const closer = typeof pr.closedBy === 'string' ? pr.closedBy : pr.closedBy?.displayName;
  const strategy = prStrategies[String(pr.mergeStrategy)];
  return `<li>${azureLink(pr.url, `PR #${id}`) || `PR #${e(id)}`}${source ? ` · ${e(source)}` : ''}${target ? ` → ${e(target)}` : ''}${strategy ? ` · ${e(strategy)}` : ''}${closer ? ` · PR closed by ${e(closer)}` : ''}${pr.mergeCommit ? ` · result <code title="${e(pr.mergeCommit)}">${e(pr.mergeCommit.slice(0, 8))}</code>` : ''}</li>`;
}
