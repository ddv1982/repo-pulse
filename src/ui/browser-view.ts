import { renderHeader } from './header.ts';
import { syncAnnouncement, syncRepoName } from './health.ts';
import { renderFeed, renderDetail } from './feed.ts';
import { detailView } from './activity-detail.ts';
import { renderRepositories } from './repositories.ts';
import { renderSettings } from './settings.ts';
import { eventIds } from './seen-actions.ts';
import { all, checked, setHtml } from './dom.ts';
import { emptyHtml, html, type SafeHtml } from './format.ts';
import type { PageState } from './refresh.ts';
import type { ResultsContext, NavigationState } from './navigation.ts';
import type { GroupState, Groups } from './groups.ts';
import { action } from './actions.ts';

/**
 * The control that takes focus when the focused control `id` left the page or the render hid it: the same control
 * rendered again, or its nearest replacement. Only controls that leave or hide need a case here; state that stays on
 * the page renders from `ui`.
 */
export function replacementFocus(id: string) {
  const current = document.getElementById(id);
  // A control the render hid, such as an option of a menu that closed, cannot take focus back.
  if (current?.checkVisibility()) return current;
  if (id === 'clear-filters') return document.getElementById('feed-search');
  const checkoutAction = /^checkout-(?:switch-target|check|pull|switch)-(.+)$/.exec(id);
  if (checkoutAction) return document.getElementById(`checkout-state-${checkoutAction[1]}`);
  if (id === 'activity-branch-action') return checked(document.querySelector('.checkout-bar'), HTMLElement, '.checkout-bar');
  if (id === 'graph-clear-search') return document.getElementById('graph-search');
  const filterTrigger =
    id === 'kind-toggle' || id.startsWith('kind-option-') || id.startsWith('summary-ci-')
      ? 'kind-toggle'
      : id === 'repo-toggle' || id.startsWith('scope-')
        ? 'repo-toggle'
        : '';
  if (filterTrigger) {
    // Below 640px the triggers sit inside the Filters disclosure, which can be collapsed.
    const trigger = document.getElementById(filterTrigger);
    return trigger?.checkVisibility() ? trigger : document.getElementById('activity-filters-toggle');
  }
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

/** web.ts owns this object: navigation state plus the connection panel state and the refresh flag the header reads. */
export type BrowserUi = NavigationState & {
  connection: import('./connection.ts').ConnectionState;
  refreshing?: boolean;
  openMenu?: string;
  /** Whether the phone header's check menu is open. */
  headerMenuOpen?: boolean;
  /** Which disclosures are open, by stable ID; `createGroupState` keeps it. */
  groups: Groups;
};
type RenderOptions = {
  restored: ResultsContext | null;
  returnUnreadOnly: boolean;
  returnToGraph?: boolean;
  showRelated?: boolean;
  matchingIds?: string[] | undefined;
  commits: import('./activity-detail.ts').LoadedView | undefined;
  feedCommits?: ReadonlyMap<string, import('./activity-detail.ts').CommitsView>;
  graph?: SafeHtml;
  checkouts: Record<string, import('./checkout.ts').CheckoutSnapshot>;
  checkoutFocus?: string | null | undefined;
  isCurrent: () => boolean;
};

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
  groups,
}: {
  page: HTMLElement;
  header: HTMLElement;
  demo: HTMLElement;
  syncLive: HTMLElement;
  picker: { mount: (element: HTMLElement | null) => void };
  toolbarMenus: Record<string, { mount: (element: HTMLElement | null) => void }>;
  groups: GroupState;
}) {
  /** The disclosures a render left on the page, with the state each rendered in. */
  const shownGroups = () =>
    [...page.querySelectorAll('details[data-group]')]
      .filter(element => element instanceof HTMLDetailsElement)
      .map((element): [string, boolean] => [element.dataset.group ?? '', element.open]);

  function renderPage(
    state: PageState,
    ui: BrowserUi,
    {
      restored,
      returnUnreadOnly,
      returnToGraph = false,
      showRelated = false,
      matchingIds,
      commits,
      feedCommits,
      graph,
      checkouts,
      checkoutFocus,
      isCurrent,
    }: RenderOptions,
  ) {
    if (restored) groups.restore(restored.groups);
    const focused = document.activeElement;
    const focusId = focused && page.contains(focused) ? focusedControlId(focused) : '';
    const neighbours = focused instanceof HTMLElement && page.contains(focused) ? seenToggleNeighbours(focused) : [];
    switch (ui.route) {
      case 'repositories':
        setHtml(page, renderRepositories(state, ui, checkouts));
        break;
      case 'graph':
        setHtml(page, graph ?? emptyHtml);
        break;
      case 'settings':
        setHtml(page, renderSettings(state, ui.connection, ui.groups));
        break;
      case 'event': {
        const view = detailView(state, ui.eventId);
        if (!view && state.detailLoading) setHtml(page, html`<div class="card loading" role="status">Loading activity details…</div>`);
        else
          setHtml(
            page,
            renderDetail(view, state, commits, { returnUnreadOnly, returnToGraph, showRelated, matchingIds, checkouts, groups: ui.groups }),
          );
        break;
      }
      case 'activity':
        setHtml(page, renderFeed(state, ui, feedCommits));
        break;
      default:
        ui.route satisfies never;
    }
    const pickerHost = page.querySelector('#repository-picker');
    picker.mount(pickerHost instanceof HTMLElement ? pickerHost : null);
    for (const [selector, menu] of Object.entries(toolbarMenus)) {
      const host = page.querySelector(selector);
      menu.mount(host instanceof HTMLElement ? host : null);
    }
    groups.settle(shownGroups());
    // A control that survived the render keeps focus; one that left, or that the render hid (a closed menu's option),
    // needs a replacement.
    if (focusId && (document.activeElement !== focused || !focused?.checkVisibility())) restoreFocus(focusId, neighbours);
    // web/theme.ts defines repoPulseTheme on window before the modules load; the optional call covers its absence.
    window.repoPulseTheme?.apply();
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
        const detail = (row ? all('[data-action="detail"]', HTMLButtonElement, row) : []).find(
          element => element.dataset.id === restored.eventId && element.checkVisibility(),
        );
        const title = detail ?? row?.querySelector('.feed-title');
        if (title instanceof HTMLElement) title.focus({ preventScroll: true });
        window.scrollTo({ top: restored.scrollY, behavior: 'instant' });
      });
    }
  }

  function renderHeaderPart(state: PageState, ui: BrowserUi) {
    setHtml(header, renderHeader(state, ui));
    const sentence = syncAnnouncement(state.syncStatus.overall, syncRepoName(state.repos, state.syncStatus.overall));
    // Writing the same text again would replace the text node and could repeat the announcement.
    if (syncLive.textContent !== sentence) syncLive.textContent = sentence;
    // As in renderPage: theme.ts runs first, and the optional call covers its absence.
    window.repoPulseTheme?.apply();
  }

  function refreshTarget(force: boolean, interacting: boolean): 'full' | null {
    if (force) return 'full';
    // A focused form control holds a choice the markup may not carry yet, unless its state lives in ui (search, repository
    // scope) or in the data it renders from (settings). Ticked commits render from their checkout's snapshot.
    const focused = document.activeElement;
    const refreshable =
      focused?.id === 'feed-search' ||
      focused?.id === 'graph-search' ||
      focused?.matches('[data-scope-repo]') ||
      (focused?.id && focused.matches('.settings-card *, .repo-entry *'));
    const preserve = interacting || (!refreshable && ['INPUT', 'SELECT', 'TEXTAREA'].includes(focused?.tagName ?? ''));
    return preserve ? null : 'full';
  }

  return {
    refreshTarget,
    renderPage,
    renderHeader: renderHeaderPart,
    render(state: PageState, ui: BrowserUi, options: RenderOptions) {
      renderHeaderPart(state, ui);
      renderPage(state, ui, options);
      setHtml(
        demo,
        state.demo
          ? html`<div class="banner info notice"><div><strong>Demo mode · fictional repositories and people</strong>No Azure requests are made. This uses an isolated local database. <button class="btn sm" type="button" ${action('demo-event')}>Simulate incoming hotfix</button></div></div>`
          : emptyHtml,
      );
    },
  };
}
