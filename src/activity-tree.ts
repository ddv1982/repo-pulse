import { branchName } from './events.ts';
import type { ActivityEvent, ActivityItem } from './activity.ts';

export type { ActivityEvent };
/**
 * How a fork origin is known. Unchecked, from the rows on the page: `pr`, a pull request from the branch names a target, which is an assumption.
 * Checked by server/fork-origin.ts, from the commit the branch started at (`base`): `recorded`, the base was the
 * latest recorded tip of one other branch; `contained`, one checked candidate already held the base. The checked
 * outcomes with no parent draw nothing: `ambiguous` (several branches held the base), `refuted` (the PR target did
 * not hold it), `unplaced` (no recorded or checked branch held it), `orphan` and `merge`.
 */
export type ForkEvidence = 'pr' | 'recorded' | 'contained' | 'ambiguous' | 'refuted' | 'unplaced' | 'orphan' | 'merge';
/** A drawn lane. `color` indexes the lane palette; -1 is neutral. */
export type TreeLane = { slot: number; color: number };
/** A lane in one row, and whether it runs on above and below. */
export type TreeLine = TreeLane & { up: boolean; down: boolean };
export type TreeNode = TreeLine & { shape: 'dot' | 'tag' | 'ring' | 'merge'; overflow: boolean };
/**
 * The origin of a new branch. Only a fork with a `parent` is drawn. `branches` names the branches of an ambiguous base.
 */
export type TreeFork = {
  evidence: ForkEvidence;
  parent: string | null;
  base?: string;
  branches?: string[];
  pullRequestId?: number | string;
  target?: string;
};
/**
 * One feed row. `through` lists the lanes that only pass by. `fork` describes the origin on the row that reports a
 * new branch. `forkFrom` and `mergeFrom` are the other lane of a drawn fork or merge, and are null when either lane
 * did not fit. The fork is drawn on the oldest row of the branch, which can be the push that created it.
 */
export type TreeRow = {
  node: TreeNode;
  through: TreeLane[];
  fork: TreeFork | null;
  forkFrom: (TreeLine & { evidence: ForkEvidence }) | null;
  mergeFrom: TreeLine | null;
};
/** `width` counts lane positions, the overflow position included. */
export type ActivityTree = { width: number; rows: TreeRow[] };
type TreeEvent = ActivityEvent & Pick<ActivityItem, 'branchLifetimes' | 'prSourceLifetime'>;
type PullRequest = { id: number | string; source: string; target: string; status?: string | undefined };
/**
 * One stretch of a branch. `top` and `bottom` are row indexes, newest first.
 */
type Lane = {
  key: string;
  top: number;
  bottom: number;
  branch: string;
  priority: number;
  slot: number;
  color: number;
};

export const MAX_LANES = 4;
export const LANE_COLORS = 6;
/** Rows a branch may stay quiet before its lane ends. */
export const MAX_GAP = 12;
const PR_REF = /^refs\/pull\/(\d+)\//;
const ZERO = /^0+$/;

const laneKey = (repoId: string, branch: string) => `${repoId}\n${branch}`;

const HEADS = 'refs/heads/';
const headRef = (ref: string | undefined) => (ref ? (ref.startsWith(HEADS) ? ref : HEADS + ref) : '');

function hash(text: string) {
  let value = 0;
  for (let i = 0; i < text.length; i++) value = (value * 31 + text.charCodeAt(i)) >>> 0;
  return value;
}

/**
 * The refs of a pull request. A PR from a fork keeps its source apart from the branches of this repository.
 */
function pullRequestRefs(
  id: number | string,
  sourceRef: string | undefined,
  targetRef: string | undefined,
  fork: { repository?: string; project?: string } | undefined,
): PullRequest {
  const branch = headRef(sourceRef);
  const source = fork && branch ? JSON.stringify([fork.project ?? '', fork.repository ?? '', branch]) : branch;
  return { id, source, target: headRef(targetRef) };
}

/** The refs one pull request row names. */
function pullRequest(item: ActivityEvent): PullRequest | undefined {
  const id = item.kind === 'pr' ? item.data?.pullRequestId : undefined;
  if (id === undefined) return undefined;
  return {
    ...pullRequestRefs(id, item.data?.sourceRefName || item.branch, item.data?.targetRefName, item.data?.fork),
    status: item.data?.status,
  };
}

/** Pull requests by id, newest row first, and every PR row of each source branch in list order. */
function pullRequests(items: TreeEvent[]) {
  const byId: Map<string, PullRequest> = new Map();
  const bySource: Map<string, { row: number; pr: PullRequest; item: TreeEvent }[]> = new Map();
  items.forEach((item, row) => {
    const pr = pullRequest(item);
    if (!pr) return;
    const id = laneKey(item.repoId, String(pr.id));
    if (!byId.has(id)) byId.set(id, pr);
    if (!pr.source || !pr.target) return;
    const source = laneKey(item.repoId, pr.source);
    const rows = bySource.get(source);
    if (rows) rows.push({ row, pr, item });
    else bySource.set(source, [{ row, pr, item }]);
  });
  return { byId, bySource };
}

/** The revision a push created a branch at. A snapshot only reports the tip at discovery, which says nothing of the start. */
function createdAt(item: ActivityEvent) {
  const { evidence, oldObjectId, newObjectId } = item.data ?? {};
  return item.kind === 'branch-created' && evidence === 'push' && (!oldObjectId || ZERO.test(oldObjectId)) ? (newObjectId ?? '') : '';
}

/**
 * The origin server/fork-origin.ts stored, or undefined when there is none or the check failed, so the unchecked
 * evidence applies. A checked origin never falls back to the pull request target.
 */
function checkedFork(
  origin: import('./activity.ts').ForkOrigin | undefined,
  pr: PullRequest | undefined,
  branch: string,
): TreeFork | undefined {
  if (!origin || origin.status === 'unknown') return undefined;
  if (origin.status === 'orphan' || origin.status === 'merge') return { evidence: origin.status, parent: null };
  const base = origin.base ?? '';
  if (origin.status === 'found') {
    const branches = [...new Set((origin.on ?? []).map(headRef))].filter(ref => ref && ref !== branch);
    // A candidate that went unanswered could also hold the base, so one match beside it draws no fork either.
    const [only] = branches;
    if (only !== undefined && branches.length === 1 && !origin.unanswered?.length)
      return { evidence: origin.via === 'contained' ? 'contained' : 'recorded', parent: branchName(only), base };
    if (branches.length) return { evidence: 'ambiguous', parent: null, base, branches: branches.map(branchName) };
  }
  if (pr && (origin.notOn ?? []).some(ref => headRef(ref) === pr.target))
    return { evidence: 'refuted', parent: null, base, pullRequestId: pr.id, target: branchName(pr.target) };
  return { evidence: 'unplaced', parent: null, base };
}

/** The branch a row sits on, or '' for a row that belongs to no branch. */
function rowBranch(item: ActivityEvent, prs?: Map<string, PullRequest>) {
  if (item.kind === 'tag') return '';
  const pr = pullRequest(item);
  if (pr) return (item.data?.status === 'completed' && pr.target) || pr.source;
  const prNumber = item.kind === 'build' ? PR_REF.exec(item.data?.sourceBranch ?? item.branch ?? '')?.[1] : undefined;
  if (prNumber === undefined) {
    if (item.kind === 'build' && item.data?.sourceBranch) {
      return item.data.sourceBranch.startsWith(HEADS) ? item.data.sourceBranch : '';
    }
    if (item.kind === 'push') {
      const heads = [...new Set(item.data?.refUpdates?.map(ref => ref.name).filter(name => name?.startsWith(HEADS)))];
      if (heads.length > 1) return '';
      if (heads[0]) return heads[0];
    }
    return headRef(item.data?.name ?? item.branch);
  }
  // A CI run on a pull request ref belongs to the PR source branch: from the stored PR the server attached, or from a
  // PR row in the list. With neither, the runs of that pull request still share a lane of their own.
  const stored = item.data?.pullRequest;
  const attached = stored && pullRequestRefs(stored.id, stored.sourceRefName, stored.targetRefName, stored.fork).source;
  return attached || prs?.get(laneKey(item.repoId, prNumber))?.source || `refs/pull/${prNumber}`;
}

/** Refs whose cached lifecycle can affect a row or one of its joins. */
export function treeBranchRefs(item: ActivityEvent) {
  const pr = pullRequest(item);
  return [...new Set([rowBranch(item), pr?.source, pr?.target, ...(item.data?.forkOrigin?.on ?? []).map(headRef)])].filter(
    (ref): ref is string => Boolean(ref?.startsWith(HEADS)),
  );
}

export function treePullRequestSource(item: ActivityEvent) {
  const pr = item.data?.pullRequest;
  const ref = pullRequest(item)?.source ?? (pr && !pr.fork ? headRef(pr.sourceRefName) : undefined);
  const createdAt = item.data?.pullRequestCreatedAt ?? pr?.createdAt;
  return ref?.startsWith(HEADS) && createdAt && Number.isFinite(Date.parse(createdAt)) ? { ref, createdAt } : undefined;
}

function nodeShape(item: ActivityEvent): TreeNode['shape'] {
  if (item.kind === 'tag') return 'tag';
  if (item.kind !== 'pr') return 'dot';
  return item.data?.status === 'completed' ? 'merge' : item.data?.status === 'active' ? 'ring' : 'dot';
}

/**
 * Gives visible defaults first claim on the left, then merge destinations and fork origins.
 * A lane that overlaps `maxLanes` others keeps slot -1.
 */
function placeLanes(lanes: Lane[], maxLanes: number) {
  const ordered = [...lanes].sort(
    (a, b) => b.priority - a.priority || Number(Boolean(b.branch)) - Number(Boolean(a.branch)) || a.top - b.top,
  );
  const placed: Lane[] = [];
  for (const lane of ordered) {
    const beside = placed.filter(other => other.bottom >= lane.top && other.top <= lane.bottom);
    for (let slot = 0; slot < maxLanes && lane.slot < 0; slot++) if (beside.every(other => other.slot !== slot)) lane.slot = slot;
    if (lane.slot >= 0) placed.push(lane);
  }
  return placed;
}

function colorLanes(lanes: Lane[], joined: Set<Lane>) {
  for (const lane of lanes) {
    // Colour is for lanes a reader can follow and real endpoints of visible joins.
    if (!lane.branch || (lane.top === lane.bottom && !joined.has(lane))) continue;
    const near = lanes.filter(other => other.bottom >= lane.top - 1 && other.top <= lane.bottom + 1);
    const preferred = hash(lane.key) % LANE_COLORS;
    const colors = Array.from({ length: LANE_COLORS }, (_, step) => (preferred + step) % LANE_COLORS);
    lane.color = colors.find(color => near.every(other => other.color !== color)) ?? preferred;
  }
}

/**
 * Splits the rows of each branch into lanes. A branch that is quiet for more than `maxGap` rows gives its lane
 * back, so long-lived branches do not hold a position through pages of unrelated activity. A lane also ends at the
 * row where a push created the branch: older rows under the same name belong to an earlier branch.
 */
type BranchRows = { branch: string; rows: Set<number>; starts: Set<number>; isDefault: boolean };

function splitLanes(branches: Map<string, BranchRows>, maxGap: number) {
  const byRow: Map<string, Map<number, Lane>> = new Map();
  const lanes: Lane[] = [];
  for (const [key, { branch, rows, starts, isDefault }] of branches) {
    const index = new Map();
    let lane: Lane | undefined;
    for (const row of [...rows].sort((a, b) => a - b)) {
      if (!lane || row - lane.bottom - 1 > maxGap || starts.has(lane.bottom)) {
        lane = { key, top: row, bottom: row, branch, priority: isDefault ? 3 : 0, slot: -1, color: -1 };
        lanes.push(lane);
      }
      lane.bottom = row;
      index.set(row, lane);
    }
    byRow.set(key, index);
  }
  return { lanes, byRow };
}

/**
 * A branch lane graph for one rendered list of Activity rows, newest first. It describes only what the list shows:
 * a lane runs between nearby rows that sit on a branch or refer to it.
 */
export function buildActivityTree(
  items: TreeEvent[],
  {
    maxLanes = MAX_LANES,
    maxGap = MAX_GAP,
    defaultBranches,
  }: { maxLanes?: number; maxGap?: number; defaultBranches?: ReadonlyMap<string, string> } = {},
): ActivityTree {
  const prs = pullRequests(items);
  const branches: Map<string, BranchRows> = new Map();
  const keyOf = (item: TreeEvent, ref: string, lifetime = item.branchLifetimes?.[ref] ?? '') =>
    laneKey(item.repoId, JSON.stringify([ref, lifetime]));
  const mark = (item: TreeEvent, branch: string, row: number) => {
    const source = item.kind === 'pr' && item.data?.status === 'completed' ? undefined : treePullRequestSource(item);
    const key = branch ? keyOf(item, branch, source?.ref === branch ? item.prSourceLifetime : undefined) : laneKey(item.repoId, `\n${row}`);
    const entry = branches.get(key) ?? {
      branch,
      rows: new Set(),
      starts: new Set(),
      isDefault: branch === defaultBranches?.get(item.repoId),
    };
    branches.set(key, entry);
    entry.rows.add(row);
    return key;
  };
  const keyed = items.map((item, row) => ({ item, key: mark(item, rowBranch(item, prs.byId), row) }));
  /**
   * The oldest row of a new branch. The push that created a branch is a row of its own and may sort below it, after
   * the other rows of the same push.
   */
  const creatingPushes = new Map<string, number>();
  keyed.forEach(({ item, key }, row) => {
    if (item.kind !== 'push' || item.data?.pushId === undefined) return;
    creatingPushes.set(JSON.stringify([key, String(item.data.pushId)]), row);
  });
  const starts = new Map<string, number>();
  const forks: (TreeFork | null)[] = items.map(() => null);
  const joins = new Map<number, { key: string; fork?: TreeFork; isolated?: boolean }>();
  keyed.forEach(({ item, key }, row) => {
    const entry = branches.get(key);
    if (!entry?.branch) return;
    if (item.kind === 'branch-deleted' && item.data?.evidence === 'push') {
      // Walking backwards, the deletion is the first row of the older lifetime.
      const previous = [...entry.rows].findLast(index => index < row);
      if (previous !== undefined) entry.starts.add(previous);
    }
    if (item.kind !== 'branch-created') return;
    const created = Boolean(createdAt(item));
    const pushId = item.data?.pushId;
    const pushRow = pushId === undefined ? undefined : creatingPushes.get(JSON.stringify([key, String(pushId)]));
    const start = Math.max(row, pushRow ?? row);
    if (created) entry.starts.add(start);
    const after = starts.get(key) ?? -1;
    const requests = prs.bySource.get(laneKey(item.repoId, entry.branch)) ?? [];
    const older = new Set(created ? requests.filter(candidate => candidate.row > row).map(candidate => candidate.pr.id) : []);
    const matching = requests.filter(
      candidate =>
        candidate.row > after &&
        (!created || (candidate.row < row && !older.has(candidate.pr.id))) &&
        keyOf(candidate.item, entry.branch, candidate.item.prSourceLifetime) === key,
    );
    const checked = checkedFork(item.data?.forkOrigin, matching.at(-1)?.pr, entry.branch);
    const open = matching.findLast(({ pr }) => prs.byId.get(laneKey(item.repoId, String(pr.id)))?.status === 'active');
    const pr = open && prs.byId.get(laneKey(item.repoId, String(open.pr.id)));
    const fork =
      checked === undefined && pr?.target && pr.target !== entry.branch
        ? { evidence: 'pr' as const, parent: branchName(pr.target), pullRequestId: pr.id }
        : (checked ?? null);
    starts.set(key, row);
    forks[row] = fork;
    if (fork?.parent) {
      const ref = fork.evidence === 'pr' && pr ? pr.target : HEADS + fork.parent;
      joins.set(start, { fork, key: keyOf(item, ref), isolated: Boolean(item.branchLifetimes && !(ref in item.branchLifetimes)) });
    }
  });
  keyed.forEach(({ item, key }, row) => {
    const pr = nodeShape(item) === 'merge' ? pullRequest(item) : undefined;
    if (!pr?.source || !pr.target) return;
    const source = keyOf(item, pr.source, item.prSourceLifetime);
    if (pr.source !== pr.target && source !== key) joins.set(row, { key: source });
  });

  const { lanes, byRow } = splitLanes(branches, maxGap);
  const ownLanes = keyed.map(({ key }, row) => byRow.get(key)?.get(row) as Lane);
  const candidates = new Map<string, Lane[]>();
  for (const lane of lanes) {
    const existing = candidates.get(lane.key);
    if (existing) existing.push(lane);
    else candidates.set(lane.key, [lane]);
  }
  const distance = (lane: Lane, row: number) => Math.max(lane.top - row, row - lane.bottom, 0);
  const targets = new Map<number, Lane>();
  for (const [row, join] of joins) {
    const own = ownLanes[row] as Lane;
    if (!join.fork) own.priority = Math.max(own.priority, 2);
    if (join.isolated) continue;
    const target = candidates
      .get(join.key)
      ?.reduce<Lane | undefined>((best, lane) => (!best || distance(lane, row) < distance(best, row) ? lane : best), undefined);
    if (target && distance(target, row) <= maxGap + 1) {
      targets.set(row, target);
      if (join.fork) target.priority = Math.max(target.priority, 1);
    }
  }
  const drawn = placeLanes(lanes, maxLanes);
  const visibleJoins = new Map<number, Lane>();
  const freeSlots = Array.from({ length: maxLanes }, (_, index) => index);
  const rangeFree = (slot: number, top: number, bottom: number, target?: Lane) =>
    drawn.every(lane => lane === target || lane.slot !== slot || lane.top > bottom || lane.bottom < top);
  // Extend a real lane only after both endpoints fit. Otherwise show a short stub in a free slot.
  for (const [row, join] of joins) {
    const own = ownLanes[row] as Lane;
    if (own.slot < 0) continue;
    const target = targets.get(row);
    if (target && target.slot >= 0) {
      const top = Math.min(row, target.top);
      const bottom = Math.max(row, target.bottom);
      const slot = rangeFree(target.slot, top, bottom, target)
        ? target.slot
        : target.priority < 2
          ? freeSlots.find(index => rangeFree(index, top, bottom, target))
          : undefined;
      if (slot !== undefined) {
        target.slot = slot;
        target.top = top;
        target.bottom = bottom;
        visibleJoins.set(row, target);
        continue;
      }
    }
    if (target && distance(target, row) === 0) continue;
    const slot =
      (!join.fork ? freeSlots.find(index => index > own.slot && rangeFree(index, row, row)) : undefined) ??
      freeSlots.find(index => rangeFree(index, row, row));
    if (slot === undefined) continue;
    const stub = { key: join.key, top: row, bottom: row, branch: '', priority: 0, slot, color: -1 };
    drawn.push(stub);
    visibleJoins.set(row, stub);
  }
  const joined = new Set(visibleJoins.values());
  for (const row of visibleJoins.keys()) joined.add(ownLanes[row] as Lane);
  colorLanes(drawn, joined);
  const width = drawn.reduce((most, lane) => Math.max(most, lane.slot + 1), 0);
  const line = (lane: Lane, row: number): TreeLine => ({ slot: lane.slot, color: lane.color, up: lane.top < row, down: lane.bottom > row });
  const rows = items.map((item, row) => {
    const own = ownLanes[row] as Lane;
    const other = visibleJoins.get(row);
    const joined = other ? line(other, row) : null;
    const fork = joins.get(row)?.fork;
    return {
      node:
        own.slot >= 0
          ? { ...line(own, row), shape: nodeShape(item), overflow: false }
          : { slot: width, color: -1, up: false, down: false, shape: nodeShape(item), overflow: true },
      through: drawn
        .filter(lane => lane !== own && lane !== other && lane.top < row && lane.bottom > row)
        .map(lane => ({ slot: lane.slot, color: lane.color })),
      fork: forks[row] ?? null,
      forkFrom: joined && fork ? { ...joined, evidence: fork.evidence } : null,
      mergeFrom: fork ? null : joined,
    };
  });
  return { width: width + Number(lanes.some(lane => lane.slot < 0)), rows };
}
