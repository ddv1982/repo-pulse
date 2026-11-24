import { request } from './api.ts';
import { joinActivitySearch } from './ui/activity-search.ts';
import { activityFilterLabel } from './activity-text.ts';
import { createCheckoutActions } from './ui/checkout-actions.ts';
import { activityBranch } from './activity-branch.ts';
import { createCheckoutPanel } from './ui/checkout.ts';
import { connectionResult, createConnectionController } from './ui/connection.ts';
import { emptyHtml, html } from './ui/format.ts';
import { createRepositoryPicker } from './ui/repository-picker.ts';
import { createNavigation, activityHref, isActivity } from './ui/navigation.ts';
import { createTypeFilter } from './ui/type-filter.ts';
import { createRefreshController } from './ui/refresh.ts';
import { createBrowserView, replacementFocus } from './ui/browser-view.ts';
import { createSeenActions, eventIds } from './ui/seen-actions.ts';
import { createFilterNameDialog, currentActivityFilters, isSavedFilterModified, savedRepositoryScope } from './ui/saved-filters.ts';
import { createToolbarMenu } from './ui/toolbar-menu.ts';
import { scopeName } from './ui/header.ts';
import { createHistoryImport } from './ui/history-import.ts';
import { createBranchPicker } from './ui/branch-picker.ts';
import { required, setHtml } from './ui/dom.ts';
import type { PageState } from './ui/refresh.ts';
import type { Action } from './ui/checkout-actions.ts';

export type { PageState, Action };

/** web/theme.ts publishes this before the modules load. */
export type ThemedWindow = Window & { repoPulseTheme?: { set: (value: string) => void } };

const page = required('#page');
const header = required('#header');
const dialog = required('#confirm-dialog', HTMLDialogElement);
let pendingConfirmation: (() => Promise<void>) | null;
let dialogOpener: HTMLElement | SVGElement | null;
let busy = false;
let lastRendered: { metadata?: string; activity?: PageState['activity']; events?: PageState['events'] } = {};
let toastTimer: ReturnType<typeof setTimeout> | undefined;

let searchTimer: ReturnType<typeof setTimeout> | undefined;
const connection = createConnectionController({
  request,
  render() {
    if (ui.route === 'settings') renderPage();
    const status = document.querySelector('#connection-status');
    if (status) {
      const focused = status.contains(document.activeElement);
      setHtml(status, connectionResult(connection.state.results.get('')));
      if (focused) status.querySelector('button')?.focus({ preventScroll: true });
    }
  },
});
const ui: import('./ui/browser-view.ts').BrowserUi = {
  route: 'catchup',
  eventId: null,
  repoIds: null,
  search: '',
  savedFilterId: '',
  kind: '',
  filtersOpen: undefined,
  openMenu: '',
  activityRoute: 'catchup',
  connection: connection.state,
};
/** Data each detail page loaded on request, by event. */
const commitResults: Map<string | null, import('./ui/activity-detail.ts').LoadedView> = new Map();
const picker = createRepositoryPicker({
  request,
  getRepos: () => refresh.state.watched,
  onAdded: async count => {
    await load({ force: true });
    toast(`${count} repositories watched.`);
  },
});
const typeFilter = createTypeFilter({
  state: ui,
  onChange: value => {
    // Every type option carries data-kind, so the fallback never applies.
    ui.kind = value ?? '';
    activityChanged();
  },
});
const savedFilterPicker = createToolbarMenu({
  toggleId: 'saved-filter-toggle',
  panelId: 'saved-filter-panel',
  itemSelector: '[data-preset]',
  state: ui,
  onSelect: option => {
    const preset = refresh.state.savedFilters?.find(filter => filter.id === option.dataset.preset);
    if (preset) applySavedFilter(preset);
    else renderPage();
  },
});
const savedFilterActions = createToolbarMenu({
  toggleId: 'saved-filter-actions-toggle',
  panelId: 'saved-filter-actions-panel',
  itemSelector: '[data-filter-action]',
  state: ui,
  onSelect: option => {
    void withAction(() => actions[option.dataset.filterAction ?? '']?.(option));
  },
});
const filterName = createFilterNameDialog(required('#filter-name-dialog', HTMLDialogElement));
const branchPicker = createBranchPicker(required('#branch-dialog', HTMLDialogElement), {
  load: async repoId => (await request(`/api/repos/${encodeURIComponent(repoId)}/checkout/branches`)).branches,
});
const historyImport = createHistoryImport(required('#history-dialog', HTMLDialogElement), {
  start: (repoId, days) => request('/api/backfill', { method: 'POST', body: { repoId, days } }),
  onStarted: async id => {
    await load({ force: true });
    if (document.activeElement === document.body || document.activeElement?.id === `import-${id}`) {
      document.getElementById(`history-${id}`)?.focus({ preventScroll: true });
    }
    toast('Older activity sync requested.');
  },
});

const seen = createSeenActions({
  page,
  request,
  toast,
  async reload() {
    const outcome = await load({ force: true });
    if (outcome.type === 'failed') throw new Error(`Could not refresh seen status. ${outcome.error.message}`);
  },
});
const view = createBrowserView({
  page,
  header,
  demo: required('#demo'),
  syncLive: required('#sync-live'),
  picker,
  toolbarMenus: { '.type-menu': typeFilter, '.saved-filter-menu': savedFilterPicker, '.saved-filter-actions': savedFilterActions },
});
const checkoutPanel = createCheckoutPanel({
  page,
  request,
  isVisible: () => ui.route === 'repositories' && !refresh.state.demo && refresh.state.repos.some(repo => repo.localPath),
});
const navigation = createNavigation({ ui, captureGroups: view.captureGroups, activityCapacity: () => refresh.capacity() });

function renderOptions() {
  const restored = navigation.takeRestoration(refresh.state.activity?.loading);
  const { generation } = navigation.view();
  return {
    restored,
    returnRoute: navigation.returnRoute,
    matchingIds: navigation.matchingIds,
    commits: commitResults.get(ui.eventId),
    checkouts: checkoutPanel.snapshots,
    checkoutFocus: navigation.takeCheckoutFocus(refresh.state.watched),
    isCurrent: () => navigation.view().generation === generation,
  };
}

function getActivityCheckout(): import('./ui/checkout-actions.ts').ActivityCheckout | null {
  if (ui.route !== 'event' || refresh.state.demo) return null;
  const event = refresh.state.events.find(event => event.id === ui.eventId);
  const repo = event && refresh.state.repos.find(repo => repo.id === event.repoId);
  const branch = event && activityBranch(event);
  if (!event || !repo?.localPath || !branch) return null;
  return { repoId: repo.id, localPath: repo.localPath, eventId: event.id, branch, isCurrent: currentView() };
}

/** A check that the page shown now is still the one shown when it was made. */
function currentView() {
  const { generation } = navigation.view();
  const hash = location.hash;
  return () => location.hash === hash && navigation.view().generation === generation;
}

/** The header, and with it the scope panel, renders only after the first state load. */
function showScopePanel(open: boolean) {
  if (open) ui.openMenu = 'repo-panel';
  // A toolbar menu opened by the same click has already taken ui.openMenu.
  else if (ui.openMenu === 'repo-panel') ui.openMenu = '';
  const panel = document.querySelector('#repo-panel');
  if (panel instanceof HTMLElement) panel.hidden = !open;
  document.querySelector('#repo-toggle')?.setAttribute('aria-expanded', String(open));
}

function renderPage() {
  view.renderPage(refresh.state, ui, renderOptions());
}

function render() {
  view.render(refresh.state, ui, renderOptions());
  if (ui.route === 'repositories') void connection.check();
}

function refreshTarget(force: boolean) {
  return view.refreshTarget(
    force,
    busy || dialog.open || historyImport.open || filterName.open || branchPicker.open || (ui.route === 'repositories' && picker.active()),
  );
}

function activityChanged({ debounce = false, header = false } = {}) {
  navigation.invalidate();
  refresh.resetActivity();
  if (header) render();
  else renderPage();
  clearTimeout(searchTimer);
  if (debounce)
    searchTimer = setTimeout(() => {
      void load({ force: true });
    }, 250);
  else void load({ force: true });
}

const refresh = createRefreshController({
  request,
  getView: navigation.view,
  reconcileRepositories: navigation.reconcileRepositories,
  onUpdate({ metadata, force }) {
    reconcileSavedFilter();
    const { activity, events } = refresh.state;
    if (force || metadata !== lastRendered.metadata || activity !== lastRendered.activity || events !== lastRendered.events) {
      const target = refreshTarget(force);
      if (target === 'full') {
        render();
        lastRendered = { metadata, activity, events };
      }
    }
    if (required('#notice').dataset.networkError) clearNotice();
    void checkoutPanel.refresh();
    const activityCheckout = getActivityCheckout();
    if (activityCheckout) {
      void checkoutPanel
        .read(activityCheckout.repoId)
        .then(checkout => {
          if (!activityCheckout.isCurrent() || busy || dialog.open) return;
          const action = document.getElementById('activity-branch-action');
          const viewing = checkout.branch === activityCheckout.branch;
          if (action && viewing !== action instanceof HTMLAnchorElement) renderPage();
        })
        .catch(() => {});
    }
  },
  onError(error, force) {
    reconcileSavedFilter();
    showError(`Cannot refresh local state: ${error.message} Last loaded events remain visible.`, true);
    if (isActivity(ui.route) && refreshTarget(force)) renderPage();
    if (ui.route === 'event' && !refresh.state.events.some(event => event.id === ui.eventId)) renderPage();
  },
});
const load = refresh.load;

function showError(message: string, network = false) {
  const notice = required('#notice');
  setHtml(
    notice,
    html`<div class="banner crit" role="alert"><span class="ic">!</span><div><strong>Something needs attention</strong><span class="error-message">${message}</span> <button class="ghost sm" type="button" data-action="dismiss-error">Dismiss</button></div></div>`,
  );
  if (network) notice.dataset.networkError = 'true';
  else delete notice.dataset.networkError;
}

function clearNotice() {
  const notice = required('#notice');
  setHtml(notice, emptyHtml);
  delete notice.dataset.networkError;
}

function toast(message: string, { undo = false } = {}) {
  const element = required('#toast');
  clearTimeout(toastTimer);
  setHtml(element, html`${message}${undo ? html`<button type="button" data-action="undo-ack">Undo</button>` : emptyHtml}`);
  element.hidden = false;
  toastTimer = setTimeout(
    () => {
      element.hidden = true;
    },
    undo ? 20000 : 6000,
  );
}

function confirm(
  title: string,
  description: string,
  callback: () => Promise<void>,
  label = 'Confirm',
  { subject = '', destructive = false } = {},
) {
  pendingConfirmation = callback;
  const opener = document.activeElement;
  dialogOpener = opener instanceof HTMLElement || opener instanceof SVGElement ? opener : null;
  required('#confirm-title').textContent = title;
  const subjectLine = required('#confirm-subject');
  subjectLine.textContent = subject;
  subjectLine.hidden = !subject;
  required('#confirm-description').textContent = description;
  const button = required('#confirm-button', HTMLButtonElement);
  button.textContent = label;
  button.classList.toggle('danger', destructive);
  dialog.showModal();
}

function closeDialog() {
  dialog.close();
  pendingConfirmation = null;
  const opener = dialogOpener?.isConnected ? dialogOpener : replacementFocus(dialogOpener?.id ?? '');
  dialogOpener = null;
  opener?.focus({ preventScroll: true });
}

async function withAction(callback: () => unknown) {
  if (busy) return;
  busy = true;
  try {
    await callback();
  } catch (error) {
    showError(error instanceof Error ? error.message : String(error));
  } finally {
    busy = false;
  }
}

function setRefreshPending(pending: boolean) {
  ui.refreshing = pending;
  for (const button of header.querySelectorAll('[data-action="refresh"]')) {
    if (!(button instanceof HTMLElement)) continue;
    button.setAttribute('aria-busy', String(pending));
    button.setAttribute('aria-disabled', String(pending));
    // The header renders data-idle-title on every refresh button, so the fallback never applies.
    button.title = pending ? 'Refreshing activity…' : (button.dataset.idleTitle ?? '');
  }
}

function selectedFilter() {
  return refresh.state.savedFilters?.find(filter => filter.id === ui.savedFilterId);
}

function reconcileSavedFilter() {
  if (ui.savedFilterId && refresh.state.savedFilters && !selectedFilter()) ui.savedFilterId = '';
}

function applySavedFilter({ id, name, filters }: import('./ui/saved-filters.ts').SavedActivityFilter) {
  const { search, people, kind, repoIds, view } = filters;
  const watched = refresh.state.watched;
  const available = new Set(refresh.state.repos.map(repo => repo.id));
  const unavailable = (repoIds ?? []).filter(id => !available.has(id)).length;
  Object.assign(ui, {
    savedFilterId: id,
    search: joinActivitySearch(search, people),
    kind,
    repoIds: savedRepositoryScope(repoIds, watched),
  });
  const destination = view === 'all' ? 'activity' : 'catchup';
  const sameView = destination === ui.route;
  if (sameView) activityChanged({ header: true });
  else location.hash = activityHref(destination);
  const destinationMessage = sameView ? '' : ` Opened ${view === 'all' ? 'All activity' : 'New updates'}.`;
  const scopeMessage = unavailable
    ? unavailable === repoIds?.length
      ? ' All saved repositories are unavailable.'
      : ' Some saved repositories are unavailable.'
    : '';
  toast(`Applied “${name}”.${destinationMessage}${scopeMessage}`);
}

const actions: Record<string, Action> = {
  ...createCheckoutActions({
    checkoutPanel,
    getActivityCheckout,
    confirm,
    toast,
    closeBranchPicker: () => branchPicker.close(),
    currentView,
  }),
  'open-branch-picker': element => {
    const repo = refresh.state.repos.find(item => item.id === element.dataset.id);
    const branch = checkoutPanel.snapshots[element.dataset.id ?? '']?.branch;
    if (repo && branch && !refresh.state.demo) void branchPicker.show(repo, branch);
  },
  'load-more-activity': async () => {
    await load({ force: true, more: true });
  },
  'retry-activity': async () => {
    await load({ force: true });
  },
  'open-history-import': element => {
    const repo = refresh.state.repos.find(item => item.id === element.dataset.id);
    if (repo) historyImport.show(repo);
  },
  'copy-diagnostics': async () => {
    try {
      await navigator.clipboard.writeText(JSON.stringify(refresh.state.diagnostics, null, 2));
      toast('Diagnostics copied.');
    } catch {
      toast('Copy is unavailable in this browser.');
    }
  },
  'check-connection': element => {
    void connection.check(element.dataset.repoId || '', { force: true });
  },
  refresh: async () => {
    setRefreshPending(true);
    try {
      await request('/api/refresh', { method: 'POST', body: { ...(ui.repoIds === null ? {} : { repoIds: ui.repoIds }) } });
      toast('Activity refresh queued.');
      await load({ force: true });
    } finally {
      setRefreshPending(false);
    }
  },
  'demo-event': async () => {
    await request('/api/demo/event', { method: 'POST', body: {} });
    await load({ force: true });
    toast('Fictional incoming hotfix added.');
  },
  detail: element => {
    // Detail buttons always carry data-id, so the fallbacks never apply.
    const row = element.closest('li[data-event-id]');
    const matchingIds = (ui.search || ui.kind) && row instanceof HTMLElement ? eventIds(row) : undefined;
    navigation.remember(element.dataset.id ?? null, matchingIds);
    location.hash = `event/${encodeURIComponent(element.dataset.id ?? '')}`;
  },
  'back-to-results': () => {
    location.hash = activityHref(navigation.returnRoute);
  },
  'copy-commit': async element => {
    try {
      await navigator.clipboard.writeText(element.dataset.value || '');
      toast('Commit copied.');
    } catch {
      toast('Copy unavailable in this browser. Open Azure DevOps to copy the full commit.');
    }
  },
  ...seen.actions,
  'ack-matching': async element => {
    const { query, scope } = element.dataset;
    if (!query || !scope) return;
    const { generation } = navigation.view();
    const { ids } = await request(`/api/activity/unseen?${query}`);
    if (navigation.view().generation !== generation) return;
    if (!ids.length) {
      await load({ force: true });
      return toast('No unread updates match the current filters.');
    }
    const shown = new Set(seen.shownUnseenIds());
    const below = ids.filter(id => !shown.has(id)).length;
    // Everything it would mark is on screen, so there is nothing to preview; Undo covers a slip.
    if (!below) return seen.acknowledge(ids, true);
    confirm(
      `Mark ${ids.length} update${ids.length === 1 ? '' : 's'} as seen?`,
      `${below} ${below === 1 ? 'is' : 'are'} below the rows shown. Updates recorded after this page loaded stay unread.`,
      () => seen.acknowledge(ids, true),
      'Mark as seen',
      { subject: scope },
    );
  },
  'cancel-dialog': closeDialog,
  'confirm-dialog': async () => {
    const callback = pendingConfirmation;
    closeDialog();
    if (callback) await callback();
  },
  'save-filter': () => {
    const filters = currentActivityFilters(ui);
    const summary = `Includes ${filters.view === 'all' ? 'All activity' : 'New updates'} · ${scopeName(refresh.state, filters)} · ${activityFilterLabel(filters.kind)}`;
    filterName.show(
      selectedFilter() ? 'Save as new filter' : 'Save Activity filter',
      '',
      async name => {
        const preset = await request('/api/activity-filters', { method: 'POST', body: { name, filters } });
        await load({ force: true });
        if (isActivity(ui.route) && refresh.state.savedFilters?.some(filter => filter.id === preset.id)) {
          ui.savedFilterId = preset.id;
          renderPage();
        }
        toast(`Filter “${preset.name}” saved.`);
      },
      `${summary}${ui.search ? ` · Search “${ui.search}”` : ''}`,
    );
  },
  'restore-filter': () => {
    const preset = selectedFilter();
    if (preset) applySavedFilter(preset);
  },
  'detach-filter': () => {
    ui.savedFilterId = '';
    renderPage();
    document.getElementById('saved-filter-toggle')?.focus({ preventScroll: true });
  },
  'rename-filter': () => {
    const preset = selectedFilter();
    if (!preset) return;
    filterName.show('Rename Activity filter', preset.name, async name => {
      await request(`/api/activity-filters/${preset.id}`, { method: 'PATCH', body: { name } });
      await load({ force: true });
      toast('Filter renamed.');
    });
  },
  'update-filter': async () => {
    const preset = selectedFilter();
    if (!preset) return;
    const filters = currentActivityFilters(ui);
    if (!isSavedFilterModified(preset.filters, filters, refresh.state.watched)) return;
    await request(`/api/activity-filters/${preset.id}`, { method: 'PATCH', body: { filters } });
    await load({ force: true });
    toast('Saved filter updated.');
  },
  'delete-filter': () => {
    const preset = selectedFilter();
    if (!preset) return;
    confirm(
      'Delete saved filter?',
      'Your current Activity filters will stay applied.',
      async () => {
        await request(`/api/activity-filters/${preset.id}`, { method: 'DELETE' });
        if (ui.savedFilterId === preset.id) ui.savedFilterId = '';
        await load({ force: true });
        toast('Saved filter deleted.');
      },
      'Delete filter',
      { subject: preset.name, destructive: true },
    );
  },
  'clear-filters': () => {
    ui.search = '';
    ui.kind = '';
    ui.savedFilterId = '';
    activityChanged();
  },
  'toggle-activity-filters': () => {
    ui.filtersOpen = !ui.filtersOpen;
    renderPage();
  },
  'dismiss-error': clearNotice,
  'all-repos': () => {
    ui.repoIds = null;
    activityChanged({ header: true });
  },
  'no-repos': () => {
    ui.repoIds = [];
    activityChanged({ header: true });
  },
  'reset-activity': () => {
    confirm(
      'Start from scratch?',
      'This deletes all stored activity, seen marks and imported history on this computer, then imports the last seven days from Azure DevOps again. Older history can be imported from Repositories. Your repositories, linked checkouts and settings stay.',
      async () => {
        await request('/api/reset', { method: 'POST', body: {} });
        await load({ force: true });
        toast('Starting from scratch. Stored activity is being deleted, then the last seven days are imported.');
      },
      'Delete and import again',
      { destructive: true },
    );
  },
  'remove-repo': element => {
    // Remove buttons are rendered from the watched list. A repository removed since the render throws here and withAction reports it.
    const repo = refresh.state.watched.find(item => item.id === element.dataset.id);
    if (!repo) throw new Error('This repository is no longer watched.');
    confirm(
      `Remove ${repo.name} from this app?`,
      'This deletes its local watch and cached history only. The checkout, Azure repository and remote data are unchanged.',
      async () => {
        await request(`/api/repos/${encodeURIComponent(repo.id)}`, { method: 'DELETE' });
        await load({ force: true });
      },
      'Remove local watch',
    );
  },
  'load-review': async element => {
    const { eventId } = ui;
    try {
      commitResults.set(
        eventId,
        await request(
          `/api/pr/${encodeURIComponent(element.dataset.repoId ?? '')}/${encodeURIComponent(element.dataset.prId ?? '')}/review`,
        ),
      );
    } catch (error) {
      commitResults.set(eventId, { error: error instanceof Error ? error.message : String(error) });
    }
    if (ui.route === 'event' && ui.eventId === eventId) renderPage();
  },
  'load-commits': async element => {
    const { eventId } = ui;
    try {
      commitResults.set(
        eventId,
        await request(
          `/api/push/${encodeURIComponent(element.dataset.repoId ?? '')}/${encodeURIComponent(element.dataset.pushId ?? '')}/commits`,
        ),
      );
    } catch (error) {
      commitResults.set(eventId, { error: error instanceof Error ? error.message : String(error) });
    }
    if (ui.route === 'event' && ui.eventId === eventId) renderPage();
  },
};

document.addEventListener('click', event => {
  const target = event.target;
  const monitoring = header.querySelector('.header-overflow[open]');
  if (monitoring instanceof HTMLDetailsElement && !(target instanceof Node && monitoring.contains(target))) monitoring.open = false;
  if (!(target instanceof Element)) return;
  const theme = target.closest('[data-theme]');
  if (theme instanceof HTMLElement) {
    // web/theme.ts defines repoPulseTheme on window before this module loads; the optional call covers its absence.
    (window as ThemedWindow).repoPulseTheme?.set(theme.dataset.theme ?? '');
    return;
  }
  if (target.closest('#repo-toggle')) {
    showScopePanel(ui.openMenu !== 'repo-panel');
    return;
  }
  if (document.querySelector('#repo-panel:not([hidden])') && !target.closest('#repo-panel')) showScopePanel(false);
  const element = target.closest('[data-action]');
  const action = element instanceof HTMLElement ? element.dataset.action : undefined;
  if (element instanceof HTMLElement && action && actions[action]) {
    event.preventDefault();
    void withAction(() => actions[action]?.(element));
  }
});

document.addEventListener('input', event => {
  const target = event.target;
  if (!(target instanceof HTMLInputElement)) return;
  if (target.id === 'feed-search') {
    ui.search = target.value;
    activityChanged({ debounce: true });
  }
});

document.addEventListener('change', event => {
  const target = event.target;
  if (!(target instanceof HTMLInputElement || target instanceof HTMLSelectElement)) return;
  if (target.matches('[data-scope-repo]')) {
    // Disabled repositories have no checkbox; keep their place in the scope for when they are enabled.
    const disabled = refresh.state.watched.filter(repo => repo.disabled && (ui.repoIds === null || ui.repoIds.includes(repo.id)));
    ui.repoIds = [...document.querySelectorAll('[data-scope-repo]:checked')]
      .filter(input => input instanceof HTMLInputElement)
      // The selector guarantees data-scope-repo, so the fallback never applies.
      .map(input => input.dataset.scopeRepo ?? '')
      .concat(disabled.map(repo => repo.id));
    activityChanged();
    view.updateScopeLabel(refresh.state, ui);
  }
  if (target.id === 'connection-repo') {
    connection.select(target.value);
    renderPage();
  }
  if (target instanceof HTMLInputElement && target.matches('[data-repo-toggle]')) {
    const control = target;
    const repo = refresh.state.watched.find(item => item.id === control.dataset.id);
    if (busy || !repo) {
      control.checked = !repo?.disabled;
      return;
    }
    const enabled = control.checked;
    void withAction(async () => {
      try {
        await request(`/api/repos/${encodeURIComponent(repo.id)}`, { method: 'PATCH', body: { disabled: !enabled } });
        await load({ force: true });
        toast(`${repo.name} ${enabled ? 'enabled' : 'disabled'}.`);
      } finally {
        const current = refresh.state.watched.find(item => item.id === repo.id);
        if (control.isConnected) control.checked = !current?.disabled;
      }
    });
  }
  if (target instanceof HTMLInputElement && target.matches('[data-auto-toggle]')) {
    const checked = target.checked;
    if (busy) {
      target.checked = refresh.state.settings.refreshEnabled !== false;
      return;
    }
    void withAction(async () => {
      try {
        await request('/api/settings', { method: 'POST', body: { refreshEnabled: checked } });
        await load({ force: true });
      } finally {
        for (const control of document.querySelectorAll('[data-auto-toggle]')) {
          if (control instanceof HTMLInputElement) control.checked = refresh.state.settings.refreshEnabled !== false;
        }
      }
    });
  }
});

dialog.addEventListener('cancel', event => {
  event.preventDefault();
  closeDialog();
});
document.addEventListener('keydown', event => {
  const monitoring = header.querySelector('.header-overflow[open]');
  if (event.key === 'Escape' && monitoring instanceof HTMLDetailsElement && monitoring.contains(document.activeElement)) {
    monitoring.open = false;
    required('summary', HTMLElement, monitoring).focus();
    return;
  }
  if (event.key === 'Escape' && ui.openMenu === 'repo-panel') {
    showScopePanel(false);
    required('#repo-toggle').focus();
  }
  if (
    event.key === '/' &&
    !dialog.open &&
    !historyImport.open &&
    !filterName.open &&
    !branchPicker.open &&
    !savedFilterPicker.expanded &&
    !savedFilterActions.expanded &&
    !['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement?.tagName ?? '')
  ) {
    event.preventDefault();
    const controls = document.getElementById('activity-filters');
    if (controls?.hidden) {
      ui.filtersOpen = true;
      renderPage();
    }
    const search = document.querySelector('#feed-search');
    if (search instanceof HTMLElement) search.focus();
  }
});

function route() {
  clearTimeout(searchTimer);
  // The branch picker belongs to the Repositories visit that opened it.
  branchPicker.close();
  const { destination, capacity, scrollToTop } = navigation.enter(refresh.loaded ? refresh.state.watched : null);
  if (isActivity(destination)) refresh.resetActivity(capacity);
  else if (destination === 'event') refresh.prepareDetail(ui.eventId);
  render();
  const needsActivity = isActivity(destination) || destination === 'event';
  void load({ force: needsActivity });
  if (needsActivity && scrollToTop) window.scrollTo({ top: 0, behavior: 'instant' });
}

window.addEventListener('hashchange', route);
window.addEventListener('focus', () => {
  void load();
});
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) void load();
});
window.matchMedia('(min-width:640px)').addEventListener('change', () => {
  // The filter bar changes layout, so an open toolbar menu closes and focus returns to its toggle.
  if (ui.openMenu !== 'repo-panel') ui.openMenu = '';
  if (['catchup', 'activity'].includes(ui.route)) renderPage();
});
navigation.initialize();
await load({ force: true });
setInterval(() => {
  if (!document.hidden) void load();
}, 5000);
