import { isUnseen } from '../activity.js';

export function eventIds(element) {
  try {
    const ids = JSON.parse(element.dataset.eventIds);
    if (Array.isArray(ids)) return ids.filter(id => typeof id === 'string');
  } catch {
    /* A row may carry only its representative ID. */
  }
  return element.dataset.id ? [element.dataset.id] : element.dataset.eventId ? [element.dataset.eventId] : [];
}

function shownUnseenIds(page, events) {
  const unseen = new Set(events.filter(isUnseen).map(event => event.id));
  const ids = [...page.querySelectorAll('li[data-event-id]')]
    .filter(element => {
      for (let ancestor = element.parentElement; ancestor && ancestor !== page; ancestor = ancestor.parentElement) {
        if (ancestor.hidden || (ancestor.tagName === 'DETAILS' && !ancestor.open)) return false;
      }
      return true;
    })
    .flatMap(eventIds);
  return [...new Set(ids)].filter(id => unseen.has(id));
}

export function createSeenActions({ page, getEvents, request, reload, toast }) {
  let undoIds = [];

  async function acknowledge(ids, seen) {
    const completed = [];
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
    if (failure) throw new Error(`${completed.length} of ${ids.length} updates changed; remaining updates were kept. ${failure.message}`);
  }

  return {
    updateShownCount() {
      const button = page.querySelector('[data-action="ack-shown"]');
      if (!button) return;
      const count = shownUnseenIds(page, getEvents()).length;
      button.textContent = `Mark shown seen (${count})`;
      button.disabled = count === 0;
    },
    actions: {
      'ack-item': element => {
        const available = getEvents();
        const events = eventIds(element)
          .map(id => available.find(item => item.id === id))
          .filter(event => event && !event.imported);
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
