import { renderHeader, scopeLabel, scopeName } from './header.ts';
import { syncAnnouncement, syncRepoName } from './health.ts';
import { renderFeed, renderDetail } from './feed.ts';
import { renderRepositories } from './repositories.ts';
import { renderSettings } from './settings.ts';
import { eventIds } from './seen-actions.ts';
import { required, setHtml } from './dom.ts';
import { emptyHtml, html, type SafeHtml } from './format.ts';
import type { PageState } from './refresh.ts';
import type { ResultsContext, NavigationState } from './navigation.ts';

export function replacementFocus(id: string) {
  const current = document.getElementById(id);
  if (current instanceof HTMLButtonElement && current.disabled && current.matches('[data-action="open-history-import"]'))
    return document.getElementById(`history-${current.dataset.id}`);
  // A control the render hid, such as an option of a menu that closed, cannot take focus back.
  if (current?.checkVisibility()) return current;
  if (id === 'clear-filters') return document.getElementById('feed-search');
  if (id.startsWith('kind-option-') || id.startsWith('summary-ci-')) return document.getElementById('kind-toggle');
  if (id.startsWith('saved-filter-option-'))
    return document.getElementById('saved-filter-toggle') ?? document.getElementById('save-filter');
  if (['saved-filter-toggle', 'saved-filter-actions-toggle', 'update-filter', 'save-filter'].includes(id))
    return document.getElementById('saved-filter-toggle') ?? document.getElementById('save-filter');
  return null;
}

/**
 * Focus the control that had focus, or a neighbour of a Seen toggle whose row left. A neighbour can sit off screen,
 * so focusing it may scroll; the same control stays where it was.
 */
function restoreFocus(id: string, neighbours: string[]) {
  const same = replacementFocus(id);
  const neighbour = same ? null : neighbours.map(other => document.getElementById(other)).find(element => element instanceof HTMLElement);
  const replacement = same ?? neighbour ?? null;
  replacement?.focus({ preventScroll: !neighbour });
  return replacement;
}

/**
 * A row's Seen toggle can leave with its row (Unread only). Its neighbours, nearest first and following rows before
 * earlier ones, take focus in that case.
 */
function seenToggleNeighbours(element: HTMLElement) {
  if (!element.matches('.seen-toggle')) return [];
  const toggles = [...(element.closest('ul.rows')?.querySelectorAll('.seen-toggle') ?? [])];
  const index = toggles.indexOf(element);
  return [...toggles.slice(index + 1), ...toggles.slice(0, index).reverse()].map(toggle => toggle.id);
}

function focusedControlId(element: Element) {
  return element.id || element.closest('.saved-filter-menu, .saved-filter-actions')?.querySelector('[aria-expanded]')?.id || '';
}

export type { PageState, ResultsContext };

/** web.ts owns this object: navigation state plus the connection panel state and the refresh flag the header reads. */
export type BrowserUi = NavigationState & {
  connection: import('./connection.ts').ConnectionState;
  refreshing?: boolean;
  openMenu?: string;
};
export type RenderOptions = {
  restored: ResultsContext | null;
  returnUnreadOnly: boolean;
  matchingIds?: string[] | undefined;
  commits: import('./activity-detail.ts').LoadedView | undefined;
  feedCommits?: ReadonlyMap<string, import('./activity-detail.ts').CommitsView>;
  graph?: SafeHtml;
  checkouts: Record<string, import('./checkout.ts').CheckoutSnapshot>;
  checkoutFocus?: string | null | undefined;
  isCurrent: () => boolean;
};
/** web/theme.ts publishes this before the modules load. */
export type ThemedWindow = Window & { repoPulseTheme?: { apply: () => void } };

/**
 * `syncLive` sits outside the header so re-rendering the header never replaces it.
 */
export function createBrowserView({
  page,
  header,
  demo,
  syncLive,
  picker,
  toolbarMenus,
}: {
  page: HTMLElement;
  header: HTMLElement;
  demo: HTMLElement;
  syncLive: HTMLElement;
  picker: { mount: (element: HTMLElement | null) => void };
  toolbarMenus: Record<string, { mount: (element: HTMLElement | null) => void }>;
}) {
  const groupElements = () => [...page.querySelectorAll('details[data-group]')].filter(element => element instanceof HTMLDetailsElement);

  function captureGroups(): [string, boolean][] {
    // The selector guarantees data-group, so the fallback never applies.
    return groupElements().map(element => [element.dataset.group ?? '', element.open]);
  }

  function renderPage(
    state: PageState,
    ui: BrowserUi,
    { restored, returnUnreadOnly, matchingIds, commits, feedCommits, graph, checkouts, checkoutFocus, isCurrent }: RenderOptions,
  ) {
    const groups = restored?.groups || captureGroups();
    const focused = document.activeElement;
    const focusId = focused && page.contains(focused) ? focusedControlId(focused) : '';
    const neighbours = focused instanceof HTMLElement && page.contains(focused) ? seenToggleNeighbours(focused) : [];
    if (ui.route === 'repositories') setHtml(page, renderRepositories(state, ui, checkouts));
    else if (ui.route === 'graph') setHtml(page, graph ?? emptyHtml);
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
            returnUnreadOnly,
            matchingIds,
            checkouts,
          },
        ),
      );
    else setHtml(page, renderFeed(state, ui, feedCommits));
    const pickerHost = page.querySelector('#repository-picker');
    picker.mount(pickerHost instanceof HTMLElement ? pickerHost : null);
    for (const [selector, menu] of Object.entries(toolbarMenus)) {
      const host = page.querySelector(selector);
      menu.mount(host instanceof HTMLElement ? host : null);
    }
    for (const [name, open] of groups) {
      groupElements()
        .find(element => element.dataset.group === name)
        ?.toggleAttribute('open', open);
    }
    // A control that survived the render keeps focus; one that left, or that the render hid (a closed menu's option),
    // needs a replacement.
    if (focusId && (document.activeElement !== focused || !focused?.checkVisibility())) restoreFocus(focusId, neighbours);
    // web/theme.ts defines repoPulseTheme on window before the modules load; the optional call covers its absence.
    (window as ThemedWindow).repoPulseTheme?.apply();
    if (checkoutFocus) {
      requestAnimationFrame(() => {
        if (!isCurrent()) return;
        const checkout = document.getElementById(`checkout-state-${checkoutFocus}`);
        checkout?.scrollIntoView({ block: 'center' });
        checkout?.focus({ preventScroll: true });
      });
    }
    if (restored) {
      requestAnimationFrame(() => {
        if (!isCurrent()) return;
        const row = [...page.querySelectorAll('li[data-event-id]')].find(
          element => element instanceof HTMLElement && restored.eventId != null && eventIds(element).includes(restored.eventId),
        );
        const detail = [...(row?.querySelectorAll<HTMLButtonElement>('[data-action="detail"]') ?? [])].find(
          element => element.dataset.id === restored.eventId && element.checkVisibility(),
        );
        const title = detail ?? row?.querySelector('.feed-title');
        if (title instanceof HTMLElement) title.focus({ preventScroll: true });
        window.scrollTo({ top: restored.scrollY, behavior: 'instant' });
      });
    }
  }

  function refreshTarget(force: boolean, interacting: boolean): 'full' | null {
    if (force) return 'full';
    // A focused form control holds a choice the markup may not carry yet, such as a ticked commit, unless its state lives
    // in ui (search, repository scope) or the settings it renders from.
    const focused = document.activeElement;
    const refreshable =
      focused?.id === 'feed-search' ||
      focused?.matches('[data-scope-repo]') ||
      (focused?.id && focused.matches('.settings-card *, .repo-entry *'));
    // Ticked commits are not in the markup, so a render would clear them before they are carried.
    const choosingCommits = Boolean(page.querySelector('.checkout-commits input:checked'));
    const preserve = interacting || choosingCommits || (!refreshable && ['INPUT', 'SELECT', 'TEXTAREA'].includes(focused?.tagName ?? ''));
    return preserve ? null : 'full';
  }

  return {
    captureGroups,
    refreshTarget,
    renderPage,
    render(state: PageState, ui: BrowserUi, options: RenderOptions) {
      const menu = header.querySelector('.header-overflow');
      const menuOpen = menu instanceof HTMLDetailsElement && menu.open;
      setHtml(header, renderHeader(state, ui));
      const sentence = syncAnnouncement(state.syncStatus.overall, syncRepoName(state.repos, state.syncStatus.overall));
      // Writing the same text again would replace the text node and could repeat the announcement.
      if (syncLive.textContent !== sentence) syncLive.textContent = sentence;
      if (menuOpen) required('.header-overflow', HTMLDetailsElement, header).open = true;
      // As in renderPage: theme.ts runs first, and the optional call covers its absence.
      (window as ThemedWindow).repoPulseTheme?.apply();
      renderPage(state, ui, options);
      setHtml(
        demo,
        state.demo
          ? html`<div class="banner info notice"><div><strong>Demo mode · fictional repositories and people</strong>No Azure requests are made. This uses an isolated local database. <button class="btn sm" type="button" data-action="demo-event">Simulate incoming hotfix</button></div></div>`
          : emptyHtml,
      );
    },
    updateScopeLabel(state: PageState, ui: BrowserUi) {
      const toggle = required('#repo-toggle', HTMLElement, header);
      setHtml(toggle, scopeLabel(state, ui));
      toggle.setAttribute('aria-label', scopeName(state, ui));
    },
  };
}
