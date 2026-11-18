import { renderHeader, scopeLabel, scopeName } from './header.js';
import { renderFeed, renderDetail } from './feed.js';
import { renderRepositories } from './repositories.js';
import { renderSettings } from './settings.js';
import { eventIds } from './seen-actions.js';

export function createBrowserView({ page, header, demo, picker, typeFilter, onPageRendered }) {
  function captureGroups() {
    return [...page.querySelectorAll('details[data-group]')].map(element => [element.dataset.group, element.open]);
  }

  function renderPage(state, ui, { restored, returnRoute, commits, checkouts, isCurrent }) {
    const groups = restored?.groups || captureGroups();
    const focused = document.activeElement;
    const focusId = page.contains(focused) ? focused.id : '';
    const selection = focused instanceof HTMLInputElement && focused.type === 'search' ? [focused.selectionStart, focused.selectionEnd] : null;
    if (ui.route === 'repositories') page.innerHTML = renderRepositories(state, ui, checkouts);
    else if (ui.route === 'settings') page.innerHTML = renderSettings(state, ui.connection);
    else if (ui.route === 'event' && state.detailLoading && !state.events.some(event => event.id === ui.eventId)) page.innerHTML = '<div class="card loading" role="status">Loading activity details…</div>';
    else if (ui.route === 'event') page.innerHTML = renderDetail(state.events.find(event => event.id === ui.eventId), state, commits, {
      returnRoute, label: returnRoute === 'activity' ? 'Back to All activity' : 'Back to New updates',
    });
    else page.innerHTML = renderFeed(state, ui);
    picker.mount(page.querySelector('#repository-picker'));
    typeFilter.mount(page.querySelector('.type-menu'));
    for (const [name, open] of groups) {
      [...page.querySelectorAll('details[data-group]')].find(element => element.dataset.group === name)?.toggleAttribute('open', open);
    }
    if (focusId) {
      const current = document.getElementById(focusId);
      const replacement = current?.disabled && current.matches('[data-action="open-history-import"]')
        ? document.getElementById(`history-${current.dataset.id}`) : current;
      replacement?.focus({ preventScroll: true });
      if (selection && replacement instanceof HTMLInputElement) replacement.setSelectionRange(...selection);
    }
    onPageRendered();
    window.repoPulseTheme?.apply();
    if (restored) {
      requestAnimationFrame(() => {
        if (!isCurrent()) return;
        const row = [...page.querySelectorAll('li[data-event-id]')].find(element => eventIds(element).includes(restored.eventId));
        row?.querySelector('.feed-title')?.focus({ preventScroll: true });
        window.scrollTo({ top: restored.scrollY, behavior: 'instant' });
      });
    }
  }

  function refreshTarget(force, interacting) {
    if (document.querySelector('#repo-panel')?.hidden === false) return force ? 'page' : null;
    if (force) return 'full';
    const focused = document.activeElement;
    const refreshable = focused?.id === 'feed-search' || focused?.id === 'kind-toggle' ||
      focused?.id && focused.matches('.settings-card *, .repo-entry *, .repo-add > summary');
    const preserve = interacting ||
      document.querySelector('#kind-panel')?.hidden === false ||
      !refreshable && (['INPUT', 'SELECT', 'TEXTAREA'].includes(focused?.tagName) ||
      page.contains(focused) && focused !== document.body);
    return preserve ? null : 'full';
  }

  return {
    captureGroups,
    refreshTarget,
    renderPage,
    render(state, ui, options) {
      const focusedId = header.contains(document.activeElement) ? document.activeElement.id : '';
      const menuOpen = header.querySelector('.header-overflow')?.open;
      header.innerHTML = renderHeader(state, ui);
      if (menuOpen) header.querySelector('.header-overflow').open = true;
      if (focusedId) document.getElementById(focusedId)?.focus({ preventScroll: true });
      window.repoPulseTheme?.apply();
      renderPage(state, ui, options);
      demo.innerHTML = state.demo ? '<div class="banner info notice"><div><strong>Demo mode · fictional repositories and people</strong>No Azure requests are made. This uses an isolated local database. <button class="btn sm" type="button" data-action="demo-event">Simulate incoming hotfix</button></div></div>' : '';
    },
    updateScopeLabel(state, ui) {
      const toggle = header.querySelector('#repo-toggle');
      toggle.innerHTML = scopeLabel(state, ui);
      toggle.setAttribute('aria-label', scopeName(state, ui));
    },
  };
}
