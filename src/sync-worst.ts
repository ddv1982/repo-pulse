import type { SyncStatus } from './contract.d.ts';

export type { SyncStatus };

const RANK: Record<SyncStatus['state'], number> = { synced: 0, paused: 1, syncing: 2, delayed: 3, problem: 4 };
/** A repository that never finished a read counts as oldest. */
const age = (status: SyncStatus) => Date.parse(status.since ?? '') || -Infinity;

/**
 * The status that needs the most attention; among equal states prefer the least progress or oldest data.
 */
export function worstStatus<T extends SyncStatus>(statuses: T[]): T | undefined {
  let worst: T | undefined;
  for (const status of statuses) {
    const waiting = status.state === 'syncing' && status.firstSync;
    const other = worst?.state === 'syncing' && worst.firstSync;
    if (
      !worst ||
      RANK[status.state] > RANK[worst.state] ||
      (status.state === worst.state && (waiting && other ? waiting.completed < other.completed : age(status) < age(worst)))
    )
      worst = status;
  }
  return worst;
}
