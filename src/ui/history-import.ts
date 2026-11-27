import { emptyHtml, html, dateTime } from './format.ts';
import { required } from './dom.ts';
import { createDialog } from './dialog.ts';

/** /api/state lists backfill jobs; these are the fields the Repositories page shows. */
export type HistoryJob = Pick<import('../contract.ts').HistoryJob, 'status' | 'error' | 'pages' | 'lastProgressAt' | 'warnings'>;
type HistoryRepo = Pick<import('./refresh.ts').Repo, 'id' | 'name'>;

function statusFor(job: HistoryJob): [string, string] {
  if (job.status === 'completed') return ['History sync finished', job.warnings?.length ? 'warn' : 'ok'];
  if (job.error || job.status === 'retrying') return ['History sync retrying', 'warn'];
  if (job.status === 'running') return ['History sync running', 'info'];
  return ['History sync queued', 'info'];
}

export function renderHistoryButton(repo: Pick<HistoryRepo, 'id'>, job: HistoryJob | null | undefined) {
  const busy = job && job.status !== 'completed';
  return html`<button class="btn sm" type="button" id="import-${repo.id}" data-action="open-history-import" data-id="${repo.id}" ${busy ? html`disabled` : emptyHtml}>Sync older activity…</button>`;
}

/** The chip names the records the import skipped, since the warnings that explain them show only in Details. */
function skippedNote(job: HistoryJob) {
  const skipped = (job.warnings ?? []).reduce((total, warning) => total + warning.count, 0);
  return skipped ? ` · ${skipped} ${skipped === 1 ? 'record' : 'records'} skipped` : '';
}

export function renderHistoryProgress(repo: Pick<HistoryRepo, 'id'>, job: HistoryJob | null | undefined) {
  if (!job) return emptyHtml;
  const [label, tone] = statusFor(job);
  return html`<div class="history-progress" id="history-${repo.id}" role="status" tabindex="-1">
    <span class="chip status-chip ${tone}">${label}${skippedNote(job)}</span>
    ${job.pages ? html`<span class="help history-extra">${job.pages} ${job.pages === 1 ? 'page' : 'pages'} read${job.lastProgressAt ? ` · Last page ${dateTime(job.lastProgressAt)}` : ''}</span>` : emptyHtml}
    ${job.error?.message ? html`<span class="help history-extra">${job.error.message}</span>` : emptyHtml}
    ${(job.warnings ?? []).map(warning => html`<span class="help history-extra history-warning">${warning.message}</span>`)}
  </div>`;
}

export function createHistoryImport(
  dialog: HTMLDialogElement,
  {
    start,
    onStarted,
    onFollowupError,
  }: {
    start: (repoId: string | undefined, days: number | 'all') => Promise<unknown>;
    onStarted: (repoId: string | undefined) => Promise<void>;
    onFollowupError: (failure: unknown) => void;
  },
) {
  const form = required('form', HTMLFormElement, dialog);
  const repositoryName = required('#history-repository', HTMLElement, dialog);
  const controls = [...form.querySelectorAll('input, button')].filter(
    control => control instanceof HTMLInputElement || control instanceof HTMLButtonElement,
  );
  let repoId: string | undefined;
  // Every control waits while the request runs.
  const modal = createDialog(dialog, { busy: () => controls });

  const submitImport = async (event: SubmitEvent) => {
    event.preventDefault();
    if (modal.busy) return;
    const range = new FormData(form).get('history-range');
    const id = repoId;
    if (!(await modal.submit(() => start(id, range === 'all' ? range : Number(range))))) {
      // The disabled controls lost focus; Start sync takes it back beside the error.
      required('[type="submit"]', HTMLElement, form).focus();
      return;
    }
    modal.close();
    try {
      await onStarted(id);
    } catch (failure) {
      onFollowupError(failure);
    }
  };
  form.addEventListener('submit', event => void submitImport(event));

  return {
    show(repo: HistoryRepo) {
      repoId = repo.id;
      repositoryName.textContent = repo.name;
      form.reset();
      modal.show();
    },
  };
}
