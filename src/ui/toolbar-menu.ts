import { required } from './dom.ts';

/**
 * The open menu is kept in `state.openMenu` (its panel ID), so a render draws it open and incoming activity can render
 * while a person is choosing.
 */
export function createToolbarMenu({
  toggleId,
  panelId,
  itemSelector,
  state,
  onSelect,
}: {
  toggleId: string;
  panelId: string;
  itemSelector: string;
  state: { openMenu?: string };
  onSelect: (item: HTMLElement) => void;
}) {
  let root: HTMLElement | null | undefined;
  let pointerDown = false;
  function menu() {
    const panel = root?.querySelector(`#${panelId}`);
    if (!root || !(panel instanceof HTMLElement)) return null;
    return { root, panel, toggle: required(`#${toggleId}`, HTMLElement, root) };
  }
  const options = (host: HTMLElement) => [...host.querySelectorAll(itemSelector)].filter(option => option instanceof HTMLElement);
  function close(restore = false) {
    const current = menu();
    if (state.openMenu === panelId) state.openMenu = '';
    if (!current || current.panel.hidden) return;
    current.panel.hidden = true;
    current.toggle.setAttribute('aria-expanded', 'false');
    if (restore) current.toggle.focus({ preventScroll: true });
  }
  function focusOption(panel: HTMLElement, option: HTMLElement | undefined) {
    if (!option) return;
    option.focus({ preventScroll: true });
    const bounds = panel.getBoundingClientRect(),
      row = option.getBoundingClientRect();
    if (row.bottom > bounds.bottom) panel.scrollTop += row.bottom - bounds.bottom;
    else if (row.top < bounds.top) panel.scrollTop -= bounds.top - row.top;
  }
  function open() {
    const current = menu();
    if (!current || current.toggle.getAttribute('aria-disabled') === 'true') return;
    // One menu is open at a time; another panel, such as the repository scope, closes as this one opens.
    const previous = state.openMenu && state.openMenu !== panelId ? document.getElementById(state.openMenu) : null;
    if (previous) {
      previous.hidden = true;
      document.querySelector(`[aria-controls="${previous.id}"]`)?.setAttribute('aria-expanded', 'false');
    }
    state.openMenu = panelId;
    current.panel.hidden = false;
    current.toggle.setAttribute('aria-expanded', 'true');
    const selected = current.root.querySelector('[aria-selected="true"]');
    focusOption(current.panel, selected instanceof HTMLElement ? selected : options(current.root)[0]);
  }
  const outside = (event: Event) => {
    const target = event.target;
    if (target instanceof Node && target.isConnected && root?.isConnected && !root.contains(target)) close();
  };
  document.addEventListener(
    'pointerdown',
    () => {
      pointerDown = true;
    },
    true,
  );
  const releasePointer = () => {
    pointerDown = false;
  };
  document.addEventListener('pointerup', releasePointer, true);
  document.addEventListener('pointercancel', releasePointer, true);
  document.addEventListener('click', outside);
  document.addEventListener('focusin', event => {
    if (!pointerDown) outside(event);
  });
  return {
    get expanded() {
      return menu()?.panel.hidden === false;
    },
    mount(element: HTMLElement | null) {
      root = element;
      // A menu that left the page, such as on another route, is not open when it comes back.
      if (!root && state.openMenu === panelId) state.openMenu = '';
      if (!root) return;
      root.onclick = event => {
        const target = event.target;
        if (!(target instanceof Element)) return;
        if (target.closest(`#${toggleId}`)) {
          if (menu()?.panel.hidden) open();
          else close(true);
          return;
        }
        const option = target.closest(itemSelector);
        if (option instanceof HTMLElement) {
          close(true);
          onSelect(option);
        }
      };
      root.onkeydown = event => {
        if (event.key === 'Tab') {
          close();
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
            : event.key === 'End'
              ? all.length - 1
              : (index + (event.key === 'ArrowDown' ? 1 : -1) + all.length) % all.length;
        focusOption(current.panel, all[next]);
      };
    },
  };
}
