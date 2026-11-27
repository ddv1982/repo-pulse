import { action } from './actions.ts';
import { required, setHtml } from './dom.ts';
import { emptyHtml, html } from './format.ts';

/** The page's error banner and its two toasts: messages, and the Undo offer for seen changes. */
export function createFeedback() {
  const notice = required('#notice');
  const toastElement = required('#toast');
  const undoElement = required('#undo-toast');
  let toastTimer: ReturnType<typeof setTimeout> | undefined;
  let undoTimer: ReturnType<typeof setTimeout> | undefined;

  function showError(message: string, network = false) {
    setHtml(
      notice,
      html`<div class="banner crit" role="alert"><span class="ic">!</span><div><strong>Something needs attention</strong><span class="error-message">${message}</span> <button class="ghost sm" type="button" ${action('dismiss-error')}>Dismiss</button></div></div>`,
    );
    if (network) notice.dataset.networkError = 'true';
    else delete notice.dataset.networkError;
  }

  function clearNotice() {
    setHtml(notice, emptyHtml);
    delete notice.dataset.networkError;
  }

  function toast(message: string) {
    clearTimeout(toastTimer);
    setHtml(toastElement, html`${message}`);
    toastElement.hidden = false;
    toastTimer = setTimeout(() => {
      toastElement.hidden = true;
    }, 6000);
  }

  function hideUndo() {
    clearTimeout(undoTimer);
    undoElement.hidden = true;
  }

  return {
    showError,
    clearNotice,
    /** Clears the banner once a refresh works again, if a failed refresh put it there. */
    clearNetworkError(this: void) {
      if (notice.dataset.networkError) clearNotice();
    },
    toast,
    hideUndo,
    /**
     * Seen feedback. An Undo offer has its own slot and timer below the message toast, so other messages show above it
     * and never remove or move it; the next seen result replaces it.
     */
    seenToast(this: void, message: string, { undo = false } = {}) {
      hideUndo();
      if (!undo) return toast(message);
      setHtml(undoElement, html`${message}<button type="button" ${action('undo-ack')}>Undo</button>`);
      undoElement.hidden = false;
      undoTimer = setTimeout(() => {
        undoElement.hidden = true;
      }, 20000);
    },
    reportError(this: void, error: unknown) {
      showError(error instanceof Error ? error.message : String(error));
    },
  };
}

export type Feedback = ReturnType<typeof createFeedback>;
