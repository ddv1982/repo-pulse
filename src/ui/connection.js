import { dateTime, escape as e } from './format.js';

export function connectionResult(connection) {
  if (!connection || connection.checking) return '<p class="help" role="status">Detecting your existing Azure CLI configuration…</p>';
  return `<div class="connection-summary"><span class="${connection.available ? 'status-good' : 'status-bad'}" role="status">
    ${connection.available ? 'Using existing Azure CLI' : 'Azure CLI needs attention'}</span>
    ${connection.account?.name ? `<span class="help" title="Azure CLI account context">${e(connection.account.name)}</span>` : ''}
    <button class="ghost sm" type="button" id="check-picker-connection" data-action="check-connection">Check again</button></div>
    ${connection.available ? '' : `<p class="help">${e(connection.message)}</p>`}`;
}

export function connectionStatus(state, connection, repoId) {
  const result = connection.results.get(repoId);
  const streams = state.streams.filter(stream => stream.repoId === repoId);
  const lastRead = Math.max(...streams.map(stream => Date.parse(stream.lastSuccess)).filter(Number.isFinite));
  const access = result?.access;
  if (state.demo) return 'Demo mode';
  if (connection.pending === repoId) return 'Checking…';
  if (result && !result.available) return 'Azure CLI needs attention';
  if (access?.status === 'ok' && Date.parse(access.checkedAt) >= lastRead) return `Repository access verified · ${dateTime(access.checkedAt)}`;
  if (access?.status === 'failed' && Date.parse(access.checkedAt) >= lastRead) {
    return access.code === 'FORBIDDEN' ? 'Repository access denied' : 'Repository check failed';
  }
  if (streams.some(stream => stream.error)) return 'Some monitoring reads failed';
  if (Number.isFinite(lastRead)) return `Last monitoring read · ${dateTime(lastRead)}`;
  if (result?.available || connection.local?.available) return 'CLI installed · access not yet checked';
  return 'Access not yet checked';
}

export function createConnectionController({ request, render }) {
  const results = new Map();
  const state = { results, local: null, pending: null, repoId: '' };
  return {
    state,
    async check(repoId = '', { force = false } = {}) {
      if (state.pending !== null || (!force && results.has(repoId))) return;
      state.pending = repoId;
      if (force) render();
      try {
        const result = await request(`/api/connection${repoId ? `?repoId=${encodeURIComponent(repoId)}` : ''}`);
        results.set(repoId, result);
        if (result.version || !repoId) state.local = result;
      } catch (error) {
        results.set(repoId, { available: false, message: error.message });
      } finally {
        state.pending = null;
        render();
      }
    },
    select(repoId) { state.repoId = repoId; },
  };
}
