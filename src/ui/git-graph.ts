import type { GitHistoryPage, Repository } from '../contract.d.ts';
import { layoutGitGraph } from '../git-graph.ts';
import { emptyHtml, html } from './format.ts';

type State = {
  repoId: string;
  path: string | undefined;
  page: GitHistoryPage | null;
  loading: boolean;
  error: string;
};

type Options = {
  read: (id: string, cursor: string | null) => Promise<GitHistoryPage>;
  render: () => void;
};

export function createGitGraph({ read, render }: Options) {
  const empty: State = { repoId: '', path: undefined, page: null, loading: false, error: '' };
  let state = empty;

  async function load(cursor: string | null, reportPending = true) {
    if (!state.repoId || state.loading) return;
    const pending = { ...state, page: cursor ? state.page : null, loading: true, error: '' };
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
    reload: () => load(null),
    more: () => {
      if (state.page?.nextCursor) return load(state.page.nextCursor);
    },
  };
}

const laneX = (index: number) => 10 + 12 * index;
const laneClass = (color: number) => `graph-lane-${color % 6}`;
const mid = 18;

function path(segment: { from: number; to: number; color: number }, top: number, bottom: number) {
  const from = laneX(segment.from);
  const to = laneX(segment.to);
  const middle = (top + bottom) / 2;
  return html`<path class="${laneClass(segment.color)}" d="M ${from} ${top} C ${from} ${middle}, ${to} ${middle}, ${to} ${bottom}"/>`;
}

function historyRows(page: GitHistoryPage) {
  const graph = layoutGitGraph(page.commits);
  return html`<ol class="graph-commits">${page.commits.map((commit, index) => {
    const row = graph.rows[index];
    if (!row) return emptyHtml;
    const current = commit.id === page.head;
    const width = laneX(graph.width);
    return html`<li class="graph-commit" id="commit-${commit.id}" ${current ? html`aria-current="true"` : emptyHtml}>
      <svg class="graph-rail" aria-hidden="true" width="${width}" height="36" viewBox="0 0 ${width} 36" preserveAspectRatio="none">
        ${row.through.map(edge => path(edge, 0, 36))}
        ${row.incoming.map(edge => path(edge, 0, mid))}
        ${row.outgoing.map(edge => path(edge, mid, 36))}
        <circle class="${laneClass(row.color)} ${current || commit.parents.length > 1 ? 'graph-ring' : ''}" cx="${laneX(row.slot)}" cy="${mid}" r="${current ? 5 : 3.7}"/>
      </svg>
      <code class="graph-sha" title="${commit.id}">${commit.id.slice(0, 9)}</code>
      <span class="graph-subject" title="${commit.subject}">${commit.subject || '(No commit message)'}</span>
      <span class="graph-author" title="${commit.author}">${commit.author}</span>
      ${commit.refs.map(ref => html`<span class="graph-ref" title="${ref}">${ref}</span>`)}
      ${commit.activity.map(item => html`<a class="graph-link" href="#event/${encodeURIComponent(item.id)}" title="${item.title}">${item.kind === 'build' ? 'CI' : 'PR'} · ${item.status}</a>`)}
    </li>`;
  })}</ol>`;
}

export function renderGitGraph(repos: Repository[], repo: Repository | undefined, state: State) {
  const { page, loading, error } = state;
  return html`<section class="card git-graph" aria-label="Git Graph">
    <header class="graph-toolbar">
      <h1>Git Graph</h1>
      ${repos.length ? html`<label class="graph-repo" for="graph-repo"><span>Repository</span><select class="control" id="graph-repo">${repos.map(item => html`<option value="${item.id}" ${item.id === repo?.id ? html`selected` : emptyHtml}>${item.name}</option>`)}</select></label>` : emptyHtml}
      ${repo?.localPath ? html`<button type="button" id="graph-reload" class="btn sm" data-action="reload-graph" ${loading ? html`disabled` : emptyHtml}>Reload graph</button>` : emptyHtml}
    </header>
    ${
      repo?.localPath
        ? html`${page ? html`<p class="graph-scope">${page.branch ?? (page.head ? 'Detached HEAD' : 'No commits yet')}${page.upstream ? html` · ${page.upstream}` : emptyHtml}${page.shallow ? html` · Shallow checkout` : emptyHtml}</p>` : emptyHtml}
        ${page?.commits.length ? historyRows(page) : emptyHtml}
        ${loading ? html`<p class="graph-status" role="status">Loading Git history…</p>` : emptyHtml}
        ${error ? html`<p class="graph-status" role="alert">${error}</p>` : emptyHtml}
        ${page?.nextCursor ? html`<div class="foot"><button type="button" id="graph-more" class="btn" data-action="more-graph" ${loading || error ? html`disabled` : emptyHtml}>Load more commits</button></div>` : emptyHtml}`
        : html`<p class="graph-status">Link a local checkout in <a href="#repositories">Repositories</a> to view its commit history.</p>`
    }
  </section>`;
}
