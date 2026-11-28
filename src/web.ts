import { request } from './api.ts';
import { createActivityController } from './ui/activity-controller.ts';
import { detailView } from './ui/activity-detail.ts';
import { createDispatcher, type ActionName, type Actions } from './ui/actions.ts';
import { createBrowserUi, createBrowserView, replacementFocus } from './ui/browser-view.ts';
import { createCheckoutActions } from './ui/checkout-actions.ts';
import { createCheckoutPanel } from './ui/checkout.ts';
import { createCommands } from './ui/commands.ts';
import { createConfirmation } from './ui/confirm.ts';
import { createConnectionController, renderConnectionStatus } from './ui/connection.ts';
import { createDetailController } from './ui/detail-controller.ts';
import { anyDialogOpen } from './ui/dialog.ts';
import { localDay } from './ui/format.ts';
import { required } from './ui/dom.ts';
import { createFeedback } from './ui/feedback.ts';
import { createGraphController } from './ui/git-graph.ts';
import { createGroupState } from './ui/groups.ts';
import { createHeaderActions } from './ui/header-actions.ts';
import { createMenuManager } from './ui/menus.ts';
import { createNavigation, isActivity } from './ui/navigation.ts';
import { createRefreshController, type PageState } from './ui/refresh.ts';
import { createRepositoriesController } from './ui/repositories-controller.ts';
import { createRepositoryScope } from './ui/repository-scope.ts';
import { createSavedFilterActions } from './ui/saved-filter-actions.ts';
import { createSavedFilterMenus } from './ui/saved-filters.ts';
import { createSettingsController } from './ui/settings-controller.ts';
import { createTypeFilter } from './ui/type-filter.ts';
import { listenForSearchKey } from './ui/search-field.ts';
import { WIDE_LAYOUT } from './ui/breakpoints.ts';
import type { Shell } from './ui/shell.ts';

// Composition: the shared services, the route controllers and the one action table, then routing and start-up.
const page = required('#page');
const header = required('#header');
const feedback = createFeedback();
const confirmation = createConfirmation(required('#confirm-dialog', HTMLDialogElement), { replacement: replacementFocus });
const commands = createCommands({ report: feedback.reportError, confirmed: () => confirmation.resource });
const groups = createGroupState();
const connection = createConnectionController({
  request,
  render() {
    if (ui.route === 'settings') renderPage();
    renderConnectionStatus(connection.state);
  },
});
const ui = createBrowserUi(connection.state, groups.open);
const menus = createMenuManager(ui);
const savedFilterMenus = createSavedFilterMenus(menus);
const navigation = createNavigation({ ui, captureGroups: groups.snapshot, activityCapacity: () => refresh.capacity() });
let lastRendered: { metadata?: string; activity?: PageState['activity']; detail?: PageState['detail']; day?: string } = {};
const refresh = createRefreshController({
  request,
  getView: navigation.view,
  reconcile(next) {
    navigation.reconcileRepositories(next.allRepos);
    if (ui.savedFilterId && !next.savedFilters.some(filter => filter.id === ui.savedFilterId)) ui.savedFilterId = '';
  },
  onUpdate({ metadata, force }) {
    const { activity, detail } = refresh.state;
    // The answer can change which repository the graph shows; its history loads before any render, checkout read or
    // probe, even when a focused control holds off the full render. A changed repository renders the graph regardless.
    let graphChanged = ui.route === 'graph' && graph.sync();
    // Day headers name today and yesterday, so a new local day renders again even when the server state is the same.
    const day = localDay(Date.now());
    if (
      force ||
      metadata !== lastRendered.metadata ||
      activity !== lastRendered.activity ||
      detail !== lastRendered.detail ||
      day !== lastRendered.day
    ) {
      if (refreshTarget(force) === 'full') {
        render();
        lastRendered = { metadata, activity, detail, day };
        graphChanged = false;
      }
    }
    if (graphChanged) renderPage();
    feedback.clearNetworkError();
    void checkoutPanel.refresh();
    checkoutPanel.readShown();
    if (ui.route === 'graph') void graph.refresh();
  },
  onError(error, force) {
    feedback.showError(`Cannot refresh local state: ${error.message} Last loaded events remain visible.`, true);
    if (isActivity(ui.route) && refreshTarget(force)) renderPage();
    if (ui.route === 'event' && !detailView(refresh.state, ui.eventId)) renderPage();
  },
});
const load = refresh.load;
const shell: Shell = {
  ui,
  page,
  request,
  state: () => refresh.state,
  load,
  renderPage,
  navigation,
  feedback,
  commands,
  confirm: confirmation.ask,
};
const checkoutPanel = createCheckoutPanel({
  page,
  groups: ui.groups,
  request,
  isVisible: () => ui.route === 'repositories' && !refresh.state.demo && refresh.state.enabledRepos.some(repo => repo.localPath),
  shown() {
    if (ui.route !== 'graph' || refresh.state.demo) return detail.activityCheckout()?.repoId;
    const { repo } = graph.selection();
    return repo?.localPath ? repo.id : undefined;
  },
  onShownChange: renderPage,
  onMutation: id => graph.checkoutChanged(id),
});
const detail = createDetailController(shell, currentView);
const activity = createActivityController(shell, () => refresh.resetActivity());
const repositories = createRepositoriesController(shell, { menus, checkouts: () => checkoutPanel.snapshots });
const view = createBrowserView({
  page,
  header,
  demo: required('#demo'),
  syncLive: required('#sync-live'),
  picker: repositories.picker,
  toolbarMenus: {
    '.type-menu': createTypeFilter(menus),
    '.scope-menu': createRepositoryScope(menus),
    '.saved-filter-menu': savedFilterMenus.list,
    '.saved-filter-actions': savedFilterMenus.commands,
  },
  groups,
});
const graph = createGraphController({
  request,
  page,
  state: () => refresh.state,
  scope: () => ui.repoIds,
  isActive: () => ui.route === 'graph',
  render: renderPage,
  checkout: id => checkoutPanel.snapshots[id],
  readCheckout: () => checkoutPanel.readShown(true),
  currentView,
  onRepositoryChoice() {
    repositories.closeBranchPicker();
    navigation.invalidate();
  },
});

/** A check that the page shown now is still the one shown when it was made, on the graph with the same checkout. */
function currentView() {
  return navigation.currentView(() => {
    const repo = ui.route === 'graph' ? graph.selection().repo : undefined;
    return repo && JSON.stringify([repo.id, repo.localPath]);
  });
}

function renderOptions() {
  const restored = navigation.takeRestoration(refresh.state.activity.loading);
  const { generation } = navigation.view();
  return {
    restored,
    returnUnseenOnly: navigation.returnUnseenOnly,
    returnToGraph: graph.returnsHere,
    showRelated: Boolean(ui.relatedCi),
    matchingIds: navigation.matchingIds,
    commits: detail.loaded(),
    feedCommits: detail.feedCommits,
    ...(ui.route === 'graph' ? { graph: graph.render() } : {}),
    checkouts: checkoutPanel.snapshots,
    checkoutFocus: navigation.takeCheckoutFocus(refresh.state.allRepos),
    isCurrent: () => navigation.view().generation === generation,
  };
}

function renderPage() {
  view.renderPage(refresh.state, ui, renderOptions());
  detail.revealRelatedCi();
}

function render() {
  view.render(refresh.state, ui, renderOptions());
  detail.revealRelatedCi();
  if (ui.route === 'repositories') void connection.check();
}

function refreshTarget(force: boolean) {
  return view.refreshTarget(force, commands.busy || anyDialogOpen() || (ui.route === 'repositories' && repositories.picker.active()));
}

const actions: Actions<ActionName> = {
  ...activity.actions,
  ...createSavedFilterActions(shell, activity.applySavedFilter),
  ...detail.actions,
  ...graph.actions,
  ...repositories.actions,
  ...checkoutPanel.actions,
  ...createCheckoutActions({
    checkoutPanel,
    getActivityCheckout: detail.activityCheckout,
    confirm: (title, description, callback, label, options) =>
      confirmation.ask(title, description, callback, label, { ...options, resource: 'checkout' }),
    toast: feedback.toast,
    closeBranchPicker: repositories.closeBranchPicker,
    currentView,
  }),
  ...createSettingsController(shell, {
    connection,
    onReset() {
      activity.seen.forgetUndo();
      feedback.hideUndo();
      detail.forgetCommits();
    },
  }),
  ...createHeaderActions(shell, { header, renderHeader: () => view.renderHeader(refresh.state, ui) }),
  ...groups.actions,
  'confirm-dialog': () => confirmation.accept(),
  'dismiss-error': feedback.clearNotice,
};
createDispatcher({
  actions,
  run: (name, callback) => void commands.run(commands.resourceOf(name), callback),
  report: feedback.reportError,
});

listenForSearchKey({
  blocked: () => anyDialogOpen() || savedFilterMenus.list.expanded || savedFilterMenus.commands.expanded,
  focus: () => (ui.route === 'graph' ? graph.focusSearch() : activity.focusSearch()),
});

function route() {
  activity.leave();
  // The branch picker belongs to the view that opened it.
  repositories.closeBranchPicker();
  const previous = ui.route;
  const { destination, capacity, scrollToTop } = navigation.enter(refresh.loaded ? refresh.state.allRepos : null);
  detail.enter(destination);
  let restoredGraph = false;
  if (destination === 'graph') restoredGraph = graph.enter(previous);
  else graph.leave(previous, destination);
  if (isActivity(destination)) refresh.resetActivity(capacity);
  else if (destination === 'event') refresh.prepareDetail(ui.eventId);
  render();
  const needsActivity = isActivity(destination) || destination === 'event';
  void load({ force: needsActivity });
  if (ui.route === 'graph' || ui.route === 'event') checkoutPanel.readShown(true);
  if (!restoredGraph && (destination === 'graph' || (needsActivity && scrollToTop))) window.scrollTo({ top: 0, behavior: 'instant' });
}

window.addEventListener('hashchange', route);
// `toggle` does not bubble, so the capture phase sees every disclosure.
document.addEventListener('toggle', event => groups.follow(event), true);
window.addEventListener('focus', () => {
  void load();
});
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) void load();
});
window.matchMedia(WIDE_LAYOUT).addEventListener('change', () => {
  // The filter bar changes layout, so an open toolbar menu closes and focus returns to its toggle. Other pages keep
  // their menus: the Repositories picker stays open and tracked.
  if (!isActivity(ui.route)) return;
  ui.openMenu = '';
  renderPage();
});
navigation.initialize();
await load({ force: true });
setInterval(() => {
  if (!document.hidden) void load();
}, 5000);
