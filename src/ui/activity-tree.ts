import { emptyHtml, html } from './format.ts';
import { tagGlyph } from './icons.ts';
import type { TreeRow, TreeLine, TreeFork } from '../activity-tree.ts';

export type { TreeRow, TreeLine, TreeFork };

// Geometry in CSS pixels. web/styles/feed.css places y = 0 on the row's type label and sizes a lane as PITCH wide.
const PITCH = 10;
const JOIN = 18;
const ABOVE = -40;
const TAIL = 9;

const x = (slot: number) => PITCH / 2 + slot * PITCH;
const lane = (color: number) => (color < 0 ? 'lane-none' : `lane-${color + 1}`);

/** The part of a lane inside one row. `anchor` is where a lane that stops here ends. */
function segment(line: TreeLine, anchor: number) {
  if (!line.up && !line.down) return emptyHtml;
  return html`<line class="${lane(line.color)}${line.isDefault ? ' default-lane' : ''}" x1="${x(line.slot)}" x2="${x(line.slot)}" y1="${line.up ? ABOVE : anchor}" y2="${line.down ? '100%' : anchor}"/>`;
}

/**
 * A fork or merge: the other lane, and the curve between it and this row's node. A lane with nothing below it in
 * the list ends in a short faded tail, because its history goes on.
 */
function join(other: TreeLine, node: TreeRow['node'], color: string, assumed = false) {
  const [from, to] = [x(other.slot), x(node.slot)];
  const tailColor = other.color < 0 ? color : lane(other.color);
  const tail = other.down
    ? emptyHtml
    : html`<line class="${tailColor} tail${other.isDefault ? ' default-lane' : ''}" x1="${from}" x2="${from}" y1="${JOIN}" y2="${JOIN + TAIL}"/>`;
  return html`${segment(other, JOIN)}${tail}<path class="${color}${assumed ? ' assumed' : ''}" d="M${from} ${JOIN}C${from} ${JOIN / 2} ${to} ${JOIN / 2} ${to} 0"/>`;
}

/** Every marker stays inside its lane, PITCH wide: the cell clips what leaves it. */
function marker(node: TreeRow['node'], color: string) {
  const at = html`cx="${x(node.slot)}" cy="0"`;
  if (node.shape === 'tag') return html`<g class="tag-mark" transform="translate(${x(node.slot) - 5} -5) scale(0.4167)">${tagGlyph}</g>`;
  if (node.shape === 'ci') return html`<rect class="${color} ci-node" x="${x(node.slot) - 3}" y="-3" width="6" height="6" rx="1"/>`;
  if (node.shape === 'ring' || node.shape === 'draft')
    return html`<circle class="${color} hole${node.shape === 'draft' ? ' draft-ring' : ''}" ${at} r="3.75"/>`;
  if (node.shape === 'merge') return html`<circle class="${color} hole" ${at} r="4.1"/><circle class="${color}" ${at} r="1.9"/>`;
  return html`<circle class="${color} dot" ${at} r="3.75"/>`;
}

function isDetachedPr({ node, forkFrom, mergeFrom }: TreeRow) {
  return (node.shape === 'ring' || node.shape === 'draft') && !node.up && !node.down && !forkFrom && !mergeFrom;
}

/**
 * The tree cell of one Activity row. It is decoration: the row text already names the branch, the status and the
 * fork evidence.
 */
export function renderTreeCell(row: TreeRow, tone: string) {
  const { node, forkFrom, mergeFrom } = row;
  return html`<svg class="tree" aria-hidden="true" focusable="false"><g>${row.through.map(line => segment({ ...line, up: true, down: true }, 0))}${segment(node, 0)}${
    forkFrom ? join(forkFrom, node, lane(node.color), forkFrom.evidence === 'pr') : emptyHtml
  }${mergeFrom ? join(mergeFrom, node, lane(mergeFrom.color)) : emptyHtml}${isDetachedPr(row) ? emptyHtml : marker(node, tone === 'crit' ? 'lane-crit' : lane(node.color))}</g></svg>`;
}

/**
 * The row text for a fork origin. Git records no branch parentage, so no text says a branch was branched from another:
 * it names the commit the branch started at and which branch held it.
 */
export function forkText(fork: TreeFork | null) {
  if (!fork) return '';
  const base = (fork.base ?? '').slice(0, 7);
  switch (fork.evidence) {
    case 'recorded':
      return `Started at ${base}, the tip of ${fork.parent}`;
    case 'contained':
      return `Started at ${base}, already on ${fork.parent}`;
    case 'pr':
      return `PR ${fork.pullRequestId} targets ${fork.parent}, origin not checked`;
    case 'ambiguous':
      return `Started at ${base}, on ${(fork.branches ?? []).join(' and ')}`;
    case 'refuted':
      return `PR ${fork.pullRequestId} targets ${fork.target}, which did not hold ${base}`;
    case 'unplaced':
      return `Started at ${base}, no branch match found`;
    case 'orphan':
      return 'Started with no earlier commit';
    case 'merge':
      return 'Started with a merge commit';
  }
}

export const treeLegend = html`<div class="activity-graph-guide"><details class="tree-guide" data-group="graph-key"><summary class="help">Activity lane key</summary><p class="help tree-legend"><span class="tree-key-item"><svg class="tree-key" aria-hidden="true" focusable="false"><path class="lane-none" d="M1 6H21"/></svg>Known fork point</span><span class="tree-key-item"><svg class="tree-key" aria-hidden="true" focusable="false"><path class="lane-none assumed" d="M1 6H21"/></svg>PR target, origin not checked</span><span class="tree-key-item"><svg class="tree-key ring" aria-hidden="true" focusable="false"><circle class="lane-none hole" cx="7" cy="6" r="4.1"/><circle class="lane-none" cx="7" cy="6" r="1.9"/></svg>Merge</span><span class="tree-key-item"><svg class="tree-key ring" aria-hidden="true" focusable="false"><circle class="lane-none hole" cx="7" cy="6" r="3.75"/></svg>Open PR</span><span class="tree-key-item"><svg class="tree-key ring" aria-hidden="true" focusable="false"><circle class="lane-none hole draft-ring" cx="7" cy="6" r="3.75"/></svg>Draft PR</span><span class="tree-key-item"><svg class="tree-key ring" aria-hidden="true" focusable="false"><rect class="lane-none ci-node" x="4" y="3" width="6" height="6" rx="1"/></svg>CI run</span><span class="tree-key-item"><svg class="tree-key ring" aria-hidden="true" focusable="false"><circle class="lane-none dot" cx="7" cy="6" r="3.75"/></svg>No branch line shown</span><span class="tree-note">Lanes connect nearby activity on a branch. Lines can pass rows of other branches.</span></p></details><a class="help" href="#graph">Open Git Graph</a></div>`;
