import { emptyHtml, html } from './format.ts';
import { syncPill, syncRepoName } from './health.ts';
import { icons, themeSwitch } from './icons.ts';
import { activityHref, isActivity } from './navigation.ts';

export type ScopeState = Pick<import('./refresh.ts').PageState, 'repos'>;
export type HeaderState = ScopeState & Pick<import('./refresh.ts').PageState, 'settings' | 'syncStatus'>;
export type ScopeView = Pick<import('./navigation.ts').NavigationState, 'repoIds'>;
/** web.ts sets `refreshing` while a refresh runs; `openMenu` is `repo-panel` while the scope panel is open. */
export type HeaderView = ScopeView &
  Pick<import('./navigation.ts').NavigationState, 'route' | 'unreadOnly'> & { refreshing?: boolean; openMenu?: string };

function selectedRepos(state: ScopeState, ui: ScopeView) {
  return state.repos.filter(repo => ui.repoIds === null || ui.repoIds.includes(repo.id));
}

export function scopeName(state: ScopeState, ui: ScopeView) {
  const count = ui.repoIds === null ? state.repos.length : selectedRepos(state, ui).length;
  return `${ui.repoIds === null && count > 1 ? 'All ' : ''}${count} repositor${count === 1 ? 'y' : 'ies'}${ui.repoIds === null ? '' : ' shown'}`;
}

export function scopeLabel(state: ScopeState, ui: ScopeView) {
  const selected = selectedRepos(state, ui);
  return html`<span class="scope-label-long">${scopeName(state, ui)}</span><span class="scope-label-short" aria-hidden="true">${selected.length} repo${selected.length === 1 ? '' : 's'}</span> ▾`;
}

export function renderHeader(state: HeaderState, ui: HeaderView) {
  const automatic = state.settings.refreshEnabled !== false;
  const pill = syncPill(state.syncStatus.overall, syncRepoName(state.repos, state.syncStatus.overall));
  const switchInput = (
    suffix: 'desktop' | 'mobile',
  ) => html`<input class="setting-switch" type="checkbox" role="switch" id="header-auto-${suffix}" data-auto-toggle
    aria-label="Automatic checks" ${automatic ? html`checked` : emptyHtml}>`;
  const refreshTitle = 'Refresh activity across selected repositories.';
  const refresh = (
    suffix: 'desktop' | 'mobile',
  ) => html`<button type="button" class="${suffix === 'mobile' ? 'ghost mobile-refresh' : 'monitor-refresh'}"
    id="header-refresh-${suffix}" data-action="refresh"
    aria-label="Refresh activity" aria-busy="${Boolean(ui.refreshing)}" aria-disabled="${Boolean(ui.refreshing)}"
    data-idle-title="${refreshTitle}" title="${ui.refreshing ? 'Refreshing activity…' : refreshTitle}">
    ${icons.refresh}${suffix === 'mobile' ? html`<span>Refresh activity</span>` : emptyHtml}</button>`;
  const current = html`aria-current="page"`;
  const repoOptions = state.repos.length
    ? state.repos.map(
        repo =>
          html`<label class="opt"><input type="checkbox" id="scope-${repo.id}" data-scope-repo="${repo.id}" ${ui.repoIds === null || ui.repoIds.includes(repo.id) ? html`checked` : emptyHtml}><b>${repo.name}</b><small>${repo.project}</small></label>`,
      )
    : html`<p class="help menu-empty">Add repositories to begin watching.</p>`;
  return html`<div class="hg header-brand"><a class="brand" href="${activityHref(false)}">Repo Pulse</a><div class="menu"><button class="control" id="repo-toggle" type="button" aria-expanded="${ui.openMenu === 'repo-panel'}" aria-controls="repo-panel" aria-label="${scopeName(state, ui)}" title="Changing visible repositories marks nothing seen">${scopeLabel(state, ui)}</button><div class="menu-panel" id="repo-panel" role="group" aria-label="Repositories shown" ${ui.openMenu === 'repo-panel' ? emptyHtml : html`hidden`}>${repoOptions}<div class="mfoot"><span>Scope changes mark nothing seen.</span><button class="ghost sm" type="button" data-action="all-repos">All</button><button class="ghost sm" type="button" data-action="no-repos">None</button></div></div></div></div>
    <nav class="seg tabs" aria-label="Main">
      <a href="${activityHref(ui.unreadOnly)}" ${isActivity(ui.route) || ui.route === 'event' ? current : emptyHtml}>Activity</a>
      <a href="#graph" ${ui.route === 'graph' ? current : emptyHtml}>Git Graph</a>
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
              <span>Automatic checks<span class="help">${automatic ? 'Every 3–5 minutes' : 'Off · refresh manually'}</span></span>
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
