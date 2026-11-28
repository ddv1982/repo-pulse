import { emptyHtml, html } from './format.ts';
import type { Actions } from './actions.ts';

/** The open state of each disclosure on the page, by its stable `data-group` ID. */
export type Groups = ReadonlyMap<string, boolean>;

/** The Activity groups, by stable ID. */
export const ACTIVITY_GROUP = 'activity';
export const IMPORTED_GROUP = 'imported-history';

/** Results contexts stored before the groups had stable IDs name them by their English titles. */
const legacyIds: Record<string, string> = { Activity: ACTIVITY_GROUP, 'New updates': ACTIVITY_GROUP, 'Imported history': IMPORTED_GROUP };
const IMPORTED_KEY = 'repo-pulse:imported-history-open';

/**
 * The `data-group` and `open` attributes of a disclosure: open as the reader left it, or as `fallback` when it is new
 * on the page.
 */
export function disclosure(groups: Groups, id: string, fallback = false) {
  return html`data-group="${id}" ${(groups.get(id) ?? fallback) ? html`open` : emptyHtml}`;
}

/**
 * Which disclosures are open. A disclosure keeps the state it first rendered with, or the one the reader gave it, while
 * it stays on the page, and starts again from its default when it comes back. Imported history is the exception: the
 * reader's choice there lasts for the browser session.
 */
export function createGroupState() {
  const open = new Map<string, boolean>();
  let importedChoice = false;
  try {
    const saved = sessionStorage.getItem(IMPORTED_KEY);
    if (saved === 'open' || saved === 'closed') {
      open.set(IMPORTED_GROUP, saved === 'open');
      importedChoice = true;
    }
  } catch {
    // The current page can still remember the choice when storage is unavailable.
  }
  /** The reader opened or closed a disclosure. */
  function toggle(id: string, value: boolean) {
    open.set(id, value);
    if (id !== IMPORTED_GROUP) return;
    importedChoice = true;
    try {
      sessionStorage.setItem(IMPORTED_KEY, value ? 'open' : 'closed');
    } catch {
      // Keep the in-memory choice for subsequent renders.
    }
  }
  return {
    open: open as Groups,
    toggle,
    /** After a render: keep the state each shown disclosure rendered with, and forget those that left the page. */
    settle(shown: Iterable<[string, boolean]>) {
      const present = new Map(shown);
      for (const [id, value] of present) if (!open.has(id)) open.set(id, value);
      for (const id of [...open.keys()]) if (!present.has(id) && !(id === IMPORTED_GROUP && importedChoice)) open.delete(id);
    },
    /** The state to put back when the reader returns to Activity, stored with the results context. */
    snapshot(this: void): [string, boolean][] {
      return [...open];
    },
    actions: {
      'toggle-group': element => {
        // A disclosure opens and closes from its state: the summary records the reader's choice, and the element shows it.
        // A control outside the disclosure, such as an Activity row's CI count, names it with aria-controls.
        const controlled = element.getAttribute('aria-controls');
        const group = controlled ? document.getElementById(controlled) : element.parentElement;
        if (!(group instanceof HTMLDetailsElement) || group.dataset.group === undefined) return;
        toggle(group.dataset.group, !group.open);
        group.open = !group.open;
        if (controlled) element.setAttribute('aria-expanded', String(group.open));
      },
    } satisfies Actions<'toggle-group'>,
    /**
     * Follows a disclosure the browser opened or closed by itself, as find in page does, so the stored state and a
     * control that names it with aria-controls agree with what the reader sees. Listen for `toggle` in the capture phase.
     */
    follow(event: Event) {
      const group = event.target;
      if (!(group instanceof HTMLDetailsElement) || group.dataset.group === undefined) return;
      // A disclosure a render just put on the page has no stored state yet; settle records it, and a render is no choice.
      const known = open.get(group.dataset.group);
      if (known !== undefined && known !== group.open) toggle(group.dataset.group, group.open);
      if (group.id)
        for (const control of document.querySelectorAll(`[aria-controls="${CSS.escape(group.id)}"]`))
          control.setAttribute('aria-expanded', String(group.open));
    },
    /** Puts back a stored snapshot. The reader's session choice for Imported history wins over it. */
    restore(entries: [string, boolean][]) {
      for (const [stored, value] of entries) {
        const id = legacyIds[stored] ?? stored;
        if (!(id === IMPORTED_GROUP && importedChoice)) open.set(id, value);
      }
    },
  };
}

export type GroupState = ReturnType<typeof createGroupState>;
