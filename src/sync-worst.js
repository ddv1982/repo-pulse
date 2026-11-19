// @ts-check

/** @typedef {import('../server/sync-status.js').SyncStatus} SyncStatus */

/** @type {Record<SyncStatus['state'], number>} */
const RANK = { synced: 0, paused: 1, syncing: 2, delayed: 3, problem: 4 };
/** A repository that never finished a read counts as oldest. @param {SyncStatus} status */
const age = status => Date.parse(status.since ?? '') || -Infinity;

/**
 * The status that needs the most attention; among equal states the one with the oldest data decides.
 * @template {SyncStatus} T @param {T[]} statuses @returns {T | undefined}
 */
export function worstStatus(statuses) {
  /** @type {T | undefined} */
  let worst;
  for (const status of statuses) {
    if (!worst || RANK[status.state] > RANK[worst.state] || (status.state === worst.state && age(status) < age(worst))) worst = status;
  }
  return worst;
}
