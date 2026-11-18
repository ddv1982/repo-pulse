// @ts-check

import { streamError, streamLabel } from './format.js';

/** @typedef {Pick<import('../../server/sync.js').StreamState, 'stream' | 'lastSuccess' | 'pending' | 'initialized' | 'error'>} StreamReading */
/** @typedef {{ now?: number, scheduled?: boolean, resumedAt?: number | null }} HealthOptions */

/** @param {StreamReading} stream @param {HealthOptions} [options] */
export function streamHealth(stream, { now = Date.now(), scheduled = true, resumedAt = null } = {}) {
  const overdueAfter = (stream.stream === 'refs' ? 20 : 10) * 60000;
  const lastSuccess = Date.parse(stream.lastSuccess ?? '');
  const stale = scheduled && now - lastSuccess > overdueAfter;
  // Number() spells out the coercion the comparison already made: null counts as 0.
  const resuming = stale && Number(resumedAt) > lastSuccess && now - Number(resumedAt) < overdueAfter;
  return {
    error: streamError(stream),
    pending: Boolean(scheduled && (stream.pending || !stream.initialized)),
    resuming,
    stale: stale && !resuming,
  };
}

/** @param {unknown} repo @param {StreamReading[]} records @param {{ now?: number, automatic?: boolean, resumedAt?: number | null }} [options] */
export function repositoryHealth(repo, records, { now = Date.now(), automatic = true, resumedAt = null } = {}) {
  if (!automatic) return { label: 'Checks off', show: false };
  const status = records.map(stream => streamHealth(stream, { now, resumedAt }));
  // A refused read stays refused until permissions change, so it is named apart from a failure that a retry can fix.
  const denied = records.filter(stream => typeof stream.error === 'object' && stream.error?.code === 'FORBIDDEN');
  if (denied.length) {
    const names = [...new Set(denied.map(stream => streamLabel(stream.stream).replace(/^\w/, c => c.toLowerCase())))];
    return { label: `No access to ${names.join(', ')}`, className: 'part', show: true };
  }
  if (status.some(item => item.error)) return { label: 'Check failed', className: 'part', show: true };
  if (status.some(item => item.stale && !item.pending)) return { label: 'Check overdue', className: 'part', show: true };
  if (status.some(item => item.resuming)) return { label: 'Catching up', className: 'name', show: true };
  if (!status.length || status.some(item => item.pending)) return { label: 'Catching up', show: false };
  return { label: 'Up to date', show: false };
}
