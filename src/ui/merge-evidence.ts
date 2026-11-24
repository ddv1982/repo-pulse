import { activityMergeBadge, matchesPushResult, matchingPushResults } from '../activity-text.ts';
import { emptyHtml, html, dateTime, branchName, azureLink } from './format.ts';
import type { EventData, EvidencePr } from '../activity.ts';

export type { EventData, EvidencePr };

/** Evidence is supplemental metadata, never an inferred actor or merge operation.  */
export function renderMergeEvidence(data: EventData = {}) {
  const evidence = data.mergeEvidence;
  if (!evidence) return emptyHtml;
  const prs = evidence.prs || [];
  const commits = evidence.commits || [];
  const prLabel = matchingPushResults(data).length ? 'Completed PR linked' : 'Related PR evidence';
  // A rewrite check alone says nothing about how the push was merged.
  const merge = prs.length || commits.length || evidence.status;
  const error = typeof evidence.error === 'string' ? evidence.error : evidence.error?.message;
  const errorText = typeof error === 'string' && error ? error : 'Merge evidence could not be checked.';
  return html`<section class="activity-history stack-gap" aria-label="Push evidence"><h2>Push evidence</h2>
    ${
      merge
        ? html`<p><span class="chip status-chip ${prs.length ? 'ok' : commits.length ? 'info' : evidence.status === 'not-applicable' ? 'neutral' : 'unk'}">${prs.length ? prLabel : commits.length ? 'Merge commit found' : evidence.status === 'not-applicable' ? 'Branch lifecycle only' : evidence.status === 'complete' ? 'No merge established' : 'Evidence incomplete'}</span>${evidence.checkedAt ? html` <span class="help">Checked ${dateTime(evidence.checkedAt)}</span>` : emptyHtml}</p>
    ${prs.length ? html`<ul>${prs.map(pr => renderPr(pr, data))}</ul>` : evidence.status === 'not-applicable' ? emptyHtml : html`<p class="help">No completed PR association established. This does not prove a push was made outside a PR.</p>`}`
        : emptyHtml
    }
    ${commits.length ? html`<ul>${commits.map(item => html`<li><code>${(item.commitId || '').slice(0, 8)}</code> · ${item.parents?.length || 0} parents${item.branches?.length ? ` · ${item.branches.map(branchName).join(', ')}` : ''}</li>`)}</ul><p class="help">Multiple parents establish a graph merge; they do not identify the original branch name or Git command.</p>` : emptyHtml}
    ${renderHistory(data)}
    ${(evidence.limitations || []).map(item => html`<p class="help">${item}</p>`)}
    ${evidence.error ? html`<p class="status-text warn">${errorText}</p>` : emptyHtml}
  </section>`;
}

const droppedText = (update: { dropped?: number; more?: boolean }) =>
  `${update.dropped}${update.more ? '+' : ''} commit${update.dropped === 1 && !update.more ? '' : 's'} dropped`;

export type CheckedUpdate = { name?: string | undefined; update: { status?: string; dropped?: number; more?: boolean } };
/**
 * Branch updates with a history check: saved as ref ranges by the earlier merge analysis, or by the rewrite check.
 */
const checkedUpdates = (data?: EventData): CheckedUpdate[] => [
  ...(data?.mergeEvidence?.refRanges || []).flatMap(range => (range.update ? [{ name: range.name, update: range.update }] : [])),
  ...(data?.mergeEvidence?.rewrite || []).map(({ ref, ...update }) => ({ name: ref, update })),
];

/** Branch updates whose old tip the new tip no longer reaches.  */
const rewrites = (data?: EventData) => checkedUpdates(data).filter(range => range.update.status === 'rewrite');

export function mergeEvidenceBadge(event: import('../activity.ts').ActivityEvent) {
  const label = activityMergeBadge(event);
  const rewritten = event.kind === 'push' ? rewrites(event.data) : [];
  const history = rewritten.length
    ? html`<span class="chip status-chip warn">History rewritten · ${rewritten.map(range => droppedText(range.update)).join(', ')}</span>`
    : emptyHtml;
  if (!label) return history;
  const count = matchingPushResults(event.data).length;
  return html`<span class="chip status-chip ok">${count > 1 ? `${count} completed PRs linked` : count === 1 ? 'Completed PR linked' : 'Related PR evidence'}</span>${history}`;
}

function renderHistory(data?: EventData) {
  const ranges = checkedUpdates(data);
  if (!ranges.length) return emptyHtml;
  const text: Record<string, string> = {
    'fast-forward': 'fast-forward, no history dropped',
    unknown: 'old tip could not be read; rewrite not established',
  };
  const line = (range: CheckedUpdate) =>
    html`<li>${branchName(range.name)} · ${range.update.status === 'rewrite' ? `history rewritten, ${droppedText(range.update)} from the old tip` : text[range.update.status ?? ''] || 'not checked'}</li>`;
  return html`<ul>${ranges.map(line)}</ul>`;
}

const prStrategies: Record<string, string | undefined> = {
  noFastForward: 'Merge commit',
  squash: 'Squash',
  rebase: 'Rebase and fast-forward',
  rebaseMerge: 'Rebase with merge commit',
};

function renderPr(pr: EvidencePr, data: EventData) {
  const id = pr.pullRequestId || pr.id;
  const source = branchName(pr.sourceRefName);
  const target = branchName(pr.targetRefName);
  const closer = typeof pr.closedBy === 'string' ? pr.closedBy : pr.closedBy?.displayName;
  const strategy = prStrategies[String(pr.mergeStrategy)];
  const link = azureLink(pr.url, `PR #${id}`);
  return html`<li>${link.toString() ? link : `PR #${id}`}${source ? ` · ${source}` : ''}${target ? ` → ${target}` : ''}${strategy ? ` · ${strategy}` : ''}${closer ? ` · PR closed by ${closer}` : ''}${matchesPushResult(data, pr) ? ' · Matches the pushed target and PR merge result' : ' · Related PR evidence'}${pr.mergeCommit ? html` · result <code title="${pr.mergeCommit}">${pr.mergeCommit.slice(0, 8)}</code>` : emptyHtml}</li>`;
}
