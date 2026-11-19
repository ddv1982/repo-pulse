// @ts-check

import { escape as e, dateTime } from './format.js';

/** @typedef {import('../../server/sync-status.js').SyncStatus} SyncStatus */
/** @typedef {import('../../server/sync-status.js').OverallSyncStatus} OverallSyncStatus */
/** `unavailable` is a state response without a sync status, as from an older server. @typedef {OverallSyncStatus | { state: 'unavailable' }} ShownSyncStatus */
/** @typedef {SyncStatus | ShownSyncStatus} AnySyncStatus */

/** @type {Record<AnySyncStatus['state'], string>} */
const tones = {
  synced: 'ok',
  syncing: 'info',
  delayed: 'warn',
  problem: 'crit',
  paused: 'neutral',
  empty: 'neutral',
  unavailable: 'neutral',
};

/** The time alone today, the date with it otherwise. @param {string} value */
function clock(value) {
  const date = new Date(value);
  return date.toDateString() === new Date().toDateString()
    ? date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : dateTime(value);
}

/** @param {AnySyncStatus} status */
const reason = status => ('reason' in status && status.reason ? status.reason : '');
/** @param {string} text */
const lowerFirst = text => text.replace(/^\w/, c => c.toLowerCase());

/** The short pill text. @param {AnySyncStatus} status */
export function syncLabel(status) {
  switch (status.state) {
    case 'synced':
      return status.lastCheck ? `Synced · ${clock(status.lastCheck)}` : 'Synced';
    case 'syncing':
      return 'Syncing…';
    case 'delayed':
      return `Delayed · ${lowerFirst(reason(status) || 'behind schedule')}`;
    case 'problem':
      return 'Problem';
    case 'paused':
      return 'Paused';
    case 'empty':
      return 'No repositories';
    default:
      return 'Sync status unavailable';
  }
}

/** The state and why, in one sentence. @param {AnySyncStatus} status @param {string} [repoName] the repository it concerns */
export function syncSentence(status, repoName = '') {
  const where = repoName ? ` in ${repoName}` : '';
  switch (status.state) {
    case 'synced':
      return status.lastCheck ? `Synced, last check ${clock(status.lastCheck)}` : 'Synced';
    case 'syncing':
      return 'Syncing, checks are running';
    case 'delayed':
      return `Delayed${where}: ${lowerFirst(reason(status) || 'behind schedule')}`;
    case 'problem':
      return `Problem${where}: ${reason(status)}`;
    case 'paused':
      return 'Paused, automatic checks are off';
    case 'empty':
      return 'No repositories watched';
    default:
      return 'Sync status unavailable';
  }
}

/** @param {AnySyncStatus} status @param {string} [repoName] */
export function syncPill(status, repoName) {
  const sentence = e(syncSentence(status, repoName));
  return `<span class="chip status-chip sync-pill ${tones[status.state]}" aria-label="Sync status: ${sentence}" title="${sentence}">${e(syncLabel(status))}</span>`;
}

/** The repository an overall status concerns. @param {{ id: string, name: string }[]} repos @param {AnySyncStatus} status */
export function syncRepoName(repos, status) {
  return 'repoId' in status ? (repos.find(repo => repo.id === status.repoId)?.name ?? '') : '';
}
