import { emptyHtml, html } from './format.ts';
import { required, setHtml } from './dom.ts';
import { createDialog } from './dialog.ts';
import type { CheckoutBranchesResponse } from '../contract.ts';

type CheckoutBranch = CheckoutBranchesResponse['branches'][number];
type PickerRepo = { id: string; name: string; localPath?: string | undefined };

/**
 * The Repositories dialog that lists a checkout's watched branches. Choosing one runs the `switch-checkout-branch`
 * action, which closes this dialog before it asks to confirm the switch.
 */
export function createBranchPicker(dialog: HTMLDialogElement, { load }: { load: (repoId: string) => Promise<CheckoutBranch[]> }) {
  const form = required('form', HTMLFormElement, dialog);
  const filter = required('#branch-filter', HTMLInputElement, dialog);
  const list = required('#branch-list', HTMLElement, dialog);
  const status = required('#branch-status', HTMLElement, dialog);
  const repository = required('#branch-repository', HTMLElement, dialog);
  let repo: PickerRepo | undefined;
  let branches: CheckoutBranch[] = [];
  let current = '';
  let failure: string | null = null;
  let loading = false;
  let opened = 0;
  // Checkout polling may have replaced the button that opened the dialog; focus its replacement or the checkout.
  const modal = createDialog(dialog, {
    replacement: id => document.getElementById(id) ?? document.getElementById(`checkout-state-${repo?.id}`),
  });

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

  return {
    close: modal.close,
    /** @param branch the branch checked out now */
    async show(next: PickerRepo, branch: string) {
      const issued = ++opened;
      repo = next;
      current = branch;
      branches = [];
      failure = null;
      loading = true;
      repository.textContent = next.localPath ? `${next.name} · ${next.localPath}` : next.name;
      filter.value = '';
      render();
      modal.show();
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
