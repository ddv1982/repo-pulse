// @ts-check

import { emptyHtml, html } from './format.js';

/** @typedef {import('../activity-tree.js').TreeRow} TreeRow */
/** @typedef {import('../activity-tree.js').TreeLine} TreeLine */
/** @typedef {import('../activity-tree.js').TreeFork} TreeFork */

// Geometry in CSS pixels. web/styles/feed.css places y = 0 on the row's status label and sizes a lane as PITCH wide.
const PITCH = 10;
const JOIN = 18;
const ABOVE = -40;
const TAIL = 9;

/** @param {number} slot */
const x = slot => PITCH / 2 + slot * PITCH;
/** @param {number} color */
const lane = color => (color < 0 ? 'lane-none' : `lane-${color + 1}`);

/** The part of a lane inside one row. `anchor` is where a lane that stops here ends. @param {TreeLine} line @param {number} anchor */
function segment(line, anchor) {
  if (!line.up && !line.down) return emptyHtml;
  return html`<line class="${lane(line.color)}" x1="${x(line.slot)}" x2="${x(line.slot)}" y1="${line.up ? ABOVE : anchor}" y2="${line.down ? '100%' : anchor}"/>`;
}

/**
 * A fork or merge: the other lane, and the curve between it and this row's node. A lane with nothing below it in
 * the list ends in a short faded tail, because its history goes on.
 * @param {TreeLine} other @param {TreeRow['node']} node @param {string} style
 */
function join(other, node, style) {
  const [from, to] = [x(other.slot), x(node.slot)];
  const tail = other.down
    ? emptyHtml
    : html`<line class="${lane(other.color)} tail" x1="${from}" x2="${from}" y1="${JOIN}" y2="${JOIN + TAIL}"/>`;
  return html`${segment(other, JOIN)}${tail}<path class="${style}" d="M${from} ${JOIN}C${from} ${JOIN / 2} ${to} ${JOIN / 2} ${to} 0"/>`;
}

/** Every marker stays inside its lane, PITCH wide: the cell clips what leaves it. @param {TreeRow['node']} node @param {string} color */
function marker(node, color) {
  const at = html`cx="${x(node.slot)}" cy="0"`;
  if (node.shape === 'ring') return html`<circle class="${color} hole" ${at} r="3.75"/>`;
  if (node.shape === 'merge') return html`<circle class="${color} hole" ${at} r="4.1"/><circle class="${color}" ${at} r="1.9"/>`;
  return html`<circle class="${color} dot" ${at} r="3.75"/>`;
}

/**
 * The tree cell of one Activity row. It is decoration: the row text already names the branch, the status and the
 * fork evidence.
 * @param {TreeRow} row @param {string} tone
 */
export function renderTreeCell(row, tone) {
  const { node, forkFrom, mergeFrom } = row;
  return html`<svg class="tree" aria-hidden="true" focusable="false"><g>${row.through.map(line => segment({ ...line, up: true, down: true }, 0))}${segment(node, 0)}${
    forkFrom ? join(forkFrom, node, `${lane(node.color)}${forkFrom.evidence === 'pr' ? ' assumed' : ''}`) : emptyHtml
  }${mergeFrom ? join(mergeFrom, node, lane(mergeFrom.color)) : emptyHtml}${marker(node, tone === 'crit' ? 'lane-crit' : lane(node.color))}</g></svg>`;
}

/** @param {TreeFork | null} fork */
export function forkText(fork) {
  if (!fork) return '';
  return fork.evidence === 'tip'
    ? `Started at a revision seen on ${fork.parent}`
    : `Branched from ${fork.parent}, assumed from PR ${fork.pullRequestId}`;
}

export const treeLegend = html`<p class="help tree-legend"><svg class="tree-key" aria-hidden="true" focusable="false"><path class="lane-none" d="M1 6H21"/></svg>Fork at a known revision<svg class="tree-key" aria-hidden="true" focusable="false"><path class="lane-none assumed" d="M1 6H21"/></svg>Fork assumed from the pull request target<svg class="tree-key ring" aria-hidden="true" focusable="false"><circle class="lane-none hole" cx="7" cy="6" r="4.1"/><circle class="lane-none" cx="7" cy="6" r="1.9"/></svg>Merge<span class="tree-note">A line can pass rows of other branches.</span></p>`;
