import { emptyHtml, html, dateTime, streamProblems, azureLink, streamLabel } from './format.ts';
import { connectionResult } from './connection.ts';
import { syncPill } from './health.ts';
import { renderCheckout } from './checkout-render.ts';
import { renderHistoryButton, renderHistoryProgress } from './history-import.ts';
import { displayLocalPath } from './repository-picker.ts';

export type PageState = import('./refresh.ts').PageState;
export type Repo = import('./refresh.ts').Repo;
export type CheckoutSnapshot = import('./checkout.ts').CheckoutSnapshot;
export type HistoryJob = import('./history-import.ts').HistoryJob;
export type RepositoriesView = Pick<import('./connection.ts').ConnectionState, 'results'>;

export function renderRepositories(
  state: PageState,
  ui: { connection?: RepositoriesView },
  checkouts: Record<string, CheckoutSnapshot> = {},
) {
  const jobs = new Map(state.jobs?.map(job => [job.repoId, job]));
  const disabled = state.watched.filter(repo => repo.disabled).length;
  return html`<div class="repo-heading">
    <h1 class="sr">Repositories</h1>
    <div class="section-heading"><span class="dim">${state.watched.length} watched${disabled ? ` · ${disabled} disabled` : ''}</span></div>
    <details class="repo-add" data-group="add-repositories" ${state.watched.length ? emptyHtml : html`open`}>
      <summary class="btn sm" id="add-repositories" aria-label="Add repositories">Add repositories</summary>
      <div class="card repo-add-body">
        <div id="repository-picker" class="card-pad" data-owned></div>
        <div id="connection-status" class="card-pad">${connectionResult(ui.connection?.results.get(''))}</div>
      </div>
    </details>
    </div>
    <section class="card block repo-list" aria-label="Watched repositories">
      ${
        state.watched.length
          ? state.watched.map(repo =>
              repo.disabled
                ? renderDisabledRepo(repo)
                : renderRepo(
                    repo,
                    state.syncStatus.repos[repo.id],
                    state.streams,
                    state.demo ? null : jobs.get(repo.id),
                    state.demo ? { state: 'not-linked' } : checkouts[repo.id],
                    state.demo,
                    state.settings,
                  ),
            )
          : html`<div class="card-pad"><p>No repositories watched yet.</p><p class="help">Add a local checkout to watch all its remote branches.</p></div>`
      }
    </section>`;
}

function repoSwitch(repo: Repo) {
  return html`<input class="setting-switch" type="checkbox" role="switch" id="enable-${repo.id}" data-repo-toggle data-id="${repo.id}"
    aria-label="Watch ${repo.name}" title="${repo.disabled ? 'Disabled: no checks and hidden from Activity' : 'Enabled: checked and shown in Activity'}" ${repo.disabled ? emptyHtml : html`checked`}>`;
}

function renderDisabledRepo(repo: Repo) {
  return html`<article class="repo-card repo-entry repo-disabled">
    <div class="repo-overview">
      ${repoSwitch(repo)}
      <h3>${repo.name}</h3>
      <span class="chip name">Disabled</span>
    </div>
    <div class="repo-disabled-actions">
      <button class="ghost sm" type="button" id="remove-${repo.id}" data-action="remove-repo" data-id="${repo.id}">Remove watch</button>
    </div>
  </article>`;
}

function renderRepo(
  repo: Repo,
  status: import('./health.ts').SyncStatus | undefined,
  streams: PageState['streams'],
  job: HistoryJob | null | undefined,
  checkout: CheckoutSnapshot | undefined,
  demo: boolean | undefined,
  settings: PageState['settings'],
) {
  const automatic = settings.refreshEnabled !== false;
  const records = streams.filter(stream => stream.repoId === repo.id);
  const checked = records.map(stream => Date.parse(stream.lastSuccess ?? '')).filter(Number.isFinite);
  const failed = records.flatMap(stream => streamProblems(stream).map(message => ({ label: streamLabel(stream.stream), message })));
  const gitStatus = checkout ?? (repo.localPath ? undefined : { state: 'not-linked' });
  return html`<article class="repo-card repo-entry">
    <div class="repo-overview">
      ${repoSwitch(repo)}
      <h3>${repo.name}</h3>
      ${status ? syncPill(status) : emptyHtml}
    </div>
    <div class="repo-checkout-line" id="checkout-state-${repo.id}" data-checkout-part="status" data-checkout-id="${repo.id}" tabindex="-1" aria-live="polite">
      ${renderCheckout(repo.id, gitStatus, 'status')}
    </div>
    <div class="checkout-guidance" id="checkout-guidance-${repo.id}" data-checkout-part="guidance" data-checkout-id="${repo.id}" tabindex="-1" aria-live="polite">${renderCheckout(repo.id, gitStatus, 'guidance')}</div>
    ${renderHistoryProgress(repo, job)}
    <details class="streams repo-details" data-group="repo-${repo.id}">
      <summary class="ghost sm" id="repo-details-${repo.id}" aria-label="Details for ${repo.name}">Details</summary>
      <div class="repo-details-content">
        <p class="help">${repo.project}${checked.length ? `${repo.project ? ' · ' : ''}Last successful Azure check ${dateTime(Math.max(...checked))}` : ''}</p>
        <p class="help checkout-last-check" data-checkout-part="last-check" data-checkout-id="${repo.id}">${renderCheckout(repo.id, gitStatus, 'last-check')}</p>
        ${repo.localPath ? html`<p class="help mono local-path" title="${repo.localPath}">${displayLocalPath(repo.localPath)}</p>` : emptyHtml}
        ${repo.localPath ? html`<p class="help">Check for updates compares your current branch with its remote. Use Refresh activity to check watched branches across the selected repositories.</p>` : emptyHtml}
        ${!checked.length && automatic && !failed.length ? html`<p class="help">Waiting for the first check.</p>` : emptyHtml}
        ${
          failed.length
            ? html`<ul class="repo-check-errors help" aria-label="Last check problems">${failed.map(
                item => html`<li><strong>${item.label}</strong>: ${item.message}</li>`,
              )}</ul>`
            : emptyHtml
        }
        <div class="actions">
          ${demo ? emptyHtml : renderHistoryButton(repo, job)}
          ${azureLink(repo.webUrl)}
          <button class="ghost sm" type="button" id="remove-${repo.id}" data-action="remove-repo" data-id="${repo.id}">Remove watch</button>
        </div>
      </div>
    </details>
  </article>`;
}
