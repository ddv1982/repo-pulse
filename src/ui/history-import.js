// @ts-check

import { emptyHtml, html, dateTime } from './format.js';
import { required } from './dom.js';

/** /api/state lists backfill jobs; these are the fields the Repositories page shows. */
/** @typedef {Pick<import('../contract.js').HistoryJob, 'status' | 'error' | 'pages' | 'lastProgressAt'>} HistoryJob */
/** @typedef {Pick<import('./refresh.js').Repo, 'id' | 'name'>} HistoryRepo */

/** @param {HistoryJob} job @returns {[string, string]} */
function statusFor(job) {
  if (job.status === 'completed') return ['History sync finished', 'ok'];
  if (job.error || job.status === 'retrying') return ['History sync retrying', 'warn'];
  if (job.status === 'running') return ['History sync running', 'info'];
  return ['History sync queued', 'info'];
}

/** @param {Pick<HistoryRepo, 'id'>} repo @param {HistoryJob | null | undefined} job */
export function renderHistoryButton(repo, job) {
  const busy = job && job.status !== 'completed';
  return html`<button class="btn sm" type="button" id="import-${repo.id}" data-action="open-history-import" data-id="${repo.id}" ${busy ? html`disabled` : emptyHtml}>Sync older activity…</button>`;
}

/** @param {Pick<HistoryRepo, 'id'>} repo @param {HistoryJob | null | undefined} job */
export function renderHistoryProgress(repo, job) {
  if (!job) return emptyHtml;
  const [label, tone] = statusFor(job);
  return html`<div class="history-progress" id="history-${repo.id}" role="status" tabindex="-1">
    <span class="chip status-chip ${tone}">${label}</span>
    ${job.pages ? html`<span class="help history-extra">${job.pages} ${job.pages === 1 ? 'page' : 'pages'} read${job.lastProgressAt ? ` · Last page ${dateTime(job.lastProgressAt)}` : ''}</span>` : emptyHtml}
    ${job.error?.message ? html`<span class="help history-extra">${job.error.message}</span>` : emptyHtml}
  </div>`;
}

/**
 * @param {HTMLDialogElement} dialog
 * @param {{ start: (repoId: string | undefined, days: number | 'all') => Promise<unknown>, onStarted: (repoId: string | undefined) => Promise<void> }} options
 */
export function createHistoryImport(dialog, { start, onStarted }) {
  const form = required('form', HTMLFormElement, dialog);
  const repositoryName = required('#history-repository', HTMLElement, dialog);
  const error = required('[role="alert"]', HTMLElement, dialog);
  const controls = [...form.querySelectorAll('input, button')].filter(
    control => control instanceof HTMLInputElement || control instanceof HTMLButtonElement,
  );
  /** @type {string | undefined} */
  let repoId;
  let submitting = false;

  required('[data-history-cancel]', HTMLElement, dialog).addEventListener('click', () => dialog.close());
  dialog.addEventListener('cancel', event => {
    if (submitting) event.preventDefault();
  });
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (submitting) return;
    const range = new FormData(form).get('history-range');
    const id = repoId;
    submitting = true;
    controls.forEach(control => {
      control.disabled = true;
    });
    error.hidden = true;
    try {
      await start(id, range === 'all' ? range : Number(range));
    } catch (failure) {
      error.textContent = failure instanceof Error ? failure.message : String(failure);
      error.hidden = false;
      return;
    } finally {
      submitting = false;
      controls.forEach(control => {
        control.disabled = false;
      });
      if (!error.hidden) required('[type="submit"]', HTMLElement, form).focus();
    }
    dialog.close();
    await onStarted(id);
  });

  return {
    get open() {
      return dialog.open;
    },
    /** @param {HistoryRepo} repo */
    show(repo) {
      repoId = repo.id;
      repositoryName.textContent = repo.name;
      form.reset();
      error.hidden = true;
      dialog.showModal();
    },
  };
}
