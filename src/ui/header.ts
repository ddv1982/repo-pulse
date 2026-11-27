import { emptyHtml, html } from './format.ts';
import { syncPill, syncRepoName } from './health.ts';
import { icons, themeSwitch } from './icons.ts';
import { activityHref, isActivity } from './navigation.ts';

type HeaderState = Pick<import('./refresh.ts').PageState, 'repos' | 'settings' | 'syncStatus'>;
/** web.ts sets `refreshing` while a refresh runs; `headerMenuOpen` while the phone check menu is open. */
type HeaderView = Pick<import('./navigation.ts').NavigationState, 'route' | 'unreadOnly'> & {
  refreshing?: boolean;
  headerMenuOpen?: boolean;
};

export function renderHeader(state: HeaderState, ui: HeaderView) {
  const automatic = state.settings.refreshEnabled;
  const pill = syncPill(state.syncStatus.overall, syncRepoName(state.repos, state.syncStatus.overall));
  const switchInput = (
    suffix: 'desktop' | 'mobile',
  ) => html`<input class="setting-switch" type="checkbox" role="switch" id="header-auto-${suffix}" data-auto-toggle
    aria-label="Automatic checks" ${automatic ? html`checked` : emptyHtml}>`;
  const refreshTitle = 'Refresh activity for the repositories shown in Activity.';
  const refresh = (
    suffix: 'desktop' | 'mobile',
  ) => html`<button type="button" class="${suffix === 'mobile' ? 'ghost mobile-refresh' : 'monitor-refresh'}"
    id="header-refresh-${suffix}" data-action="refresh"
    aria-label="Refresh activity" aria-busy="${Boolean(ui.refreshing)}" aria-disabled="${Boolean(ui.refreshing)}"
    data-idle-title="${refreshTitle}" title="${ui.refreshing ? 'Refreshing activity…' : refreshTitle}">
    ${icons.refresh}${suffix === 'mobile' ? html`<span>Refresh activity</span>` : emptyHtml}</button>`;
  const current = html`aria-current="page"`;
  return html`<div class="hg header-brand"><a class="brand" href="${activityHref(false)}">Repo Pulse</a></div>
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
        <details class="header-overflow" ${ui.headerMenuOpen ? html`open` : emptyHtml}>
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
