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

const page = document.querySelector('#page');
const header = document.querySelector('#header');
const dialog = document.querySelector('#confirm-dialog');
const ui = {
  route: 'catchup', eventId: null, repoIds: null, search: '', kind: '',
  filtersOpen: undefined, activityRoute: 'catchup',
};
let pendingConfirmation;
let dialogOpener;
let busy = false;
let lastRendered = {};
let toastTimer;

let searchTimer;
const connection = createConnectionController({ request, render() {
  if (ui.route === 'settings') renderPage();
  const status = document.querySelector('#connection-status');
  if (status) {
    const focused = status.contains(document.activeElement);
    status.innerHTML = connectionResult(connection.state.results.get(''));
    if (focused) status.querySelector('button')?.focus({ preventScroll: true });
  }
} });
ui.connection = connection.state;
const commitResults = new Map();
const picker = createRepositoryPicker({ request, getRepos: () => refresh.state.watched, onAdded: async count => { await load({ force: true }); toast(`${count} repositories watched.`); } });
const typeFilter = createTypeFilter({ onChange: value => { ui.kind = value; activityChanged(); } });
const historyImport = createHistoryImport(document.querySelector('#history-dialog'), {
  start: (repoId, days) => request('/api/backfill', { method: 'POST', body: { repoId, days } }),
  onStarted: async id => {
    await load({ force: true });
    if (document.activeElement === document.body || document.activeElement?.id === `import-${id}`) {
      document.getElementById(`history-${id}`)?.focus({ preventScroll: true });
    }
    toast('History import requested.');
  },
});

const seen = createSeenActions({ page, request, getEvents: () => refresh.state.events,
  reload: () => load({ force: true }), toast });
const view = createBrowserView({ page, header, demo: document.querySelector('#demo'),
  picker, typeFilter, onPageRendered: seen.updateShownCount });
const checkoutPanel = createCheckoutPanel({ page, request,
  isVisible: () => ui.route === 'repositories' && !refresh.state.demo && refresh.state.repos.some(repo => repo.localPath) });
const navigation = createNavigation({ ui, captureGroups: view.captureGroups, activityCapacity: () => refresh.capacity() });

function renderOptions() {
  const restored = navigation.takeRestoration(refresh.state.activity?.loading);
  const { generation } = navigation.view();
  return {
    restored, returnRoute: navigation.returnRoute, commits: commitResults.get(ui.eventId), checkouts: checkoutPanel.snapshots,
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

function refreshTarget(force) {
  return view.refreshTarget(force, busy || dialog.open || historyImport.open || ui.route === 'repositories' && picker.active());
}

function activityChanged({ debounce = false, header = false } = {}) {
  navigation.invalidate();
  refresh.resetActivity();
  if (header) render(); else renderPage();
  clearTimeout(searchTimer);
  if (debounce) searchTimer = setTimeout(() => { void load({ force: true }); }, 250);
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
    if (document.querySelector('#notice')?.dataset.networkError) clearNotice();
    void checkoutPanel.refresh();
  },
  onError(error, force) {
    showError(`Cannot refresh local state: ${error.message} Last loaded events remain visible.`, true);
    if (isActivity(ui.route) && refreshTarget(force)) renderPage();
    if (ui.route === 'event' && !refresh.state.events.some(event => event.id === ui.eventId)) renderPage();
  },
});
const load = refresh.load;

function showError(message, network = false) {
  const notice = document.querySelector('#notice');
  notice.innerHTML = `<div class="banner crit" role="alert"><span class="ic">!</span><div><strong>Something needs attention</strong><span class="error-message">${e(message)}</span> <button class="ghost sm" type="button" data-action="dismiss-error">Dismiss</button></div></div>`;
  if (network) notice.dataset.networkError = 'true';
  else delete notice.dataset.networkError;
}

function clearNotice() {
  const notice = document.querySelector('#notice');
  notice.innerHTML = '';
  delete notice.dataset.networkError;
}

function toast(message, { undo = false } = {}) {
  const element = document.querySelector('#toast');
  clearTimeout(toastTimer);
  element.innerHTML = `${e(message)}${undo ? '<button type="button" data-action="undo-ack">Undo</button>' : ''}`;
  element.hidden = false;
  toastTimer = setTimeout(() => { element.hidden = true; }, undo ? 20000 : 6000);
}

function confirm(title, description, callback, label = 'Confirm', { subject = '', destructive = false } = {}) {
  pendingConfirmation = callback;
  dialogOpener = document.activeElement;
  document.querySelector('#confirm-title').textContent = title;
  const subjectLine = document.querySelector('#confirm-subject');
  subjectLine.textContent = subject;
  subjectLine.hidden = !subject;
  document.querySelector('#confirm-description').textContent = description;
  const button = document.querySelector('#confirm-button');
  button.textContent = label;
  button.classList.toggle('danger', destructive);
  dialog.showModal();
}

function closeDialog() {
  dialog.close();
  pendingConfirmation = null;
  if (dialogOpener?.isConnected) dialogOpener.focus({ preventScroll: true });
}

async function withAction(callback) {
  if (busy) return;
  busy = true;
  try { await callback(); } catch (error) { showError(error.message); }
  finally { busy = false; }
}

function setRefreshPending(pending) {
  ui.refreshing = pending;
  for (const button of header.querySelectorAll('[data-action="refresh"]')) {
    button.setAttribute('aria-busy', String(pending));
    button.setAttribute('aria-disabled', String(pending));
    button.title = pending ? 'Refreshing activity…' : button.dataset.idleTitle;
  }
}

const actions = {
  ...createCheckoutActions({ checkoutPanel, confirm, toast }),
  'load-more-activity': async () => { await load({ force: true, more: true }); },
  'retry-activity': async () => { await load({ force: true }); },
  'open-history-import': element => {
    const repo = refresh.state.repos.find(item => item.id === element.dataset.id);
    if (repo) historyImport.show(repo);
  },
  'copy-diagnostics': async () => {
    try {
      await navigator.clipboard.writeText(JSON.stringify({ ...refresh.state.diagnostics, mergeQueue: refresh.state.mergeQueue }, null, 2));
      toast('Diagnostics copied.');
    } catch { toast('Copy is unavailable in this browser.'); }
  },
  'check-connection': element => { void connection.check(element.dataset.repoId || '', { force: true }); },
  'refresh': async () => {
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
  'detail': element => { navigation.remember(element.dataset.id); location.hash = `event/${encodeURIComponent(element.dataset.id)}`; },
  'back-to-results': () => { location.hash = activityHref(navigation.returnRoute); },
  'copy-commit': async element => {
    try { await navigator.clipboard.writeText(element.dataset.value || ''); toast('Commit copied.'); }
    catch { toast('Copy unavailable in this browser. Open Azure DevOps to copy the full commit.'); }
  },
  ...seen.actions,
  'cancel-dialog': closeDialog,
  'confirm-dialog': async () => { const callback = pendingConfirmation; closeDialog(); if (callback) await callback(); },
  'clear-filters': () => { ui.search = ''; ui.kind = ''; activityChanged(); },
  'dismiss-error': clearNotice,
  'all-repos': () => { ui.repoIds = null; activityChanged({ header: true }); },
  'no-repos': () => { ui.repoIds = []; activityChanged({ header: true }); },
  'remove-repo': element => {
    const repo = refresh.state.watched.find(item => item.id === element.dataset.id);
    confirm(`Remove ${repo.name} from this app?`, 'This deletes its local watch and cached history only. The checkout, Azure repository and remote data are unchanged.', async () => {
      await request(`/api/repos/${encodeURIComponent(repo.id)}`, { method: 'DELETE' });
      await load({ force: true });
    }, 'Remove local watch');
  },
  'load-commits': async element => {
    const { eventId } = ui;
    try { commitResults.set(eventId, await request(`/api/push/${encodeURIComponent(element.dataset.repoId)}/${encodeURIComponent(element.dataset.pushId)}/commits`)); }
    catch (error) { commitResults.set(eventId, { error: error.message }); }
    if (ui.route === 'event' && ui.eventId === eventId) renderPage();
  },
};

document.addEventListener('click', event => {
  const monitoring = header.querySelector('.header-overflow[open]');
  if (monitoring && !monitoring.contains(event.target)) monitoring.open = false;
  const theme = event.target.closest('[data-theme]');
  if (theme) { window.repoPulseTheme?.set(theme.dataset.theme); return; }
  if (event.target.closest('#repo-toggle')) {
    const panel = document.querySelector('#repo-panel');
    panel.hidden = !panel.hidden;
    document.querySelector('#repo-toggle').setAttribute('aria-expanded', String(!panel.hidden));
    return;
  }
  const panel = document.querySelector('#repo-panel');
  if (panel && !panel.hidden && !event.target.closest('#repo-panel')) {
    panel.hidden = true;
    document.querySelector('#repo-toggle').setAttribute('aria-expanded', 'false');
  }
  const element = event.target.closest('[data-action]');
  if (element && actions[element.dataset.action]) {
    event.preventDefault();
    void withAction(() => actions[element.dataset.action](element));
  }
});

document.addEventListener('input', event => {
  if (event.target.id === 'feed-search') { ui.search = event.target.value; activityChanged({ debounce: true }); }
});

document.addEventListener('change', event => {
  if (event.target.matches('[data-scope-repo]')) {
    ui.repoIds = [...document.querySelectorAll('[data-scope-repo]:checked')].map(input => input.dataset.scopeRepo);
    activityChanged();
    view.updateScopeLabel(refresh.state, ui);
  }
  if (event.target.id === 'connection-repo') {
    connection.select(event.target.value);
    renderPage();
  }
  if (event.target.matches('[data-repo-toggle]')) {
    const control = event.target;
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
  if (event.target.matches('[data-auto-toggle]')) {
    const checked = event.target.checked;
    if (busy) {
      event.target.checked = refresh.state.settings.refreshEnabled !== false;
      return;
    }
    void withAction(async () => {
      try {
        await request('/api/settings', { method: 'POST', body: { refreshEnabled: checked } });
        await load({ force: true });
      } finally {
        for (const control of document.querySelectorAll('[data-auto-toggle]')) {
          control.checked = refresh.state.settings.refreshEnabled !== false;
        }
      }
    });
  }
});

page.addEventListener('toggle', seen.updateShownCount, true);
page.addEventListener('click', event => {
  if (!event.target.closest('details[data-filter-panel] > summary')) return;
  const filters = event.target.closest('details[data-filter-panel]');
  requestAnimationFrame(() => { if (filters.isConnected) ui.filtersOpen = filters.open; });
});
dialog.addEventListener('cancel', () => { pendingConfirmation = null; });
document.addEventListener('keydown', event => {
  const monitoring = header.querySelector('.header-overflow[open]');
  if (event.key === 'Escape' && monitoring?.contains(document.activeElement)) {
    monitoring.open = false;
    monitoring.querySelector('summary').focus();
    return;
  }
  if (event.key === 'Escape' && !document.querySelector('#repo-panel')?.hidden) {
    document.querySelector('#repo-panel').hidden = true;
    document.querySelector('#repo-toggle').setAttribute('aria-expanded', 'false');
    document.querySelector('#repo-toggle').focus();
  }
  if (event.key === '/' && !dialog.open && !historyImport.open && !['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement?.tagName)) {
    event.preventDefault(); document.querySelector('#feed-search')?.focus();
  }
});

function route() {
  clearTimeout(searchTimer);
  const { destination, capacity, scrollToTop } = navigation.enter(refresh.state.repos);
  if (isActivity(destination)) refresh.resetActivity(capacity);
  else if (destination === 'event') refresh.prepareDetail(ui.eventId);
  render();
  const needsActivity = isActivity(destination) || destination === 'event';
  void load({ force: needsActivity });
  if (needsActivity && scrollToTop) window.scrollTo({ top: 0, behavior: 'instant' });
}

window.addEventListener('hashchange', route);
window.addEventListener('focus', () => { void load(); });
document.addEventListener('visibilitychange', () => { if (!document.hidden) void load(); });
window.matchMedia('(min-width:640px)').addEventListener('change', () => {
  if (['catchup', 'activity'].includes(ui.route)) renderPage();
});
navigation.initialize();
await load({ force: true });
setInterval(() => { if (!document.hidden) void load(); }, 5000);
