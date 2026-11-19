import { renderHeader, scopeLabel, scopeName } from './header.js';
import { syncAnnouncement, syncRepoName } from './health.js';
import { renderFeed, renderDetail } from './feed.js';
import { renderRepositories } from './repositories.js';
import { renderSettings } from './settings.js';
import { eventIds } from './seen-actions.js';
import { required, setHtml } from './dom.js';
import { emptyHtml, html } from './format.js';

/** @typedef {import('./refresh.js').PageState} PageState */
/** @typedef {import('./navigation.js').ResultsContext} ResultsContext */
/** web.js owns this object: navigation state plus the connection panel state and the refresh flag the header reads. */
/** @typedef {import('./navigation.js').NavigationState & { connection: import('./connection.js').ConnectionState, refreshing?: boolean, savedFilterId: string }} BrowserUi */
/**
 * @typedef {{ restored: ResultsContext | null, returnRoute: string, matchingIds?: string[], commits: import('./activity-detail.js').LoadedView | undefined,
 *   checkouts: Record<string, import('./checkout.js').CheckoutSnapshot>, isCurrent: () => boolean }} RenderOptions
 */
/** web/theme.js publishes this before the modules load. @typedef {Window & { repoPulseTheme?: { apply: () => void } }} ThemedWindow */

/**
 * `syncLive` sits outside the header so re-rendering the header never replaces it.
 * @param {{ page: HTMLElement, header: HTMLElement, demo: HTMLElement, syncLive: HTMLElement, picker: { mount: (element: HTMLElement | null) => void },
 *   typeFilter: { mount: (element: HTMLElement | null) => void }, onPageRendered: () => void }} options
 */
export function createBrowserView({ page, header, demo, syncLive, picker, typeFilter, onPageRendered }) {
  const groupElements = () => [...page.querySelectorAll('details[data-group]')].filter(element => element instanceof HTMLDetailsElement);
  /** @param {string} selector */
  const shown = selector => {
    const element = document.querySelector(selector);
    return element instanceof HTMLElement && !element.hidden;
  };

  /** @returns {[string, boolean][]} */
  function captureGroups() {
    // The selector guarantees data-group, so the fallback never applies.
    return groupElements().map(element => [element.dataset.group ?? '', element.open]);
  }

  /** @param {PageState} state @param {BrowserUi} ui @param {RenderOptions} options */
  function renderPage(state, ui, { restored, returnRoute, matchingIds, commits, checkouts, isCurrent }) {
    const groups = restored?.groups || captureGroups();
    const focused = document.activeElement;
    const focusId = focused && page.contains(focused) ? focused.id : '';
    /** @type {[number | null, number | null] | null} */
    const selection =
      focused instanceof HTMLInputElement && focused.type === 'search' ? [focused.selectionStart, focused.selectionEnd] : null;
    if (ui.route === 'repositories') setHtml(page, renderRepositories(state, ui, checkouts));
    else if (ui.route === 'settings') setHtml(page, renderSettings(state, ui.connection));
    else if (ui.route === 'event' && state.detailLoading && !state.events.some(event => event.id === ui.eventId))
      setHtml(page, html`<div class="card loading" role="status">Loading activity details…</div>`);
    else if (ui.route === 'event')
      setHtml(
        page,
        renderDetail(
          state.events.find(event => event.id === ui.eventId),
          state,
          commits,
          {
            returnRoute,
            matchingIds,
            label: returnRoute === 'activity' ? 'Back to All activity' : 'Back to New updates',
          },
        ),
      );
    else setHtml(page, renderFeed(state, ui));
    const pickerHost = page.querySelector('#repository-picker');
    picker.mount(pickerHost instanceof HTMLElement ? pickerHost : null);
    const typeMenu = page.querySelector('.type-menu');
    typeFilter.mount(typeMenu instanceof HTMLElement ? typeMenu : null);
    for (const [name, open] of groups) {
      groupElements()
        .find(element => element.dataset.group === name)
        ?.toggleAttribute('open', open);
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
    // web/theme.js defines repoPulseTheme on window before the modules load; the optional call covers its absence.
    /** @type {ThemedWindow} */ (window).repoPulseTheme?.apply();
    if (restored) {
      requestAnimationFrame(() => {
        if (!isCurrent()) return;
        const row = [...page.querySelectorAll('li[data-event-id]')].find(
          element => element instanceof HTMLElement && restored.eventId != null && eventIds(element).includes(restored.eventId),
        );
        const title = row?.querySelector('.feed-title');
        if (title instanceof HTMLElement) title.focus({ preventScroll: true });
        window.scrollTo({ top: restored.scrollY, behavior: 'instant' });
      });
    }
  }

  /** @param {boolean} force @param {boolean} interacting @returns {'page' | 'full' | null} */
  function refreshTarget(force, interacting) {
    if (shown('#repo-panel')) return force ? 'page' : null;
    if (force) return 'full';
    const focused = document.activeElement;
    const refreshable =
      focused?.id === 'feed-search' ||
      focused?.id === 'feed-people' ||
      focused?.id === 'kind-toggle' ||
      (focused?.id && focused.matches('.settings-card *, .repo-entry *, .repo-add > summary'));
    const preserve =
      interacting ||
      shown('#kind-panel') ||
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
      const menu = header.querySelector('.header-overflow');
      const menuOpen = menu instanceof HTMLDetailsElement && menu.open;
      setHtml(header, renderHeader(state, ui));
      const sentence = syncAnnouncement(state.syncStatus.overall, syncRepoName(state.repos, state.syncStatus.overall));
      // Writing the same text again would replace the text node and could repeat the announcement.
      if (syncLive.textContent !== sentence) syncLive.textContent = sentence;
      if (menuOpen) required('.header-overflow', HTMLDetailsElement, header).open = true;
      if (focusedId) document.getElementById(focusedId)?.focus({ preventScroll: true });
      // As in renderPage: theme.js runs first, and the optional call covers its absence.
      /** @type {ThemedWindow} */ (window).repoPulseTheme?.apply();
      renderPage(state, ui, options);
      setHtml(
        demo,
        state.demo
          ? html`<div class="banner info notice"><div><strong>Demo mode · fictional repositories and people</strong>No Azure requests are made. This uses an isolated local database. <button class="btn sm" type="button" data-action="demo-event">Simulate incoming hotfix</button></div></div>`
          : emptyHtml,
      );
    },
    /** @param {PageState} state @param {BrowserUi} ui */
    updateScopeLabel(state, ui) {
      const toggle = required('#repo-toggle', HTMLElement, header);
      setHtml(toggle, scopeLabel(state, ui));
      toggle.setAttribute('aria-label', scopeName(state, ui));
    },
  };
}
