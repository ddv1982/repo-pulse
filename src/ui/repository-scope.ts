import { emptyHtml, html } from './format.ts';
import { createToolbarMenu } from './toolbar-menu.ts';
import type { MenuManager } from './menus.ts';

type ScopeState = Pick<import('./refresh.ts').PageState, 'repos'>;
/** `openMenu` is `repo-panel` while the scope panel is open. */
type ScopeView = Pick<import('./navigation.ts').NavigationState, 'repoIds'> & { openMenu?: string };

export function scopeName(state: ScopeState, ui: ScopeView) {
  const count = ui.repoIds === null ? state.repos.length : state.repos.filter(repo => ui.repoIds?.includes(repo.id)).length;
  return `${ui.repoIds === null && count > 1 ? 'All ' : ''}${count} repositor${count === 1 ? 'y' : 'ies'}${ui.repoIds === null ? '' : ' shown'}`;
}

/** The repositories Activity shows. Saved filters store this scope, and refresh checks it on every page. */
export function renderRepositoryScope(state: ScopeState, ui: ScopeView) {
  const open = ui.openMenu === 'repo-panel';
  const name = scopeName(state, ui);
  const options = state.repos.length
    ? state.repos.map(
        repo =>
          html`<label class="opt"><input type="checkbox" id="scope-${repo.id}" data-scope-repo="${repo.id}" ${ui.repoIds === null || ui.repoIds.includes(repo.id) ? html`checked` : emptyHtml}><b>${repo.name}</b><small>${repo.project}</small></label>`,
      )
    : html`<p class="help menu-empty">Add repositories to begin watching.</p>`;
  return html`<div class="menu scope-menu"><button class="control" id="repo-toggle" type="button" data-active="${ui.repoIds !== null}" aria-expanded="${open}" aria-controls="repo-panel" aria-label="${name}" title="Changing visible repositories marks nothing seen">${name} ▾</button><div class="menu-panel scope-panel" id="repo-panel" role="group" aria-label="Repositories shown" ${open ? emptyHtml : html`hidden`}><div class="scope-options">${options}</div><div class="mfoot"><span>Scope changes mark nothing seen.</span><button class="ghost sm" type="button" data-action="all-repos">All</button><button class="ghost sm" type="button" data-action="no-repos">None</button></div></div></div>`;
}

export function createRepositoryScope(menus: MenuManager) {
  return createToolbarMenu({ menus, toggleId: 'repo-toggle', panelId: 'repo-panel', itemSelector: '[data-scope-repo]' });
}
