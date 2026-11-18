import { escape as e, dateTime } from './format.js';

function statusFor(job, paused) {
  if (job.status === 'completed') return ['Import finished', 'ok'];
  if (paused) return ['Import paused', 'neutral'];
  if (job.error || job.status === 'retrying') return ['Import retrying', 'warn'];
  if (job.status === 'running') return ['Import running', 'info'];
  return ['Import queued', 'info'];
}

export function renderHistoryButton(repo, job) {
  const busy = job && job.status !== 'completed';
  return `<button class="btn sm" type="button" id="import-${e(repo.id)}" data-action="open-history-import" data-id="${e(repo.id)}" ${busy ? 'disabled' : ''}>Import older activity…</button>`;
}

export function renderHistoryProgress(repo, job) {
  if (!job) return '';
  const [label, tone] = statusFor(job, repo.paused);
  return `<div class="history-progress" id="history-${e(repo.id)}" role="status" tabindex="-1">
    <span class="chip status-chip ${tone}">${label}</span>
    ${job.pages ? `<span class="help history-extra">${e(job.pages)} ${job.pages === 1 ? 'page' : 'pages'} read${job.lastProgressAt ? ` · Last page ${e(dateTime(job.lastProgressAt))}` : ''}</span>` : ''}
    ${job.error?.message ? `<span class="help history-extra">${e(job.error.message)}</span>` : ''}
  </div>`;
}

export function createHistoryImport(dialog, { start, onStarted }) {
  const form = dialog.querySelector('form');
  const repositoryName = dialog.querySelector('#history-repository');
  const error = dialog.querySelector('[role="alert"]');
  const controls = form.querySelectorAll('input, button');
  let repoId;
  let submitting = false;

  dialog.querySelector('[data-history-cancel]').addEventListener('click', () => dialog.close());
  dialog.addEventListener('cancel', event => { if (submitting) event.preventDefault(); });
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (submitting) return;
    const range = new FormData(form).get('history-range');
    const id = repoId;
    submitting = true;
    controls.forEach(control => { control.disabled = true; });
    error.hidden = true;
    try {
      await start(id, range === 'all' ? range : Number(range));
    } catch (failure) {
      error.textContent = failure.message;
      error.hidden = false;
      return;
    } finally {
      submitting = false;
      controls.forEach(control => { control.disabled = false; });
      if (!error.hidden) form.querySelector('[type="submit"]').focus();
    }
    dialog.close();
    await onStarted(id);
  });

  return {
    get open() { return dialog.open; },
    show(repo) {
      repoId = repo.id;
      repositoryName.textContent = repo.name;
      dialog.querySelector('#history-paused').hidden = !repo.paused;
      form.reset();
      error.hidden = true;
      dialog.showModal();
    },
  };
}
