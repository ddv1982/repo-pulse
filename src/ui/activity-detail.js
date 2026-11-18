import { renderMergeEvidence } from './merge-evidence.js';
import { groupActivity } from '../activity.js';
import {
  escape as e,
  branchName,
  labels,
  dateTime,
  azureLink,
  activityLabel,
  activityTone,
  activityTitle,
  activitySummary,
  triggerLabel,
} from './format.js';
import { renderTrail } from './activity-trail.js';
import { activityHref } from './navigation.js';

function commit(value) {
  return `<code title="${e(value)}">${e(value.slice(0, 8))}</code> <button class="ghost sm" type="button" data-action="copy-commit" data-value="${e(value)}" aria-label="Copy full commit ID">Copy</button>`;
}

export function renderDetail(event, state, commits, { returnRoute = 'catchup', label = 'Back to New updates' } = {}) {
  const back = `<a class="ghost sm back" data-action="back-to-results" href="${activityHref(returnRoute)}">← ${e(label)}</a>`;
  if (!event) return `${back}<div class="card empty"><h1>Activity not found</h1></div>`;
  const record = groupActivity(state.events).find(item => item.eventIds.includes(event.id)) || groupActivity([event])[0];
  const repo = state.repos.find(item => item.id === record.repoId);
  const data = record.data || {};
  const pushId = data.pushId || data.push?.pushId;
  const sha = data.sourceVersion || data.sourceCommit || data.commitId;
  const tone = activityTone(record);
  const title = activityTitle(record);
  const fields = [
    ['Repository', `${e(repo?.name)}${repo?.project ? ` · ${e(repo.project)}` : ''}`],
    [record.kind === 'pr' ? 'Source branch' : 'Branch', e(branchName(record.branch) || 'Not supplied')],
    [record.kind === 'pr' ? 'Created by' : 'By', e(record.actor || 'Not supplied by Azure')],
    [new Date(record.time).valueOf() === new Date(record.observedAt).valueOf() ? 'Time' : 'Source time', e(dateTime(record.time))],
  ];
  if (new Date(record.time).valueOf() !== new Date(record.observedAt).valueOf())
    fields.push(['Observed locally', e(dateTime(record.observedAt))]);
  if (record.kind === 'pr' && data.targetRefName) fields.push(['Target branch', e(branchName(data.targetRefName))]);
  if (sha) fields.push([record.kind === 'pr' ? 'Source commit' : 'Commit', commit(sha)]);
  if (record.kind === 'pr' && data.status === 'completed' && data.mergeCommit) fields.push(['Merge commit', commit(data.mergeCommit)]);
  if (data.mergeStrategy)
    fields.push([
      'Merge strategy',
      e(
        { noFastForward: 'Merge commit', squash: 'Squash', rebase: 'Rebase and fast-forward', rebaseMerge: 'Rebase with merge commit' }[
          data.mergeStrategy
        ] || 'Not supplied',
      ),
    ]);
  if (record.kind === 'pr' && data.closedBy) fields.push(['PR closed by', e(data.closedBy)]);
  if (data.reason) fields.push(['Trigger', e(triggerLabel(data.reason))]);
  if (data.pullRequestId) fields.push(['Pull request', `#${e(data.pullRequestId)}`]);
  if (pushId) fields.push(['Push', `#${e(pushId)}`]);
  const ids = e(JSON.stringify(record.eventIds));
  return `<div class="crumb">${back}<span>${e(repo?.name)}</span></div><section class="card"><div class="dhead"><div><h1>${e(title)}</h1><div class="meta">${e(record.kind.startsWith('branch-') ? 'Branch' : labels[record.kind])} · ${e(repo?.name)} · ${e(branchName(record.branch))}</div></div><div class="actions">${azureLink(record.url, 'Open in Azure DevOps', 'btn')}${record.imported ? '' : `<button class="btn" data-action="ack-item" data-id="${e(record.id)}" data-event-ids="${ids}">Mark ${record.unseen ? 'seen' : 'unseen'}</button>`}</div></div>
    <div class="facts"><span class="chip status-chip ${tone}">${e(activityLabel(record))}</span><span class="chip">${record.unseen ? `${record.unseenIds.length} new update${record.unseenIds.length === 1 ? '' : 's'}` : record.imported ? 'Imported history' : 'Seen'}</span>${record.kind === 'build' ? '<span class="chip name">CI outcome · deployment unknown</span>' : ''}</div>
    <div class="detail-data">${record.kind !== 'build' ? `<p>${e(activitySummary(record))}</p>` : ''}<dl class="detail-facts">${fields.map(([name, value]) => `<div><dt>${name}</dt><dd>${value}</dd></div>`).join('')}</dl>${record.kind === 'pr' && data.status === 'completed' ? '<p class="help">Completed in Azure DevOps. Push details show separately checked commit and PR evidence.</p>' : ''}${record.kind === 'push' ? renderMergeEvidence(data) : ''}${renderTrail(record, { expanded: true })}${record.kind === 'push' && pushId ? `<button class="btn" data-action="load-commits" data-repo-id="${e(repo.id)}" data-push-id="${e(pushId)}">${commits ? 'Reload commits' : 'Load push commits'}</button><p class="help">Loads on request within the shared budget.</p>${commits ? renderCommits(commits) : ''}` : ''}</div></section>`;
}

function renderCommits(commits) {
  if (commits.error) return `<p class="status-bad">${e(commits.error)}</p>`;
  const items = commits.items || commits.value || (Array.isArray(commits) ? commits : []);
  return `<ul class="rows">${items.map(item => `<li class="push">${commit(item.commitId || '')} ${e(item.comment || item.message || '')}</li>`).join('')}</ul>${commits.nextCursor ? '<p class="help">More commits are available in Azure DevOps.</p>' : ''}`;
}
