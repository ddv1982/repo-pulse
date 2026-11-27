/** Every dialog the page made with createDialog, so a background render and the `/` shortcut can tell one is open. */
const dialogs = new Set<HTMLDialogElement>();

/** Whether any dialog is open. A background render waits, and `/` does not move focus behind it. */
export function anyDialogOpen() {
  return [...dialogs].some(dialog => dialog.open);
}

/**
 * One modal dialog: it opens over the control that opened it and gives focus back to that control when it closes. A
 * control marked `data-dialog-cancel` and Escape close it, except while it is busy saving. While busy, the `busy`
 * controls are disabled. An element with `role="alert"` inside it is its error slot.
 *
 * Focus returns synchronously in `close()`, before whatever the dialog's answer starts, so a confirmation that leads to
 * another one, or to a focus move of its own, is not undone later.
 */
export function createDialog(
  dialog: HTMLDialogElement,
  {
    busy: busyControls = () => [],
    replacement = id => document.getElementById(id),
    onClose,
  }: {
    /** The controls disabled while the dialog's work runs. */
    busy?: () => (HTMLButtonElement | HTMLInputElement)[];
    /** The control that takes focus when the opener left the page, found by the opener's ID. */
    replacement?: (openerId: string) => HTMLElement | null;
    /** Runs as the dialog closes, before focus returns, however it was closed. */
    onClose?: () => void;
  } = {},
) {
  dialogs.add(dialog);
  const error = dialog.querySelector('[role="alert"]');
  let opener: HTMLElement | SVGElement | null = null;
  let busy = false;

  function close() {
    if (!dialog.open) return;
    dialog.close();
    onClose?.();
    const previous = opener;
    opener = null;
    const target = previous?.isConnected ? previous : replacement(previous?.id ?? '');
    target?.focus({ preventScroll: true });
  }

  function setBusy(value: boolean) {
    busy = value;
    for (const control of busyControls()) control.disabled = value;
  }

  dialog.addEventListener('cancel', event => {
    event.preventDefault();
    if (!busy) close();
  });
  dialog.addEventListener('click', event => {
    if (!busy && event.target instanceof Element && event.target.closest('[data-dialog-cancel]')) close();
  });

  return {
    get open() {
      return dialog.open;
    },
    get busy() {
      return busy;
    },
    /** Opens the dialog over the focused control, which takes focus back when it closes. */
    show() {
      const focused = document.activeElement;
      opener = focused instanceof HTMLElement || focused instanceof SVGElement ? focused : null;
      if (error instanceof HTMLElement) error.hidden = true;
      dialog.showModal();
    },
    close,
    /**
     * Runs the dialog's work while it is busy. A failure shows in the error slot and the dialog stays open.
     * @returns whether the work finished
     */
    async submit(work: () => Promise<unknown>) {
      if (busy) return false;
      setBusy(true);
      if (error instanceof HTMLElement) error.hidden = true;
      try {
        await work();
        return true;
      } catch (failure) {
        if (error instanceof HTMLElement) {
          error.textContent = failure instanceof Error ? failure.message : String(failure);
          error.hidden = false;
        }
        return false;
      } finally {
        setBusy(false);
      }
    },
  };
}
