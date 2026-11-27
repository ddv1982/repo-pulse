// The jobs sync queues for later Azure checks, and the one builder for a fork check. The store, the normalizer and the
// checks themselves read these shapes, so they live apart from all three.

/** One moved branch of a live push, checked once for commits the new tip no longer reaches. */
export type RewriteJob = {
  id: string;
  type: 'rewrite';
  repoId: string;
  eventId: string;
  ref: string;
  oldObjectId: string;
  newObjectId: string;
  attempts: number;
  nextAt: string;
};

/**
 * One live branch creation, checked for the commit it started from and the branch that held it. Until `base` is known,
 * `at` is the commit to read next and `reads` counts the commit reads so far. `checks` are the candidate branches
 * still to test with the tip each had before the creating push.
 */
export type ForkJob = {
  id: string;
  type: 'fork';
  repoId: string;
  eventId: string;
  ref: string;
  pushId: number;
  at: string;
  reads: number;
  attempts: number;
  nextAt: string;
  base?: string;
  checks?: { ref: string; tip: string }[];
  on?: string[];
  notOn?: string[];
  unanswered?: string[];
};

/**
 * The check for one push branch creation, or null when the row cannot be checked (no full ref or created tip).
 */
export function forkJob(event: {
  id: string;
  repoId: string;
  kind: string;
  observedAt: string;
  data?: {
    evidence?: string;
    name?: string;
    newObjectId?: string | undefined;
    pushId?: number | string | undefined;
  };
}): ForkJob | null {
  const { evidence, name, newObjectId, pushId } = event.data ?? {};
  if (event.kind !== 'branch-created' || evidence !== 'push' || typeof name !== 'string') return null;
  if (typeof newObjectId !== 'string' || !/^[0-9a-f]{40}$/i.test(newObjectId) || /^0+$/.test(newObjectId)) return null;
  if (!Number.isSafeInteger(Number(pushId)) || Number(pushId) <= 0) return null;
  return {
    id: `fork:${event.id}`,
    type: 'fork',
    repoId: event.repoId,
    eventId: event.id,
    ref: name,
    pushId: Number(pushId),
    at: newObjectId.toLowerCase(),
    reads: 0,
    attempts: 0,
    nextAt: event.observedAt,
  };
}
