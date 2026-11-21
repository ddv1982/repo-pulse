import { emptyHtml, html } from './format.js';
import { required, setHtml } from './dom.js';

/** @typedef {import('../../server.js').FoldersResponse} FoldersResponse */
/** @typedef {import('../../server.js').Repository} Repository */
/** @typedef {import('../../server/repositories.js').DiscoveredRemote} DiscoveredRemote */
/** A subfolder row, or the row that leads up to the parent folder. @typedef {FoldersResponse['folders'][number] & { up?: boolean }} FolderOption */
/** One remote of a local checkout: a checkout with several remotes gets one row per remote. @typedef {{ localPath: string, remote: DiscoveredRemote, multiple: boolean }} CheckoutItem */
/** Whether the listed checkouts span several organizations or projects, so rows must name them. @typedef {{ organizations: boolean, projects: boolean }} Mixed */
/**
 * @typedef {object} PickerHost
 * @property {typeof import('../api.js').request} request
 * @property {() => Repository[]} getRepos The watched repositories; their checkouts are shown as already watched.
 * @property {(count: number) => unknown} onAdded Called after at least one repository was added.
 */

const KEY = 'repo-pulse-picker-folder';
/** @param {CheckoutItem} item */
const keyOf = item => JSON.stringify([item.localPath, item.remote.name]);
/** @param {unknown} value */
const lower = value => String(value || '').toLowerCase();
/** @param {string} [path] */
const homePrefix = path => String(path || '').match(/^(\/home\/[^/]+|\/Users\/[^/]+)(?=\/|$)|^([A-Za-z]:\\Users\\[^\\]+)(?=\\|$)/)?.[0];

/** @param {string} path @param {string} [root] */
export function displayLocalPath(path, root) {
  const value = String(path || '');
  const home = homePrefix(value);
  if (home) return `~${value.slice(home.length)}`;
  if (root && (value.startsWith(`${root}/`) || value.startsWith(`${root}\\`))) return `.${value.slice(root.length)}`;
  return value;
}
/** @param {string} text @param {string} query */
function highlight(text, query) {
  const index = lower(text).indexOf(lower(query));
  return !query || index < 0
    ? html`${text}`
    : html`${text.slice(0, index)}<mark>${text.slice(index, index + query.length)}</mark>${text.slice(index + query.length)}`;
}

/** @param {unknown} cause */
const messageOf = cause => (cause instanceof Error ? cause.message : String(cause));

/** Self-contained local picker: no Azure reads until the explicit commit action. @param {PickerHost} callbacks */
export function createRepositoryPicker({ request, getRepos, onAdded }) {
  /** @type {HTMLElement | undefined} */
  let host;
  /** @type {HTMLElement | undefined} */
  let boundHost;
  /** @type {FoldersResponse | undefined} The folder whose checkouts are listed, or the one being browsed. */
  let data;
  /** @type {FoldersResponse | undefined} The listed folder before browsing started, restored on Cancel. */
  let beforeBrowse;
  /** @type {'checkouts' | 'folders'} */
  let mode = 'checkouts';
  let query = '',
    open = false,
    active = 0;
  let loading = false,
    adding = false,
    error = '',
    message = '',
    generation = 0;
  /** @type {string | undefined} */
  let remembered;
  /** @type {Map<string, CheckoutItem>} */
  const selected = new Map();
  try {
    remembered = localStorage.getItem(KEY) || undefined;
  } catch {
    /* Optional browser preference. */
  }
  /** @returns {CheckoutItem[]} */
  const items = () =>
    (data?.repositories || []).flatMap(repo =>
      repo.remotes.map(remote => ({ localPath: repo.localPath, remote, multiple: repo.remotes.length > 1 })),
    );
  /** @param {CheckoutItem} item */
  const watched = item =>
    getRepos().some(
      repo =>
        repo.localPath &&
        lower(repo.organization) === lower(item.remote.organization) &&
        lower(repo.project) === lower(item.remote.project) &&
        lower(repo.name) === lower(item.remote.repoName),
    );
  /** @param {Event} event */
  function closeOutside(event) {
    const target = event.target;
    if (!open || adding || !host?.isConnected || !(target instanceof Node) || !target.isConnected || host.contains(target)) return;
    open = false;
    render();
  }
  // One listener per picker instance, not one per mount/re-render.
  document.addEventListener('pointerdown', closeOutside);
  document.addEventListener('focusin', closeOutside);
  /** @returns {FolderOption[] | CheckoutItem[]} */
  function options() {
    return mode === 'folders' ? folderOptions() : checkoutOptions();
  }
  /** @returns {FolderOption[]} */
  function folderOptions() {
    return [
      ...(data?.parent ? [{ name: 'Up one folder', path: data.parent, up: true }] : []),
      ...(data?.folders || []).filter(folder => lower(folder.name).includes(lower(query))),
    ];
  }
  function checkoutOptions() {
    return items().filter(item =>
      [item.remote.repoName, item.localPath, item.remote.name, item.remote.project, item.remote.organization].some(value =>
        lower(value).includes(lower(query)),
      ),
    );
  }
  function remember() {
    if (!data) return;
    remembered = data.path;
    try {
      localStorage.setItem(KEY, remembered);
    } catch {
      /* Picking still works without storage. */
    }
  }
  /** @param {string} [path] */
  async function readFolder(path) {
    const current = ++generation;
    loading = true;
    error = '';
    query = '';
    active = 0;
    render();
    try {
      const result = await request('/api/folders', { method: 'POST', body: path === undefined ? {} : { path } });
      if (current !== generation) return;
      data = result;
      message = '';
      if (mode === 'checkouts') remember();
    } catch (cause) {
      if (current === generation) error = messageOf(cause);
    } finally {
      if (current === generation) {
        loading = false;
        render();
      }
    }
  }
  function breadcrumbs() {
    if (!data) return [];
    const home = homePrefix(data.path);
    const homeIndex = data.breadcrumbs.findIndex(crumb => crumb.path === home);
    return homeIndex >= 0
      ? data.breadcrumbs.slice(homeIndex).map((crumb, index) => (index === 0 ? { ...crumb, name: '~' } : crumb))
      : data.breadcrumbs;
  }
  function crumbsMarkup() {
    if (!data) return html`<span class="dim">Your projects folder</span>`;
    const crumbs = breadcrumbs();
    return html`${crumbs.map(
      (crumb, index) =>
        html`${index > 0 && !/^(?:\/|[A-Za-z]:[\\/])$/.test(crumbs[index - 1].path) ? html`<span aria-hidden="true">/</span>` : emptyHtml}${index === crumbs.length - 1 ? html`<span aria-current="location" title="${crumb.path}">${crumb.name}</span>` : html`<button class="ghost sm" type="button" data-picker="navigate" data-path="${crumb.path}" title="${crumb.path}">${crumb.name}</button>`}`,
    )}`;
  }
  /** @param {FolderOption} item @param {number} index */
  function folderOption(item, index) {
    return html`<li id="checkout-option-${index}" role="option" aria-selected="false" data-picker-option="${index}" class="picker-option ${index === active ? 'active' : ''}"><span aria-hidden="true">${item.up ? '↑' : '▸'}</span><span><b>${highlight(item.name, query)}</b><small title="${item.path}">${displayLocalPath(item.path, data?.path)}</small></span>${data?.repositories.some(repo => repo.localPath === item.path) ? html`<span class="chip">Git</span>` : emptyHtml}</li>`;
  }
  /** @param {CheckoutItem} item @param {number} index @param {Mixed} mixed */
  function checkoutOption(item, index, mixed) {
    const disabled = watched(item),
      checked = selected.has(keyOf(item));
    const context = [
      mixed.projects ? item.remote.project : '',
      mixed.organizations ? item.remote.organization.replace(/^https:\/\/dev\.azure\.com\//, '') : '',
    ]
      .filter(Boolean)
      .join(' · ');
    return html`<li id="checkout-option-${index}" role="option" aria-selected="${checked}" aria-disabled="${disabled || adding}" data-picker-option="${index}" title="${`${item.localPath} · ${item.remote.project} · ${item.remote.organization}`}" class="picker-option ${index === active ? 'active' : ''}"><span class="picker-check" aria-hidden="true">${disabled || checked ? '☑' : '☐'}</span><span><b>${highlight(item.remote.repoName, query)}</b><small title="${item.localPath}">${highlight(displayLocalPath(item.localPath, data?.path), query)}</small>${context ? html`<small>${context}</small>` : emptyHtml}</span><span class="picker-badges">${item.multiple ? html`<span class="chip">${item.remote.name}</span>` : emptyHtml}${disabled ? html`<span class="chip">Watched</span>` : emptyHtml}</span></li>`;
  }
  /** @param {FolderOption[] | CheckoutItem[]} list The rows options() returned for the current mode. */
  function optionsMarkup(list) {
    if (loading) return html`<li class="picker-empty" role="presentation">Reading local folders…</li>`;
    if (!list.length) {
      const empty =
        mode === 'folders'
          ? 'No matching subfolders.'
          : query
            ? `No checkout matches “${query}”.`
            : 'No Azure Git checkouts here. Change folder to find your repositories.';
      return html`<li class="picker-empty" role="presentation">${empty}</li>`;
    }
    if (mode === 'folders') return html`${folderOptions().map(folderOption)}`;
    const all = items();
    const mixed = {
      organizations: new Set(all.map(item => lower(item.remote.organization))).size > 1,
      projects: new Set(all.map(item => lower(item.remote.project))).size > 1,
    };
    return html`${checkoutOptions().map((item, index) => checkoutOption(item, index, mixed))}`;
  }
  function footerMarkup() {
    if (mode === 'folders')
      return html`<div class="actions picker-footer"><button class="btn primary sm" type="button" data-picker="use" ${!data || loading ? html`disabled` : emptyHtml}>Use this folder</button><button class="ghost sm" type="button" data-picker="cancel">Cancel</button></div>`;
    return html`<div class="picker-chips">${[...selected].map(([key, item]) => html`<span class="chip">${item.remote.repoName}${item.multiple ? ` · ${item.remote.name}` : ''}<button type="button" data-picker="remove" data-key="${key}" aria-label="Remove ${item.remote.repoName} ${item.remote.name}" ${adding ? html`disabled` : emptyHtml}>×</button></span>`)}</div><div class="actions picker-footer"><button class="btn primary" type="button" data-picker="add" ${!selected.size || adding ? html`disabled` : emptyHtml}>${adding ? 'Watching selected…' : `Watch ${selected.size} selected`}</button><span class="help">Nothing is added until you press Watch selected.</span></div>`;
  }
  function render() {
    if (!host?.isConnected) return;
    const list = options();
    active = Math.max(0, Math.min(active, list.length - 1));
    const label = mode === 'folders' ? 'Find a folder' : 'Search local repositories';
    setHtml(
      host,
      html`<div class="picker-root-row"><nav class="picker-crumbs" aria-label="Local folder">${crumbsMarkup()}</nav><div class="actions"><button class="btn sm" type="button" data-picker="browse" ${adding ? html`disabled` : emptyHtml}>Change folder</button><button class="ghost sm" type="button" data-picker="rescan" aria-label="Rescan folder" title="Rescan local folder" ${loading || adding ? html`disabled` : emptyHtml}>↻</button></div></div>
      <label for="checkout-search" class="picker-label">${label}</label><div class="picker-input"><input id="checkout-search" class="search" role="combobox" autocomplete="off" aria-expanded="${open}" aria-controls="checkout-options" aria-autocomplete="list" ${open && list.length && !loading ? html`aria-activedescendant="checkout-option-${active}"` : emptyHtml} placeholder="${mode === 'folders' ? 'Folder name or /path/to/folder' : 'Search repository or folder name…'}" value="${query}" ${adding ? html`readonly` : emptyHtml}><button class="ghost" type="button" data-picker="toggle" aria-label="${open ? 'Close' : 'Open'} repository picker" ${adding ? html`disabled` : emptyHtml}>▾</button></div>
      <div class="picker-results" ${open ? emptyHtml : html`hidden`}><ul id="checkout-options" role="listbox" aria-label="${label}" ${mode === 'checkouts' ? html`aria-multiselectable="true"` : emptyHtml} ${loading ? html`aria-busy="true"` : emptyHtml}>${optionsMarkup(list)}</ul><p class="help picker-count">${loading ? 'Only local disk is read.' : `${list.length} ${mode === 'folders' ? 'folders' : 'checkout remotes'} shown · no Azure requests`}</p></div>
      ${error ? html`<div class="banner warn" role="alert"><div>${error}</div></div>` : emptyHtml}${(data?.warnings || []).map(warning => html`<p class="help">${warning}</p>`)}
      ${footerMarkup()}
      <p class="help" role="status" aria-live="polite">${message || (!loading && open ? `${list.length} matches. ${selected.size} selected.` : '')}</p>`,
    );
  }
  /** @param {number} index */
  async function choose(index) {
    if (loading || adding) return;
    if (mode === 'folders') {
      const folder = folderOptions()[index];
      if (!folder) return;
      active = index;
      return readFolder(folder.path);
    }
    const item = checkoutOptions()[index];
    if (!item) return;
    active = index;
    if (!watched(item)) {
      const key = keyOf(item);
      if (selected.has(key)) selected.delete(key);
      else selected.set(key, item);
    }
    render();
    required('#checkout-search', HTMLInputElement, host).focus({ preventScroll: true });
  }
  function useFolder() {
    mode = 'checkouts';
    query = '';
    active = 0;
    remember();
    render();
    required('#checkout-search', HTMLInputElement, host).focus();
  }
  async function add() {
    if (adding || !selected.size) return;
    adding = true;
    error = '';
    message = '';
    render();
    let added = 0;
    /** @type {string[]} */
    const failures = [];
    for (const [key, item] of [...selected]) {
      try {
        await request('/api/repos', { method: 'POST', body: { path: item.localPath, remote: item.remote.name } });
        selected.delete(key);
        added++;
      } catch (cause) {
        failures.push(`${item.remote.repoName} · ${item.remote.name}: ${messageOf(cause)}`);
      }
    }
    try {
      if (added) await onAdded(added);
    } catch (cause) {
      failures.push(messageOf(cause));
    }
    adding = false;
    error = failures.join(' ');
    message = `${added} repositories watched. All their remote branches are watched.`;
    render();
  }
  function cancel() {
    generation++;
    loading = false;
    data = beforeBrowse || data;
    mode = 'checkouts';
    query = '';
    error = '';
    render();
  }
  /** The buttons' data-picker actions. @type {Record<string, (button: HTMLButtonElement) => unknown>} */
  const actions = {
    toggle() {
      open = !open;
      render();
      if (open && !data && !loading) void readFolder(remembered);
    },
    browse() {
      if (mode !== 'folders') beforeBrowse = data;
      mode = 'folders';
      open = true;
      query = '';
      render();
      if (!data && !loading) void readFolder(remembered);
      required('#checkout-search', HTMLInputElement, host).focus();
    },
    navigate(element) {
      open = true;
      query = '';
      return readFolder(element.dataset.path);
    },
    rescan() {
      open = true;
      return readFolder(data?.path || remembered);
    },
    use: useFolder,
    cancel,
    remove(element) {
      selected.delete(element.dataset.key ?? '');
      render();
    },
    add,
  };
  return {
    active: () => adding || open,
    /** @param {HTMLElement | null} element */
    mount(element) {
      host = element ?? undefined;
      if (!host) return;
      render();
      if (boundHost === host) return;
      boundHost = host;
      host.onclick = event => {
        if (!(event.target instanceof Element)) return;
        const option = event.target.closest('[data-picker-option]');
        if (option instanceof HTMLElement) {
          void choose(Number(option.dataset.pickerOption));
          return;
        }
        const button = event.target.closest('[data-picker]');
        if (button instanceof HTMLButtonElement && !button.disabled) {
          event.preventDefault();
          void actions[button.dataset.picker ?? '']?.(button);
        }
      };
      host.onmousedown = event => {
        if (event.target instanceof Element && event.target.closest('[data-picker-option]')) event.preventDefault();
      };
      host.addEventListener('focusin', event => {
        if (event.target instanceof Element && event.target.id === 'checkout-search' && !open) {
          open = true;
          render();
          if (!data && !loading) void readFolder(remembered);
        }
      });
      host.oninput = event => {
        if (event.target instanceof HTMLInputElement && event.target.id === 'checkout-search') {
          query = event.target.value;
          open = true;
          active = 0;
          render();
        }
      };
      host.onkeydown = event => {
        if (!(event.target instanceof Element) || event.target.id !== 'checkout-search' || adding) return;
        const list = options();
        if (event.key === 'Escape') {
          event.preventDefault();
          if (mode === 'folders') cancel();
          else {
            if (!open) query = '';
            open = false;
            render();
          }
        } else if (event.key === 'Enter') {
          event.preventDefault();
          if (event.ctrlKey || event.metaKey) {
            if (mode === 'folders') useFolder();
            else void add();
          } else if (mode === 'folders' && /^[~/]/.test(query)) void readFolder(query);
          else if (!open) {
            open = true;
            render();
          } else void choose(active);
        } else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
          event.preventDefault();
          open = true;
          active =
            event.key === 'Home'
              ? 0
              : event.key === 'End'
                ? list.length - 1
                : Math.max(0, Math.min(list.length - 1, active + (event.key === 'ArrowDown' ? 1 : -1)));
          render();
          host?.querySelector(`#checkout-option-${active}`)?.scrollIntoView({ block: 'nearest' });
        } else if (event.key === 'Backspace' && !query) {
          if (mode === 'folders' && data?.parent) {
            event.preventDefault();
            void readFolder(data.parent);
          } else {
            selected.delete([...selected.keys()].at(-1) ?? '');
            render();
          }
        }
      };
    },
  };
}
