import type { SyncStatus } from './contract.ts';

export type { SyncStatus };

const RANK: Record<SyncStatus['state'], number> = { synced: 0, paused: 1, syncing: 2, delayed: 3, problem: 4 };
/** A repository that never finished a read counts as oldest. */
const age = (status: SyncStatus) => Date.parse(status.since ?? '') || -Infinity;

/**
 * The status that needs the most attention; among equal states the one with the oldest data decides.
 */
export function worstStatus<T extends SyncStatus>(statuses: T[]): T | undefined {
  let worst: T | undefined;
  for (const status of statuses) {
    if (!worst || RANK[status.state] > RANK[worst.state] || (status.state === worst.state && age(status) < age(worst))) worst = status;
  }
  return worst;
}
