// @ts-check

import { isUnseen } from '../activity.js';

/** @typedef {import('../activity.js').ActivityEvent} ActivityEvent */
/** @typedef {(element: HTMLElement) => Promise<void> | void} Action */

/** @param {HTMLElement} element @returns {string[]} */
export function eventIds(element) {
  try {
    const ids = JSON.parse(element.dataset.eventIds ?? '');
    if (Array.isArray(ids)) return ids.filter((/** @type {unknown} */ id) => typeof id === 'string');
  } catch {
    /* A row may carry only its representative ID. */
  }
  return element.dataset.id ? [element.dataset.id] : element.dataset.eventId ? [element.dataset.eventId] : [];
}

/** @param {HTMLElement} page @param {ActivityEvent[]} events */
function shownUnseenIds(page, events) {
  const unseen = new Set(events.filter(isUnseen).map(event => event.id));
  const ids = [...page.querySelectorAll('li[data-event-id]')]
    .filter(element => element instanceof HTMLLIElement)
    .filter(element => {
      for (let ancestor = element.parentElement; ancestor && ancestor !== page; ancestor = ancestor.parentElement) {
        if (ancestor.hidden || (ancestor instanceof HTMLDetailsElement && !ancestor.open)) return false;
      }
      return true;
    })
    .flatMap(eventIds);
  return [...new Set(ids)].filter(id => unseen.has(id));
}

/**
 * @param {{
 *   page: HTMLElement,
 *   getEvents: () => ActivityEvent[],
 *   request: typeof import('../api.js').request,
 *   reload: () => Promise<unknown>,
 *   toast: (message: string, options?: { undo?: boolean }) => void,
 * }} options
 */
export function createSeenActions({ page, getEvents, request, reload, toast }) {
  /** @type {string[]} */
  let undoIds = [];

  /** @param {string[]} ids @param {boolean} seen */
  async function acknowledge(ids, seen) {
    /** @type {string[]} */
    const completed = [];
    /** @type {unknown} */
    let failure;
    for (let offset = 0; offset < ids.length; offset += 250) {
      const batch = ids.slice(offset, offset + 250);
      try {
        await request('/api/ack', { method: 'POST', body: { ids: batch, seen } });
        completed.push(...batch);
      } catch (error) {
        failure = error;
        break;
      }
    }
    if (seen && completed.length) undoIds = completed;
    await reload();
    if (completed.length)
      toast(`${completed.length} update${completed.length === 1 ? '' : 's'} marked ${seen ? 'seen' : 'unseen'}.`, { undo: seen });
    if (failure)
      throw new Error(
        `${completed.length} of ${ids.length} updates changed; remaining updates were kept. ${failure instanceof Error ? failure.message : String(failure)}`,
      );
  }

  return {
    updateShownCount() {
      const button = page.querySelector('[data-action="ack-shown"]');
      if (!(button instanceof HTMLButtonElement)) return;
      const count = shownUnseenIds(page, getEvents()).length;
      button.textContent = `Mark shown seen (${count})`;
      button.disabled = count === 0;
    },
    /** @type {Record<string, Action>} */
    actions: {
      'ack-item': element => {
        const available = getEvents();
        const events = eventIds(element)
          .map(id => available.find(item => item.id === id))
          .filter(/** @returns {event is ActivityEvent} */ event => Boolean(event && !event.imported));
        const unseen = events.filter(isUnseen);
        const ids = (unseen.length ? unseen : events).map(event => event.id);
        if (ids.length) return acknowledge([...new Set(ids)], unseen.length > 0);
      },
      'ack-shown': () => {
        const ids = shownUnseenIds(page, getEvents());
        if (!ids.length) return;
        return acknowledge(ids, true);
      },
      'undo-ack': async () => {
        const ids = undoIds;
        undoIds = [];
        await acknowledge(ids, false);
      },
    },
  };
}
