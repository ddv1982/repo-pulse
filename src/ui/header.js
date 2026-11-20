// @ts-check

import { emptyHtml, html } from './format.js';
import { syncPill, syncRepoName } from './health.js';
import { icons, themeSwitch } from './icons.js';
import { activityHref, isActivity } from './navigation.js';

/** @typedef {Pick<import('./refresh.js').PageState, 'repos'>} ScopeState */
/** @typedef {ScopeState & Pick<import('./refresh.js').PageState, 'settings' | 'syncStatus'>} HeaderState */
/** @typedef {Pick<import('./navigation.js').NavigationState, 'repoIds'>} ScopeView */
/** web.js sets `refreshing` while a refresh runs. @typedef {ScopeView & Pick<import('./navigation.js').NavigationState, 'route' | 'activityRoute'> & { refreshing?: boolean }} HeaderView */

/** @param {ScopeState} state @param {ScopeView} ui */
function selectedRepos(state, ui) {
  return state.repos.filter(repo => ui.repoIds === null || ui.repoIds.includes(repo.id));
}

/** @param {ScopeState} state @param {ScopeView} ui */
export function scopeName(state, ui) {
  const count = ui.repoIds === null ? state.repos.length : selectedRepos(state, ui).length;
  return `${ui.repoIds === null ? 'All ' : ''}${count} repositor${count === 1 ? 'y' : 'ies'}${ui.repoIds === null ? '' : ' shown'}`;
}

/** @param {ScopeState} state @param {ScopeView} ui */
export function scopeLabel(state, ui) {
  const selected = selectedRepos(state, ui);
  return html`<span class="scope-label-long">${scopeName(state, ui)}</span><span class="scope-label-short" aria-hidden="true">${selected.length} repo${selected.length === 1 ? '' : 's'}</span> ▾`;
}

/** @param {HeaderState} state @param {HeaderView} ui */
export function renderHeader(state, ui) {
  const automatic = state.settings.refreshEnabled !== false;
  const pill = syncPill(state.syncStatus.overall, syncRepoName(state.repos, state.syncStatus.overall));
  const switchInput = (
    /** @type {'desktop' | 'mobile'} */ suffix,
  ) => html`<input class="setting-switch" type="checkbox" role="switch" id="header-auto-${suffix}" data-auto-toggle
    aria-label="Automatic checks" ${automatic ? html`checked` : emptyHtml}>`;
  const refreshTitle = 'Refresh activity across selected repositories.';
  const refresh = (
    /** @type {'desktop' | 'mobile'} */ suffix,
  ) => html`<button type="button" class="${suffix === 'mobile' ? 'ghost mobile-refresh' : 'monitor-refresh'}"
    id="header-refresh-${suffix}" data-action="refresh"
    aria-label="Refresh activity" aria-busy="${Boolean(ui.refreshing)}" aria-disabled="${Boolean(ui.refreshing)}"
    data-idle-title="${refreshTitle}" title="${ui.refreshing ? 'Refreshing activity…' : refreshTitle}">
    ${icons.refresh}${suffix === 'mobile' ? html`<span>Refresh activity</span>` : emptyHtml}</button>`;
  const current = html`aria-current="page"`;
  const repoOptions = state.repos.length
    ? state.repos.map(
        repo =>
          html`<label class="opt"><input type="checkbox" data-scope-repo="${repo.id}" ${ui.repoIds === null || ui.repoIds.includes(repo.id) ? html`checked` : emptyHtml}><b>${repo.name}</b><small>${repo.project}</small></label>`,
      )
    : html`<p class="help" style="padding:8px">Add repositories to begin watching.</p>`;
  return html`<div class="hg header-brand"><a class="brand" href="#activity/new" style="text-decoration:none">Repo Pulse</a><div class="menu"><button class="control" id="repo-toggle" type="button" aria-expanded="false" aria-controls="repo-panel" aria-label="${scopeName(state, ui)}" title="Changing visible repositories marks nothing seen">${scopeLabel(state, ui)}</button><div class="menu-panel" id="repo-panel" role="group" aria-label="Repositories shown" hidden>${repoOptions}<div class="mfoot"><span>Scope changes mark nothing seen.</span><button class="ghost sm" type="button" data-action="all-repos">All</button><button class="ghost sm" type="button" data-action="no-repos">None</button></div></div></div></div>
    <nav class="seg tabs" aria-label="Main">
      <a href="${activityHref(ui.activityRoute)}" ${isActivity(ui.route) || ui.route === 'event' ? current : emptyHtml}>Activity</a>
      <a href="#repositories" ${ui.route === 'repositories' ? current : emptyHtml}>Repositories</a>
      <a href="#settings" ${ui.route === 'settings' ? current : emptyHtml}>Settings</a>
    </nav>
    <div class="hg end header-tools">
      ${pill}
      <div class="hg header-actions">
        <div class="seg monitor-group" role="group" aria-label="Monitoring">
          <label class="header-auto" for="header-auto-desktop">${switchInput('desktop')}<span>Automatic checks</span></label>
          ${refresh('desktop')}
        </div>
        <details class="header-overflow">
          <summary class="ghost monitor-trigger" id="header-monitoring" aria-label="Checks: automatic ${automatic ? 'on' : 'off'}">${icons.pulse}${automatic ? html`<span class="monitor-dot" aria-hidden="true"></span>` : emptyHtml}</summary>
          <div class="menu-panel header-monitoring-menu">
            <label class="settings-row settings-toggle" for="header-auto-mobile">
              <span>Automatic checks<span class="help">${automatic ? 'Every 2–5 minutes' : 'Off · refresh manually'}</span></span>
              ${switchInput('mobile')}
            </label>
            ${refresh('mobile')}
            <p class="monitor-footer">${pill}</p>
          </div>
        </details>
        ${themeSwitch()}
      </div>
    </div>`;
}
