// Complete jobs for store tests. The store reads a job back only in the shape its writer saves, so a test job carries
// every field that writer sets.
import type { HistoryJob } from '../../src/contract.ts';
import type { RewriteJob } from '../../server/jobs.ts';

/** A history import job as server/backfill.ts starts it. */
export const historyJob = (repoId: string, extra: Partial<HistoryJob> = {}): HistoryJob => ({
  id: `backfill:${repoId}`,
  type: 'backfill',
  repoId,
  days: 30,
  status: 'pending',
  startedAt: '2026-11-17T10:00:00.000Z',
  nextAt: '2026-11-17T10:00:00.000Z',
  rangeStart: '2026-10-18T10:00:00.000Z',
  rangeEnd: '2026-11-17T10:00:00.000Z',
  stream: 'pushes',
  cursor: null,
  window: { since: '2026-10-18T10:00:00.000Z', until: '2026-11-17T10:00:00.000Z' },
  pages: 0,
  records: 0,
  windowsCompleted: 0,
  failures: 0,
  error: null,
  note: 'Imports older history before monitoring began; current activity stays in live sync.',
  ...extra,
});

/** A rewrite check as server/normalize.ts queues it for a push that moved refs/heads/main. */
export const rewriteJob = (repoId: string, eventId: string, extra: Partial<RewriteJob> = {}): RewriteJob => ({
  id: `rewrite:${eventId}:refs/heads/main`,
  type: 'rewrite',
  repoId,
  eventId,
  ref: 'refs/heads/main',
  oldObjectId: 'a'.repeat(40),
  newObjectId: 'b'.repeat(40),
  attempts: 0,
  nextAt: '2026-11-17T10:00:00.000Z',
  ...extra,
});
