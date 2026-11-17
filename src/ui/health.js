import { streamError } from './format.js';

export function streamHealth(stream, { now = Date.now(), scheduled = true, resumedAt = null } = {}) {
  const overdueAfter = (stream.stream === 'refs' ? 20 : 10) * 60000;
  const lastSuccess = Date.parse(stream.lastSuccess);
  const stale = scheduled && now - lastSuccess > overdueAfter;
  const resuming = stale && resumedAt > lastSuccess && now - resumedAt < overdueAfter;
  return {
    error: streamError(stream),
    pending: Boolean(scheduled && (stream.pending || !stream.initialized)),
    resuming,
    stale: stale && !resuming,
  };
}

export function repositoryHealth(repo, records, { now = Date.now(), automatic = true, resumedAt = null } = {}) {
  if (repo.paused) return { label: 'Paused', className: 'name', show: true };
  if (!automatic) return { label: 'Checks off', show: false };
  const status = records.map(stream => streamHealth(stream, { now, resumedAt }));
  if (status.some(item => item.error)) return { label: 'Check failed', className: 'part', show: true };
  if (status.some(item => item.stale && !item.pending)) return { label: 'Check overdue', className: 'part', show: true };
  if (status.some(item => item.resuming)) return { label: 'Catching up', className: 'name', show: true };
  if (!status.length || status.some(item => item.pending)) return { label: 'Catching up', show: false };
  return { label: 'Up to date', show: false };
}
