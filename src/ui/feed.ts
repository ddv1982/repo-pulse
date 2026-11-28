import { ACTIVITY_GROUP, IMPORTED_GROUP, disclosure, type Groups } from './groups.ts';
import {
  emptyHtml,
  html,
  joinHtml,
  fullDateTime,
  timeInRow,
  ciTime,
  dayLabel,
  localDay,
  azureLink,
  activityActor,
  activityLabel,
  activityTone,
  activityTitle,
  activitySummary,
  buildState,
  type SafeHtml,
} from './format.ts';
import { syncRepoName } from './health.ts';
import { worstStatus } from '../sync-worst.ts';
import { emptyActivityMessage, renderSummary } from './activity-summary.ts';
import { icons } from './icons.ts';
import { renderTrail } from './activity-trail.ts';
import { renderSearchInput, renderSearchHelp } from './search-field.ts';
import { renderTypeFilter } from './type-filter.ts';
import { activityScopeQuery } from './activity-data.ts';
import { activityFilterLabel, activityRef, prForkSource, prTarget, prVoteChanges, reviewerName, voteLabel } from '../activity-text.ts';
import { branchName } from '../events.ts';
import { renderRepositoryScope, scopeName } from './repository-scope.ts';
import { currentActivityFilters, isSavedFilterModified, renderSavedFilters } from './saved-filters.ts';
import { mergeEvidenceBadge } from './merge-evidence.ts';
import { buildActivityTree, type ActivityTree } from '../activity-tree.ts';
import { forkText, renderTreeCell, renderTreePassThrough, treeLegend } from './activity-tree.ts';
import { linkedMergePushes } from './linked-pushes.ts';
import { linkedTagBuilds } from './linked-tag-builds.ts';
import type { PageState } from './refresh.ts';
import type { ActivityItem } from '../activity.ts';
import { renderCommits, type CommitsView } from './activity-detail.ts';
import { action } from './actions.ts';
import { WIDE_LAYOUT } from './breakpoints.ts';
export { renderDetail } from './activity-detail.ts';

/** `openMenu` is the panel ID of the open toolbar menu, if any; `groups` holds which disclosures are open. */
export type FeedView = Pick<
  import('./navigation.ts').NavigationState,
  'unseenOnly' | 'repoIds' | 'search' | 'activityFilter' | 'filtersOpen'
> & {
  openMenu?: string;
  groups: Groups;
};

function filterControls(ui: FeedView & { savedFilterId: string }, state: PageState) {
  const desktop = globalThis.matchMedia?.(WIDE_LAYOUT).matches ?? true;
  const active = Number(Boolean(ui.search)) + Number(Boolean(ui.activityFilter)) + Number(ui.unseenOnly);
  // Clear filter leaves the repository scope alone, so only the Filters count includes it.
  const count = active + Number(ui.repoIds !== null);
  const open = desktop || ui.filtersOpen === true;
  const presets = state.savedFilters;
  const saved = presets.find(filter => filter.id === ui.savedFilterId);
  const modified = Boolean(saved && isSavedFilterModified(saved.filters, currentActivityFilters(ui), state.allRepos));
  return html`<div class="activity-filter-bar">
    <button class="btn filters-toggle" id="activity-filters-toggle" ${action('toggle-activity-filters')} type="button"
      aria-expanded="${open}" aria-controls="activity-filters">Filters${count ? ` · ${count}` : ''}</button>
    ${renderSavedFilters(presets, ui.savedFilterId, modified, ui.openMenu)}
    <div class="filters-box" id="activity-filters" ${open ? emptyHtml : html`hidden`}>
      <div class="toolbar">${renderSearchInput('feed-search', 'Search activity', 'Search branch, commit, person or repository…', ui.search, 'search-activity')}
        <div class="filter-actions">
          ${renderTypeFilter(ui.activityFilter, state.activity.filterOptions, state.activity.loading, ui.openMenu === 'kind-panel')}
          ${renderRepositoryScope(state, ui)}
          <button class="btn" id="unread-only" type="button" ${action('toggle-unseen-only')} aria-pressed="${ui.unseenOnly}">Unread only</button>
          ${active ? html`<button class="btn" id="clear-filters" type="button" ${action('clear-filters')}>Clear filter</button>` : emptyHtml}
        </div>
      </div>${renderSearchHelp('feed-search', 'names only')}
    </div>
  </div>`;
}

/** What the named person did, per kind, as line 2 says it. A branch or tag event comes from a push. */
const actorRoles: Record<import('../activity.ts').ActivityKind, string> = {
  pr: 'author',
  build: 'requested by',
  push: 'pushed by',
  'branch-created': 'pushed by',
  'branch-deleted': 'pushed by',
  tag: 'pushed by',
};

/** Who did it, with their role. Azure's explicit Unknown has no role to name; a missing actor shows nothing. */
function renderActor(record: ActivityItem) {
  const actor = activityActor(record);
  if (!actor) return emptyHtml;
  return html`<span class="ref-actor">${actor === 'Unknown' ? emptyHtml : html`${actorRoles[record.kind]} `}<span class="actor">${actor}</span></span>`;
}

/** Who and when, for a run nested in another row. The day header above the row names the day of `rowTime`. */
function renderMeta(record: ActivityItem, rowTime: ActivityItem['time']) {
  const actor = activityActor(record);
  const role = actor && actor !== 'Unknown' ? `${actorRoles[record.kind]} ` : '';
  return html`<div class="help event-meta">${actor ? html`${role}<span class="actor">${actor}</span> · ` : emptyHtml}<time datetime="${record.time}" title="${fullDateTime(record.time)}">${timeInRow(record.time, rowTime)}</time></div>`;
}

const ciPhase = (run: import('../activity.ts').RelatedCi) =>
  run.validation ? 'PR validation' : run.postMerge ? 'Post-merge CI' : 'Branch CI';
const activeCi = (run: import('../activity.ts').RelatedCi) => ['queued', 'running', 'canceling'].includes(run.outcome);

/** A run in the run list the CI count opens: its phase, outcome and time. */
function ciRunButton(run: import('../activity.ts').RelatedCi, rowTime: ActivityItem['time'], tone: string, named = false) {
  const outcome = run.outcome === 'passing again' ? 'passed' : run.outcome;
  return html`<button type="button" class="ghost sm ci-run status-text ${tone}" ${action('detail')} data-event-id="${run.id}" title="${run.title} · ${fullDateTime(run.time)}"><span>${ciPhase(run)} ${outcome}${run.stale ? ' on earlier revision' : ''}${named && run.title !== 'CI run' ? ` · ${run.title}` : ''}</span> ${ciTime(run.time, true, rowTime)}</button>`;
}

/**
 * One part of the trouble line: a glyph, then the pipeline and its outcome. A result that stands alone names its phase
 * and then its pipeline; in a mixed state each part names its pipeline. Failures are red, runs in progress and other
 * problems amber, and passes muted. A note follows in muted text.
 */
function troublePart({ run, tone, note }: import('../activity.ts').CiResult, named: boolean) {
  const known = run.title !== 'CI run';
  const outcome = run.outcome === 'passing again' ? 'passed again' : run.outcome;
  const glyph = run.outcome === 'failed' ? '✕' : activeCi(run) ? '○' : run.outcome === 'partially succeeded' ? '!' : '✓';
  const colour = activeCi(run) ? 'warn' : tone === 'crit' || tone === 'warn' ? tone : 'muted';
  return html`<button type="button" class="ghost sm ci-run ${colour}" ${action('detail')} data-event-id="${run.id}" title="${ciPhase(run)} · ${run.title} · ${fullDateTime(run.time)}"><span class="ci-glyph" aria-hidden="true">${glyph}</span> ${named && known ? run.title : ciPhase(run)} ${outcome}${run.stale ? ' on earlier revision' : ''}${!named && known ? html`<span class="ci-pipeline"> · ${run.title}</span>` : emptyHtml}${note ? html`<span class="ci-note"> · ${note}</span>` : emptyHtml}</button>`;
}

/**
 * A row's CI: the count of its runs and a recovery note for the status cell, the trouble line under line 2, and the
 * run list the count opens. Results that all pass stay folded into the count. A result with a problem puts every
 * result on the trouble line, and the count opens the runs not shown already. With nothing more to open, the count is
 * plain text. A CI run that tested a change links to it from the trouble line.
 */
function relatedCi(record: ActivityItem, groups: Groups) {
  const { results, historyCount } = record.ciSummary ?? { results: [], historyCount: 0 };
  const host = record.ciHost
    ? html`<button type="button" class="ghost sm ci-host" ${action('detail')} data-event-id="${record.ciHost}">${record.highlight ? 'View pull request' : 'View tested change'}</button>`
    : emptyHtml;
  const passing = results.every(({ run, tone, note }) => tone === 'ok' && !note && !run.stale);
  const parts = passing ? [] : results.map(result => troublePart(result, results.length > 1));
  const trouble =
    parts.length || host !== emptyHtml
      ? html`<div class="ci-trouble">${joinHtml(parts, html` <span class="ci-sep" aria-hidden="true">·</span> `)}${host}</div>`
      : emptyHtml;
  if (!results.length) return { count: emptyHtml, trouble, runs: emptyHtml };
  const again =
    passing && results.some(({ run }) => run.outcome === 'passing again')
      ? html`<span class="ci-again"><span aria-hidden="true">✓</span> passed again</span>`
      : emptyHtml;
  const currentIds = new Set(results.map(({ run }) => run.id));
  const history = record.relatedCi?.filter(run => !currentIds.has(run.id)) ?? [];
  const total = results.length + historyCount;
  const label = html`CI · ${total} ${total === 1 ? 'run' : 'runs'}`;
  if (!passing && !historyCount) return { count: html`${again} <span class="ci-count">${label}</span>`, trouble, runs: emptyHtml };
  const id = `ci-${record.groupKey}`;
  const listId = `ci-runs-${record.groupKey}`;
  const count = html`${again} <button type="button" class="ghost sm ci-count" id="ci-count-${record.groupKey}" ${action('toggle-group')} aria-controls="${listId}" aria-expanded="${groups.get(id) ?? false}">${label}<span aria-hidden="true"> ›</span></button>`;
  // The list is a disclosure that the count in the status cell opens; its own summary stays hidden.
  const runs = html`<details class="linked-event ci-history" id="${listId}" ${disclosure(groups, id)}><summary hidden></summary><div class="ci-rollup">${passing ? results.map(({ run }) => ciRunButton(run, record.time, 'neutral', results.length > 1)) : emptyHtml}${history.map(run => ciRunButton(run, record.time, 'neutral'))}${historyCount > history.length ? html`<button type="button" class="ghost sm" ${action('detail')} data-event-id="${record.id}" data-related>View all CI runs</button>` : emptyHtml}</div></details>`;
  return { count, trouble, runs };
}

/** A vote kind as the tally counts it. */
function voteCount(vote: number, label: string, count: number) {
  if (vote === 10) return `${count} ${count === 1 ? 'approval' : 'approvals'}`;
  if (vote === 0) return `${count} ${count === 1 ? 'vote reset' : 'votes reset'}`;
  return `${count} ${label}`;
}

/**
 * The votes a PR row names: on an open PR's latest milestone, its current approvals and the other votes that changed;
 * on other milestones, the votes that changed there. Line 2 counts them, and the count opens the named list.
 */
function rowVotes(record: ActivityItem, pr: ActivityItem['data'], groups: Groups) {
  const changes = pr ? prVoteChanges(pr) : [];
  const latest = record.latestPrMilestone && pr?.status === 'active' ? pr.reviewers : undefined;
  const named = latest
    ? [
        ...latest
          .filter(reviewer => reviewer.vote > 0)
          .map(reviewer => ({ name: reviewerName(reviewer.name), vote: reviewer.vote, label: voteLabel(reviewer.vote) })),
        ...changes.filter(change => change.vote <= 0),
      ]
    : changes;
  if (!named.length) return latest ? { tally: html`<span>0 approvals</span>`, list: emptyHtml } : undefined;
  const kinds = new Map<number, { label: string; count: number }>();
  for (const { vote, label } of named) kinds.set(vote, { label, count: (kinds.get(vote)?.count ?? 0) + 1 });
  const words = [...kinds].map(([vote, { label, count }]) => voteCount(vote, label, count)).join(', ');
  const tone = named.some(({ vote }) => vote === -10) ? ' crit' : named.some(({ vote }) => vote === -5) ? ' warn' : '';
  const id = `votes-${record.groupKey}`;
  const listId = `vote-list-${record.groupKey}`;
  return {
    tally: html`<button type="button" class="ghost sm vote-tally${tone}" id="vote-tally-${record.groupKey}" ${action('toggle-group')} aria-controls="${listId}" aria-expanded="${groups.get(id) ?? false}">${words}<span aria-hidden="true"> ›</span></button>`,
    list: html`<details class="linked-event vote-list" id="${listId}" ${disclosure(groups, id)}><summary hidden></summary><ul>${named.map(
      ({ name, vote, label }) =>
        html`<li><span class="voter">${name}</span> <span class="status-text ${voteTone(vote)}">${label}</span></li>`,
    )}</ul></details>`,
  };
}

/** Line 2's last token: the vote tally of a PR, or the row's summary; and the named votes the tally opens. */
function eventSummary(record: ActivityItem, targetShown: boolean, pr: ActivityItem['data'], groups: Groups) {
  const votes = rowVotes(record, pr, groups);
  if (votes) return { summary: votes.tally, votes: votes.list };
  if (pr?.targetRefName) return { summary: targetShown ? '' : prTarget(pr), votes: emptyHtml };
  return { summary: rowSummary(record), votes: emptyHtml };
}

/** A line 3 token that opens a panel under line 3, as the CI count opens the run list. */
function panelToken(panelId: string, groupId: string, groups: Groups, label: SafeHtml | string, unread = false) {
  return html`<button type="button" class="ghost sm token${unread ? ' unread' : ''}" id="${panelId}-token" ${action('toggle-group')} aria-controls="${panelId}" aria-expanded="${groups.get(groupId) ?? false}">${label}<span aria-hidden="true"> ›</span></button>`;
}

/** A linked push or tag build: its line 3 token and the panel the token opens. */
function linkedEvent(record: ActivityItem, related: ActivityItem, groups: Groups) {
  const groupId = `linked-${related.kind}-${record.groupKey}`;
  const panelId = `linked-${record.groupKey}`;
  const build = related.kind === 'build';
  const token = build
    ? panelToken(panelId, groupId, groups, html`CI succeeded ${ciTime(related.time, true, record.time)}`)
    : panelToken(panelId, groupId, groups, `Linked push${related.unseen ? ' · unread' : ''}`, related.unseen);
  const content = build
    ? html`<button class="ghost sm" type="button" ${action('detail')} data-event-id="${related.id}">${activityTitle(related)}</button>
        ${renderMeta(related, record.time)}${azureLink(related.url, 'Build in Azure ↗')}`
    : html`<button class="ghost sm" type="button" ${action('detail')} data-event-id="${related.id}">View push to ${activityRef(related).branch}</button>`;
  return {
    token,
    panel: html`<details class="linked-event" id="${panelId}" ${disclosure(groups, groupId)}><summary hidden></summary>${content}</details>`,
  };
}

/**
 * Line 3 and the panels under it. Line 3 holds tokens of one shape in a fixed order: the update trail, a linked push or
 * tag build, where the branch or PR started (plain text), and Load commits. It is left out when it has none. The panels
 * follow in the same order, after the run list the CI count opens.
 */
function renderExtra(
  record: ActivityItem,
  origins: string[],
  ciRuns: SafeHtml,
  groups: Groups,
  related?: ActivityItem,
  commits?: CommitsView,
) {
  const tokens: SafeHtml[] = [];
  const panels: SafeHtml[] = [ciRuns];
  if (record.unseen && record.events.length > 1) {
    const panelId = `trail-${record.groupKey}`;
    tokens.push(panelToken(panelId, `activity-${record.groupKey}`, groups, `${record.events.length} updates`, true));
    panels.push(renderTrail(record, { groups, id: panelId }));
  }
  if (related) {
    const { token, panel } = linkedEvent(record, related, groups);
    tokens.push(token);
    panels.push(panel);
  }
  tokens.push(...origins.map(text => html`<span class="token plain event-origin">${icons.branch}<span>${text}</span></span>`));
  const pushId = record.kind === 'push' ? (record.data?.pushId ?? record.data?.push?.pushId) : undefined;
  if (pushId !== undefined) {
    tokens.push(
      html`<button class="ghost sm token" type="button" id="commits-${record.id}" ${action('load-commits')} data-inline-id="${record.id}" data-repo-id="${record.repoId}" data-push-id="${pushId}">${commits && 'error' in commits ? 'Retry loading commits' : commits ? 'Reload commits' : 'Load commits'}</button>`,
    );
    panels.push(
      commits && 'items' in commits
        ? html`<details class="linked-event" ${disclosure(groups, `push-commits-${record.groupKey}`, true)}><summary ${action('toggle-group')}>Push commits</summary>${renderCommits(commits)}</details>`
        : commits
          ? renderCommits(commits)
          : emptyHtml,
    );
  }
  const shown = panels.filter(panel => panel !== emptyHtml);
  return html`${tokens.length ? html`<div class="row-line3">${tokens}</div>` : emptyHtml}${shown.length ? html`<div class="row-extra">${shown}</div>` : emptyHtml}`;
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
  return ['branch-created', 'branch-deleted'].includes(record.kind) && ['New remote branch', 'Remote branch deleted'].includes(summary)
    ? ''
    : summary;
}

/** Whether the title names the ref as a whole word, so `main` is not found inside `main-old`. */
const namesRef = (title: string, ref: string) =>
  new RegExp(`(^|[\\s,(])${ref.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[\\s,)])`).test(title);

function commitSubject(record: ActivityItem, loaded: CommitsView | undefined) {
  const refs = record.data?.refUpdates;
  const tip = refs?.length === 1 ? refs[0]?.newObjectId : undefined;
  const commits = loaded && 'items' in loaded && loaded.items.length ? loaded.items : (record.data?.commits ?? []);
  const lead = tip
    ? commits.find(
        commit =>
          commit &&
          typeof commit === 'object' &&
          'commitId' in commit &&
          typeof commit.commitId === 'string' &&
          commit.commitId.toLowerCase() === tip.toLowerCase(),
      )
    : commits.length === 1 && !(loaded && 'nextCursor' in loaded && loaded.nextCursor)
      ? commits[0]
      : undefined;
  if (lead && typeof lead === 'object' && 'comment' in lead && typeof lead.comment === 'string') {
    const subject = lead.comment.split(/\r?\n/, 1)[0]?.trim();
    return subject;
  }
}

/**
 * A branch row's title without its branch and pusher, which the ref line and the meta line show instead, so every
 * branch row reads the same way. Only a title that ends with the row's single branch loses it; one that names several
 * branches keeps them.
 */
function rowTitle(record: ActivityItem, title: string, loaded?: CommitsView) {
  if (record.kind === 'push') {
    const subject = commitSubject(record, loaded);
    if (subject) return subject;
  }
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

function renderTitle(record: ActivityItem, title: string) {
  const prefix = record.kind === 'pr' && record.data?.pullRequestId ? `PR ${record.data.pullRequestId} · ` : '';
  const hasPrefix = prefix && title.startsWith(prefix);
  const subject = hasPrefix ? title.slice(prefix.length) : title;
  const parts = subject.split(/(?<=\w_)(?=\w)/);
  return html`${hasPrefix ? html`<span class="title-id">${prefix}</span>` : emptyHtml}${joinHtml(
    parts.map(part => html`${part}`),
    html`<wbr>`,
  )}`;
}

/** The separator between line 2's facts as it is read out; the middot a reader sees is drawn by the stylesheet. */
const SEPARATOR = html`<span class="sr"> · </span>`;
const sep = (token: SafeHtml) => (token === emptyHtml ? emptyHtml : html`${SEPARATOR}${token}`);

/** A merged PR's merge commit, shortened, with the full ID in its title. */
function mergeShaToken(pr: ActivityItem['data']) {
  const sha = pr?.status === 'completed' ? pr.mergeCommit : undefined;
  return sha ? html`<code class="ref-sha" title="${sha}"><span class="sr">merge commit </span>${sha.slice(0, 9)}</code>` : emptyHtml;
}

/**
 * Where line 2 says a row happened: `branch → target` and the merge commit once landed, or the branch and its PR. A
 * push, branch or tag title already names its ref, so the line leaves it out; a PR or CI title can contain a branch
 * name by accident, so those keep it.
 * @param target the branch a PR row goes into, or ''
 */
function renderRoute(record: ActivityItem, title: string, target: string) {
  const pr = record.kind === 'pr' ? record.data : undefined;
  const ref = target ? { branch: branchName(pr?.sourceRefName || record.branch) } : record.branch ? activityRef(record) : { branch: '' };
  const named = !['pr', 'build'].includes(record.kind) && Boolean(ref.branch) && namesRef(title, ref.branch);
  // A branch into the same name says it once, except from a fork, where the two are branches of different repositories.
  const branch = named || (ref.branch === target && !pr?.fork) ? '' : ref.branch;
  const { pullRequestId } = ref;
  const shaToken = mergeShaToken(pr);
  if (!branch && !pullRequestId && !target) return shaToken;
  const tag = record.kind === 'build' && (record.data?.sourceBranch ?? branch).startsWith('refs/tags/');
  // The branch and its PR share a group that never wraps, so a long branch name is cut short before the chip moves.
  return html`<span class="ref-target${target ? ' ref-route' : ''}">${
    branch
      ? html`<span class="ref-branch" title="${branch}">${tag ? icons.tag : icons.branch}<span class="sr">${tag ? 'tag' : target ? 'source branch' : 'branch'} </span><span class="ref-name">${tag ? branch.replace(/^refs\/tags\//, '') : branch}</span></span>`
      : emptyHtml
  }${
    target
      ? html`${branch ? html`<span aria-hidden="true">→</span><span class="sr"> targeting branch </span>` : html`<span>Target:</span> `}<span class="ref-destination" title="${target}"><span class="ref-name">${target}</span></span> ${sep(shaToken)}`
      : html` ${sep(shaToken)}`
  }${pullRequestId ? html`<span class="chip ref-pr"><span class="sr"> · </span>PR ${pullRequestId}</span>` : emptyHtml}</span>`;
}

/**
 * Line 2, the facts under a row's title, in this order: repository, where (`renderRoute`), who did it, then the
 * summary or vote tally, and the merge evidence. It describes the title button, and its hidden words keep that
 * description readable.
 * @param title the row's shown title
 * @param repoName empty when the row needs no repository name
 */
function renderFacts(
  record: ActivityItem,
  { title, repoName, target, summary }: { title: string; repoName: string; target: string; summary: string | SafeHtml },
) {
  const parts = [
    repoName ? html`<span class="ref-repo"><span class="sr">repository </span>${repoName}</span>` : emptyHtml,
    renderRoute(record, title, target),
    renderActor(record),
    summary ? html`<span class="ref-summary">${summary}</span>` : emptyHtml,
    mergeEvidenceBadge(record),
  ].filter(part => part !== emptyHtml);
  // A click on line 2 opens the detail as the title does; a control in it, such as the vote tally, keeps its own action.
  return parts.length
    ? html`<div class="subref" id="facts-${record.groupKey}" ${action('detail')} data-event-id="${record.id}">${joinHtml(parts, SEPARATOR)}</div>`
    : emptyHtml;
}

function renderKind(record: ActivityItem, tone: string) {
  const kind = activityLabel(record);
  const build = record.kind === 'build';
  const active = record.kind === 'pr' && record.data?.status === 'active';
  const draft = active && record.data?.isDraft;
  const created =
    active &&
    !draft &&
    record.data?.pullRequestCreatedAt &&
    new Date(record.time).valueOf() === Date.parse(record.data.pullRequestCreatedAt);
  const highlightLabels: Partial<Record<NonNullable<ActivityItem['highlight']>, string>> = {
    'review-ready': 'Ready for review',
    reopened: 'PR reopened',
    retargeted: 'PR retargeted',
    abandoned: 'PR abandoned',
    'review-blocked': 'Review needs action',
    'review-approved': 'Approvals met',
    'default-push': 'Default branch push',
    rewrite: 'History rewritten',
  };
  const label =
    (record.highlight && highlightLabels[record.highlight]) ||
    (build
      ? `CI ${kind.toLowerCase()}`
      : kind === 'Merged'
        ? 'PR merged'
        : active && !draft && record.data?.voteChanges?.length
          ? 'PR review'
          : created
            ? 'PR opened'
            : kind);
  const glyph =
    record.kind === 'branch-created'
      ? icons.branch
      : record.kind === 'tag'
        ? icons.tag
        : html`<span class="d${build ? ' ci-marker' : ''}${active ? ' pr-marker' : ''}${draft ? ' draft-marker' : ''}"></span>`;
  const state = record.highlight === 'review-approved' ? ' approved' : kind === 'Merged' ? ' merged' : '';
  return html`<span class="kind ${tone}${state}">${glyph}<span class="kind-label">${label}</span></span>`;
}

/**
 * Line 2 of a row, and the origin notes it leaves for under it. Open and merged PRs name their target on line 2.
 * @param repoName empty when the row needs no repository name
 */
function rowFacts(
  record: ActivityItem,
  title: string,
  repoName: string,
  tree: import('../activity-tree.ts').TreeRow | undefined,
  groups: Groups,
) {
  const pr = record.kind === 'pr' ? record.data : undefined;
  const target = pr && ['active', 'completed'].includes(pr.status ?? '') && pr.targetRefName ? branchName(pr.targetRefName) : '';
  const { summary, votes } = eventSummary(record, Boolean(target), pr, groups);
  const origins = [pr ? prForkSource(pr.fork) : '', forkText(tree?.fork ?? null)].filter(Boolean);
  // A new branch can lead with its origin. A PR with its target on line 2 keeps the origin under it.
  const lead = summary || target || origins.length === 0 ? summary : (origins.shift() ?? '');
  return { facts: renderFacts(record, { title, repoName, target, summary: lead }), votes, origins };
}

/**
 * @param showRepo whether more than one repository is in view, so the row has to say which one it belongs to
 */
function row(
  record: ActivityItem,
  state: PageState,
  tree: import('../activity-tree.ts').TreeRow | undefined,
  showRepo: boolean,
  groups: Groups,
  related?: ActivityItem,
  commits?: CommitsView,
) {
  const repo = state.enabledRepos.find(item => item.id === record.repoId);
  const tone = activityTone(record);
  const failed = record.kind === 'build' && buildState(record).tone === 'crit';
  const push = related?.kind === 'push' ? related : undefined;
  const ids = JSON.stringify([...record.eventIds, ...(related?.eventIds ?? [])]);
  const unseen = [...record.unseenIds, ...(push?.unseenIds ?? [])];
  const unseenIds = JSON.stringify(unseen);
  const ackIds = record.unseen
    ? unseenIds
    : JSON.stringify([...record.events, ...(push?.events ?? [])].filter(event => !event.imported).map(event => event.id));
  const ackLinkedPush = push && (!record.unseen || push.unseen);
  const fullTitle = activityTitle(record);
  const title = rowTitle(record, fullTitle, commits);
  const { facts, votes, origins } = rowFacts(record, title, showRepo ? repo?.name || 'Unknown repository' : '', tree, groups);
  const ci = relatedCi(record, groups);
  return html`<li class="${['row', failed ? 'crit' : '', record.unseen ? 'new' : '', `tone-${tone}`].filter(Boolean).join(' ')}" id="row-${record.groupKey}" data-event-id="${record.id}" data-event-ids="${ids}" data-group-key="${record.groupKey}" data-unseen-ids="${unseenIds}">${tree ? renderTreeCell(tree, tone) : emptyHtml}
    <div class="status">${renderKind(record, tone)} ${ci.count}</div>
    <div class="subject"><div class="row-head"><button class="feed-title" type="button" ${action('detail')} data-event-id="${record.id}" ${facts === emptyHtml ? emptyHtml : html`aria-describedby="facts-${record.groupKey}"`}><span class="title">${renderTitle(record, title)}${unseen.length > 1 ? html` <span class="pill u new-count">${unseen.length} new</span>` : emptyHtml}</span></button>${facts}</div>${votes}${ci.trouble}${renderExtra(record, origins, ci.runs, groups, related, commits)}</div>
    ${renderRowActions(record, fullTitle, ackIds, Boolean(ackLinkedPush))}</li>`;
}

/** The right cell: the row's clock time, its Azure link and its Seen toggle. Imported rows have no Seen toggle. */
function renderRowActions(record: ActivityItem, fullTitle: string, ackIds: string, ackLinkedPush: boolean) {
  return html`<div class="rowact"><time class="row-time" datetime="${record.time}" title="${fullDateTime(record.time)}">${timeInRow(record.time, record.time)}</time>${azureLink(record.url)}${record.imported ? emptyHtml : html`<button class="ghost sm seen-toggle" type="button" id="seen-${record.groupKey}" ${action('ack-item')} data-event-id="${record.id}" data-mark-seen="${record.unseen}" data-event-ids="${ackIds}" aria-pressed="${!record.unseen}" aria-label="Seen: ${fullTitle}${ackLinkedPush ? ' and linked push' : ''}">${icons.seenBox}Seen</button>`}</div>`;
}

/**
 * A day header before the first row of each local calendar day. It is a list item without a row's data attributes,
 * so nothing that reads rows counts it, and the row below keeps its tree row index. Over the tree it draws the lanes
 * that enter that row from above, so they run on through the header.
 */
function dayHeader(groupId: string, day: string, first: ActivityItem, tree: import('../activity-tree.ts').TreeRow | undefined) {
  // Keyed by the row it starts: a day can start twice when a CI group sorts by a newer time than it shows.
  return html`<li class="day" id="day-${groupId}-${first.groupKey}">${tree ? renderTreePassThrough(tree) : emptyHtml}<time datetime="${day}">${dayLabel(first.time)}</time></li>`;
}

/** The day of each row that starts a new local day, or '' when it continues the day above. Invalid times start none. */
function rowDays(records: ActivityItem[]) {
  let previous = '';
  return records.map(record => {
    const day = localDay(record.time);
    if (!day || day === previous) return '';
    previous = day;
    return day;
  });
}

function group(
  id: string,
  title: string,
  records: ActivityItem[],
  state: PageState,
  {
    open = true,
    description = '',
    tree,
    showRepo,
    linked,
    feedCommits,
    groups,
  }: {
    groups: Groups;
    open?: boolean;
    description?: string;
    tree?: import('../activity-tree.ts').ActivityTree;
    showRepo: boolean;
    linked: Map<string, ActivityItem>;
    feedCommits: ReadonlyMap<string, CommitsView> | undefined;
  },
) {
  if (!records.length) return emptyHtml;
  const days = rowDays(records);
  return html`<section class="group"><details ${disclosure(groups, id, open)}><summary ${action('toggle-group')} class="ghead">${title} <span class="pill u">${records.length + linked.size + records.reduce((total, record) => total + (record.foldedCi ?? 0), 0)}</span><span class="note">${description}</span></summary><ul class="rows${tree ? ' with-tree' : ''}" ${tree ? html`data-tree-lanes="${tree.width}"` : emptyHtml}>${records.map(
    (record, index) => {
      const day = days[index];
      return html`${day ? dayHeader(id, day, record, tree?.rows[index]) : emptyHtml}${row(record, state, tree?.rows[index], showRepo, groups, linked.get(record.id), feedCommits?.get(record.id))}`;
    },
  )}</ul></details></section>`;
}

const hasTreeLegend = (tree: ActivityTree) =>
  tree.rows.some(row => row.forkFrom || row.mergeFrom || row.node.shape === 'merge' || row.node.down);

/**
 * Both groups carry a branch tree. They share one width so their columns line up.
 */
function historyGroups(
  records: ActivityItem[],
  state: PageState,
  hasQuery: boolean,
  showRepo: boolean,
  feedCommits: ReadonlyMap<string, CommitsView> | undefined,
  groups: Groups,
) {
  const recorded = historyRows(
    records.filter(record => !record.imported),
    hasQuery,
  );
  const imported = historyRows(
    records.filter(record => record.imported),
    hasQuery,
  );
  const defaultBranches = new Map(state.enabledRepos.flatMap(repo => (repo.defaultBranch ? [[repo.id, repo.defaultBranch]] : [])));
  const recordedTree = buildActivityTree(recorded.items, { defaultBranches });
  const importedTree = buildActivityTree(imported.items, { defaultBranches });
  const width = Math.max(recordedTree.width, importedTree.width);
  return {
    content: html`${group(ACTIVITY_GROUP, 'Activity', recorded.items, state, { tree: { ...recordedTree, width }, showRepo, feedCommits, groups, linked: recorded.linked })}${group(IMPORTED_GROUP, 'Imported history', imported.items, state, { groups, open: hasQuery || !recorded.items.length, description: 'Captured before monitoring started', tree: { ...importedTree, width }, showRepo, feedCommits, linked: imported.linked })}`,
    legend: hasTreeLegend(recordedTree) || hasTreeLegend(importedTree),
  };
}

function historyRows(records: ActivityItem[], hasQuery: boolean) {
  const linked =
    hasQuery || records.some(record => record.highlight)
      ? new Map<string, ActivityItem>()
      : new Map([...linkedMergePushes(records), ...linkedTagBuilds(records)]);
  const nestedIds = new Set([...linked.values()].map(push => push.id));
  return { items: records.filter(record => !nestedIds.has(record.id)), linked };
}

/**
 * One banner when the shown repositories need the reader's attention. Plain text: #sync-live already announces sync changes.
 */
function statusBanner(state: PageState, status: (import('../contract.ts').SyncStatus & { repoId: string }) | undefined) {
  if (!status) return emptyHtml;
  const name = syncRepoName(state.enabledRepos, status);
  const where = name ? `${name}: ` : '';
  if (status.state === 'problem' && status.signInRequired)
    return html`<div class="banner crit azure-sign-in"><div>
      <strong>Azure sign-in required</strong>
      Run <span class="azure-sign-in-command"><code>az login</code><button class="ghost sm" type="button" id="copy-azure-login" ${action('copy-azure-login')} aria-label="Copy az login" title="Copy az login">${icons.copy}</button></span> in your terminal to reconnect${name ? ` ${name}` : ''}.
      <button class="ghost sm" type="button" id="retry-sign-in" ${action('refresh')} data-retry-sign-in>Retry after signing in</button>
    </div></div>`;
  if (status.state === 'problem')
    return html`<div class="banner crit"><div><strong>Problem</strong>${where}${status.reason} <a href="#repositories">See Repositories</a></div></div>`;
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
  const scope = `${scopeName(state, ui)} · ${activityFilterLabel(ui.activityFilter)}${search ? ` · Search “${search}”` : ''}`;
  const label = ui.search || ui.activityFilter || ui.repoIds !== null ? 'Mark all matching seen' : 'Mark all seen';
  return html`<button class="btn sm" type="button" ${action('ack-matching')} data-query="${query.toString()}" data-scope="${scope}">${label} (${total})</button>`;
}

export function renderFeed(state: PageState, ui: FeedView & { savedFilterId: string }, feedCommits?: ReadonlyMap<string, CommitsView>) {
  const records = state.activity.items;
  const hasQuery = Boolean(ui.search || ui.activityFilter);
  const shown = state.enabledRepos.filter(repo => ui.repoIds === null || ui.repoIds.includes(repo.id));
  // Until every shown repository is synced, an empty or short list does not prove that nothing changed.
  const partial = shown.some(repo => state.syncStatus.repos[repo.id]?.state !== 'synced');
  const overall = state.syncStatus.overall;
  const attention =
    overall.state === 'problem' && overall.repoId === undefined
      ? { ...overall, repoId: '' }
      : worstStatus(
          shown.flatMap(repo => {
            const status = state.syncStatus.repos[repo.id];
            return status ? [{ ...status, repoId: repo.id }] : [];
          }),
        );
  const progress = attention?.state === 'syncing' ? attention.firstSync : undefined;
  const firstSync =
    attention && progress
      ? `${shown.length > 1 ? `${syncRepoName(state.enabledRepos, attention)} · ` : ''}${progress.completed} of ${progress.total} checks complete`
      : undefined;
  // With one repository in view every row would repeat its name, so rows name it only when several are shown.
  const showRepo = shown.length > 1;
  const { content, legend } = historyGroups(records, state, hasQuery, showRepo, feedCommits, ui.groups);
  const emptyMessage = emptyActivityMessage(ui, partial);
  const emptyHint =
    state.activity.error ||
    (state.activity.loading
      ? 'Reading your locally stored history.'
      : partial
        ? 'This does not confirm that nothing changed. Check repository status.'
        : ui.unseenOnly
          ? 'Turn off Unread only to browse history.'
          : hasQuery || ui.repoIds !== null
            ? 'Adjust your filters to see more activity.'
            : '');
  const bulk = matchingAction(
    state,
    ui,
    shown.map(repo => repo.id),
  );
  return html`<h1 class="sr">Activity</h1>${renderSummary(records, state, ui, partial, firstSync)}${statusBanner(state, attention)}${filterControls(ui, state)}
    <section class="card feed" aria-label="Repository activity">${bulk === emptyHtml ? emptyHtml : html`<div class="foot feed-actions">${bulk}</div>`}${legend ? treeLegend(ui.groups) : emptyHtml}${records.length ? content : html`<div class="empty"><p class="big">${state.activity.loading ? 'Loading activity…' : state.activity.error ? 'Activity could not load' : emptyMessage}</p>${emptyHint ? html`<p class="dim">${emptyHint}</p>` : emptyHtml}${state.activity.error ? html`<button class="btn sm" type="button" ${action('retry-activity')}>Try again</button>` : emptyHtml}</div>`}${state.activity.nextCursor ? html`<div class="foot"><button class="btn" type="button" ${action('load-more-activity')}>Load more</button><span>Showing ${records.reduce((total, record) => total + 1 + (record.foldedCi ?? 0), 0)} of ${state.activity.total} recorded items.</span></div>` : emptyHtml}</section>`;
}
