import type { GitHistoryActivity, GitHistoryPage, Repository } from '../contract.ts';
import { layoutGitGraph } from '../git-graph.ts';
import { foldSearchText, matchesPersonName, parsePeople, parseSearchTerms } from '../search-terms.ts';
import { splitActivitySearch } from './activity-search.ts';
import { ciTime, emptyHtml, fullDateTime, html } from './format.ts';
import { renderCheckoutBar } from './checkout-render.ts';
import type { CheckoutSnapshot } from './checkout.ts';
import { renderSearchHelp, renderSearchInput } from './search-field.ts';

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
    select(repo: Repository | undefined) {
      if (state.repoId === (repo?.id ?? '') && state.path === repo?.localPath) return;
      state = { repoId: repo?.id ?? '', path: repo?.localPath, page: null, loading: false, error: '' };
      if (repo?.localPath) void load(null, false);
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

const laneX = (index: number) => 10 + 14 * index;
const laneClass = (color: number) => `graph-lane-${color % 6}`;
const mid = 18;

function path(segment: { from: number; to: number; color: number }, top: number, bottom: number) {
  const from = laneX(segment.from);
  const to = laneX(segment.to);
  const middle = (top + bottom) / 2;
  return html`<path class="${laneClass(segment.color)}" d="M ${from} ${top} C ${from} ${middle}, ${to} ${middle}, ${to} ${bottom}"/>`;
}

const ciTones = new Map([
  ['Succeeded', 'ok'],
  ['Failed', 'crit'],
  ['Canceled', 'warn'],
  ['Canceling', 'warn'],
  ['Partially succeeded', 'warn'],
  ['Running', 'info'],
  ['Queued', 'info'],
]);

function graphActivity(item: GitHistoryActivity) {
  const merged = item.kind === 'pr' && item.status === 'Merged';
  const date = item.kind === 'build' ? ciTime(item.time) : emptyHtml;
  const tone = item.kind === 'build' ? (ciTones.get(item.status) ?? 'neutral') : merged ? 'ok merged' : 'neutral';
  return html`<a class="graph-link chip status-chip ${tone}" href="#event/${encodeURIComponent(item.id)}" title="${item.kind === 'build' ? `${item.title} · ${fullDateTime(item.time)}` : item.title}">${item.kind === 'build' ? 'CI' : 'PR'} · ${item.status}${date === emptyHtml ? emptyHtml : html` · ${date}`}</a>`;
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
      ${renderSearchInput('graph-search', 'Search commits', 'Search commit, ref or author…', query)}
      ${
        query
          ? html`<div class="filter-actions">
        <button type="button" class="btn" id="graph-clear-search" data-action="clear-graph-search">Clear search</button>
        ${
          count
            ? html`<button type="button" class="btn" id="graph-previous-match" data-action="previous-graph-match">Previous match</button>
          <button type="button" class="btn" id="graph-next-match" data-action="next-graph-match">Next match</button>`
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
      ${repos.length ? html`<label class="graph-repo" for="graph-repo"><span>Repository</span><select class="control" id="graph-repo">${repos.map(item => html`<option value="${item.id}" ${item.id === repo?.id ? html`selected` : emptyHtml}>${item.name} · ${item.project}</option>`)}</select></label>` : emptyHtml}
      ${repo?.localPath ? html`<button type="button" id="graph-reload" class="btn" data-action="reload-graph" ${loading ? html`disabled` : emptyHtml}>Reload graph</button>` : emptyHtml}
    </header>
    ${repo?.localPath ? renderCheckoutBar(repo.id, checkout) : emptyHtml}
    ${changed ? html`<p class="graph-status" role="status">Checkout changed. Reload the graph to see the current history.</p>` : emptyHtml}
    ${
      repo?.localPath
        ? html`${graphSearch(page, query, matches, currentMatch)}
        ${page?.commits.length ? historyRows(page, new Set(matches?.ids), currentMatch) : emptyHtml}
        ${loading ? html`<p class="graph-status" role="status">Loading Git history…</p>` : emptyHtml}
        ${error ? html`<p class="graph-status" role="alert">${error}</p>` : emptyHtml}
        ${page?.nextCursor ? html`<div class="foot"><button type="button" id="graph-more" class="btn" data-action="more-graph" ${loading || error || changed ? html`disabled` : emptyHtml}>Load more commits</button></div>` : emptyHtml}`
        : html`<p class="graph-status">Link a local checkout in <a href="#repositories">Repositories</a> to view its commit history.</p>`
    }
  </section>`;
}
