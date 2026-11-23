// @ts-check

import { emptyHtml, html } from './format.js';
import { required, setHtml } from './dom.js';

/** @typedef {import('../contract.js').CheckoutBranchesResponse['branches'][number]} CheckoutBranch */
/** @typedef {{ id: string, name: string, localPath?: string }} PickerRepo */

/**
 * The Repositories dialog that lists a checkout's watched branches. Choosing one runs the `switch-checkout-branch`
 * action, which closes this dialog before it asks to confirm the switch.
 * @param {HTMLDialogElement} dialog
 * @param {{ load: (repoId: string) => Promise<CheckoutBranch[]> }} options
 */
export function createBranchPicker(dialog, { load }) {
  const form = required('form', HTMLFormElement, dialog);
  const filter = required('#branch-filter', HTMLInputElement, dialog);
  const list = required('#branch-list', HTMLElement, dialog);
  const status = required('#branch-status', HTMLElement, dialog);
  const repository = required('#branch-repository', HTMLElement, dialog);
  /** @type {PickerRepo | undefined} */
  let repo;
  /** @type {CheckoutBranch[]} */
  let branches = [];
  let current = '';
  /** @type {string | null} */
  let failure = null;
  let loading = false;
  let opened = 0;

  function render() {
    const query = filter.value.trim().toLowerCase();
    const shown = branches.filter(branch => branch.name.toLowerCase().includes(query));
    setHtml(
      list,
      html`${shown.map(branch => {
        const here = branch.name === current;
        const label = here ? 'Checked out' : branch.local ? 'Local' : 'Remote only';
        const attributes = html`data-id="${repo?.id ?? ''}" data-path="${repo?.localPath ?? ''}" data-branch="${branch.name}"`;
        return html`<li><button type="button" class="branch-option" data-action="switch-checkout-branch" ${attributes} ${here ? html`disabled aria-current="true"` : emptyHtml}><code>${branch.name}</code> <span class="chip ${here ? 'status-chip ok' : ''}">${label}</span></button></li>`;
      })}`,
    );
    status.textContent = loading
      ? 'Loading branches…'
      : (failure ??
        (!branches.length
          ? 'This repository lists no branches yet.'
          : shown.length
            ? `${shown.length} of ${branches.length} branches`
            : 'No branch matches this filter.'));
  }

  filter.addEventListener('input', render);
  form.addEventListener('submit', event => {
    event.preventDefault();
    // Enter in the filter chooses the first branch it shows.
    list.querySelector('button:not([disabled])')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  required('[data-branch-cancel]', HTMLElement, dialog).addEventListener('click', () => dialog.close());
  // Checkout polling may have replaced the button that opened the dialog; focus its replacement or the checkout.
  dialog.addEventListener('close', () => {
    const active = document.activeElement;
    if (active && active !== document.body && !dialog.contains(active)) return;
    (document.getElementById(`checkout-switch-${repo?.id}`) ?? document.getElementById(`checkout-state-${repo?.id}`))?.focus();
  });

  return {
    get open() {
      return dialog.open;
    },
    close() {
      if (dialog.open) dialog.close();
    },
    /** @param {PickerRepo} next @param {string} branch the branch checked out now */
    async show(next, branch) {
      const issued = ++opened;
      repo = next;
      current = branch;
      branches = [];
      failure = null;
      loading = true;
      repository.textContent = next.localPath ? `${next.name} · ${next.localPath}` : next.name;
      filter.value = '';
      render();
      dialog.showModal();
      try {
        const loaded = await load(next.id);
        if (issued === opened) branches = loaded;
      } catch (error) {
        if (issued === opened) failure = error instanceof Error ? error.message : String(error);
      } finally {
        if (issued === opened) {
          loading = false;
          render();
        }
      }
    },
  };
}
