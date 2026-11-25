import {
  emptyHtml,
  html,
  dateTime,
  fullDateTime,
  azureLink,
  activityActor,
  activityLabel,
  activityTone,
  activityTitle,
  activitySummary,
  buildState,
} from './format.ts';
import { syncRepoName } from './health.ts';
import { worstStatus } from '../sync-worst.ts';
import { emptyActivityMessage, renderSummary } from './activity-summary.ts';
import { icons } from './icons.ts';
import { renderTrail } from './activity-trail.ts';
import { renderTypeFilter } from './type-filter.ts';
import { activityScopeQuery } from './activity-data.ts';
import { activityFilterLabel, activityRef, prForkSource, prTarget, prVoteChanges } from '../activity-text.ts';
import { scopeName } from './header.ts';
import { currentActivityFilters, isSavedFilterModified, renderSavedFilters } from './saved-filters.ts';
import { mergeEvidenceBadge } from './merge-evidence.ts';
import { buildActivityTree, type ActivityTree } from '../activity-tree.ts';
import { forkText, renderTreeCell, treeLegend } from './activity-tree.ts';
import { linkedMergePushes } from './linked-pushes.ts';
import type { PageState } from './refresh.ts';
import type { ActivityItem } from '../activity.ts';
export { renderDetail } from './activity-detail.ts';

export type { PageState, ActivityItem };

/** `openMenu` is the panel ID of the open toolbar menu, if any. */
export type FeedView = Pick<import('./navigation.ts').NavigationState, 'unreadOnly' | 'repoIds' | 'search' | 'kind' | 'filtersOpen'> & {
  openMenu?: string;
};

export function filterControls(ui: FeedView & { savedFilterId: string }, state: PageState) {
  const desktop = globalThis.matchMedia?.('(min-width: 640px)').matches ?? true;
  const active = Number(Boolean(ui.search)) + Number(Boolean(ui.kind)) + Number(ui.unreadOnly);
  const open = desktop || ui.filtersOpen === true;
  const presets = state.savedFilters ?? [];
  const saved = presets.find(filter => filter.id === ui.savedFilterId);
  const modified = Boolean(saved && isSavedFilterModified(saved.filters, currentActivityFilters(ui), state.watched));
  return html`<div class="activity-filter-bar">
    <button class="btn filters-toggle" id="activity-filters-toggle" data-action="toggle-activity-filters" type="button"
      aria-expanded="${open}" aria-controls="activity-filters">Filters${active ? ` · ${active}` : ''}</button>
    ${renderSavedFilters(presets, ui.savedFilterId, modified, ui.openMenu)}
    <div class="filters-box" id="activity-filters" ${open ? emptyHtml : html`hidden`}>
      <div class="toolbar"><input id="feed-search" class="search" type="search" aria-label="Search activity" aria-describedby="feed-search-help" placeholder="Search branch, commit, person or repository…" value="${ui.search}">
        <div class="filter-actions">
          ${renderTypeFilter(ui.kind, state.activity.filterOptions, state.activity.loading, ui.openMenu === 'kind-panel')}
          <button class="btn" id="unread-only" type="button" data-action="toggle-unread" aria-pressed="${ui.unreadOnly}">Unread only</button>
          ${active ? html`<button class="btn" id="clear-filters" type="button" data-action="clear-filters">Clear filter</button>` : emptyHtml}
        </div>
      </div><p class="help" id="feed-search-help">Commas match any term · <code>people:Ali, Jo</code> searches names only</p>
    </div>
  </div>`;
}

/** What the named person did, per kind. A branch or tag event comes from a push. */
const actorRoles: Record<import('../activity.ts').ActivityKind, string> = {
  pr: 'Created by',
  build: 'Requested by',
  push: 'Pushed by',
  'branch-created': 'Pushed by',
  'branch-deleted': 'Pushed by',
  tag: 'Pushed by',
};

/** Who and when. An unknown actor has no role to name. */
function renderMeta(record: ActivityItem) {
  const actor = activityActor(record);
  const shown = Boolean(actor);
  const role = actor === 'Unknown' ? '' : `${actorRoles[record.kind]} `;
  return html`<div class="help event-meta">${shown ? html`${role}<span class="actor">${actor}</span> · ` : emptyHtml}<time datetime="${record.time}" title="${fullDateTime(record.time)}">${dateTime(record.time)}</time></div>`;
}

/**
 * The event column in tiers: what happened with its evidence chips, then who and when, then where the branch started.
 */
function renderEvent(record: ActivityItem, origin: string, push?: ActivityItem) {
  const pr =
    record.kind === 'pr' && record.data && (record.data.targetRefName || record.data.voteChanges?.length) ? record.data : undefined;
  const votes = pr ? prVoteChanges(pr) : [];
  const approvals = votes.filter(change => change.vote === 10).length;
  const shownVotes =
    approvals > 1 ? [{ vote: 10, text: `${approvals} new approvals` }, ...votes.filter(change => change.vote !== 10)] : votes;
  const summary = votes.length
    ? html`${shownVotes.map(change => html`<span class="status-text ${voteTone(change.vote)}"><span class="status-dot" aria-hidden="true"></span>${change.text}</span>`)}`
    : pr
      ? prTarget(pr)
      : rowSummary(record);
  const badge = mergeEvidenceBadge(record);
  const origins = [pr ? prForkSource(pr.fork) : '', origin].filter(Boolean);
  // A row with nothing else to say first, such as a new branch, leads with where it started.
  const lead = summary || origins.length === 0 ? summary : origins.shift();
  const trail = record.unseen ? renderTrail(record) : emptyHtml;
  const linked = push
    ? html`<details class="linked-push" data-group="linked-push-${record.groupKey}"><summary>Linked push${push.unseen ? ' · unread' : ''}</summary>
        <button class="ghost sm" type="button" data-action="detail" data-id="${push.id}">View push to ${activityRef(push).branch}</button>
      </details>`
    : emptyHtml;
  return html`<div class="event">${lead || badge !== emptyHtml ? html`<div class="event-main">${typeof lead === 'string' ? (lead ? html`<span>${lead}</span>` : emptyHtml) : lead}${badge}</div>` : emptyHtml}${renderMeta(record)}${
    origins.length || trail !== emptyHtml || push
      ? html`<div class="event-notes">${origins.map(text => html`<div class="help event-origin">${icons.branch}<span>${text}</span></div>`)}${trail}${linked}</div>`
      : emptyHtml
  }</div>`;
}

/** A reviewer vote's tone; the words carry the meaning, the color repeats it. */
const voteTone = (vote: number) => (vote > 0 ? 'ok' : vote === -5 ? 'warn' : vote < 0 ? 'crit' : 'neutral');

/**
 * A CI run without a known trigger has nothing to summarise in its row, and a branch a push created or deleted would only
 * repeat its label. The detail page still says both. A branch read from a ref list keeps its caveat.
 */
function rowSummary(record: ActivityItem) {
  const summary = activitySummary(record);
  if (
    record.kind === 'build' &&
    (summary === 'Not supplied' ||
      (record.data?.result === 'succeeded' &&
        (record.data.reason === 'individualCI' || (record.data.reason === 'pullRequest' && activityRef(record).pullRequestId))))
  )
    return '';
  if (record.kind === 'push' && /^[a-f\d]{7} → [a-f\d]{7}$/i.test(summary)) return '';
  return ['branch-created', 'branch-deleted'].includes(record.kind) && ['New remote branch', 'Remote branch deleted'].includes(summary)
    ? ''
    : summary;
}

/** Whether the title names the ref as a whole word, so `main` is not found inside `main-old`. */
const namesRef = (title: string, ref: string) =>
  new RegExp(`(^|[\\s,(])${ref.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[\\s,)])`).test(title);

/**
 * A branch row's title without its branch and pusher, which the ref line and the meta line show instead, so every
 * branch row reads the same way. Only a title that ends with the row's single branch loses it; one that names several
 * branches keeps them.
 */
function rowTitle(record: ActivityItem, title: string) {
  if (record.kind === 'tag') {
    const prefix = `${activityLabel(record)} · `;
    return title.startsWith(prefix) ? title.slice(prefix.length) || title : title;
  }
  if (!['push', 'branch-created', 'branch-deleted'].includes(record.kind)) return title;
  const branch = record.branch ? activityRef(record).branch : '';
  const suffix = branch ? [` to ${branch}`, ` · ${branch}`].find(end => title.endsWith(end)) : undefined;
  const rest = suffix ? title.slice(0, -suffix.length) : title;
  const actor = activityActor(record);
  const text = actor && rest.startsWith(`${actor} `) ? rest.slice(actor.length + 1) : rest;
  const compact = text === title ? title : text.charAt(0).toUpperCase() + text.slice(1);
  return branch && [activityLabel(record), 'Pushed'].includes(compact) ? branch : compact;
}

/**
 * The line under a row's title says where it happened: repository, branch and pull request as separate tokens.
 * The hidden words keep the button's accessible name readable after its title. A push, branch or tag title already
 * names its ref, so the line leaves it out; a PR or CI title can contain a branch name by accident, so those keep it.
 * @param title the row's shown title
 * @param repoName empty when the row needs no repository name
 */
function renderRefLine(record: ActivityItem, title: string, repoName: string) {
  const ref = record.branch ? activityRef(record) : { branch: '' };
  const named = !['pr', 'build'].includes(record.kind) && Boolean(ref.branch) && namesRef(title, ref.branch);
  const { branch, pullRequestId } = named ? { ...ref, branch: '' } : ref;
  if (!repoName && !branch && !pullRequestId) return emptyHtml;
  const tag = record.kind === 'build' && (record.data?.sourceBranch ?? branch).startsWith('refs/tags/');
  // The branch and its PR share a group that never wraps, so a long branch name is cut short before the chip moves.
  return html`<span class="subref">${repoName ? html`<span class="ref-repo"><span class="sr"> · repository </span>${repoName}</span>` : emptyHtml}${
    branch || pullRequestId
      ? html`<span class="ref-target">${
          branch
            ? html`<span class="ref-branch" title="${branch}">${tag ? icons.tag : icons.branch}<span class="sr"> · ${tag ? 'tag' : 'branch'} </span><span class="ref-name">${tag ? branch.replace(/^refs\/tags\//, '') : branch}</span></span>`
            : emptyHtml
        }${pullRequestId ? html`<span class="chip ref-pr"><span class="sr"> · </span>PR ${pullRequestId}</span>` : emptyHtml}</span>`
      : emptyHtml
  }</span>`;
}

/**
 * @param showRepo whether more than one repository is in view, so the row has to say which one it belongs to
 */
function row(
  record: ActivityItem,
  state: PageState,
  tree: import('../activity-tree.ts').TreeRow | undefined,
  showRepo: boolean,
  push?: ActivityItem,
) {
  const repo = state.repos.find(item => item.id === record.repoId);
  const tone = activityTone(record);
  const failed = record.kind === 'build' && buildState(record).tone === 'crit';
  const ids = JSON.stringify([...record.eventIds, ...(push?.eventIds ?? [])]);
  const unread = [...record.unseenIds, ...(push?.unseenIds ?? [])];
  const unreadIds = JSON.stringify(unread);
  const ackIds = record.unseen
    ? unreadIds
    : JSON.stringify([...record.events, ...(push?.events ?? [])].filter(event => !event.imported).map(event => event.id));
  const ackLinkedPush = push && (!record.unseen || push.unseen);
  const fullTitle = activityTitle(record);
  const title = rowTitle(record, fullTitle);
  const origin = forkText(tree?.fork ?? null);
  return html`<li class="${['row', failed ? 'crit' : '', record.unseen ? 'new' : '', `tone-${tone}`].filter(Boolean).join(' ')}" id="row-${record.groupKey}" data-event-id="${record.id}" data-event-ids="${ids}" data-group-key="${record.groupKey}" data-unseen-ids="${unreadIds}">${tree ? renderTreeCell(tree, tone) : emptyHtml}
    <span class="kind ${tone}">${record.kind === 'branch-created' ? icons.branch : record.kind === 'tag' ? icons.tag : html`<span class="d"></span>`}${activityLabel(record)}</span>
    <div class="subject"><button class="feed-title" type="button" data-action="detail" data-id="${record.id}"><span class="title">${title}${unread.length > 1 ? html` <span class="pill u new-count">${unread.length} new</span>` : emptyHtml}</span>${renderRefLine(record, title, showRepo ? repo?.name || 'Unknown repository' : '')}</button></div>
    ${renderEvent(record, origin, push)}
    <div class="rowact">${azureLink(record.url)}${record.imported ? emptyHtml : html`<button class="ghost sm seen-toggle" type="button" id="seen-${record.groupKey}" data-action="ack-item" data-id="${record.id}" data-mark-seen="${record.unseen}" data-event-ids="${ackIds}" aria-pressed="${!record.unseen}" aria-label="Seen: ${fullTitle}${ackLinkedPush ? ' and linked push' : ''}">${icons.seenBox}Seen</button>`}</div></li>`;
}

function group(
  title: string,
  records: ActivityItem[],
  state: PageState,
  {
    open = true,
    description = '',
    tree,
    showRepo,
    linked,
  }: {
    open?: boolean;
    description?: string;
    tree?: import('../activity-tree.ts').ActivityTree;
    showRepo: boolean;
    linked: Map<string, ActivityItem>;
  },
) {
  if (!records.length) return emptyHtml;
  return html`<section class="group"><details data-group="${title}" ${open ? html`open` : emptyHtml}><summary class="ghead">${title} <span class="pill u">${records.length + linked.size}</span><span class="note">${description}</span></summary><ul class="rows${tree ? ' with-tree' : ''}" ${tree ? html`data-tree-lanes="${tree.width}"` : emptyHtml}>${records.map((record, index) => row(record, state, tree?.rows[index], showRepo, linked.get(record.id)))}</ul></details></section>`;
}

const hasTreeLegend = (tree: ActivityTree) =>
  tree.rows.some(row => row.forkFrom || row.mergeFrom || row.node.shape === 'ring' || row.node.shape === 'merge' || row.node.down);

/**
 * Both groups carry a branch tree. They share one width so their columns line up.
 */
function historyGroups(records: ActivityItem[], state: PageState, hasQuery: boolean, showRepo: boolean) {
  const recorded = historyRows(
    records.filter(record => !record.imported),
    hasQuery,
  );
  const imported = historyRows(
    records.filter(record => record.imported),
    hasQuery,
  );
  const defaultBranches = new Map(state.repos.flatMap(repo => (repo.defaultBranch ? [[repo.id, repo.defaultBranch]] : [])));
  const recordedTree = buildActivityTree(recorded.items, { defaultBranches });
  const importedTree = buildActivityTree(imported.items, { defaultBranches });
  const width = Math.max(recordedTree.width, importedTree.width);
  return {
    content: html`${group('Activity', recorded.items, state, { tree: { ...recordedTree, width }, showRepo, linked: recorded.linked })}${group('Imported history', imported.items, state, { open: hasQuery, description: 'Captured before monitoring started', tree: { ...importedTree, width }, showRepo, linked: imported.linked })}`,
    legend: hasTreeLegend(recordedTree) || hasTreeLegend(importedTree),
  };
}

function historyRows(records: ActivityItem[], hasQuery: boolean) {
  const linked = hasQuery ? new Map<string, ActivityItem>() : linkedMergePushes(records);
  const nestedIds = new Set([...linked.values()].map(push => push.id));
  return { items: records.filter(record => !nestedIds.has(record.id)), linked };
}

/**
 * One banner when the shown repositories need the reader's attention. Plain text: #sync-live already announces sync changes.
 */
function statusBanner(state: PageState, status: (import('./health.ts').SyncStatus & { repoId: string }) | undefined) {
  if (!status) return emptyHtml;
  const name = syncRepoName(state.repos, status);
  const where = name ? `${name}: ` : '';
  if (status.state === 'problem')
    return html`<div class="banner crit"><div><strong>Problem</strong>${where}${status.reason} ${
      status.signInRequired
        ? html`<button class="ghost sm" type="button" id="retry-sign-in" data-action="refresh" data-retry-sign-in>Retry after signing in</button>`
        : html`<a href="#repositories">See Repositories</a>`
    }</div></div>`;
  if (status.state === 'delayed')
    return html`<div class="banner warn"><div><strong>Delayed</strong>${where}${status.reason}. Showing the activity stored so far.</div></div>`;
  if (status.state === 'paused')
    return html`<div class="banner info"><div><strong>Paused</strong>Automatic checks are off. <a href="#settings">Turn them on</a> or refresh manually.</div></div>`;
  return emptyHtml;
}

function matchingAction(state: PageState, ui: FeedView, repoIds: string[]) {
  const total = state.activity.newUpdates;
  if (!total) return emptyHtml;
  const query = activityScopeQuery({ ...ui, repoIds });
  // Stop at the snapshot this page was read at, so updates recorded later stay unread.
  if (state.activity.asOf !== undefined) query.set('through', String(state.activity.asOf));
  const search = ui.search.trim();
  const scope = `${scopeName(state, ui)} · ${activityFilterLabel(ui.kind)}${search ? ` · Search “${search}”` : ''}`;
  const label = ui.search || ui.kind || ui.repoIds !== null ? 'Mark all matching seen' : 'Mark all seen';
  return html`<button class="btn sm" type="button" data-action="ack-matching" data-query="${query.toString()}" data-scope="${scope}">${label} (${total})</button>`;
}

export function renderFeed(state: PageState, ui: FeedView & { savedFilterId: string }) {
  const records = state.activity.items;
  const hasQuery = Boolean(ui.search || ui.kind);
  const shown = state.repos.filter(repo => ui.repoIds === null || ui.repoIds.includes(repo.id));
  // Until every shown repository is synced, an empty or short list does not prove that nothing changed.
  const partial = shown.some(repo => state.syncStatus.repos[repo.id]?.state !== 'synced');
  const overall = state.syncStatus.overall;
  const attention =
    overall.state === 'problem' && !('repoId' in overall)
      ? { ...overall, repoId: '' }
      : worstStatus(
          shown.flatMap(repo => {
            const status = state.syncStatus.repos[repo.id];
            return status ? [{ ...status, repoId: repo.id }] : [];
          }),
        );
  // With one repository in view every row would repeat its name, so rows name it only when several are shown.
  const showRepo = shown.length > 1;
  const { content, legend } = historyGroups(records, state, hasQuery, showRepo);
  const emptyMessage = emptyActivityMessage(ui, partial);
  const emptyHint =
    state.activity.error ||
    (state.activity.loading
      ? 'Reading your locally stored history.'
      : partial
        ? 'This does not confirm that nothing changed. Check repository status.'
        : ui.unreadOnly
          ? 'Turn off Unread only to browse history.'
          : hasQuery || ui.repoIds !== null
            ? 'Adjust your filters to see more activity.'
            : '');
  const bulk = matchingAction(
    state,
    ui,
    shown.map(repo => repo.id),
  );
  return html`<h1 class="sr">Activity</h1>${renderSummary(records, state, ui, partial)}${statusBanner(state, attention)}${filterControls(ui, state)}
    <section class="card feed" aria-label="Repository activity">${bulk === emptyHtml ? emptyHtml : html`<div class="foot feed-actions">${bulk}</div>`}${legend ? treeLegend : emptyHtml}${records.length ? content : html`<div class="empty"><p class="big">${state.activity?.loading ? 'Loading activity…' : state.activity?.error ? 'Activity could not load' : emptyMessage}</p>${emptyHint ? html`<p class="dim">${emptyHint}</p>` : emptyHtml}${state.activity?.error ? html`<button class="btn sm" type="button" data-action="retry-activity">Try again</button>` : emptyHtml}</div>`}${state.activity?.nextCursor ? html`<div class="foot"><button class="btn" type="button" data-action="load-more-activity">Load more</button><span>Showing ${records.length} of ${state.activity.total} recorded items.</span></div>` : emptyHtml}</section>`;
}
