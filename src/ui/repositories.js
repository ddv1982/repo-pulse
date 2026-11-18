import { escape as e, dateTime, streamError, azureLink, streamLabel } from './format.js';
import { connectionResult } from './connection.js';
import { repositoryHealth } from './health.js';
import { renderCheckout } from './checkout.js';
import { renderHistoryButton, renderHistoryProgress } from './history-import.js';
import { displayLocalPath } from './repository-picker.js';

export function renderRepositories(state, ui, checkouts = {}) {
  const jobs = new Map(state.jobs?.map(job => [job.repoId, job]));
  return `<div class="repo-heading">
    <h1 class="sr">Repositories</h1>
    <div class="section-heading"><span class="dim">${state.repos.length} watched</span></div>
    <details class="repo-add" data-group="add-repositories" ${state.repos.length ? '' : 'open'}>
      <summary class="btn sm" id="add-repositories" aria-label="Add repositories">Add repositories</summary>
      <div class="card repo-add-body">
        <div id="repository-picker" class="card-pad"></div>
        <div id="connection-status" class="card-pad">${connectionResult(ui.connection?.results.get(''))}</div>
      </div>
    </details>
    </div>
    <section class="card block repo-list" aria-label="Watched repositories">
      ${state.repos.length ? state.repos.map(repo => renderRepo(repo, state.streams, state.demo ? null : jobs.get(repo.id),
        state.demo ? { state: 'not-linked' } : checkouts[repo.id], state.demo, state.settings)).join('') : '<div class="card-pad"><p>No repositories watched yet.</p><p class="help">Add a local checkout to watch all its remote branches.</p></div>'}
    </section>`;
}

function renderRepo(repo, streams, job, checkout, demo, settings) {
  const automatic = settings.refreshEnabled !== false;
  const id = e(repo.id);
  const records = streams.filter(stream => stream.repoId === repo.id);
  const health = repositoryHealth(repo, records, { automatic, resumedAt: settings.refreshResumedAt });
  const checked = records.map(stream => Date.parse(stream.lastSuccess)).filter(Number.isFinite);
  const failed = records.map(stream => ({ label: streamLabel(stream.stream), message: streamError(stream) })).filter(item => item.message);
  const gitStatus = checkout ?? (repo.localPath ? undefined : { state: 'not-linked' });
  return `<article class="repo-card repo-entry">
    <div class="repo-overview">
      <h3>${e(repo.name)}</h3>
      ${health.show ? `<span class="chip ${health.className}">${health.label}</span>` : ''}
    </div>
    <div class="repo-checkout-line" id="checkout-state-${id}" data-checkout-part="status" data-checkout-id="${id}" tabindex="-1" aria-live="polite">
      ${renderCheckout(repo.id, gitStatus, 'status')}
    </div>
    <div class="checkout-guidance" id="checkout-guidance-${id}" data-checkout-part="guidance" data-checkout-id="${id}" tabindex="-1" aria-live="polite">${renderCheckout(repo.id, gitStatus, 'guidance')}</div>
    ${renderHistoryProgress(repo, job)}
    <details class="streams repo-details" data-group="repo-${id}">
      <summary class="ghost sm" id="repo-details-${id}" aria-label="Details for ${e(repo.name)}">Details</summary>
      <div class="repo-details-content">
        <p class="help">${e(repo.project)}${checked.length ? `${repo.project ? ' · ' : ''}Last successful Azure check ${e(dateTime(Math.max(...checked)))}` : ''}</p>
        <p class="help checkout-last-check" data-checkout-part="last-check" data-checkout-id="${id}">${renderCheckout(repo.id, gitStatus, 'last-check')}</p>
        ${repo.localPath ? `<p class="help mono local-path" title="${e(repo.localPath)}">${e(displayLocalPath(repo.localPath))}</p>` : ''}
        ${repo.localPath ? '<p class="help">Check for updates compares your current branch with its remote. Use Refresh activity to check watched branches across the selected repositories.</p>' : ''}
        ${!checked.length && automatic && !repo.paused && !failed.length ? '<p class="help">Waiting for the first check.</p>' : ''}
        ${failed.length ? `<ul class="repo-check-errors help" aria-label="Last check failures">${failed.map(item =>
          `<li><strong>${e(item.label)}</strong>: ${e(item.message)}</li>`).join('')}</ul>` : ''}
        <div class="actions">
          ${demo ? '' : renderHistoryButton(repo, job)}
          ${azureLink(repo.webUrl)}
          <button class="btn sm" type="button" id="pause-${id}" data-action="pause-repo" data-id="${id}">${repo.paused ? 'Resume' : 'Pause'}</button>
          <button class="ghost sm" type="button" id="remove-${id}" data-action="remove-repo" data-id="${id}">Remove watch</button>
        </div>
      </div>
    </details>
  </article>`;
}
