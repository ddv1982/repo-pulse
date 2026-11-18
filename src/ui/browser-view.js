import { renderHeader, scopeLabel, scopeName } from './header.js';
import { renderFeed, renderDetail } from './feed.js';
import { renderRepositories } from './repositories.js';
import { renderSettings } from './settings.js';
import { eventIds } from './seen-actions.js';
import { required } from './dom.js';

/** @typedef {import('./refresh.js').PageState} PageState */
/** @typedef {import('./navigation.js').ResultsContext} ResultsContext */
/** web.js owns this object: navigation state plus the connection panel state and the refresh flag the header reads. */
/** @typedef {import('./navigation.js').NavigationState & { connection: import('./connection.js').ConnectionState, refreshing?: boolean }} BrowserUi */
/**
 * @typedef {{ restored: ResultsContext | null, returnRoute: string, commits: import('./activity-detail.js').CommitsView | undefined,
 *   checkouts: Record<string, import('./checkout.js').CheckoutSnapshot>, isCurrent: () => boolean }} RenderOptions
 */
/** web/theme.js publishes this before the modules load. @typedef {Window & { repoPulseTheme?: { apply: () => void } }} ThemedWindow */

/**
 * @param {{ page: HTMLElement, header: HTMLElement, demo: HTMLElement, picker: { mount: (element: HTMLElement | null) => void },
 *   typeFilter: { mount: (element: HTMLElement | null) => void }, onPageRendered: () => void }} options
 */
export function createBrowserView({ page, header, demo, picker, typeFilter, onPageRendered }) {
  const groupElements = () => /** @type {NodeListOf<HTMLDetailsElement>} */ (page.querySelectorAll('details[data-group]'));

  /** @returns {[string, boolean][]} */
  function captureGroups() {
    // The selector guarantees data-group, so the fallback never applies.
    return [...groupElements()].map(element => [element.dataset.group ?? '', element.open]);
  }

  /** @param {PageState} state @param {BrowserUi} ui @param {RenderOptions} options */
  function renderPage(state, ui, { restored, returnRoute, commits, checkouts, isCurrent }) {
    const groups = restored?.groups || captureGroups();
    const focused = document.activeElement;
    const focusId = focused && page.contains(focused) ? focused.id : '';
    /** @type {[number | null, number | null] | null} */
    const selection =
      focused instanceof HTMLInputElement && focused.type === 'search' ? [focused.selectionStart, focused.selectionEnd] : null;
    if (ui.route === 'repositories') page.innerHTML = renderRepositories(state, ui, checkouts);
    else if (ui.route === 'settings') page.innerHTML = renderSettings(state, ui.connection);
    else if (ui.route === 'event' && state.detailLoading && !state.events.some(event => event.id === ui.eventId))
      page.innerHTML = '<div class="card loading" role="status">Loading activity details…</div>';
    else if (ui.route === 'event')
      page.innerHTML = renderDetail(
        state.events.find(event => event.id === ui.eventId),
        state,
        commits,
        {
          returnRoute,
          label: returnRoute === 'activity' ? 'Back to All activity' : 'Back to New updates',
        },
      );
    else page.innerHTML = renderFeed(state, ui);
    const pickerHost = page.querySelector('#repository-picker');
    picker.mount(pickerHost instanceof HTMLElement ? pickerHost : null);
    const typeMenu = page.querySelector('.type-menu');
    typeFilter.mount(typeMenu instanceof HTMLElement ? typeMenu : null);
    for (const [name, open] of groups) {
      [...groupElements()].find(element => element.dataset.group === name)?.toggleAttribute('open', open);
    }
    if (focusId) {
      const current = document.getElementById(focusId);
      const replacement =
        current instanceof HTMLButtonElement && current.disabled && current.matches('[data-action="open-history-import"]')
          ? document.getElementById(`history-${current.dataset.id}`)
          : current;
      replacement?.focus({ preventScroll: true });
      if (selection && replacement instanceof HTMLInputElement) replacement.setSelectionRange(...selection);
    }
    onPageRendered();
    /** @type {ThemedWindow} */ (window).repoPulseTheme?.apply();
    if (restored) {
      requestAnimationFrame(() => {
        if (!isCurrent()) return;
        const row = [.../** @type {NodeListOf<HTMLElement>} */ (page.querySelectorAll('li[data-event-id]'))].find(
          element => restored.eventId != null && eventIds(element).includes(restored.eventId),
        );
        /** @type {HTMLElement | null | undefined} */ (row?.querySelector('.feed-title'))?.focus({ preventScroll: true });
        window.scrollTo({ top: restored.scrollY, behavior: 'instant' });
      });
    }
  }

  /** @param {boolean} force @param {boolean} interacting @returns {'page' | 'full' | null} */
  function refreshTarget(force, interacting) {
    if (/** @type {HTMLElement | null} */ (document.querySelector('#repo-panel'))?.hidden === false) return force ? 'page' : null;
    if (force) return 'full';
    const focused = document.activeElement;
    const refreshable =
      focused?.id === 'feed-search' ||
      focused?.id === 'kind-toggle' ||
      (focused?.id && focused.matches('.settings-card *, .repo-entry *, .repo-add > summary'));
    const preserve =
      interacting ||
      /** @type {HTMLElement | null} */ (document.querySelector('#kind-panel'))?.hidden === false ||
      (!refreshable &&
        (['INPUT', 'SELECT', 'TEXTAREA'].includes(focused?.tagName ?? '') || (page.contains(focused) && focused !== document.body)));
    return preserve ? null : 'full';
  }

  return {
    captureGroups,
    refreshTarget,
    renderPage,
    /** @param {PageState} state @param {BrowserUi} ui @param {RenderOptions} options */
    render(state, ui, options) {
      const active = document.activeElement;
      const focusedId = active && header.contains(active) ? active.id : '';
      const menuOpen = /** @type {HTMLDetailsElement | null} */ (header.querySelector('.header-overflow'))?.open;
      header.innerHTML = renderHeader(state, ui);
      if (menuOpen) required('.header-overflow', HTMLDetailsElement, header).open = true;
      if (focusedId) document.getElementById(focusedId)?.focus({ preventScroll: true });
      /** @type {ThemedWindow} */ (window).repoPulseTheme?.apply();
      renderPage(state, ui, options);
      demo.innerHTML = state.demo
        ? '<div class="banner info notice"><div><strong>Demo mode · fictional repositories and people</strong>No Azure requests are made. This uses an isolated local database. <button class="btn sm" type="button" data-action="demo-event">Simulate incoming hotfix</button></div></div>'
        : '';
    },
    /** @param {PageState} state @param {BrowserUi} ui */
    updateScopeLabel(state, ui) {
      const toggle = required('#repo-toggle', HTMLElement, header);
      toggle.innerHTML = scopeLabel(state, ui);
      toggle.setAttribute('aria-label', scopeName(state, ui));
    },
  };
}
