// @ts-check

import { required } from './dom.js';

/**
 * @param {{ toggleId: string, panelId: string, itemSelector: string, onSelect: (item: HTMLElement) => void, onClose?: () => void }} config
 */
export function createToolbarMenu({ toggleId, panelId, itemSelector, onSelect, onClose }) {
  /** @type {HTMLElement | null | undefined} */
  let root;
  let pointerDown = false;
  function menu() {
    const panel = root?.querySelector(`#${panelId}`);
    if (!root || !(panel instanceof HTMLElement)) return null;
    return { root, panel, toggle: required(`#${toggleId}`, HTMLElement, root) };
  }
  /** @param {HTMLElement} host */
  const options = host => [...host.querySelectorAll(itemSelector)].filter(option => option instanceof HTMLElement);
  function close(restore = false) {
    const current = menu();
    if (!current || current.panel.hidden) return;
    current.panel.hidden = true;
    current.toggle.setAttribute('aria-expanded', 'false');
    if (restore) current.toggle.focus({ preventScroll: true });
    onClose?.();
  }
  /** @param {HTMLElement} panel @param {HTMLElement | undefined} option */
  function focusOption(panel, option) {
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
    current.panel.hidden = false;
    current.toggle.setAttribute('aria-expanded', 'true');
    const selected = current.root.querySelector('[aria-selected="true"]');
    focusOption(current.panel, selected instanceof HTMLElement ? selected : options(current.root)[0]);
  }
  /** @param {Event} event */
  const outside = event => {
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
    /** @param {HTMLElement | null} element */
    mount(element) {
      root = element;
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
