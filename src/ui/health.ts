import { html, dateTime } from './format.ts';
import type { SyncStatus, OverallSyncStatus } from '../contract.d.ts';

/** `unavailable` is a state response without a sync status, as from an older server. */
export type ShownSyncStatus = OverallSyncStatus | { state: 'unavailable' };
type AnySyncStatus = SyncStatus | ShownSyncStatus;

const tones: Record<AnySyncStatus['state'], string> = {
  synced: 'ok',
  syncing: 'info',
  delayed: 'warn',
  problem: 'crit',
  paused: 'neutral',
  empty: 'neutral',
  unavailable: 'neutral',
};

/** The time alone today, the date with it otherwise. */
function clock(value: string) {
  const date = new Date(value);
  return date.toDateString() === new Date().toDateString()
    ? date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : dateTime(value);
}

const reason = (status: AnySyncStatus) => ('reason' in status && status.reason ? status.reason : '');
// A reason that starts with a product name, such as Azure DevOps, keeps its capital.
const lowerFirst = (text: string) => (text.startsWith('Azure') ? text : text.replace(/^\w/, c => c.toLowerCase()));

/** The short pill text. */
export function syncLabel(status: AnySyncStatus) {
  switch (status.state) {
    case 'synced':
      return status.lastCheck ? `Synced · ${clock(status.lastCheck)}` : 'Synced';
    case 'syncing':
      return status.firstSync ? `First sync · ${status.firstSync.completed} of ${status.firstSync.total}` : 'Syncing…';
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

/** The state and why, in one sentence. @param [repoName] the repository it concerns */
export function syncSentence(status: AnySyncStatus, repoName: string = '') {
  const where = repoName ? ` in ${repoName}` : '';
  switch (status.state) {
    case 'synced':
      return status.lastCheck ? `Synced, last check ${clock(status.lastCheck)}` : 'Synced';
    case 'syncing':
      return status.firstSync
        ? `First sync${where}, ${status.firstSync.completed} of ${status.firstSync.total} checks complete`
        : 'Syncing, checks are running';
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

/**
 * What the live region announces: the sentence without the clock time or minute count, which change on every check
 * and would make a screen reader repeat an unchanged status.
 */
export function syncAnnouncement(status: AnySyncStatus, repoName: string = '') {
  if (status.state === 'synced') return 'Synced';
  if (status.state === 'syncing' && status.firstSync) return repoName ? `First sync in ${repoName}` : 'First sync';
  if (status.state === 'delayed') return `Delayed${repoName ? ` in ${repoName}` : ''}`;
  return syncSentence(status, repoName);
}

export function syncPill(status: AnySyncStatus, repoName?: string) {
  const sentence = syncSentence(status, repoName);
  return html`<span class="chip status-chip sync-pill ${tones[status.state]}" aria-label="Sync status: ${sentence}" title="${sentence}">${syncLabel(status)}</span>`;
}

/** The repository an overall status concerns. */
export function syncRepoName(repos: { id: string; name: string }[], status: AnySyncStatus) {
  return 'repoId' in status ? (repos.find(repo => repo.id === status.repoId)?.name ?? '') : '';
}
