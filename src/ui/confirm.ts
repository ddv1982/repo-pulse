import { required } from './dom.ts';
import { createDialog } from './dialog.ts';

/**
 * The confirmation dialog. It holds one command at a time: a command that asks while another waits for an answer is
 * refused, never swapped in. The command runs under the resource of the command that asked for it.
 */
export function createConfirmation(dialog: HTMLDialogElement, { replacement }: { replacement: (openerId: string) => HTMLElement | null }) {
  let pending: { callback: () => Promise<void>; resource: string } | null = null;
  const modal = createDialog(dialog, {
    replacement,
    onClose: () => {
      pending = null;
    },
  });
  const title = required('#confirm-title', HTMLElement, dialog);
  const subjectLine = required('#confirm-subject', HTMLElement, dialog);
  const description = required('#confirm-description', HTMLElement, dialog);
  const button = required('#confirm-button', HTMLButtonElement, dialog);
  return {
    /** The resource the waiting command changes. */
    get resource() {
      return pending?.resource;
    },
    ask(
      this: void,
      heading: string,
      text: string,
      callback: () => Promise<void>,
      label = 'Confirm',
      { subject = '', destructive = false, resource = 'confirm-dialog' } = {},
    ) {
      if (dialog.open) throw new Error('Finish the open confirmation before starting another action.');
      title.textContent = heading;
      subjectLine.textContent = subject;
      subjectLine.hidden = !subject;
      description.textContent = text;
      button.textContent = label;
      button.classList.toggle('danger', destructive);
      modal.show();
      pending = { callback, resource };
    },
    /** Closes the dialog, returning focus, then runs the confirmed command. */
    async accept() {
      const callback = pending?.callback;
      modal.close();
      if (callback) await callback();
    },
  };
}
