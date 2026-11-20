// @ts-check

import { branchName } from './events.js';

/** @typedef {import('./activity.js').ActivityEvent} ActivityEvent */
/**
 * How a fork origin is known. `tip`: the new branch started at a revision an older row shows on another branch.
 * `pr`: a pull request from the branch names a target, which is an assumption about where it started.
 * @typedef {'tip' | 'pr'} ForkEvidence
 */
/** @typedef {{ slot: number, color: number }} TreeLane A drawn lane. `color` indexes the lane palette; -1 is neutral. */
/** @typedef {TreeLane & { up: boolean, down: boolean }} TreeLine A lane in one row, and whether it runs on above and below. */
/** @typedef {TreeLine & { shape: 'dot' | 'ring' | 'merge', overflow: boolean }} TreeNode */
/** @typedef {{ evidence: ForkEvidence, parent: string, pullRequestId?: number | string, line: TreeLine | null }} TreeFork */
/**
 * One feed row. `through` lists the lanes that only pass by. `fork.line` and `mergeFrom` are the other lane of a
 * drawn fork or merge, and are null when either lane did not fit.
 * @typedef {{ node: TreeNode, through: TreeLane[], fork: TreeFork | null, mergeFrom: TreeLine | null }} TreeRow
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

/** @param {ActivityEvent[]} items */
function pullRequests(items) {
  /** @type {Map<string, PullRequest>} */
  const byId = new Map();
  /** @type {Map<string, PullRequest>} */
  const bySource = new Map();
  for (const item of items) {
    const id = item.kind === 'pr' ? item.data?.pullRequestId : undefined;
    if (id === undefined) continue;
    const pr = { id, source: branchName(item.data?.sourceRefName) || item.branch || '', target: branchName(item.data?.targetRefName) };
    byId.set(laneKey(item.repoId, String(id)), pr);
    if (pr.source && pr.target) bySource.set(laneKey(item.repoId, pr.source), pr);
  }
  return { byId, bySource };
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
  });
  return sightings;
}

/** The branch a row sits on, or '' for a row that belongs to no branch. @param {ActivityEvent} item @param {Map<string, PullRequest>} prs */
function rowBranch(item, prs) {
  if (item.kind === 'tag') return '';
  if (item.kind === 'pr') {
    const pr = prs.get(laneKey(item.repoId, String(item.data?.pullRequestId)));
    return (item.data?.status === 'completed' && pr?.target) || pr?.source || item.branch || '';
  }
  const prRef = item.kind === 'build' ? PR_REF.exec(item.branch ?? '') : null;
  return (prRef && prs.get(laneKey(item.repoId, prRef[1]))?.source) || item.branch || '';
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
 * back, so long-lived branches do not hold a position through pages of unrelated activity.
 * @param {Map<string, { branch: string, rows: Set<number> }>} branches @param {number} maxGap
 */
function splitLanes(branches, maxGap) {
  /** @type {Map<string, Map<number, Lane>>} */
  const byRow = new Map();
  /** @type {Lane[]} */
  const lanes = [];
  for (const [key, { branch, rows }] of branches) {
    const index = new Map();
    /** @type {Lane | undefined} */
    let lane;
    for (const row of [...rows].sort((a, b) => a - b)) {
      if (!lane || row - lane.bottom > maxGap) {
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
  /** @type {Map<string, { branch: string, rows: Set<number>, own: Set<number> }>} */
  const branches = new Map();
  /** @param {string} repoId @param {string} branch @param {number} row @param {boolean} own */
  const mark = (repoId, branch, row, own) => {
    const key = branch ? laneKey(repoId, branch) : laneKey(repoId, `\n${row}`);
    const entry = branches.get(key) ?? { branch, rows: new Set(), own: new Set() };
    branches.set(key, entry);
    entry.rows.add(row);
    if (own) entry.own.add(row);
    return key;
  };
  const rowKeys = items.map((item, row) => mark(item.repoId, rowBranch(item, prs.byId), row, true));
  /** @param {string} key */
  const ownRows = key => [...(branches.get(key)?.own ?? [])];

  /** @param {ActivityEvent} item @param {number} row @returns {Omit<TreeFork, 'line'> | null} */
  const forkOrigin = (item, row) => {
    const branch = branches.get(rowKeys[row])?.branch;
    if (item.kind !== 'branch-created' || !branch || Math.max(...ownRows(rowKeys[row])) !== row) return null;
    const tip = (item.data?.newObjectId ?? item.data?.objectId ?? '').toLowerCase();
    const seen = sightings.get(laneKey(item.repoId, tip))?.find(sighting => sighting.row > row && sighting.branch !== branch);
    if (seen) return { evidence: 'tip', parent: seen.branch };
    const pr = prs.bySource.get(laneKey(item.repoId, branch));
    return pr && pr.target !== branch ? { evidence: 'pr', parent: pr.target, pullRequestId: pr.id } : null;
  };
  const forks = items.map((item, row) => {
    const origin = forkOrigin(item, row);
    return origin && { origin, key: mark(item.repoId, origin.parent, row, false) };
  });
  const merges = items.map((item, row) => {
    const pr = nodeShape(item) === 'merge' ? prs.byId.get(laneKey(item.repoId, String(item.data?.pullRequestId))) : undefined;
    const key = pr && laneKey(item.repoId, pr.source);
    const near = key && key !== rowKeys[row] && ownRows(key).some(source => source > row && source - row <= maxGap);
    return near ? mark(item.repoId, pr.source, row, false) : null;
  });

  const { lanes, byRow } = splitLanes(branches, maxGap);
  /** @param {string | null | undefined} key @param {number} row */
  const laneOf = (key, row) => (key ? byRow.get(key)?.get(row) : undefined);
  items.forEach((_, row) => {
    const parent = laneOf(forks[row]?.key, row);
    const own = laneOf(rowKeys[row], row);
    if (own && parent) [parent.target, own.forked] = [true, true];
    if (own && merges[row]) own.target = true;
  });
  const drawn = placeLanes(lanes, maxLanes);
  const width = drawn.reduce((most, lane) => Math.max(most, lane.slot + 1), 0);
  /** @param {Lane} lane @param {number} row @returns {TreeLine} */
  const line = (lane, row) => ({ slot: lane.slot, color: lane.color, up: lane.top < row, down: lane.bottom > row });
  /** @param {Lane | undefined} lane */
  const fits = lane => (lane && lane.slot >= 0 ? lane : null);
  const rows = items.map((item, row) => {
    const own = /** @type {Lane} */ (laneOf(rowKeys[row], row));
    const fork = forks[row];
    const forkLane = fits(own) && fits(laneOf(fork?.key, row));
    const mergeLane = fits(own) && fits(laneOf(merges[row], row));
    return {
      node: fits(own)
        ? { ...line(own, row), shape: nodeShape(item), overflow: false }
        : { slot: width, color: own.color, up: false, down: false, shape: nodeShape(item), overflow: true },
      through: drawn
        .filter(lane => lane !== own && lane !== forkLane && lane !== mergeLane && lane.top < row && lane.bottom > row)
        .map(lane => ({ slot: lane.slot, color: lane.color })),
      fork: fork ? { ...fork.origin, line: forkLane ? line(forkLane, row) : null } : null,
      mergeFrom: mergeLane ? line(mergeLane, row) : null,
    };
  });
  return { width: width + Number(drawn.length < lanes.length), rows };
}
