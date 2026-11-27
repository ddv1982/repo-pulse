import type { GitHistoryActivity, GitHistoryPage, Repository } from '../contract.ts';
import { layoutGitGraph } from '../git-graph.ts';
import { statusLabel, statusTone } from '../activity-text.ts';
import { foldSearchText, matchesPersonName, parsePeople, parseSearchTerms } from '../search-terms.ts';
import { splitActivitySearch } from './activity-search.ts';
import { ciTime, emptyHtml, fullDateTime, html } from './format.ts';
import { renderCheckoutBar } from './checkout-render.ts';
import type { CheckoutSnapshot } from './checkout.ts';
import { renderSearchHelp, renderSearchInput } from './search-field.ts';
import { all, checked } from './dom.ts';
import type { Actions } from './actions.ts';
import { action } from './actions.ts';

type State = {
  repoId: string;
  path: string | undefined;
  page: GitHistoryPage | null;
  loading: boolean;
  error: string;
  changed?: boolean;
};

type Options = {
  read: (id: string, cursor: string | null) => Promise<GitHistoryPage>;
  render: () => void;
};

export function createGitGraph({ read, render }: Options) {
  const empty: State = { repoId: '', path: undefined, page: null, loading: false, error: '' };
  let state = empty;

  async function load(cursor: string | null, reportPending = true) {
    if (!state.repoId || (cursor && (state.loading || state.changed))) return;
    const pending = { ...state, page: cursor ? state.page : null, loading: true, error: '', changed: false };
    state = pending;
    if (reportPending) render();
    try {
      const result = await read(pending.repoId, cursor);
      if (state !== pending) return;
      state = {
        ...pending,
        page: cursor && pending.page ? { ...result, commits: [...pending.page.commits, ...result.commits] } : result,
        loading: false,
      };
    } catch (error) {
      if (state !== pending) return;
      state = { ...pending, loading: false, error: error instanceof Error ? error.message : 'Could not load Git history.' };
    }
    render();
  }

  return {
    get state() {
      return state;
    },
    /** @returns whether the shown repository or its checkout changed */
    select(repo: Repository | undefined) {
      if (state.repoId === (repo?.id ?? '') && state.path === repo?.localPath) return false;
      state = { repoId: repo?.id ?? '', path: repo?.localPath, page: null, loading: false, error: '' };
      if (repo?.localPath) void load(null, false);
      return true;
    },
    reset() {
      state = empty;
    },
    markChanged(snapshot: string) {
      if (state.page?.snapshot !== snapshot || state.changed) return;
      state = { ...state, loading: false, changed: true, error: '' };
      render();
    },
    reload: () => load(null),
    more: () => {
      if (state.page?.nextCursor) return load(state.page.nextCursor);
    },
  };
}

/** Where a click on a graph link left the page, so Back from the detail it opened can put the reader back there. */
type GraphReturn = {
  visit: number;
  repoId: string;
  rowId: string;
  href: string;
  y: number;
  x: number;
  revision: string;
};

/**
 * The Git Graph page: which repository it shows, the history loaded for it, the search and its current match, and the
 * place a graph link left. Rendering reads this state and starts no request; the history loads when the page is
 * entered, when the reader picks a repository, and when a state answer changes which repository it shows.
 */
export function createGraphController({
  request,
  page,
  state,
  scope,
  isActive,
  render,
  checkout,
  readCheckout,
  currentView,
  onRepositoryChoice,
}: {
  request: typeof import('../api.ts').request;
  page: HTMLElement;
  state: () => { repos: Repository[]; activityRevision: string };
  /** The Activity repository scope: one repository in it is the graph's first choice. */
  scope: () => string[] | null;
  isActive: () => boolean;
  render: () => void;
  checkout: (repoId: string) => CheckoutSnapshot | undefined;
  /** Reads the shown checkout again after its history changed under the page. */
  readCheckout: () => void;
  currentView: () => () => boolean;
  /** Runs before a repository the reader picked replaces the shown one. */
  onRepositoryChoice: () => void;
}) {
  const history = createGitGraph({
    read: (id, cursor) => request('GET /api/repos/:id/graph', { params: { id }, query: { cursor: cursor || undefined } }),
    render: () => {
      if (isActive()) render();
    },
  });
  /** The repository the reader picked, if any. */
  let chosenId = '';
  let query = '';
  let match = '';
  let visit = 0;
  let back: GraphReturn | undefined;
  /** The detail a graph link opened, while it is shown. */
  let detailOrigin = '';
  let probing: { repoId: string; snapshot: string } | undefined;

  function selection() {
    const { repos } = state();
    const ids = scope();
    const repo =
      repos.find(item => item.id === chosenId) ??
      repos.find(item => ids?.length === 1 && item.id === ids[0]) ??
      repos.find(item => item.localPath) ??
      repos[0];
    return { repos, repo };
  }

  /** Loads the history of the repository the page shows, when that is not the one loaded; returns whether it changed. */
  function sync() {
    return history.select(selection().repo);
  }

  /** Checks whether the checkout moved under the loaded history; after a Git action, reloads it instead. */
  async function probe(mutated = false) {
    const { repoId, page: loaded, changed } = history.state;
    if (!repoId || (!mutated && (!loaded || changed))) return;
    if (mutated && !loaded) {
      match = '';
      void history.reload();
      return;
    }
    if (!loaded || (!mutated && probing?.repoId === repoId && probing.snapshot === loaded.snapshot)) return;
    const current = { repoId, snapshot: loaded.snapshot };
    probing = current;
    let matches = false;
    try {
      const { snapshot } = await request('GET /api/repos/:id/graph/snapshot', { params: { id: repoId } });
      matches = snapshot === current.snapshot;
    } catch {
      // A checkout can disappear or become unreadable after the history loaded.
    }
    if (probing !== current) return;
    probing = undefined;
    if (matches || !isActive() || history.state.repoId !== repoId || history.state.page?.snapshot !== current.snapshot) return;
    if (mutated) {
      match = '';
      void history.reload();
    } else {
      history.markChanged(current.snapshot);
      readCheckout();
    }
  }

  function matchIds() {
    return searchMatches(history.state.page, query)?.ids ?? [];
  }

  /** The reader picked a repository: show its history from the top. */
  function selectRepository(id: string) {
    back = undefined;
    chosenId = id;
    match = '';
    sync();
    render();
  }

  function search(value: string) {
    query = value;
    match = '';
    render();
  }

  function moveMatch(step: 1 | -1) {
    const ids = matchIds();
    if (!ids.length) return;
    const current = ids.indexOf(match);
    const index = current < 0 ? (step === 1 ? 0 : ids.length - 1) : (current + step + ids.length) % ids.length;
    const next = ids[index];
    if (next === undefined) return;
    match = next;
    render();
    document.getElementById(`commit-${next}`)?.scrollIntoView({ block: 'center', inline: 'nearest' });
  }

  /** Records the place a graph link leaves, before the detail it opens is shown. */
  function followLink(link: HTMLAnchorElement) {
    back = {
      visit: ++visit,
      repoId: history.state.repoId,
      rowId: link.closest('.graph-commit')?.id ?? '',
      href: link.hash,
      y: window.scrollY,
      x: page.querySelector('.graph-commits')?.scrollLeft ?? 0,
      revision: state().activityRevision,
    };
    // Mark the history entry we left, so a fresh click on Git Graph still reads the checkout.
    window.history.replaceState({ ...window.history.state, graphVisit: visit }, '');
  }

  // A plain click on a graph link opens its detail; Back from there returns to this place.
  page.addEventListener('click', event => {
    const link = event.target instanceof Element ? checked(event.target.closest('.graph-link'), HTMLAnchorElement, '.graph-link') : null;
    if (isActive() && link && !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey) followLink(link);
  });

  return {
    selection,
    get state() {
      return history.state;
    },
    render() {
      const { repos, repo } = selection();
      return renderGitGraph(repos, repo, history.state, query, match, repo ? checkout(repo.id) : undefined);
    },
    /**
     * Shows the graph. Coming back from a detail a graph link opened, while the history and Activity are unchanged,
     * keeps the history and puts focus and scrolling back where the link was; otherwise the history loads again.
     * @returns whether the place was restored
     */
    enter(previous: import('./navigation.ts').Route) {
      detailOrigin = '';
      const restore =
        previous === 'event' &&
        back &&
        back.visit === window.history.state?.graphVisit &&
        back.repoId === selection().repo?.id &&
        back.revision === state().activityRevision &&
        !history.state.error
          ? back
          : undefined;
      if (!restore) {
        back = undefined;
        match = '';
        history.reset();
      }
      sync();
      if (!restore) return false;
      void probe();
      const isCurrent = currentView();
      requestAnimationFrame(() => {
        if (!isCurrent()) return;
        const row = document.getElementById(restore.rowId);
        const link = (row ? all('.graph-link', HTMLAnchorElement, row) : []).find(link => link.hash === restore.href);
        (link ?? document.getElementById('graph-search'))?.focus({ preventScroll: true });
        page.querySelector('.graph-commits')?.scrollTo({ left: restore.x, behavior: 'instant' });
        window.scrollTo({ top: restore.y, behavior: 'instant' });
      });
      return true;
    },
    /** A navigation to a page other than the graph. A detail opened from a graph link can go back to it. */
    leave(previous: import('./navigation.ts').Route, destination: Exclude<import('./navigation.ts').Route, 'graph'>) {
      detailOrigin = previous === 'graph' && destination === 'event' && back ? location.hash : '';
    },
    /** Whether Back on the shown detail returns to the graph that opened it. */
    get returnsHere() {
      return Boolean(detailOrigin) && location.hash === detailOrigin;
    },

    selectRepository,
    /** `/` on the graph focuses its search box, when the graph shows one. */
    focusSearch() {
      const search = document.getElementById('graph-search');
      search?.focus();
      return Boolean(search);
    },
    /** A state answer arrived: the shown repository can change with it. */
    sync,
    /** Checks the shown checkout for changes that make the loaded history stale. */
    refresh: () => probe(),
    /** A Git action changed a checkout: reload its history if it is shown, or forget it. */
    checkoutChanged(repoId: string) {
      if (history.state.repoId !== repoId) return;
      if (isActive()) return void probe(true);
      back = undefined;
      history.reset();
    },
    actions: {
      'reload-graph': () => {
        readCheckout();
        match = '';
        void history.reload();
      },
      'more-graph': () => {
        void history.more();
      },
      'clear-graph-search': () => search(''),
      'previous-graph-match': () => moveMatch(-1),
      'next-graph-match': () => moveMatch(1),
      'search-graph': element => {
        if (element instanceof HTMLInputElement) search(element.value);
      },
      'choose-graph-repo': element => {
        if (!(element instanceof HTMLSelectElement)) return;
        onRepositoryChoice();
        selectRepository(element.value);
        readCheckout();
      },
    } satisfies Actions<
      | 'reload-graph'
      | 'more-graph'
      | 'clear-graph-search'
      | 'previous-graph-match'
      | 'next-graph-match'
      | 'search-graph'
      | 'choose-graph-repo'
    >,
  };
}

const laneX = (index: number) => 10 + 14 * index;
const laneClass = (color: number) => `graph-lane-${color % 6}`;
const mid = 18;

function path(segment: { from: number; to: number; color: number }, top: number, bottom: number) {
  const from = laneX(segment.from);
  const to = laneX(segment.to);
  const middle = (top + bottom) / 2;
  return html`<path class="${laneClass(segment.color)}" d="M ${from} ${top} C ${from} ${middle}, ${to} ${middle}, ${to} ${bottom}"/>`;
}

function graphActivity(item: GitHistoryActivity) {
  const date = item.kind === 'build' ? ciTime(item.time) : emptyHtml;
  const tone = `${statusTone(item.status)}${item.status === 'merged' ? ' merged' : ''}`;
  return html`<a class="graph-link chip status-chip ${tone}" href="#event/${encodeURIComponent(item.id)}" title="${item.kind === 'build' ? `${item.title} · ${fullDateTime(item.time)}` : item.title}">${item.kind === 'build' ? 'CI' : 'PR'} · ${statusLabel(item.status)}${date === emptyHtml ? emptyHtml : html` · ${date}`}</a>`;
}

function searchMatches(page: GitHistoryPage | null, query: string) {
  const { search, people } = splitActivitySearch(query);
  const terms = parseSearchTerms(search);
  const foldedTerms = terms.map(foldSearchText);
  let names: string[];
  try {
    names = parsePeople(people);
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error), ids: [] };
  }
  if (!terms.length && !names.length) return null;
  const ids = (page?.commits ?? [])
    .filter(commit => {
      if (names.length && !matchesPersonName(commit.author, names)) return false;
      if (!terms.length) return true;
      const fields = [commit.subject, commit.author, ...commit.refs, ...(commit.id === page?.head ? ['HEAD'] : [])].map(field =>
        field.toLowerCase(),
      );
      if (terms.some(term => commit.id.startsWith(term) || fields.some(field => field.includes(term)))) return true;
      return fields.map(foldSearchText).some(field => foldedTerms.some(term => field.includes(term)));
    })
    .map(commit => commit.id);
  return { error: '', ids };
}

function graphSearch(page: GitHistoryPage | null, query: string, matches: ReturnType<typeof searchMatches>, current: string) {
  const count = matches?.ids.length ?? 0;
  const position = matches?.ids.indexOf(current) ?? -1;
  return html`<div class="graph-search">
    <div class="toolbar">
      ${renderSearchInput('graph-search', 'Search commits', 'Search commit, ref or author…', query, 'search-graph')}
      ${
        query
          ? html`<div class="filter-actions">
        <button type="button" class="btn" id="graph-clear-search" ${action('clear-graph-search')}>Clear search</button>
        ${
          count
            ? html`<button type="button" class="btn" id="graph-previous-match" ${action('previous-graph-match')}>Previous match</button>
          <button type="button" class="btn" id="graph-next-match" ${action('next-graph-match')}>Next match</button>`
            : emptyHtml
        }
      </div>`
          : emptyHtml
      }
    </div>
    ${renderSearchHelp('graph-search', 'commit authors only')}
    <div role="status" class="help graph-match-status">${
      matches?.error ||
      (matches && page
        ? html`${position >= 0 ? `Match ${position + 1} of ${count} · ` : ''}${count} ${count === 1 ? 'match' : 'matches'} in ${page.commits.length} loaded commit${page.commits.length === 1 ? '' : 's'}${page.nextCursor ? ' · Load more to search older commits' : ''}`
        : emptyHtml)
    }</div>
  </div>`;
}

function historyRows(page: GitHistoryPage, matches: Set<string>, currentMatch: string) {
  const graph = layoutGitGraph(page.commits);
  const width = laneX(graph.width);
  return html`<div class="graph-columns" aria-hidden="true"><span>Commit history</span><span>Refs and activity</span></div>
    <ol class="graph-commits">${page.commits.map((commit, index) => {
      const row = graph.rows[index];
      if (!row) return emptyHtml;
      const current = commit.id === page.head;
      const merge = commit.parents.length > 1;
      const match = matches.has(commit.id);
      return html`<li class="graph-commit ${laneClass(row.color)}${merge ? ' graph-merge' : ''}${match ? ' graph-match' : ''}${match && currentMatch === commit.id ? ' graph-match-current' : ''}" id="commit-${commit.id}" ${current ? html`aria-current="true"` : emptyHtml}>
      <span class="graph-rail" aria-hidden="true">
        <svg class="graph-edges" width="${width}" height="36" viewBox="0 0 ${width} 36" preserveAspectRatio="none">
          ${row.through.map(edge => path(edge, 0, 36))}
          ${row.incoming.map(edge => path(edge, 0, mid))}
          ${row.outgoing.map(edge => path(edge, mid, 36))}
        </svg>
        <svg class="graph-node" width="${width}" height="14"><circle class="${laneClass(row.color)} ${current || merge ? 'graph-ring' : ''}" cx="${laneX(row.slot)}" cy="7" r="${current ? 5 : 4}"/></svg>
      </span>
      <div class="graph-entry">
        ${match ? html`<span class="sr">Search match: </span>` : emptyHtml}
        <code class="graph-sha" title="${commit.id}">${commit.id.slice(0, 9)}</code>
        <span class="graph-subject" title="${commit.subject}">${commit.subject || '(No commit message)'}</span>
        <span class="graph-author" title="${commit.author}">${commit.author}</span>
        <div class="graph-badges">${current ? html`<span class="graph-ref graph-ref-current">HEAD</span>` : emptyHtml}${commit.refs.map(ref => html`<span class="graph-ref${ref === page.branch ? ' graph-ref-current' : ref === page.upstream ? ' graph-ref-upstream' : ''}" title="${ref}">${ref}</span>`)}${commit.activity.map(graphActivity)}</div>
      </div>
    </li>`;
    })}</ol>`;
}
export function renderGitGraph(
  repos: Repository[],
  repo: Repository | undefined,
  state: State,
  query: string,
  currentMatch: string,
  checkout?: CheckoutSnapshot,
) {
  const { page, loading, error, changed } = state;
  const matches = searchMatches(page, query);
  return html`<section class="card git-graph" aria-label="Git Graph">
    <header class="graph-toolbar">
      <div class="graph-heading"><h1>Git Graph</h1>${page && (changed || !checkout || checkout.branch !== page.branch || checkout.head !== page.head || page.shallow) ? html`<p class="graph-scope"><span class="graph-branch">${page.branch ?? (page.head ? 'Detached HEAD' : 'No commits yet')}</span>${page.upstream ? html` · <code>${page.upstream}</code>` : emptyHtml}${page.shallow ? ' · Shallow checkout' : ''}</p>` : emptyHtml}</div>
      ${repos.length ? html`<label class="graph-repo" for="graph-repo"><span>Repository</span><select class="control" id="graph-repo" ${action('choose-graph-repo')}>${repos.map(item => html`<option value="${item.id}" ${item.id === repo?.id ? html`selected` : emptyHtml}>${item.name} · ${item.project}</option>`)}</select></label>` : emptyHtml}
      ${repo?.localPath ? html`<button type="button" id="graph-reload" class="btn" ${action('reload-graph')} ${loading ? html`disabled` : emptyHtml}>Reload graph</button>` : emptyHtml}
    </header>
    ${repo?.localPath ? renderCheckoutBar(repo.id, checkout) : emptyHtml}
    ${changed ? html`<p class="graph-status" role="status">Checkout changed. Reload the graph to see the current history.</p>` : emptyHtml}
    ${
      repo?.localPath
        ? html`${graphSearch(page, query, matches, currentMatch)}
        ${page?.commits.length ? historyRows(page, new Set(matches?.ids), currentMatch) : emptyHtml}
        ${loading ? html`<p class="graph-status" role="status">Loading Git history…</p>` : emptyHtml}
        ${error ? html`<p class="graph-status" role="alert">${error}</p>` : emptyHtml}
        ${page?.nextCursor ? html`<div class="foot"><button type="button" id="graph-more" class="btn" ${action('more-graph')} ${loading || error || changed ? html`disabled` : emptyHtml}>Load more commits</button></div>` : emptyHtml}`
        : html`<p class="graph-status">Link a local checkout in <a href="#repositories">Repositories</a> to view its commit history.</p>`
    }
  </section>`;
}
