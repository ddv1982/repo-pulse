// @ts-check

import { escape as e } from './format.js';
import { activityFilterLabel, canonicalActivityFilter } from '../activity-text.js';
import { required } from './dom.js';

/** @param {string} [value] @param {string[]} [options] @param {boolean} [loading] */
export function renderTypeFilter(value = '', options = [], loading = false) {
  value = canonicalActivityFilter(value);
  const choices = [...new Set(['', ...options, value])];
  return `<div class="menu type-menu"><button class="control" id="kind-toggle" type="button" aria-label="Activity type: ${e(activityFilterLabel(value))}" aria-haspopup="listbox" aria-disabled="${Boolean(loading)}" aria-expanded="false" aria-controls="kind-panel">${e(activityFilterLabel(value))} ▾</button><div class="menu-panel type-panel" id="kind-panel" role="listbox" aria-label="Activity type" hidden>${choices.map(key => `<button class="type-option" type="button" role="option" aria-selected="${value === key}" data-kind="${e(key)}" tabindex="-1"><span class="type-check" aria-hidden="true">${value === key ? '✓' : ''}</span>${e(activityFilterLabel(key))}</button>`).join('')}</div></div>`;
}

/** One controller per app; remounting never accumulates document listeners. @param {{ onChange: (kind: string | undefined) => void }} options */
export function createTypeFilter({ onChange }) {
  /** @type {HTMLElement | null | undefined} */
  let root;
  /** The mounted menu, or null when none is mounted. renderTypeFilter renders the toggle and panel together. */
  function menu() {
    const panel = root?.querySelector('#kind-panel');
    if (!root || !(panel instanceof HTMLElement)) return null;
    return { root, panel, toggle: required('#kind-toggle', HTMLElement, root) };
  }
  /** @param {HTMLElement} host */
  const options = host => [...host.querySelectorAll('[role="option"]')].filter(option => option instanceof HTMLElement);
  function close(restore = false) {
    const current = menu();
    if (!current) return;
    current.panel.hidden = true;
    current.toggle.setAttribute('aria-expanded', 'false');
    if (restore) current.toggle.focus({ preventScroll: true });
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
  document.addEventListener('pointerdown', outside);
  document.addEventListener('focusin', outside);
  return {
    /** @param {HTMLElement | null} element */
    mount(element) {
      root = element;
      if (!root) return;
      root.onclick = event => {
        const target = event.target;
        if (!(target instanceof Element)) return;
        if (target.closest('#kind-toggle')) {
          if (menu()?.panel.hidden) open();
          else close(true);
          return;
        }
        const option = target.closest('[data-kind]');
        if (option instanceof HTMLElement) {
          const value = option.dataset.kind;
          close();
          onChange(value);
          // onChange re-renders and remounts, so look the toggle up in the new menu, which may be absent.
          const toggle = root?.querySelector('#kind-toggle');
          if (toggle instanceof HTMLElement) toggle.focus({ preventScroll: true });
        }
      };
      root.onkeydown = event => {
        if (event.key === 'Tab') {
          close();
          return;
        }
        if (event.key === 'Escape') {
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
