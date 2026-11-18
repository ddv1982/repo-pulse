import { activityMergeBadge } from '../activity-text.js';
import { escape as e, dateTime, branchName, azureLink } from './format.js';

/** Evidence is supplemental metadata, never an inferred actor or merge operation. */
export function renderMergeEvidence(data = {}) {
  const evidence = data.mergeEvidence;
  if (!evidence) return '<p class="help">Merge evidence: waiting for background inspection.</p>';
  const prs = evidence.prs || [];
  const commits = evidence.commits || [];
  return `<section class="activity-history stack-gap" aria-label="Merge evidence"><h2>Merge evidence</h2>
    <p><span class="chip status-chip ${prs.length ? 'ok' : commits.length ? 'info' : evidence.status === 'not-applicable' ? 'neutral' : 'unk'}">${prs.length ? 'Completed PR linked' : commits.length ? 'Merge commit found' : evidence.status === 'not-applicable' ? 'Branch lifecycle only' : evidence.status === 'enriching' ? 'Checking merge evidence' : evidence.status === 'complete' ? 'No merge established' : 'Evidence incomplete'}</span>${evidence.checkedAt ? ` <span class="help">Checked ${e(dateTime(evidence.checkedAt))}</span>` : ''}</p>
    ${prs.length ? `<ul>${prs.map(renderPr).join('')}</ul>` : evidence.status === 'not-applicable' ? '' : '<p class="help">No completed PR association established. This does not prove a push was made outside a PR.</p>'}
    ${commits.length ? `<ul>${commits.map(item => `<li><code>${e((item.commitId || '').slice(0, 8))}</code> · ${e(item.parents?.length || 0)} parents${item.branches?.length ? ` · ${e(item.branches.map(branchName).join(', '))}` : ''}</li>`).join('')}</ul><p class="help">Multiple parents establish a graph merge; they do not identify the original branch name or Git command.</p>` : ''}
    ${(evidence.limitations || []).map(item => `<p class="help">${e(item)}</p>`).join('')}
    ${evidence.error ? `<p class="status-text warn">${e(evidence.error.message || evidence.error)}</p>` : ''}
  </section>`;
}

export function mergeEvidenceBadge(event) {
  const label = activityMergeBadge(event);
  if (!label) return '';
  return `<span class="chip status-chip ${label === 'Completed PR linked' ? 'ok' : 'info'}">${e(label)}</span>`;
}

function renderPr(pr) {
  const id = pr.pullRequestId || pr.id;
  const source = branchName(pr.sourceRefName);
  const target = branchName(pr.targetRefName);
  const closer = typeof pr.closedBy === 'string' ? pr.closedBy : pr.closedBy?.displayName;
  const strategy = {
    noFastForward: 'Merge commit',
    squash: 'Squash',
    rebase: 'Rebase and fast-forward',
    rebaseMerge: 'Rebase with merge commit',
  }[pr.mergeStrategy];
  return `<li>${azureLink(pr.url, `PR #${id}`) || `PR #${e(id)}`}${source ? ` · ${e(source)}` : ''}${target ? ` → ${e(target)}` : ''}${strategy ? ` · ${e(strategy)}` : ''}${closer ? ` · PR closed by ${e(closer)}` : ''}${pr.mergeCommit ? ` · result <code title="${e(pr.mergeCommit)}">${e(pr.mergeCommit.slice(0, 8))}</code>` : ''}</li>`;
}
