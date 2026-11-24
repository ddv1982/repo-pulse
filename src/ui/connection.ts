import { dateTime, emptyHtml, html } from './format.ts';
import type { ConnectionResponse as ConnectionStatus } from '../api.ts';

/** A connection check's answer; a failed request is recorded as an unavailable status. */
export type { ConnectionStatus };
export type ConnectionState = {
  results: Map<string, ConnectionStatus>;
  local: ConnectionStatus | null;
  pending: string | null;
  repoId: string;
};
export type ConnectionPage = Pick<import('./refresh.ts').PageState, 'demo' | 'streams'>;

export function connectionResult(connection: ConnectionStatus | undefined) {
  if (!connection) return html`<p class="help" role="status">Detecting your existing Azure CLI configuration…</p>`;
  return html`<div class="connection-summary"><span class="${connection.available ? 'status-good' : 'status-bad'}" role="status">
    ${connection.available ? 'Using existing Azure CLI' : 'Azure CLI needs attention'}</span>
    ${connection.account?.name ? html`<span class="help" title="Azure CLI account context">${connection.account.name}</span>` : emptyHtml}
    <button class="ghost sm" type="button" id="check-picker-connection" data-action="check-connection">Check again</button></div>
    ${connection.available ? emptyHtml : html`<p class="help">${connection.message}</p>`}`;
}

export function connectionStatus(state: ConnectionPage, connection: ConnectionState, repoId: string) {
  const result = connection.results.get(repoId);
  const streams = state.streams.filter(stream => stream.repoId === repoId);
  const lastRead = Math.max(...streams.map(stream => Date.parse(stream.lastSuccess ?? '')).filter(Number.isFinite));
  const access = result?.access;
  if (state.demo) return 'Demo mode';
  if (connection.pending === repoId) return 'Checking…';
  if (result && !result.available) return 'Azure CLI needs attention';
  if (access?.status === 'ok' && Date.parse(access.checkedAt) >= lastRead)
    return `Repository access verified · ${dateTime(access.checkedAt)}`;
  if (access?.status === 'failed' && Date.parse(access.checkedAt) >= lastRead) {
    return access.code === 'FORBIDDEN' ? 'Repository access denied' : 'Repository check failed';
  }
  if (streams.some(stream => stream.error)) return 'Some monitoring reads failed';
  if (Number.isFinite(lastRead)) return `Last monitoring read · ${dateTime(lastRead)}`;
  if (result?.available || connection.local?.available) return 'CLI installed · access not yet checked';
  return 'Access not yet checked';
}

export function createConnectionController({ request, render }: { request: typeof import('../api.ts').request; render: () => void }) {
  const results: Map<string, ConnectionStatus> = new Map();
  const state: ConnectionState = { results, local: null, pending: null, repoId: '' };
  return {
    state,
    async check(repoId: string = '', { force = false }: { force?: boolean } = {}) {
      if (state.pending !== null || (!force && results.has(repoId))) return;
      state.pending = repoId;
      if (force) render();
      try {
        const result = repoId ? await request(`/api/connection?repoId=${encodeURIComponent(repoId)}`) : await request('/api/connection');
        results.set(repoId, result);
        if (result.version || !repoId) state.local = result;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        results.set(repoId, { available: false, identity: null, identityVerified: false, message });
      } finally {
        state.pending = null;
        render();
      }
    },
    select(repoId: string) {
      state.repoId = repoId;
    },
  };
}
