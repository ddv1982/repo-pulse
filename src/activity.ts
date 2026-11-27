export type ActivityKind = 'branch-created' | 'branch-deleted' | 'tag' | 'push' | 'pr' | 'build';
export type RefUpdate = { name?: string; oldObjectId?: string; newObjectId?: string | undefined };
/**
 * A completed PR in push merge evidence (server/merge-evidence.ts localPrLink). `id` and an object `closedBy` come from older rows.
 */
export type EvidencePr = {
  pullRequestId?: number | string | undefined;
  id?: number | string;
  url?: string | undefined;
  sourceRefName?: string | undefined;
  targetRefName?: string | undefined;
  closedBy?: string | { displayName?: string } | undefined;
  mergeStrategy?: string | undefined;
  mergeCommit?: string | undefined;
  relationship?: string;
};
export type EvidenceCommit = { commitId?: string; parents?: string[]; branches?: (string | undefined)[] };
/**
 * A moved branch's range, saved by the earlier merge analysis.
 */
export type EvidenceRange = {
  name?: string;
  oldObjectId?: string;
  newObjectId?: string;
  commitIds?: string[];
  complete?: boolean;
  update?: { status?: string; dropped?: number; more?: boolean };
};
/**
 * One moved branch of a live push, checked by server/rewrite-check.ts. `dropped` counts the commits the old tip reaches
 * and the new tip does not, up to one page; `more` says the page was full.
 */
export type RewriteResult = { ref: string; status: 'fast-forward' | 'rewrite' | 'unknown'; dropped?: number; more?: boolean };
/**
 * Merge evidence on a push: PR links matched by tip, rewrite checks, plus what the earlier merge analysis saved
 * (status, commits, ranges, limitations). Nothing writes those older fields any more.
 */
export type MergeEvidenceData = {
  status?: string;
  checkedAt?: string;
  limitations?: string[];
  error?: string | { message?: string };
  prs?: EvidencePr[];
  commits?: EvidenceCommit[];
  refRanges?: EvidenceRange[];
  introducedCommitIds?: string[];
  rewrite?: RewriteResult[];
};
/**
 * Where a live branch creation started, checked by server/fork-origin.ts. `base` is the first commit of the branch that
 * the creating push did not bring. `found`: `on` lists the branches whose latest recorded tip before that push was the
 * base (`via: 'tip'`), or, failing that, the checked candidates whose tip then contained it (`via: 'contained'`).
 * `none`: the base is known but no recorded tip or checked candidate held it; `notOn` lists the candidates checked.
 * `orphan`: the branch history has no earlier commit. `merge`: its first pushed commit has several parents.
 * `unknown`: the check failed or the creating push brought too many commits to walk. `unanswered` lists candidates
 * whose read failed, so a match beside them is not the only one.
 */
export type ForkOrigin = {
  status: 'found' | 'none' | 'orphan' | 'merge' | 'unknown';
  base?: string;
  on?: string[];
  via?: 'tip' | 'contained';
  notOn?: string[];
  unanswered?: string[];
};
/**
 * Provider fields of an event, plus enrichment. Each kind fills its own subset (see server/normalize.ts).
 */
export type EventData = RefUpdate & {
  id?: number | string;
  buildId?: number | string;
  pushId?: number | string | undefined;
  status?: string;
  result?: string | undefined;
  reason?: string;
  isDraft?: boolean;
  evidence?: string;
  targetRefName?: string;
  refUpdates?: RefUpdate[];
  commits?: unknown[] | undefined;
  definition?: { id?: number | string; name?: string };
  mergeEvidence?: MergeEvidenceData;
  forkOrigin?: ForkOrigin;
  pullRequestId?: number | string;
  pullRequestCreatedAt?: string;
  sourceRefName?: string;
  sourceCommit?: string;
  previewCommit?: string | undefined;
  targetCommit?: string;
  mergeCommit?: string | undefined;
  mergeStrategy?: string;
  closedBy?: string;
  sourceVersion?: string;
  buildStartedAt?: string | undefined;
  sourceBranch?: string;
  commitId?: string;
  push?: { pushId?: number | string };
  change?: 'created' | 'moved' | 'deleted';
  objectId?: string;
  peeledObjectId?: string;
  fork?: { repository?: string; project?: string };
  sourceRepositoryId?: string;
  targetRepositoryId?: string;
  pullRequest?: {
    id: number | string;
    sourceRefName?: string;
    targetRefName?: string;
    createdAt?: string;
    fork?: { repository?: string; project?: string };
  };
  reviewers?: { name: string; vote: number; required?: boolean }[];
  voteChanges?: { name: string; vote: number }[];
};
export type ActivityEvent = {
  id: string;
  repoId: string;
  kind: ActivityKind;
  time: string | number;
  observedAt?: string;
  title?: string;
  actor?: string;
  branch?: string;
  summary?: string;
  url?: string;
  seen?: boolean;
  imported?: boolean;
  data?: EventData;
};
export type RelatedCi = {
  id: string;
  time: ActivityEvent['time'];
  title: string;
  validation: boolean;
  postMerge: boolean;
  stale?: boolean;
  outcome: 'passed' | 'failed' | 'partially succeeded' | 'passing again' | 'queued' | 'running' | 'canceling';
};
export type CiResult = {
  run: RelatedCi;
  tone: 'ok' | 'warn' | 'crit' | 'neutral';
  note?: 'revision unknown' | 'retry order unknown' | 'trigger unverified';
};
export type HighlightReason =
  | 'review-ready'
  | 'merged'
  | 'abandoned'
  | 'reopened'
  | 'retargeted'
  | 'review-blocked'
  | 'review-approved'
  | 'default-push'
  | 'rewrite'
  | 'active-branch-deleted'
  | 'tag'
  | 'ci-failed';

export type ActivityItem = ActivityEvent & {
  groupKey: string;
  events: ActivityEvent[];
  eventIds: string[];
  unseenIds: string[];
  unseen: boolean;
  /** Latest cached lifecycle boundary for each branch used by the tree, or an empty ID before any boundary. */
  branchLifetimes?: Record<string, string>;
  prSourceLifetime?: string;
  latestPrMilestone?: boolean;
  relatedCi?: RelatedCi[];
  ciSummary?: { results: CiResult[]; historyCount: number };
  highlight?: HighlightReason;
  ciHost?: string;
  foldedCi?: number;
};

export type ActivityRequest = {
  repoIds?: string[] | undefined;
  view?: 'new' | 'all';
  kind?: string | undefined;
  search?: string | undefined;
  people?: string;
  limit?: number;
  cursor?: string | undefined;
};
export type ActivityPage = {
  items: ActivityItem[];
  nextCursor: string | null;
  total: number;
  newItems: number;
  newUpdates: number;
  filterOptions?: string[] | undefined;
  counts?: Record<string, number>;
  newCounts?: Record<string, number>;
  newBuildCounts?: { running: number; queued: number; failed: number };
  asOf?: number;
};

export const isUnseen = (event: Pick<ActivityEvent, 'seen' | 'imported'>) => !event.seen && !event.imported;
const timestamp = (value: string | number | undefined) => Date.parse(String(value ?? '')) || 0;
const sourceId = (value: string | number | undefined) => {
  const id = Number(value);
  return /^\d+$/.test(String(value)) && Number.isSafeInteger(id) && id > 0 ? String(id) : null;
};

function newestFirst(a: ActivityEvent, b: ActivityEvent) {
  return (
    timestamp(b.observedAt) - timestamp(a.observedAt) ||
    timestamp(b.time) - timestamp(a.time) ||
    (String(a.id) < String(b.id) ? 1 : String(a.id) > String(b.id) ? -1 : 0)
  );
}

export function lifecycleKey(event: ActivityEvent) {
  if (!['branch-created', 'branch-deleted'].includes(event.kind)) return null;
  const { pushId, name, oldObjectId, newObjectId } = event.data || {};
  const id = sourceId(pushId);
  if (!id || !name?.startsWith('refs/heads/') || typeof oldObjectId !== 'string' || typeof newObjectId !== 'string') return null;
  const zero = (value: string) => /^0+$/.test(value);
  if (event.kind === 'branch-created' ? !zero(oldObjectId) || zero(newObjectId) : !zero(newObjectId) || zero(oldObjectId)) return null;
  return JSON.stringify(['branch', event.repoId, id, name, event.kind, oldObjectId, newObjectId]);
}

export function supportingPushKey(event: ActivityEvent) {
  const data = event.data;
  if (
    event.kind !== 'push' ||
    !Array.isArray(data?.refUpdates) ||
    data.refUpdates.length !== 1 ||
    !Array.isArray(data.commits) ||
    data.commits.length
  )
    return null;
  const [ref] = data.refUpdates;
  if (!ref) return null;
  const kind = /^0+$/.test(ref.oldObjectId || '') ? 'branch-created' : 'branch-deleted';
  // Push-list commit coverage is incomplete. A new branch may carry real work even
  // when its cached commits array is empty; only a deletion is unambiguously lifecycle-only.
  if (kind !== 'branch-deleted') return null;
  return lifecycleKey({ ...event, kind, data: { ...ref, pushId: data.pushId } });
}

export function activityKey(event: ActivityEvent) {
  const build = event.kind === 'build' ? sourceId(event.data?.buildId || event.data?.id) : null;
  return build
    ? JSON.stringify(['build', event.repoId, build])
    : lifecycleKey(event) || JSON.stringify(['event', event.repoId, event.kind, event.id]);
}

/** View-only grouping. Raw events and their exact acknowledgement flags remain untouched. */
export function groupActivity(events: ActivityEvent[]): ActivityItem[] {
  const lifecycle = new Set(events.map(lifecycleKey).filter(Boolean));
  const groups: Map<string, ActivityEvent[]> = new Map();
  for (const event of events) {
    const push = supportingPushKey(event);
    const groupKey = push && lifecycle.has(push) ? push : activityKey(event);
    const items = groups.get(groupKey);
    if (items) items.push(event);
    else groups.set(groupKey, [event]);
  }
  return [...groups]
    .flatMap(([groupKey, items]) => {
      const item = projectActivity(groupKey, items);
      const [newest] = item?.events ?? [];
      return item && newest ? [{ item, newest }] : [];
    })
    .sort((a, b) => newestFirst(a.newest, b.newest))
    .map(({ item }) => item);
}

export function projectActivity(groupKey: string, items: ActivityEvent[], representativeId?: string): ActivityItem | undefined {
  const ordered = [...items].sort(newestFirst);
  // A deletion is the primary fact when its supporting push is folded into the group.
  const representative = representativeId
    ? ordered.find(event => event.id === representativeId)
    : ordered.find(event => lifecycleKey(event) === groupKey) || ordered[0];
  if (!representative) return undefined;
  const unseenIds = [...new Set(ordered.filter(isUnseen).map(event => event.id))];
  return {
    ...representative,
    events: ordered,
    eventIds: [...new Set(ordered.map(event => event.id))],
    unseenIds,
    unseen: unseenIds.length > 0,
    seen: unseenIds.length === 0,
    imported: ordered.every(event => event.imported),
    groupKey,
  };
}
