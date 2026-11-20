// @ts-check

import { branchName } from './events.js';

/** @typedef {import('./activity.js').ActivityEvent} ActivityEvent */
/**
 * How a fork origin is known. `tip`: the new branch started at a revision an older row shows on another branch.
 * `pr`: a pull request from the branch names a target, which is an assumption about where it started.
 * Neither says at which commit the branch left its parent.
 * @typedef {'tip' | 'pr'} ForkEvidence
 */
/** @typedef {{ slot: number, color: number }} TreeLane A drawn lane. `color` indexes the lane palette; -1 is neutral. */
/** @typedef {TreeLane & { up: boolean, down: boolean }} TreeLine A lane in one row, and whether it runs on above and below. */
/** @typedef {TreeLine & { shape: 'dot' | 'ring' | 'merge', overflow: boolean }} TreeNode */
/** @typedef {{ evidence: ForkEvidence, parent: string, pullRequestId?: number | string }} TreeFork */
/**
 * One feed row. `through` lists the lanes that only pass by. `fork` describes the origin on the row that reports a
 * new branch. `forkFrom` and `mergeFrom` are the other lane of a drawn fork or merge, and are null when either lane
 * did not fit. The fork is drawn on the oldest row of the branch, which can be the push that created it.
 * @typedef {{ node: TreeNode, through: TreeLane[], fork: TreeFork | null,
 *   forkFrom: (TreeLine & { evidence: ForkEvidence }) | null, mergeFrom: TreeLine | null }} TreeRow
 */
/** @typedef {{ width: number, rows: TreeRow[] }} ActivityTree `width` counts lane positions, the overflow position included. */
/** @typedef {{ id: number | string, source: string, target: string }} PullRequest */
/**
 * One stretch of a branch. `top` and `bottom` are row indexes, newest first. `target` marks a lane that others fork
 * from or merge into, `forked` one that starts with a fork.
 * @typedef {{ key: string, top: number, bottom: number, branch: string, target: boolean, forked: boolean, slot: number, color: number }} Lane
 */

export const MAX_LANES = 4;
export const LANE_COLORS = 6;
/** Rows a branch may stay quiet before its lane ends. */
export const MAX_GAP = 12;
const PR_REF = /^refs\/pull\/(\d+)\//;
const ZERO = /^0+$/;

/** @param {string} repoId @param {string} branch */
const laneKey = (repoId, branch) => `${repoId}\n${branch}`;

/** @param {string} text */
function hash(text) {
  let value = 0;
  for (let i = 0; i < text.length; i++) value = (value * 31 + text.charCodeAt(i)) >>> 0;
  return value;
}

/**
 * The refs of a pull request. A PR from a fork keeps its source apart from the branches of this repository.
 * @param {number | string} id @param {string | undefined} sourceRef @param {string | undefined} targetRef
 * @param {{ repository?: string, project?: string } | undefined} fork @returns {PullRequest}
 */
function pullRequestRefs(id, sourceRef, targetRef, fork) {
  const branch = branchName(sourceRef);
  const source = fork && branch ? `${fork.project ?? ''}/${fork.repository ?? 'fork'}:${branch}` : branch;
  return { id, source, target: branchName(targetRef) };
}

/** The refs one pull request row names. @param {ActivityEvent} item @returns {PullRequest | undefined} */
function pullRequest(item) {
  const id = item.kind === 'pr' ? item.data?.pullRequestId : undefined;
  if (id === undefined) return undefined;
  return pullRequestRefs(id, item.data?.sourceRefName || item.branch, item.data?.targetRefName, item.data?.fork);
}

/** Pull requests by id, newest row first, and every PR row of each source branch in list order. @param {ActivityEvent[]} items */
function pullRequests(items) {
  /** @type {Map<string, PullRequest>} */
  const byId = new Map();
  /** @type {Map<string, { row: number, pr: PullRequest }[]>} */
  const bySource = new Map();
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

/** The revision a push created a branch at. A snapshot only reports the tip at discovery, which says nothing of the start. @param {ActivityEvent} item */
function createdAt(item) {
  const { evidence, oldObjectId, newObjectId } = item.data ?? {};
  return item.kind === 'branch-created' && evidence === 'push' && (!oldObjectId || ZERO.test(oldObjectId)) ? (newObjectId ?? '') : '';
}

/** Where each revision was seen as a branch tip: `repo, sha` to the rows and branches. @param {ActivityEvent[]} items */
function tipSightings(items) {
  /** @type {Map<string, { row: number, branch: string }[]>} */
  const sightings = new Map();
  /** @param {ActivityEvent} item @param {number} row @param {string | undefined} sha @param {string | undefined} ref */
  const add = (item, row, sha, ref) => {
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

/** The branch a row sits on, or '' for a row that belongs to no branch. @param {ActivityEvent} item @param {Map<string, PullRequest>} prs */
function rowBranch(item, prs) {
  if (item.kind === 'tag') return '';
  const pr = pullRequest(item);
  if (pr) return (item.data?.status === 'completed' && pr.target) || pr.source;
  const prRef = item.kind === 'build' ? PR_REF.exec(item.branch ?? '') : null;
  if (!prRef) return item.branch || '';
  // A CI run on a pull request ref belongs to the PR source branch: from the stored PR the server attached, or from a
  // PR row in the list. With neither, the runs of that pull request still share a lane of their own.
  const stored = item.data?.pullRequest;
  const attached = stored && pullRequestRefs(stored.id, stored.sourceRefName, stored.targetRefName, stored.fork).source;
  return attached || prs.get(laneKey(item.repoId, prRef[1]))?.source || `refs/pull/${prRef[1]}`;
}

/** @param {ActivityEvent} item @returns {TreeNode['shape']} */
function nodeShape(item) {
  if (item.kind !== 'pr') return 'dot';
  return item.data?.status === 'completed' ? 'merge' : item.data?.status === 'active' ? 'ring' : 'dot';
}

/**
 * Gives each lane a position and a colour. Lanes that others fork from or merge into go first, so a trunk stays on
 * the left. A lane that overlaps `maxLanes` others keeps slot -1.
 * @param {Lane[]} lanes @param {number} maxLanes
 */
function placeLanes(lanes, maxLanes) {
  const ordered = [...lanes].sort((a, b) => Number(b.target) - Number(a.target) || a.top - b.top);
  /** @type {Lane[]} */
  const placed = [];
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
 * @param {Map<string, { branch: string, rows: Set<number>, starts: Set<number> }>} branches @param {number} maxGap
 */
function splitLanes(branches, maxGap) {
  /** @type {Map<string, Map<number, Lane>>} */
  const byRow = new Map();
  /** @type {Lane[]} */
  const lanes = [];
  for (const [key, { branch, rows, starts }] of branches) {
    const index = new Map();
    /** @type {Lane | undefined} */
    let lane;
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
 * @param {ActivityEvent[]} items @param {{ maxLanes?: number, maxGap?: number }} [limits] @returns {ActivityTree}
 */
export function buildActivityTree(items, { maxLanes = MAX_LANES, maxGap = MAX_GAP } = {}) {
  const prs = pullRequests(items);
  const sightings = tipSightings(items);
  /** @type {Map<string, { branch: string, rows: Set<number>, starts: Set<number> }>} */
  const branches = new Map();
  /** @param {string} repoId @param {string} branch @param {number} row */
  const mark = (repoId, branch, row) => {
    const key = branch ? laneKey(repoId, branch) : laneKey(repoId, `\n${row}`);
    const entry = branches.get(key) ?? { branch, rows: new Set(), starts: new Set() };
    branches.set(key, entry);
    entry.rows.add(row);
    return key;
  };
  const rowKeys = items.map((item, row) => mark(item.repoId, rowBranch(item, prs.byId), row));

  /**
   * The oldest row of a new branch. The push that created a branch is a row of its own and may sort below it, after
   * the other rows of the same push.
   * @param {ActivityEvent} item @param {number} row
   */
  const startRow = (item, row) => {
    const pushId = item.data?.pushId;
    let start = row;
    for (let below = row + 1; pushId !== undefined && items[below]?.data?.pushId === pushId; below++)
      if (items[below].kind === 'push' && rowKeys[below] === rowKeys[row]) start = below;
    return start;
  };
  /**
   * `after` is the row where the same name was created again, or -1: a pull request above it belongs to that later branch.
   * @param {ActivityEvent} item @param {string} branch @param {number} row @param {number} start @param {number} after
   * @returns {TreeFork | null}
   */
  const forkOrigin = (item, branch, row, start, after) => {
    const tip = createdAt(item).toLowerCase();
    const seen = sightings.get(laneKey(item.repoId, tip))?.find(sighting => sighting.row > start && sighting.branch !== branch);
    if (seen) return { evidence: 'tip', parent: seen.branch };
    const requests = prs.bySource.get(laneKey(item.repoId, branch)) ?? [];
    // A push dates the branch, so its pull request has every row above. A snapshot only dates the discovery.
    const earlier = new Set(tip ? requests.filter(entry => entry.row > row).map(entry => entry.pr.id) : []);
    const pr = requests.findLast(entry => entry.row > after && (!tip || (entry.row < row && !earlier.has(entry.pr.id))))?.pr;
    return pr && pr.target !== branch ? { evidence: 'pr', parent: pr.target, pullRequestId: pr.id } : null;
  };
  /** @type {(TreeFork | null)[]} */
  const forks = items.map(() => null);
  /** The fork curve sits on the oldest row of the branch: row index to the fork and the parent it joins. @type {Map<number, { fork: TreeFork, key: string }>} */
  const forkJoins = new Map();
  /** @type {Map<string, number>} */
  const createdAbove = new Map();
  items.forEach((item, row) => {
    const entry = branches.get(rowKeys[row]);
    if (item.kind !== 'branch-created' || !entry?.branch) return;
    const start = startRow(item, row);
    // Only a push proves a new branch. A snapshot discovery has no creation time, so older rows stay on its lane.
    if (createdAt(item)) entry.starts.add(start);
    const fork = forkOrigin(item, entry.branch, row, start, createdAbove.get(rowKeys[row]) ?? -1);
    createdAbove.set(rowKeys[row], row);
    forks[row] = fork;
    if (fork) forkJoins.set(start, { fork, key: mark(item.repoId, fork.parent, start) });
  });
  const merges = items.map((item, row) => {
    const pr = nodeShape(item) === 'merge' ? pullRequest(item) : undefined;
    return pr?.source && laneKey(item.repoId, pr.source) !== rowKeys[row] ? mark(item.repoId, pr.source, row) : null;
  });

  const { lanes, byRow } = splitLanes(branches, maxGap);
  /** @param {string | null | undefined} key @param {number} row */
  const laneOf = (key, row) => (key ? byRow.get(key)?.get(row) : undefined);
  items.forEach((_, row) => {
    const own = /** @type {Lane} */ (laneOf(rowKeys[row], row));
    const parent = laneOf(forkJoins.get(row)?.key, row);
    if (parent) [parent.target, own.forked] = [true, true];
    if (merges[row]) own.target = true;
  });
  const drawn = placeLanes(lanes, maxLanes);
  const width = drawn.reduce((most, lane) => Math.max(most, lane.slot + 1), 0);
  /** @param {Lane} lane @param {number} row @returns {TreeLine} */
  const line = (lane, row) => ({ slot: lane.slot, color: lane.color, up: lane.top < row, down: lane.bottom > row });
  /** @param {Lane | undefined} lane */
  const fits = lane => (lane && lane.slot >= 0 ? lane : null);
  const rows = items.map((item, row) => {
    const own = /** @type {Lane} */ (laneOf(rowKeys[row], row));
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
      fork: forks[row],
      forkFrom: join && forkLane ? { ...line(forkLane, row), evidence: join.fork.evidence } : null,
      mergeFrom: mergeLane ? line(mergeLane, row) : null,
    };
  });
  return { width: width + Number(drawn.length < lanes.length), rows };
}
