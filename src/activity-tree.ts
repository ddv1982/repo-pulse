import { branchName } from './events.ts';

export type ActivityEvent = import('./activity.ts').ActivityEvent;
/**
 * How a fork origin is known. Unchecked, from the rows on the page: `tip`, the new branch started at a revision an
 * older row shows on another branch; `pr`, a pull request from the branch names a target, which is an assumption.
 * Checked by server/fork-origin.ts, from the commit the branch started at (`base`): `recorded`, the base was the
 * latest recorded tip of one other branch; `contained`, one checked candidate already held the base. The checked
 * outcomes with no parent draw nothing: `ambiguous` (several branches held the base), `refuted` (the PR target did
 * not hold it), `unplaced` (no recorded or checked branch held it), `orphan` and `merge`.
 */
export type ForkEvidence = 'tip' | 'pr' | 'recorded' | 'contained' | 'ambiguous' | 'refuted' | 'unplaced' | 'orphan' | 'merge';
/** A drawn lane. `color` indexes the lane palette; -1 is neutral. */
export type TreeLane = { slot: number; color: number };
/** A lane in one row, and whether it runs on above and below. */
export type TreeLine = TreeLane & { up: boolean; down: boolean };
export type TreeNode = TreeLine & { shape: 'dot' | 'ring' | 'merge'; overflow: boolean };
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
export type PullRequest = { id: number | string; source: string; target: string };
/**
 * One stretch of a branch. `top` and `bottom` are row indexes, newest first. `target` marks a lane that others fork
 * from or merge into, `forked` one that starts with a fork.
 */
export type Lane = {
  key: string;
  top: number;
  bottom: number;
  branch: string;
  target: boolean;
  forked: boolean;
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
  const branch = branchName(sourceRef);
  const source = fork && branch ? `${fork.project ?? ''}/${fork.repository ?? 'fork'}:${branch}` : branch;
  return { id, source, target: branchName(targetRef) };
}

/** The refs one pull request row names. */
function pullRequest(item: ActivityEvent): PullRequest | undefined {
  const id = item.kind === 'pr' ? item.data?.pullRequestId : undefined;
  if (id === undefined) return undefined;
  return pullRequestRefs(id, item.data?.sourceRefName || item.branch, item.data?.targetRefName, item.data?.fork);
}

/** Pull requests by id, newest row first, and every PR row of each source branch in list order. */
function pullRequests(items: ActivityEvent[]) {
  const byId: Map<string, PullRequest> = new Map();
  const bySource: Map<string, { row: number; pr: PullRequest }[]> = new Map();
  items.forEach((item, row) => {
    const pr = pullRequest(item);
    if (!pr) return;
    const id = laneKey(item.repoId, String(pr.id));
    if (!byId.has(id)) byId.set(id, pr);
    if (!pr.source || !pr.target) return;
    const source = laneKey(item.repoId, pr.source);
    const rows = bySource.get(source);
    if (rows) rows.push({ row, pr });
    else bySource.set(source, [{ row, pr }]);
  });
  return { byId, bySource };
}

/** The revision a push created a branch at. A snapshot only reports the tip at discovery, which says nothing of the start. */
function createdAt(item: ActivityEvent) {
  const { evidence, oldObjectId, newObjectId } = item.data ?? {};
  return item.kind === 'branch-created' && evidence === 'push' && (!oldObjectId || ZERO.test(oldObjectId)) ? (newObjectId ?? '') : '';
}

/** Where each revision was seen as a branch tip: `repo, sha` to the rows and branches. */
function tipSightings(items: ActivityEvent[]) {
  const sightings: Map<string, { row: number; branch: string }[]> = new Map();
  const add = (item: ActivityEvent, row: number, sha: string | undefined, ref: string | undefined) => {
    if (!sha || ZERO.test(sha) || !ref?.startsWith('refs/heads/')) return;
    const key = laneKey(item.repoId, sha.toLowerCase());
    const seen = sightings.get(key);
    if (seen) seen.push({ row, branch: branchName(ref) });
    else sightings.set(key, [{ row, branch: branchName(ref) }]);
  };
  items.forEach((item, row) => {
    if (item.kind === 'push')
      for (const update of item.data?.refUpdates ?? []) {
        add(item, row, update.newObjectId, update.name);
        add(item, row, update.oldObjectId, update.name);
      }
    if (item.kind === 'pr') add(item, row, item.data?.mergeCommit, item.data?.targetRefName);
    // A snapshot row records the tip the branch had when it was found.
    if (item.kind === 'branch-created') add(item, row, createdAt(item) || item.data?.objectId, item.data?.name);
  });
  return sightings;
}

/**
 * The origin server/fork-origin.ts stored, or undefined when there is none or the check failed, so the unchecked
 * evidence applies. A checked origin never falls back to the pull request target.
 */
function checkedFork(origin: import('./activity.ts').ForkOrigin | undefined, pr: PullRequest | undefined): TreeFork | null | undefined {
  if (!origin || origin.status === 'unknown') return undefined;
  if (origin.status === 'orphan' || origin.status === 'merge') return { evidence: origin.status, parent: null };
  const base = origin.base ?? '';
  if (origin.status === 'found') {
    const branches = (origin.on ?? []).map(ref => branchName(ref));
    // A candidate that went unanswered could also hold the base, so one match beside it draws no fork either.
    const [only] = branches;
    if (only !== undefined && branches.length === 1 && !origin.unanswered?.length)
      return { evidence: origin.via === 'contained' ? 'contained' : 'recorded', parent: only, base };
    if (branches.length) return { evidence: 'ambiguous', parent: null, base, branches };
  }
  if (pr && (origin.notOn ?? []).some(ref => branchName(ref) === pr.target))
    return { evidence: 'refuted', parent: null, base, pullRequestId: pr.id, target: pr.target };
  return { evidence: 'unplaced', parent: null, base };
}

/** The branch a row sits on, or '' for a row that belongs to no branch. */
function rowBranch(item: ActivityEvent, prs: Map<string, PullRequest>) {
  if (item.kind === 'tag') return '';
  const pr = pullRequest(item);
  if (pr) return (item.data?.status === 'completed' && pr.target) || pr.source;
  const prNumber = item.kind === 'build' ? PR_REF.exec(item.branch ?? '')?.[1] : undefined;
  if (prNumber === undefined) return item.branch || '';
  // A CI run on a pull request ref belongs to the PR source branch: from the stored PR the server attached, or from a
  // PR row in the list. With neither, the runs of that pull request still share a lane of their own.
  const stored = item.data?.pullRequest;
  const attached = stored && pullRequestRefs(stored.id, stored.sourceRefName, stored.targetRefName, stored.fork).source;
  return attached || prs.get(laneKey(item.repoId, prNumber))?.source || `refs/pull/${prNumber}`;
}

function nodeShape(item: ActivityEvent): TreeNode['shape'] {
  if (item.kind !== 'pr') return 'dot';
  return item.data?.status === 'completed' ? 'merge' : item.data?.status === 'active' ? 'ring' : 'dot';
}

/**
 * Gives each lane a position and a colour. Lanes that others fork from or merge into go first, so a trunk stays on
 * the left. A lane that overlaps `maxLanes` others keeps slot -1.
 */
function placeLanes(lanes: Lane[], maxLanes: number) {
  const ordered = [...lanes].sort((a, b) => Number(b.target) - Number(a.target) || a.top - b.top);
  const placed: Lane[] = [];
  for (const lane of ordered) {
    const beside = placed.filter(other => other.bottom >= lane.top && other.top <= lane.bottom);
    // A single row with nothing attached stays neutral: colour is for lanes a reader can follow.
    if (lane.branch && (lane.top < lane.bottom || lane.target || lane.forked)) {
      // A lane that ends in the row before this one starts counts as a neighbour too, so two branches in a row differ.
      const near = placed.filter(other => other.bottom >= lane.top - 1 && other.top <= lane.bottom + 1);
      const preferred = hash(lane.key) % LANE_COLORS;
      const free = Array.from({ length: LANE_COLORS }, (_, step) => (preferred + step) % LANE_COLORS);
      lane.color = free.find(color => near.every(other => other.color !== color)) ?? preferred;
    }
    for (let slot = 0; slot < maxLanes && lane.slot < 0; slot++) if (beside.every(other => other.slot !== slot)) lane.slot = slot;
    if (lane.slot >= 0) placed.push(lane);
  }
  return ordered.filter(lane => lane.slot >= 0);
}

/**
 * Splits the rows of each branch into lanes. A branch that is quiet for more than `maxGap` rows gives its lane
 * back, so long-lived branches do not hold a position through pages of unrelated activity. A lane also ends at the
 * row where a push created the branch: older rows under the same name belong to an earlier branch.
 */
function splitLanes(branches: Map<string, { branch: string; rows: Set<number>; starts: Set<number> }>, maxGap: number) {
  const byRow: Map<string, Map<number, Lane>> = new Map();
  const lanes: Lane[] = [];
  for (const [key, { branch, rows, starts }] of branches) {
    const index = new Map();
    let lane: Lane | undefined;
    for (const row of [...rows].sort((a, b) => a - b)) {
      if (!lane || row - lane.bottom - 1 > maxGap || starts.has(lane.bottom)) {
        lane = { key, top: row, bottom: row, branch, target: false, forked: false, slot: -1, color: -1 };
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
  items: ActivityEvent[],
  { maxLanes = MAX_LANES, maxGap = MAX_GAP }: { maxLanes?: number; maxGap?: number } = {},
): ActivityTree {
  const prs = pullRequests(items);
  const sightings = tipSightings(items);
  const branches: Map<string, { branch: string; rows: Set<number>; starts: Set<number> }> = new Map();
  const mark = (repoId: string, branch: string, row: number) => {
    const key = branch ? laneKey(repoId, branch) : laneKey(repoId, `\n${row}`);
    const entry = branches.get(key) ?? { branch, rows: new Set(), starts: new Set() };
    branches.set(key, entry);
    entry.rows.add(row);
    return key;
  };
  const keyed = items.map((item, row) => ({ item, key: mark(item.repoId, rowBranch(item, prs.byId), row) }));
  const rowKeys = keyed.map(({ key }) => key);

  /**
   * The oldest row of a new branch. The push that created a branch is a row of its own and may sort below it, after
   * the other rows of the same push.
   */
  const startRow = (item: ActivityEvent, row: number) => {
    const pushId = item.data?.pushId;
    let start = row;
    for (let below = row + 1; pushId !== undefined; below++) {
      const next = keyed[below];
      if (next?.item.data?.pushId !== pushId) break;
      if (next.item.kind === 'push' && next.key === rowKeys[row]) start = below;
    }
    return start;
  };
  /**
   * `after` is the row where the same name was created again, or -1: a pull request above it belongs to that later branch.
   */
  const forkOrigin = (item: ActivityEvent, branch: string, row: number, start: number, after: number): TreeFork | null => {
    const tip = createdAt(item).toLowerCase();
    const requests = prs.bySource.get(laneKey(item.repoId, branch)) ?? [];
    // A push dates the branch, so its pull request has every row above. A snapshot only dates the discovery.
    const earlier = new Set(tip ? requests.filter(entry => entry.row > row).map(entry => entry.pr.id) : []);
    const pr = requests.findLast(entry => entry.row > after && (!tip || (entry.row < row && !earlier.has(entry.pr.id))))?.pr;
    const checked = checkedFork(item.data?.forkOrigin, pr);
    if (checked !== undefined) return checked;
    const seen = sightings.get(laneKey(item.repoId, tip))?.find(sighting => sighting.row > start && sighting.branch !== branch);
    if (seen) return { evidence: 'tip', parent: seen.branch };
    return pr && pr.target !== branch ? { evidence: 'pr', parent: pr.target, pullRequestId: pr.id } : null;
  };
  const forks: (TreeFork | null)[] = items.map(() => null);
  /** The fork curve sits on the oldest row of the branch: row index to the fork and the parent it joins. */
  const forkJoins: Map<number, { fork: TreeFork; key: string }> = new Map();
  const createdAbove: Map<string, number> = new Map();
  keyed.forEach(({ item, key }, row) => {
    const entry = branches.get(key);
    if (item.kind !== 'branch-created' || !entry?.branch) return;
    const start = startRow(item, row);
    // Only a push proves a new branch. A snapshot discovery has no creation time, so older rows stay on its lane.
    if (createdAt(item)) entry.starts.add(start);
    const fork = forkOrigin(item, entry.branch, row, start, createdAbove.get(key) ?? -1);
    createdAbove.set(key, row);
    forks[row] = fork;
    if (fork?.parent) forkJoins.set(start, { fork, key: mark(item.repoId, fork.parent, start) });
  });
  const merges = items.map((item, row) => {
    const pr = nodeShape(item) === 'merge' ? pullRequest(item) : undefined;
    return pr?.source && laneKey(item.repoId, pr.source) !== rowKeys[row] ? mark(item.repoId, pr.source, row) : null;
  });

  const { lanes, byRow } = splitLanes(branches, maxGap);
  const laneOf = (key: string | null | undefined, row: number) => (key ? byRow.get(key)?.get(row) : undefined);
  items.forEach((_, row) => {
    const own = laneOf(rowKeys[row], row) as Lane;
    const parent = laneOf(forkJoins.get(row)?.key, row);
    if (parent) [parent.target, own.forked] = [true, true];
    if (merges[row]) own.target = true;
  });
  const drawn = placeLanes(lanes, maxLanes);
  const width = drawn.reduce((most, lane) => Math.max(most, lane.slot + 1), 0);
  const line = (lane: Lane, row: number): TreeLine => ({ slot: lane.slot, color: lane.color, up: lane.top < row, down: lane.bottom > row });
  const fits = (lane: Lane | undefined) => (lane && lane.slot >= 0 ? lane : null);
  const rows = items.map((item, row) => {
    const own = laneOf(rowKeys[row], row) as Lane;
    const join = forkJoins.get(row);
    const forkLane = fits(own) && fits(laneOf(join?.key, row));
    const mergeLane = fits(own) && fits(laneOf(merges[row], row));
    return {
      node: fits(own)
        ? { ...line(own, row), shape: nodeShape(item), overflow: false }
        : { slot: width, color: own.color, up: false, down: false, shape: nodeShape(item), overflow: true },
      through: drawn
        .filter(lane => lane !== own && lane !== forkLane && lane !== mergeLane && lane.top < row && lane.bottom > row)
        .map(lane => ({ slot: lane.slot, color: lane.color })),
      fork: forks[row] ?? null,
      forkFrom: join && forkLane ? { ...line(forkLane, row), evidence: join.fork.evidence } : null,
      mergeFrom: mergeLane ? line(mergeLane, row) : null,
    };
  });
  return { width: width + Number(drawn.length < lanes.length), rows };
}
