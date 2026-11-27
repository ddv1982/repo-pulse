import { required } from './dom.ts';
import type { MenuManager } from './menus.ts';

/**
 * A toolbar menu. The menu manager keeps the open menu in `openMenu` (its panel ID), so a render draws it open and
 * incoming activity can render while a person is choosing. Each item names its own action, which the dispatcher runs.
 *
 * When a person chooses `one` item, an option or a command, choosing closes the menu and returns focus to its toggle
 * before the item's action runs, and Tab closes it. When they choose `many`, the items are checkboxes: a tick keeps
 * the menu open, Tab moves through its controls, and the menu closes once focus leaves it.
 */
export function createToolbarMenu({
  menus,
  toggleId,
  panelId,
  itemSelector,
  choosing,
}: {
  menus: MenuManager;
  toggleId: string;
  panelId: string;
  itemSelector: string;
  choosing: 'one' | 'many';
}) {
  let root: HTMLElement | null | undefined;
  function menu() {
    const panel = root?.querySelector(`#${panelId}`);
    if (!root || !(panel instanceof HTMLElement)) return null;
    return { root, panel, toggle: required(`#${toggleId}`, HTMLElement, root) };
  }
  const options = (host: HTMLElement) => [...host.querySelectorAll(itemSelector)].filter(option => option instanceof HTMLElement);
  function close(restore = false) {
    const current = menu();
    menus.closed(panelId);
    if (!current || current.panel.hidden) return;
    current.panel.hidden = true;
    current.toggle.setAttribute('aria-expanded', 'false');
    if (restore) current.toggle.focus({ preventScroll: true });
  }
  function focusOption(panel: HTMLElement, option: HTMLElement | undefined) {
    if (!option) return;
    option.focus({ preventScroll: true });
    // A checkbox sits in its label row, and the rows' parent is the list that scrolls.
    const item = option.closest('label') ?? option;
    const list = item.parentElement ?? panel;
    const bounds = list.getBoundingClientRect(),
      row = item.getBoundingClientRect();
    if (row.bottom > bounds.bottom) list.scrollTop += row.bottom - bounds.bottom;
    else if (row.top < bounds.top) list.scrollTop -= bounds.top - row.top;
  }
  function open() {
    const current = menu();
    if (!current || current.toggle.getAttribute('aria-disabled') === 'true') return;
    // One menu is open at a time; another panel, such as the repository scope, closes as this one opens.
    menus.open(panelId);
    current.panel.hidden = false;
    current.toggle.setAttribute('aria-expanded', 'true');
    const selected = current.root.querySelector('[aria-selected="true"]');
    focusOption(current.panel, selected instanceof HTMLElement ? selected : options(current.root)[0]);
    current.panel.scrollIntoView({ block: 'nearest' });
  }
  menus.register(panelId, { root: () => root, close: () => close(), outside: { pointer: 'click', focus: 'keyboard' } });
  return {
    get expanded() {
      return menu()?.panel.hidden === false;
    },
    mount(element: HTMLElement | null) {
      root = element;
      // A menu that left the page, such as on another route, is not open when it comes back.
      if (!root) menus.closed(panelId);
      if (!root) return;
      root.onclick = event => {
        const target = event.target;
        if (!(target instanceof Element)) return;
        if (target.closest(`#${toggleId}`)) {
          if (menu()?.panel.hidden) open();
          else close(true);
          return;
        }
        if (choosing === 'one' && target.closest(itemSelector)) close(true);
      };
      root.onkeydown = event => {
        if (event.key === 'Tab') {
          if (choosing === 'one') close();
          return;
        }
        if (event.key === 'Escape' && !menu()?.panel.hidden) {
          event.preventDefault();
          close(true);
          return;
        }
        if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        const current = menu();
        if (!current) return;
        if (current.panel.hidden) {
          open();
          return;
        }
        const all = options(current.root),
          index = all.findIndex(option => option === document.activeElement);
        const next =
          event.key === 'Home'
            ? 0
            : event.key === 'End' || (event.key === 'ArrowUp' && index === -1)
              ? all.length - 1
              : (index + (event.key === 'ArrowDown' ? 1 : -1) + all.length) % all.length;
        focusOption(current.panel, all[next]);
      };
    },
  };
}
