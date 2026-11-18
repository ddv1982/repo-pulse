import { escape as e, dateTime } from './format.js';
import { icons, themeSwitch } from './icons.js';
import { activityHref, isActivity } from './navigation.js';

function selectedRepos(state, ui) {
  return state.repos.filter(repo => ui.repoIds === null || ui.repoIds.includes(repo.id));
}

export function scopeName(state, ui) {
  const count = ui.repoIds === null ? state.repos.length : selectedRepos(state, ui).length;
  return `${ui.repoIds === null ? 'All ' : ''}${count} repositor${count === 1 ? 'y' : 'ies'}${ui.repoIds === null ? '' : ' shown'}`;
}

export function scopeLabel(state, ui) {
  const selected = selectedRepos(state, ui);
  return `<span class="scope-label-long">${e(scopeName(state, ui))}</span><span class="scope-label-short" aria-hidden="true">${selected.length} repo${selected.length === 1 ? '' : 's'}</span> ▾`;
}

export function renderHeader(state, ui) {
  const streamTimes = state.streams
    .map(stream => stream.lastSuccess)
    .filter(Boolean)
    .map(value => new Date(value).valueOf())
    .filter(Number.isFinite);
  const automatic = state.settings.refreshEnabled !== false;
  const freshness = streamTimes.length ? `Last Azure check ${dateTime(Math.max(...streamTimes))}` : 'No Azure check yet';
  const switchInput = suffix => `<input class="setting-switch" type="checkbox" role="switch" id="header-auto-${suffix}" data-auto-toggle
    aria-label="Automatic checks" ${automatic ? 'checked' : ''}>`;
  const refreshTitle = e(`Refresh activity across selected repositories. ${freshness}`);
  const refresh = suffix => `<button type="button" class="${suffix === 'mobile' ? 'ghost mobile-refresh' : 'monitor-refresh'}"
    id="header-refresh-${suffix}" data-action="refresh"
    aria-label="Refresh activity" aria-busy="${Boolean(ui.refreshing)}" aria-disabled="${Boolean(ui.refreshing)}"
    data-idle-title="${refreshTitle}" title="${ui.refreshing ? 'Refreshing activity…' : refreshTitle}">
    ${icons.refresh}${suffix === 'mobile' ? '<span>Refresh activity</span>' : ''}</button>`;
  return `<div class="hg header-brand"><a class="brand" href="#activity/new" style="text-decoration:none">Repo Pulse</a><div class="menu"><button class="control" id="repo-toggle" type="button" aria-expanded="false" aria-controls="repo-panel" aria-label="${e(scopeName(state, ui))}" title="Changing visible repositories marks nothing seen">${scopeLabel(state, ui)}</button><div class="menu-panel" id="repo-panel" role="group" aria-label="Repositories shown" hidden>${state.repos.map(repo => `<label class="opt"><input type="checkbox" data-scope-repo="${e(repo.id)}" ${ui.repoIds === null || ui.repoIds.includes(repo.id) ? 'checked' : ''}><b>${e(repo.name)}</b><small>${e(repo.project)}</small></label>`).join('') || '<p class="help" style="padding:8px">Add repositories to begin watching.</p>'}<div class="mfoot"><span>Scope changes mark nothing seen.</span><button class="ghost sm" type="button" data-action="all-repos">All</button><button class="ghost sm" type="button" data-action="no-repos">None</button></div></div></div></div>
    <nav class="seg tabs" aria-label="Main">
      <a href="${activityHref(ui.activityRoute)}" ${isActivity(ui.route) || ui.route === 'event' ? 'aria-current="page"' : ''}>Activity</a>
      <a href="#repositories" ${ui.route === 'repositories' ? 'aria-current="page"' : ''}>Repositories</a>
      <a href="#settings" ${ui.route === 'settings' ? 'aria-current="page"' : ''}>Settings</a>
    </nav>
    <div class="hg end header-tools">
      <span class="fresh">${e(freshness)}</span>
      <div class="hg header-actions">
        <div class="seg monitor-group" role="group" aria-label="Monitoring">
          <label class="header-auto" for="header-auto-desktop">${switchInput('desktop')}<span>Auto checks</span></label>
          ${refresh('desktop')}
        </div>
        <details class="header-overflow">
          <summary class="ghost monitor-trigger" id="header-monitoring" aria-label="Checks: automatic ${automatic ? 'on' : 'off'}">${icons.pulse}${automatic ? '<span class="monitor-dot" aria-hidden="true"></span>' : ''}</summary>
          <div class="menu-panel header-monitoring-menu">
            <label class="settings-row settings-toggle" for="header-auto-mobile">
              <span>Automatic checks<span class="help">${automatic ? 'Every 2–5 minutes' : 'Off · refresh manually'}</span></span>
              ${switchInput('mobile')}
            </label>
            ${refresh('mobile')}
            <p class="help monitor-footer">${e(freshness)}</p>
          </div>
        </details>
        ${themeSwitch()}
      </div>
    </div>`;
}
