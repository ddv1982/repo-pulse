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
import { createGraphController } from './ui/git-graph.ts';
import { createTypeFilter } from './ui/type-filter.ts';
import { createRefreshController } from './ui/refresh.ts';
import { createBrowserView, replacementFocus } from './ui/browser-view.ts';
import { createSeenActions, eventIds } from './ui/seen-actions.ts';
import { detailView } from './ui/activity-detail.ts';
import { createFilterNameDialog, currentActivityFilters, isSavedFilterModified, savedRepositoryScope } from './ui/saved-filters.ts';
import { createToolbarMenu } from './ui/toolbar-menu.ts';
import { createMenuManager } from './ui/menus.ts';
import { createRepositoryScope, scopeName } from './ui/repository-scope.ts';
import { createHistoryImport } from './ui/history-import.ts';
import { createBranchPicker } from './ui/branch-picker.ts';
import { createConfirmation } from './ui/confirm.ts';
import { anyDialogOpen } from './ui/dialog.ts';
import { checked, required, setHtml } from './ui/dom.ts';
import type { PageState } from './ui/refresh.ts';
import type { Action } from './ui/dom.ts';

const page = required('#page');
const header = required('#header');
const confirmation = createConfirmation(required('#confirm-dialog', HTMLDialogElement), { replacement: replacementFocus });
/**
 * Commands in flight, by the resource they change. A command is held back only while another command on the same
 * resource runs, so a pending refresh never blocks navigation or a detail view.
 */
const pending = new Set<string>();
const savedFiltersBusy = 'A saved filter change is still being saved. Try again when it finishes.';
/** Commands that change the same local data share a resource; every other command is its own. */
const actionResources: Record<string, string> = {
  'ack-item': 'activity',
  'undo-ack': 'activity',
  'ack-matching': 'activity',
  'reset-activity': 'activity',
  'demo-event': 'activity',
  'switch-activity-branch': 'checkout',
  'switch-checkout-branch': 'checkout',
  'check-checkout': 'checkout',
  'pull-checkout': 'checkout',
  'switch-checkout-target': 'checkout',
  'review-checkout-branch': 'checkout',
  'remove-checkout-branch': 'checkout',
  'carry-checkout-branch': 'checkout',
  'update-filter': 'saved-filters',
  'delete-filter': 'saved-filters',
  'remove-repo': 'repos',
};
let lastRendered: { metadata?: string; activity?: PageState['activity']; detail?: PageState['detail'] } = {};
let toastTimer: ReturnType<typeof setTimeout> | undefined;
let undoTimer: ReturnType<typeof setTimeout> | undefined;

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
  route: 'activity',
  eventId: null,
  repoIds: null,
  search: '',
  savedFilterId: '',
  kind: '',
  filtersOpen: undefined,
  openMenu: '',
  unreadOnly: false,
  connection: connection.state,
};
/** Data each detail page loaded on request, by event. */
const commitResults: Map<string | null, import('./ui/activity-detail.ts').LoadedView> = new Map();
const feedCommits = new Map<string, import('./ui/activity-detail.ts').CommitsView>();
const menus = createMenuManager(ui);
const picker = createRepositoryPicker({
  menus,
  request,
  getRepos: () => refresh.state.watched,
  onError: reportError,
  onAdded: async count => {
    await load({ force: true });
    toast(`${count} repositories watched.`);
  },
});
const typeFilter = createTypeFilter({
  menus,
  onChange: setActivityType,
});
const repositoryScope = createRepositoryScope(menus);
const savedFilterPicker = createToolbarMenu({
  menus,
  toggleId: 'saved-filter-toggle',
  panelId: 'saved-filter-panel',
  itemSelector: '[data-preset]',
  onSelect: option => {
    const preset = refresh.state.savedFilters.find(filter => filter.id === option.dataset.preset);
    if (preset) applySavedFilter(preset);
    else renderPage();
  },
});
const savedFilterActions = createToolbarMenu({
  menus,
  toggleId: 'saved-filter-actions-toggle',
  panelId: 'saved-filter-actions-panel',
  itemSelector: '[data-filter-action]',
  onSelect: option => {
    void withAction(actionResource(option.dataset.filterAction), () => dispatch(option.dataset.filterAction, option));
  },
});
const filterName = createFilterNameDialog(required('#filter-name-dialog', HTMLDialogElement));
const branchPicker = createBranchPicker(required('#branch-dialog', HTMLDialogElement), {
  load: async repoId => (await request('GET /api/repos/:id/checkout/branches', { params: { id: repoId } })).branches,
});
const historyImport = createHistoryImport(required('#history-dialog', HTMLDialogElement), {
  start: (repoId, days) => request('POST /api/repos/:id/backfill', { params: { id: repoId ?? '' }, body: { days } }),
  onStarted: async id => {
    try {
      await load({ force: true });
      if (document.activeElement === document.body || document.activeElement?.id === `import-${id}`) {
        document.getElementById(`history-${id}`)?.focus({ preventScroll: true });
      }
    } finally {
      toast('Older activity sync requested.');
    }
  },
  onFollowupError: failure => {
    const detail = failure instanceof Error ? failure.message : typeof failure === 'string' ? failure : '';
    showError(`Older activity sync was requested, but its status could not be shown.${detail ? ` ${detail}` : ''}`);
  },
});

const seen = createSeenActions({
  page,
  request,
  toast: seenToast,
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
  toolbarMenus: {
    '.type-menu': typeFilter,
    '.scope-menu': repositoryScope,
    '.saved-filter-menu': savedFilterPicker,
    '.saved-filter-actions': savedFilterActions,
  },
});
const checkoutPanel = createCheckoutPanel({
  page,
  request,
  isVisible: () => ui.route === 'repositories' && !refresh.state.demo && refresh.state.repos.some(repo => repo.localPath),
  onChange(before) {
    const id = visibleCheckout();
    if (id && JSON.stringify(before[id]) !== JSON.stringify(checkoutPanel.snapshots[id])) renderPage();
  },
  onMutation(id) {
    graph.checkoutChanged(id);
  },
});
const navigation = createNavigation({ ui, captureGroups: view.captureGroups, activityCapacity: () => refresh.capacity() });

let focusRelatedCi = false;
const graph = createGraphController({
  request,
  page,
  state: () => refresh.state,
  scope: () => ui.repoIds,
  isActive: () => ui.route === 'graph',
  render: renderPage,
  checkout: id => checkoutPanel.snapshots[id],
  readCheckout: () => refreshViewCheckout(true),
  currentView,
});

function visibleCheckout() {
  if (ui.route === 'graph' && !refresh.state.demo) {
    const { repo } = graph.selection();
    return repo?.localPath ? repo.id : undefined;
  }
  return getActivityCheckout()?.repoId;
}

function refreshViewCheckout(fresh = false) {
  const id = visibleCheckout();
  if (id) void checkoutPanel.read(id, fresh);
}

function renderOptions() {
  const restored = navigation.takeRestoration(refresh.state.activity.loading);
  const { generation } = navigation.view();
  return {
    restored,
    returnUnreadOnly: navigation.returnUnreadOnly,
    returnToGraph: graph.returnsHere,
    showRelated: Boolean(ui.relatedCi),
    matchingIds: navigation.matchingIds,
    commits: commitResults.get(ui.eventId),
    feedCommits,
    ...(ui.route === 'graph' ? { graph: graph.render() } : {}),
    checkouts: checkoutPanel.snapshots,
    checkoutFocus: navigation.takeCheckoutFocus(refresh.state.watched),
    isCurrent: () => navigation.view().generation === generation,
  };
}

function getActivityCheckout(): import('./ui/checkout-actions.ts').ActivityCheckout | null {
  if (ui.route !== 'event' || refresh.state.demo) return null;
  const event = detailView(refresh.state, ui.eventId)?.event;
  const repo = event && refresh.state.repos.find(repo => repo.id === event.repoId);
  const branch = event && activityBranch(event);
  if (!event || !repo?.localPath || !branch) return null;
  return { repoId: repo.id, localPath: repo.localPath, eventId: event.id, branch, isCurrent: currentView() };
}

/** A check that the page shown now is still the one shown when it was made. */
function currentView() {
  const { generation } = navigation.view();
  const hash = location.hash;
  const repo = ui.route === 'graph' ? graph.selection().repo : undefined;
  return () => {
    if (location.hash !== hash || navigation.view().generation !== generation) return false;
    if (!repo) return true;
    const selected = graph.selection().repo;
    return selected?.id === repo.id && selected.localPath === repo.localPath;
  };
}

function revealRelatedCi() {
  if (!focusRelatedCi || ui.route !== 'event') return;
  const summary = checked(page.querySelector('.detail-related > summary'), HTMLElement, '.detail-related > summary');
  if (!summary) return;
  focusRelatedCi = false;
  summary.scrollIntoView({ block: 'start' });
  summary.focus({ preventScroll: true });
}

function renderPage() {
  view.renderPage(refresh.state, ui, renderOptions());
  revealRelatedCi();
}

function render() {
  view.render(refresh.state, ui, renderOptions());
  revealRelatedCi();
  if (ui.route === 'repositories') void connection.check();
}

function refreshTarget(force: boolean) {
  return view.refreshTarget(force, pending.size > 0 || anyDialogOpen() || (ui.route === 'repositories' && picker.active()));
}

function setActivityType(kind: string | undefined) {
  ui.kind = kind ?? '';
  activityChanged();
}

function activityChanged({ debounce = false } = {}) {
  navigation.invalidate();
  refresh.resetActivity();
  renderPage();
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
  reconcile(next) {
    navigation.reconcileRepositories(next.watched);
    if (ui.savedFilterId && !next.savedFilters.some(filter => filter.id === ui.savedFilterId)) ui.savedFilterId = '';
  },
  onUpdate({ metadata, force }) {
    const { activity, detail } = refresh.state;
    if (force || metadata !== lastRendered.metadata || activity !== lastRendered.activity || detail !== lastRendered.detail) {
      const target = refreshTarget(force);
      if (target === 'full') {
        // The answer can change which repository the graph shows; its history loads before the page renders.
        if (ui.route === 'graph') graph.sync();
        render();
        lastRendered = { metadata, activity, detail };
      }
    }
    if (required('#notice').dataset.networkError) clearNotice();
    void checkoutPanel.refresh();
    refreshViewCheckout();
    if (ui.route === 'graph') void graph.refresh();
  },
  onError(error, force) {
    showError(`Cannot refresh local state: ${error.message} Last loaded events remain visible.`, true);
    if (isActivity(ui.route) && refreshTarget(force)) renderPage();
    if (ui.route === 'event' && !detailView(refresh.state, ui.eventId)) renderPage();
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

function toast(message: string) {
  const element = required('#toast');
  clearTimeout(toastTimer);
  setHtml(element, html`${message}`);
  element.hidden = false;
  toastTimer = setTimeout(() => {
    element.hidden = true;
  }, 6000);
}

function hideUndo() {
  clearTimeout(undoTimer);
  required('#undo-toast').hidden = true;
}

/**
 * Seen feedback. An Undo offer has its own slot and timer below the message toast, so other messages show above it
 * and never remove or move it; the next seen result replaces it.
 */
function seenToast(message: string, { undo = false } = {}) {
  const element = required('#undo-toast');
  hideUndo();
  if (!undo) return toast(message);
  setHtml(element, html`${message}<button type="button" data-action="undo-ack">Undo</button>`);
  element.hidden = false;
  undoTimer = setTimeout(() => {
    element.hidden = true;
  }, 20000);
}

const confirm = confirmation.ask;

function reportError(error: unknown) {
  showError(error instanceof Error ? error.message : String(error));
}

async function withAction(resource: string, callback: () => unknown) {
  if (pending.has(resource)) return;
  pending.add(resource);
  try {
    await callback();
  } catch (error) {
    reportError(error);
  } finally {
    pending.delete(resource);
  }
}

/**
 * Runs a dialog's submission under a resource, so it cannot overlap a command on the same resource. A busy resource
 * throws, and the dialog shows the message.
 */
function holding<T extends unknown[]>(resource: string, message: string, callback: (...args: T) => Promise<void>) {
  return async (...args: T) => {
    if (pending.has(resource)) throw new Error(message);
    pending.add(resource);
    try {
      await callback(...args);
    } finally {
      pending.delete(resource);
    }
  };
}

/** The resource a named action changes; a confirmation runs under the resource of the command that asked for it. */
function actionResource(name: string | undefined) {
  if (name === 'confirm-dialog') return confirmation.resource ?? name;
  return (name && Object.hasOwn(actionResources, name) ? actionResources[name] : undefined) ?? name ?? '';
}

/** Runs the named action. A name without one is broken markup, reported instead of ignored. */
function dispatch(name: string | undefined, element: HTMLElement) {
  const action = name && Object.hasOwn(actions, name) ? actions[name] : undefined;
  if (!action) throw new Error(`Repo Pulse: unknown action ${JSON.stringify(name ?? '')}`);
  return action(element);
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
  return refresh.state.savedFilters.find(filter => filter.id === ui.savedFilterId);
}

function applySavedFilter({ id, name, filters }: import('./contract.ts').SavedActivityFilter) {
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
  const unreadOnly = view === 'new';
  if (unreadOnly === ui.unreadOnly) activityChanged();
  else location.hash = activityHref(unreadOnly);
  const scopeMessage = unavailable
    ? unavailable === repoIds?.length
      ? ' All saved repositories are unavailable.'
      : ' Some saved repositories are unavailable.'
    : '';
  toast(`Applied “${name}”.${scopeMessage}`);
}

const actions: Record<string, Action> = {
  'reload-graph': () => {
    refreshViewCheckout(true);
    void graph.reload();
  },
  'more-graph': () => {
    void graph.more();
  },
  'clear-graph-search': () => graph.search(''),
  'previous-graph-match': () => graph.moveMatch(-1),
  'next-graph-match': () => graph.moveMatch(1),
  ...createCheckoutActions({
    checkoutPanel,
    getActivityCheckout,
    confirm: (title, description, callback, label, options) =>
      confirm(title, description, callback, label, { ...options, resource: 'checkout' }),
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
  'copy-azure-login': async () => {
    try {
      await navigator.clipboard.writeText('az login');
      toast('Command copied.');
    } catch {
      toast('Copy is unavailable in this browser. Select the command to copy it manually.');
    }
  },
  'check-connection': element => {
    void connection.check(element.dataset.repoId || '', { force: true });
  },
  refresh: async element => {
    setRefreshPending(true);
    try {
      const retrySignIn = element.hasAttribute('data-retry-sign-in');
      const { status } = await request('POST /api/refresh', {
        body: { ...(ui.repoIds === null ? {} : { repoIds: ui.repoIds }), ...(retrySignIn ? { retrySignIn: true } : {}) },
      });
      toast(
        status.scheduled
          ? 'Activity refresh queued.'
          : status.cooldown
            ? 'A refresh was requested recently. Try again shortly.'
            : retrySignIn
              ? 'No sign-in checks need retrying.'
              : 'No enabled repositories are selected.',
      );
      await load({ force: true });
    } finally {
      setRefreshPending(false);
    }
  },
  'demo-event': async () => {
    await request('POST /api/demo/event', { body: {} });
    await load({ force: true });
    toast('Fictional incoming hotfix added.');
  },
  detail: element => {
    // Detail buttons always carry data-id, so the fallbacks never apply.
    const row = element.closest('li[data-event-id]');
    const matchingIds = (ui.search || ui.kind) && row instanceof HTMLElement ? eventIds(row) : undefined;
    navigation.remember(element.dataset.id ?? null, matchingIds);
    location.hash = `event/${encodeURIComponent(element.dataset.id ?? '')}${element.hasAttribute('data-related') ? '/ci' : ''}`;
  },
  'back-to-graph': () => history.back(),
  'back-to-results': () => {
    location.hash = activityHref(navigation.returnUnreadOnly);
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
    const { ids } = await request('GET /api/activity/unseen', { query: new URLSearchParams(query) });
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
      { subject: scope, resource: 'activity' },
    );
  },
  'confirm-dialog': () => confirmation.accept(),
  'save-filter': () => {
    const filters = currentActivityFilters(ui);
    const summary = `Includes ${filters.view === 'all' ? 'All activity' : 'Unread only'} · ${scopeName(refresh.state, filters)} · ${activityFilterLabel(filters.kind)}`;
    filterName.show(
      selectedFilter() ? 'Save as new filter' : 'Save Activity filter',
      '',
      holding('saved-filters', savedFiltersBusy, async name => {
        const preset = await request('POST /api/activity-filters', { body: { name, filters } });
        await load({ force: true });
        if (isActivity(ui.route) && refresh.state.savedFilters.some(filter => filter.id === preset.id)) {
          ui.savedFilterId = preset.id;
          renderPage();
        }
        toast(`Filter “${preset.name}” saved.`);
      }),
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
    filterName.show(
      'Rename Activity filter',
      preset.name,
      holding('saved-filters', savedFiltersBusy, async name => {
        await request('PATCH /api/activity-filters/:id', { params: { id: preset.id }, body: { name } });
        await load({ force: true });
        toast('Filter renamed.');
      }),
    );
  },
  'update-filter': async () => {
    const preset = selectedFilter();
    if (!preset) return;
    const filters = currentActivityFilters(ui);
    if (!isSavedFilterModified(preset.filters, filters, refresh.state.watched)) return;
    await request('PATCH /api/activity-filters/:id', { params: { id: preset.id }, body: { filters } });
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
        await request('DELETE /api/activity-filters/:id', { params: { id: preset.id } });
        if (ui.savedFilterId === preset.id) ui.savedFilterId = '';
        await load({ force: true });
        toast('Saved filter deleted.');
      },
      'Delete filter',
      { subject: preset.name, destructive: true, resource: 'saved-filters' },
    );
  },
  'clear-filters': () => {
    ui.search = '';
    ui.kind = '';
    ui.savedFilterId = '';
    if (ui.unreadOnly) location.hash = activityHref(false);
    else activityChanged();
  },
  'toggle-unread': () => {
    location.hash = activityHref(!ui.unreadOnly);
  },
  'filter-activity-type': element => {
    ui.filtersOpen = true;
    setActivityType(element.dataset.kind);
  },
  'toggle-activity-filters': () => {
    ui.filtersOpen = !ui.filtersOpen;
    renderPage();
  },
  'dismiss-error': clearNotice,
  'all-repos': () => {
    ui.repoIds = null;
    activityChanged();
  },
  'no-repos': () => {
    ui.repoIds = [];
    activityChanged();
  },
  'reset-activity': () => {
    confirm(
      'Start from scratch?',
      'This deletes all stored activity, seen marks and imported history on this computer, then imports the last seven days from Azure DevOps again. Older history can be imported from Repositories. Your repositories, linked checkouts and settings stay.',
      async () => {
        await request('POST /api/reset', { body: {} });
        // The activity Undo would restore is being deleted.
        seen.forgetUndo();
        hideUndo();
        feedCommits.clear();
        await load({ force: true });
        toast('Starting from scratch. Stored activity is being deleted, then the last seven days are imported.');
      },
      'Delete and import again',
      { destructive: true, resource: 'activity' },
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
        await request('DELETE /api/repos/:id', { params: { id: repo.id } });
        await load({ force: true });
      },
      'Remove local watch',
      { resource: 'repos' },
    );
  },
  'load-review': async element => {
    const { eventId } = ui;
    try {
      commitResults.set(
        eventId,
        await request('GET /api/repos/:id/prs/:prId/review', {
          params: { id: element.dataset.repoId ?? '', prId: element.dataset.prId ?? '' },
        }),
      );
    } catch (error) {
      commitResults.set(eventId, { error: error instanceof Error ? error.message : String(error) });
    }
    if (ui.route === 'event' && ui.eventId === eventId) renderPage();
  },
  'load-commits': async element => {
    const inlineId = element.dataset.inlineId;
    const eventId = inlineId ?? ui.eventId;
    const results = inlineId ? feedCommits : commitResults;
    element.setAttribute('aria-busy', 'true');
    try {
      results.set(
        eventId,
        await request('GET /api/repos/:id/pushes/:pushId/commits', {
          params: { id: element.dataset.repoId ?? '', pushId: element.dataset.pushId ?? '' },
        }),
      );
    } catch (error) {
      results.set(eventId, { error: error instanceof Error ? error.message : String(error) });
    }
    if ((inlineId && isActivity(ui.route)) || (ui.route === 'event' && ui.eventId === eventId)) renderPage();
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
    window.repoPulseTheme?.set(theme.dataset.theme ?? '');
    return;
  }
  const graphLink = checked(target.closest('.graph-link'), HTMLAnchorElement, '.graph-link');
  if (ui.route === 'graph' && graphLink && !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey)
    graph.followLink(graphLink);
  const element = target.closest('[data-action]');
  if (element instanceof HTMLElement) {
    event.preventDefault();
    void withAction(actionResource(element.dataset.action), () => dispatch(element.dataset.action, element));
  }
});

document.addEventListener('input', event => {
  const target = event.target;
  if (!(target instanceof HTMLInputElement)) return;
  if (target.id === 'feed-search') {
    ui.search = target.value;
    activityChanged({ debounce: true });
  } else if (target.id === 'graph-search') graph.search(target.value);
});

document.addEventListener('change', event => {
  const target = event.target;
  if (!(target instanceof HTMLInputElement || target instanceof HTMLSelectElement)) return;
  if (target.id === 'graph-repo') {
    branchPicker.close();
    navigation.invalidate();
    graph.selectRepository(target.value);
    refreshViewCheckout(true);
    return;
  }
  if (target.matches('[data-scope-repo]')) {
    // Disabled repositories have no checkbox; keep their place in the scope for when they are enabled.
    const disabled = refresh.state.watched.filter(repo => repo.disabled && (ui.repoIds === null || ui.repoIds.includes(repo.id)));
    ui.repoIds = [...document.querySelectorAll('[data-scope-repo]:checked')]
      .filter(input => input instanceof HTMLInputElement)
      // The selector guarantees data-scope-repo, so the fallback never applies.
      .map(input => input.dataset.scopeRepo ?? '')
      .concat(disabled.map(repo => repo.id));
    activityChanged();
  }
  if (target.id === 'connection-repo') {
    connection.select(target.value);
    renderPage();
  }
  if (target instanceof HTMLInputElement && target.matches('[data-repo-toggle]')) {
    const control = target;
    const repo = refresh.state.watched.find(item => item.id === control.dataset.id);
    if (pending.has('repos') || !repo) {
      control.checked = !repo?.disabled;
      return;
    }
    const enabled = control.checked;
    void withAction('repos', async () => {
      try {
        await request('PATCH /api/repos/:id', { params: { id: repo.id }, body: { disabled: !enabled } });
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
    if (pending.has('settings')) {
      target.checked = refresh.state.settings.refreshEnabled;
      return;
    }
    void withAction('settings', async () => {
      try {
        await request('PATCH /api/settings', { body: { refreshEnabled: checked } });
        await load({ force: true });
      } finally {
        for (const control of document.querySelectorAll('[data-auto-toggle]')) {
          if (control instanceof HTMLInputElement) control.checked = refresh.state.settings.refreshEnabled;
        }
      }
    });
  }
});

document.addEventListener('keydown', event => {
  const monitoring = header.querySelector('.header-overflow[open]');
  if (event.key === 'Escape' && monitoring instanceof HTMLDetailsElement && monitoring.contains(document.activeElement)) {
    monitoring.open = false;
    required('summary', HTMLElement, monitoring).focus();
    return;
  }
  if (
    event.key === '/' &&
    !anyDialogOpen() &&
    !savedFilterPicker.expanded &&
    !savedFilterActions.expanded &&
    !['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement?.tagName ?? '')
  ) {
    if (ui.route === 'graph') {
      const search = document.getElementById('graph-search');
      if (search) {
        event.preventDefault();
        search.focus();
      }
      return;
    }
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
  // The branch picker belongs to the view that opened it.
  branchPicker.close();
  const previous = ui.route;
  const { destination, capacity, scrollToTop } = navigation.enter(refresh.loaded ? refresh.state.watched : null);
  focusRelatedCi = destination === 'event' && Boolean(ui.relatedCi);
  let restoredGraph = false;
  if (destination === 'graph') restoredGraph = graph.enter(previous);
  else graph.leave(previous, destination);
  if (isActivity(destination)) refresh.resetActivity(capacity);
  else if (destination === 'event') refresh.prepareDetail(ui.eventId);
  render();
  const needsActivity = isActivity(destination) || destination === 'event';
  void load({ force: needsActivity });
  if (ui.route === 'graph' || ui.route === 'event') refreshViewCheckout(true);
  if (!restoredGraph && (destination === 'graph' || (needsActivity && scrollToTop))) window.scrollTo({ top: 0, behavior: 'instant' });
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
  ui.openMenu = '';
  if (isActivity(ui.route)) renderPage();
});
navigation.initialize();
await load({ force: true });
setInterval(() => {
  if (!document.hidden) void load();
}, 5000);
