import { connectionStatus } from './connection.js';
import { escape as e } from './format.js';

export function renderSettings(state, connection) {
  const { settings, diagnostics = {}, mergeQueue = {} } = state;
  const repoId = state.repos.some(repo => repo.id === connection.repoId) ? connection.repoId : state.repos[0]?.id || '';
  const result = connection.results.get(repoId);
  const local = result?.version || result?.available === false ? result : connection.local;
  const { startsLastMinute, limitPerMinute, running, concurrency, lastError } = diagnostics;
  const { pending = 0, errors = 0 } = mergeQueue;
  const lag = diagnostics.sync?.lag;
  const cli = limitPerMinute
    ? `${e(startsLastMinute)} of ${e(limitPerMinute)} Azure calls in the last minute · ${e(running)} of ${e(concurrency)} in progress`
    : 'No CLI activity to report';
  return `<div class="section-heading"><h1>Settings</h1></div>
    <div class="card settings-card">
      <details data-group="azure-connection">
        <summary class="settings-row connection-heading" id="azure-connection-toggle">
          <span><strong>Azure DevOps connection</strong><span class="help">Uses your existing Azure CLI (az) and Azure DevOps extension.</span></span>
          <span class="help connection-state" role="status">${e(connectionStatus(state, connection, repoId))}</span>
          <span class="settings-chevron" aria-hidden="true"></span>
        </summary>
        <div class="settings-content">
          ${state.demo ? '<p class="help">Demo mode uses fictional data.</p>' : `
          <div class="connection-summary">
            ${state.repos.length ? `<label>Repository <select class="control" id="connection-repo">
              ${state.repos.map(repo => `<option value="${e(repo.id)}" ${repo.id === repoId ? 'selected' : ''}>${e(repo.name)} · ${e(repo.project)}</option>`).join('')}
            </select></label>` : ''}
            <button class="btn sm" type="button" id="check-settings-connection" data-action="check-connection" data-repo-id="${e(repoId)}" ${connection.pending === null ? '' : 'aria-disabled="true"'}>Check connection</button>
          </div>
          ${local?.version ? `<p class="help">Azure CLI ${e(local.version)}${local.extension ? ` · azure-devops ${e(local.extension)}` : ''}</p>` : ''}
          ${local?.account?.name ? `<p class="help">Azure CLI account context · ${e(local.account.name)}</p>` : ''}
          ${result?.access?.message || result?.available === false ? `<p class="help">${e(result.access?.message ?? result.message)}</p>` : ''}
          <p class="help">The connection check reads repository details. CI permissions and local Git upstream access are separate.</p>`}
        </div>
      </details>
      <label class="settings-row settings-toggle" for="refresh-enabled">
        <span><strong id="refresh-label">Automatic checks</strong><span class="help" id="refresh-help">Checks watched branches, pull requests and CI in Azure DevOps. You can still refresh activity manually.</span></span>
        <input class="setting-switch" type="checkbox" role="switch" id="refresh-enabled" data-auto-toggle aria-labelledby="refresh-label" aria-describedby="refresh-help" ${settings.refreshEnabled !== false ? 'checked' : ''}>
      </label>
      <details data-group="troubleshooting">
        <summary class="settings-row" id="troubleshooting-toggle">Troubleshooting <span class="settings-chevron" aria-hidden="true"></span></summary>
        <div class="settings-content">
          <dl class="diagnostic-summary">
            <div><dt>Azure calls</dt><dd>${cli}</dd></div>
            ${lag?.overdueStreams ? `<div><dt>Checks behind</dt><dd>${e(lag.overdueStreams)} checks waiting · up to ${e(Math.round(lag.maxDelayMs / 60000))} min late</dd></div>` : ''}
            <div><dt>Merge checks</dt><dd>${e(pending)} pending${errors ? ` · ${e(errors)} retrying` : ''}</dd></div>
            ${lastError?.message ? `<div><dt>Last CLI issue</dt><dd>${e(lastError.message)}</dd></div>` : ''}
          </dl>
          <p class="help">Activity reads are single Azure DevOps requests. Connection checks start the Azure CLI, which can make several requests.</p>
          <button class="btn sm" type="button" id="copy-diagnostics" data-action="copy-diagnostics">Copy diagnostics</button>
        </div>
      </details>
      <details data-group="coverage">
        <summary class="settings-row" id="coverage-toggle">What Repo Pulse tracks <span class="settings-chevron" aria-hidden="true"></span></summary>
        <div class="settings-content help">
          <p>Repo Pulse reads remote branches, pushes, pull requests, and CI runs for the primary repository. It stores the results locally.</p>
          <p>Initial history covers about seven days plus older active items. All activity includes imported history. Polling can miss changes between checks.</p>
          <p>A successful build or merged pull request does not confirm deployment.</p>
        </div>
      </details>
    </div>`;
}
