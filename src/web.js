import { request } from './api.js';
import { createCheckoutActions } from './ui/checkout-actions.js';
import { createCheckoutPanel } from './ui/checkout.js';
import { connectionResult, createConnectionController } from './ui/connection.js';
import { escape as e } from './ui/format.js';
import { createRepositoryPicker } from './ui/repository-picker.js';
import { createNavigation, activityHref, isActivity } from './ui/navigation.js';
import { createTypeFilter } from './ui/type-filter.js';
import { createRefreshController } from './ui/refresh.js';
import { createBrowserView } from './ui/browser-view.js';
import { createSeenActions } from './ui/seen-actions.js';
import { createHistoryImport } from './ui/history-import.js';
import { required } from './ui/dom.js';

/** @typedef {import('./ui/refresh.js').PageState} PageState */
/** @typedef {import('./ui/checkout-actions.js').Action} Action */
/** web/theme.js publishes this before the modules load. @typedef {Window & { repoPulseTheme?: { set: (value: string) => void } }} ThemedWindow */

const page = required('#page');
const header = required('#header');
const dialog = required('#confirm-dialog', HTMLDialogElement);
/** @type {(() => Promise<void>) | null} */
let pendingConfirmation;
/** @type {HTMLElement | SVGElement | null} */
let dialogOpener;
let busy = false;
/** @type {{ metadata?: string, activity?: PageState['activity'], events?: PageState['events'] }} */
let lastRendered = {};
/** @type {ReturnType<typeof setTimeout> | undefined} */
let toastTimer;

/** @type {ReturnType<typeof setTimeout> | undefined} */
let searchTimer;
const connection = createConnectionController({
  request,
  render() {
    if (ui.route === 'settings') renderPage();
    const status = document.querySelector('#connection-status');
    if (status) {
      const focused = status.contains(document.activeElement);
      status.innerHTML = connectionResult(connection.state.results.get(''));
      if (focused) status.querySelector('button')?.focus({ preventScroll: true });
    }
  },
});
/** @type {import('./ui/browser-view.js').BrowserUi} */
const ui = {
  route: 'catchup',
  eventId: null,
  repoIds: null,
  search: '',
  kind: '',
  filtersOpen: undefined,
  activityRoute: 'catchup',
  connection: connection.state,
};
/** Data each detail page loaded on request, by event. @type {Map<string | null, import('./ui/activity-detail.js').LoadedView>} */
const commitResults = new Map();
const picker = createRepositoryPicker({
  request,
  getRepos: () => refresh.state.watched,
  onAdded: async count => {
    await load({ force: true });
    toast(`${count} repositories watched.`);
  },
});
const typeFilter = createTypeFilter({
  onChange: value => {
    // Every type option carries data-kind, so the fallback never applies.
    ui.kind = value ?? '';
    activityChanged();
  },
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

const seen = createSeenActions({ page, request, getEvents: () => refresh.state.events, reload: () => load({ force: true }), toast });
const view = createBrowserView({
  page,
  header,
  demo: required('#demo'),
  syncLive: required('#sync-live'),
  picker,
  typeFilter,
  onPageRendered: seen.updateShownCount,
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
    commits: commitResults.get(ui.eventId),
    checkouts: checkoutPanel.snapshots,
    isCurrent: () => navigation.view().generation === generation,
  };
}

function renderPage() {
  view.renderPage(refresh.state, ui, renderOptions());
}

function render() {
  view.render(refresh.state, ui, renderOptions());
  if (ui.route === 'repositories') void connection.check();
}

/** @param {boolean} force */
function refreshTarget(force) {
  return view.refreshTarget(force, busy || dialog.open || historyImport.open || (ui.route === 'repositories' && picker.active()));
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
    const { activity, events } = refresh.state;
    if (force || metadata !== lastRendered.metadata || activity !== lastRendered.activity || events !== lastRendered.events) {
      const target = refreshTarget(force);
      if (target === 'page') renderPage();
      if (target === 'full') {
        render();
        lastRendered = { metadata, activity, events };
      }
    }
    if (required('#notice').dataset.networkError) clearNotice();
    void checkoutPanel.refresh();
  },
  onError(error, force) {
    showError(`Cannot refresh local state: ${error.message} Last loaded events remain visible.`, true);
    if (isActivity(ui.route) && refreshTarget(force)) renderPage();
    if (ui.route === 'event' && !refresh.state.events.some(event => event.id === ui.eventId)) renderPage();
  },
});
const load = refresh.load;

/** @param {string} message */
function showError(message, network = false) {
  const notice = required('#notice');
  notice.innerHTML = `<div class="banner crit" role="alert"><span class="ic">!</span><div><strong>Something needs attention</strong><span class="error-message">${e(message)}</span> <button class="ghost sm" type="button" data-action="dismiss-error">Dismiss</button></div></div>`;
  if (network) notice.dataset.networkError = 'true';
  else delete notice.dataset.networkError;
}

function clearNotice() {
  const notice = required('#notice');
  notice.innerHTML = '';
  delete notice.dataset.networkError;
}

/** @param {string} message */
function toast(message, { undo = false } = {}) {
  const element = required('#toast');
  clearTimeout(toastTimer);
  element.innerHTML = `${e(message)}${undo ? '<button type="button" data-action="undo-ack">Undo</button>' : ''}`;
  element.hidden = false;
  toastTimer = setTimeout(
    () => {
      element.hidden = true;
    },
    undo ? 20000 : 6000,
  );
}

/** @param {string} title @param {string} description @param {() => Promise<void>} callback */
function confirm(title, description, callback, label = 'Confirm', { subject = '', destructive = false } = {}) {
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
  if (dialogOpener?.isConnected) dialogOpener.focus({ preventScroll: true });
}

/** @param {() => unknown} callback */
async function withAction(callback) {
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

/** @param {boolean} pending */
function setRefreshPending(pending) {
  ui.refreshing = pending;
  for (const button of header.querySelectorAll('[data-action="refresh"]')) {
    if (!(button instanceof HTMLElement)) continue;
    button.setAttribute('aria-busy', String(pending));
    button.setAttribute('aria-disabled', String(pending));
    // The header renders data-idle-title on every refresh button, so the fallback never applies.
    button.title = pending ? 'Refreshing activity…' : (button.dataset.idleTitle ?? '');
  }
}

/** @type {Record<string, Action>} */
const actions = {
  ...createCheckoutActions({ checkoutPanel, confirm, toast }),
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
    navigation.remember(element.dataset.id ?? null);
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
  'cancel-dialog': closeDialog,
  'confirm-dialog': async () => {
    const callback = pendingConfirmation;
    closeDialog();
    if (callback) await callback();
  },
  'clear-filters': () => {
    ui.search = '';
    ui.kind = '';
    activityChanged();
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
    // web/theme.js defines repoPulseTheme on window before this module loads; the optional call covers its absence.
    /** @type {ThemedWindow} */ (window).repoPulseTheme?.set(theme.dataset.theme ?? '');
    return;
  }
  if (target.closest('#repo-toggle')) {
    const panel = required('#repo-panel');
    panel.hidden = !panel.hidden;
    required('#repo-toggle').setAttribute('aria-expanded', String(!panel.hidden));
    return;
  }
  const panel = document.querySelector('#repo-panel');
  if (panel instanceof HTMLElement && !panel.hidden && !target.closest('#repo-panel')) {
    panel.hidden = true;
    required('#repo-toggle').setAttribute('aria-expanded', 'false');
  }
  const element = target.closest('[data-action]');
  const action = element instanceof HTMLElement ? element.dataset.action : undefined;
  if (element instanceof HTMLElement && action && actions[action]) {
    event.preventDefault();
    void withAction(() => actions[action](element));
  }
});

document.addEventListener('input', event => {
  if (event.target instanceof HTMLInputElement && event.target.id === 'feed-search') {
    ui.search = event.target.value;
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

page.addEventListener('toggle', seen.updateShownCount, true);
page.addEventListener('click', event => {
  const target = event.target;
  if (!(target instanceof Element)) return;
  if (!target.closest('details[data-filter-panel] > summary')) return;
  const filters = target.closest('details[data-filter-panel]');
  if (!(filters instanceof HTMLDetailsElement)) return;
  requestAnimationFrame(() => {
    if (filters.isConnected) ui.filtersOpen = filters.open;
  });
});
dialog.addEventListener('cancel', () => {
  pendingConfirmation = null;
});
document.addEventListener('keydown', event => {
  const monitoring = header.querySelector('.header-overflow[open]');
  if (event.key === 'Escape' && monitoring instanceof HTMLDetailsElement && monitoring.contains(document.activeElement)) {
    monitoring.open = false;
    required('summary', HTMLElement, monitoring).focus();
    return;
  }
  // The header, and with it the scope panel, renders only after the first state load.
  const panel = document.querySelector('#repo-panel');
  if (event.key === 'Escape' && panel instanceof HTMLElement && panel.hidden === false) {
    panel.hidden = true;
    const toggle = required('#repo-toggle');
    toggle.setAttribute('aria-expanded', 'false');
    toggle.focus();
  }
  if (
    event.key === '/' &&
    !dialog.open &&
    !historyImport.open &&
    !['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement?.tagName ?? '')
  ) {
    event.preventDefault();
    const search = document.querySelector('#feed-search');
    if (search instanceof HTMLElement) search.focus();
  }
});

function route() {
  clearTimeout(searchTimer);
  const { destination, capacity, scrollToTop } = navigation.enter(refresh.state.watched);
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
  if (['catchup', 'activity'].includes(ui.route)) renderPage();
});
navigation.initialize();
await load({ force: true });
setInterval(() => {
  if (!document.hidden) void load();
}, 5000);
