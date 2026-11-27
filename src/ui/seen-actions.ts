import type { Action } from './dom.ts';

function readIds(encoded: string | undefined): string[] | undefined {
  try {
    const ids = JSON.parse(encoded ?? '');
    if (Array.isArray(ids)) return ids.filter((id: unknown) => typeof id === 'string');
  } catch {
    /* A row may carry only its representative ID. */
  }
}

export function eventIds(element: HTMLElement) {
  return (
    readIds(element.dataset.eventIds) ??
    (element.dataset.id ? [element.dataset.id] : element.dataset.eventId ? [element.dataset.eventId] : [])
  );
}

/** The state a Seen control sets. Anything but "true" or "false" is broken markup, so nothing is sent. */
function markSeen(element: HTMLElement) {
  const value = element.dataset.markSeen;
  if (value === 'true' || value === 'false') return value === 'true';
  throw new Error(`Repo Pulse: a Seen control has data-mark-seen ${JSON.stringify(value ?? null)}, expected "true" or "false"`);
}

function shownUnseenIds(page: HTMLElement) {
  const ids = [...page.querySelectorAll('li[data-event-id]')]
    .filter(element => element instanceof HTMLLIElement)
    .filter(element => {
      for (let ancestor = element.parentElement; ancestor && ancestor !== page; ancestor = ancestor.parentElement) {
        if (ancestor.hidden || (ancestor instanceof HTMLDetailsElement && !ancestor.open)) return false;
      }
      return true;
    })
    .flatMap(element => readIds(element.dataset.unseenIds) ?? []);
  return [...new Set(ids)];
}

export function createSeenActions({
  page,
  request,
  reload,
  toast,
}: {
  page: HTMLElement;
  request: typeof import('../api.ts').request;
  reload: () => Promise<unknown>;
  toast: (message: string, options?: { undo?: boolean }) => void;
}) {
  let undoIds: string[] = [];

  async function acknowledge(ids: string[], seen: boolean, { undo = false }: { undo?: boolean } = {}) {
    const completed: string[] = [];
    let failure: unknown;
    let processed = 0;
    for (let offset = 0; offset < ids.length; offset += 250) {
      const batch = ids.slice(offset, offset + 250);
      try {
        const { changedIds } = await request('/api/ack', { method: 'POST', body: { ids: batch, seen } });
        completed.push(...changedIds);
        processed += batch.length;
      } catch (error) {
        failure = error;
        break;
      }
    }
    const errors = [];
    if (failure) {
      // The browser request rejects with an Error. Keep primitive rejection text from injected callers.
      // oxlint-disable-next-line typescript/no-base-to-string
      const message = failure instanceof Error ? failure.message : String(failure);
      errors.push(`Stopped after processing ${processed} of ${ids.length} updates. ${message}`);
    }
    try {
      await reload();
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }

    if (undo) undoIds = ids.slice(processed);
    if (seen && completed.length) undoIds = completed;
    const retryUndo = undo && undoIds.length > 0;
    const feedback = completed.length
      ? `${completed.length} update${completed.length === 1 ? '' : 's'} marked ${seen ? 'seen' : 'unseen'}.`
      : '';
    if (feedback || retryUndo) {
      const retry = retryUndo ? `Retry Undo for ${undoIds.length} remaining update${undoIds.length === 1 ? '' : 's'}.` : '';
      toast(`${feedback} ${retry}`.trim(), { undo: (seen && completed.length > 0) || retryUndo });
    }
    if (errors.length) throw new Error(errors.join(' '));
  }

  return {
    acknowledge,
    /** Forget the updates Undo would restore, for when they no longer exist. */
    forgetUndo() {
      undoIds = [];
    },
    shownUnseenIds: () => shownUnseenIds(page),
    actions: {
      'ack-item': element => {
        const seen = markSeen(element);
        const ids = eventIds(element);
        if (ids.length) return acknowledge(ids, seen);
      },
      'undo-ack': async () => {
        if (undoIds.length) await acknowledge(undoIds, false, { undo: true });
      },
    } satisfies Record<string, Action>,
  };
}
