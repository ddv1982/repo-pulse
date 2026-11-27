import { connectionStatus } from './connection.ts';
import { emptyHtml, html } from './format.ts';
import { syncRepoName, syncSentence } from './health.ts';
import type { PageState } from './refresh.ts';
import type { ConnectionState } from './connection.ts';
import type { ConnectionResponse as ConnectionStatus } from '../contract.ts';

function repositorySelect(repos: PageState['repos'], repoId: string) {
  if (!repos.length) return emptyHtml;
  return html`<label>Repository <select class="control sm" id="connection-repo">
              ${repos.map(repo => html`<option value="${repo.id}" ${repo.id === repoId ? html`selected` : emptyHtml}>${repo.name} · ${repo.project}</option>`)}
            </select></label>`;
}

function connectionDetails(state: PageState, connection: ConnectionState, repoId: string, result: ConnectionStatus | undefined) {
  const local = result?.version || result?.available === false ? result : connection.local;
  return html`
          <div class="connection-summary">
            ${repositorySelect(state.repos, repoId)}
            <button class="btn sm" type="button" id="check-settings-connection" data-action="check-connection" data-repo-id="${repoId}" ${connection.pending === null ? emptyHtml : html`aria-disabled="true"`}>Check connection</button>
          </div>
          ${local?.version ? html`<p class="help">Azure CLI ${local.version}${local.extension ? ` · azure-devops ${local.extension}` : ''}</p>` : emptyHtml}
          ${local?.account?.name ? html`<p class="help">Azure CLI account context · ${local.account.name}</p>` : emptyHtml}
          ${result?.access?.message || result?.available === false ? html`<p class="help">${result.access?.message ?? result.message}</p>` : emptyHtml}
          <p class="help">The connection check reads repository details. CI permissions and local Git upstream access are separate.</p>`;
}

export function renderSettings(state: PageState, connection: ConnectionState) {
  const { settings, syncStatus } = state;
  const repoId = state.repos.some(repo => repo.id === connection.repoId) ? connection.repoId : state.repos[0]?.id || '';
  const result = connection.results.get(repoId);
  return html`<div class="section-heading"><h1>Settings</h1></div>
    <div class="card settings-card">
      <details data-group="azure-connection">
        <summary class="settings-row connection-heading" id="azure-connection-toggle">
          <span><strong>Azure DevOps connection</strong><span class="help">Uses your existing Azure CLI (az) and Azure DevOps extension.</span></span>
          <span class="help connection-state" role="status">${connectionStatus(state, connection, repoId)}</span>
          <span class="settings-chevron" aria-hidden="true"></span>
        </summary>
        <div class="settings-content">
          ${state.demo ? html`<p class="help">Demo mode uses fictional data.</p>` : connectionDetails(state, connection, repoId, result)}
        </div>
      </details>
      <label class="settings-row settings-toggle" for="refresh-enabled">
        <span><strong id="refresh-label">Automatic checks</strong><span class="help" id="refresh-help">Checks watched branches, pull requests and CI in Azure DevOps. You can still refresh activity manually.</span></span>
        <input class="setting-switch" type="checkbox" role="switch" id="refresh-enabled" data-auto-toggle aria-labelledby="refresh-label" aria-describedby="refresh-help" ${settings.refreshEnabled ? html`checked` : emptyHtml}>
      </label>
      <details data-group="troubleshooting">
        <summary class="settings-row" id="troubleshooting-toggle"><strong>Troubleshooting</strong> <span class="settings-chevron" aria-hidden="true"></span></summary>
        <div class="settings-content">
          <p class="sync-sentence">${syncSentence(syncStatus.overall, syncRepoName(state.repos, syncStatus.overall))}</p>
          <button class="btn sm" type="button" id="copy-diagnostics" data-action="copy-diagnostics">Copy diagnostics</button>
        </div>
      </details>
      ${
        state.demo
          ? emptyHtml
          : html`<div class="settings-row settings-action">
        <span><strong id="reset-label">Start from scratch</strong><span class="help" id="reset-help">Deletes stored activity and imports the last seven days again. Your repositories and settings stay.</span></span>
        <button class="btn sm" type="button" data-action="reset-activity" aria-describedby="reset-help">Start from scratch</button>
      </div>`
      }
      <details data-group="coverage">
        <summary class="settings-row" id="coverage-toggle"><strong>What Repo Pulse tracks</strong> <span class="settings-chevron" aria-hidden="true"></span></summary>
        <div class="settings-content help">
          <p>Repo Pulse reads remote branches, pushes, pull requests, and CI runs for the primary repository. It stores the results locally.</p>
          <p>Initial history covers about seven days plus older active items. Activity includes imported history. Polling can miss changes between checks.</p>
          <p>A successful build or merged pull request does not confirm deployment.</p>
        </div>
      </details>
    </div>`;
}
