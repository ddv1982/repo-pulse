// @ts-check

import { escape as e } from './format.js';
import { activityFilterLabel, canonicalActivityFilter } from '../activity-text.js';

/** @param {string} [value] @param {string[]} [options] @param {boolean} [loading] */
export function renderTypeFilter(value = '', options = [], loading = false) {
  value = canonicalActivityFilter(value);
  const choices = [...new Set(['', ...options, value])];
  return `<div class="menu type-menu"><button class="control" id="kind-toggle" type="button" aria-label="Activity type: ${e(activityFilterLabel(value))}" aria-haspopup="listbox" aria-disabled="${Boolean(loading)}" aria-expanded="false" aria-controls="kind-panel">${e(activityFilterLabel(value))} ▾</button><div class="menu-panel type-panel" id="kind-panel" role="listbox" aria-label="Activity type" hidden>${choices.map(key => `<button class="type-option" type="button" role="option" aria-selected="${value === key}" data-kind="${e(key)}" tabindex="-1"><span class="type-check" aria-hidden="true">${value === key ? '✓' : ''}</span>${e(activityFilterLabel(key))}</button>`).join('')}</div></div>`;
}

// The mounted root holds renderTypeFilter markup: the toggle, the panel and its option buttons are
// HTML elements that are present together. The casts below record that; the code relied on it already.

/** One controller per app; remounting never accumulates document listeners. @param {{ onChange: (kind: string | undefined) => void }} options */
export function createTypeFilter({ onChange }) {
  /** @type {HTMLElement | null | undefined} */
  let root;
  const panel = () => /** @type {HTMLElement} */ (root?.querySelector('#kind-panel'));
  const toggle = () => /** @type {HTMLElement} */ (root?.querySelector('#kind-toggle'));
  /** @param {string} selector */
  const find = selector => /** @type {HTMLElement | null} */ (/** @type {HTMLElement} */ (root).querySelector(selector));
  const options = () => /** @type {HTMLElement[]} */ ([.../** @type {HTMLElement} */ (root).querySelectorAll('[role="option"]')]);
  function close(restore = false) {
    if (!panel()) return;
    panel().hidden = true;
    toggle().setAttribute('aria-expanded', 'false');
    if (restore) toggle().focus({ preventScroll: true });
  }
  /** @param {HTMLElement | null | undefined} option */
  function focusOption(option) {
    if (!option) return;
    option.focus({ preventScroll: true });
    const bounds = panel().getBoundingClientRect(),
      row = option.getBoundingClientRect();
    if (row.bottom > bounds.bottom) panel().scrollTop += row.bottom - bounds.bottom;
    else if (row.top < bounds.top) panel().scrollTop -= bounds.top - row.top;
  }
  function open() {
    if (!panel() || toggle().getAttribute('aria-disabled') === 'true') return;
    panel().hidden = false;
    toggle().setAttribute('aria-expanded', 'true');
    focusOption(find('[aria-selected="true"]') || options()[0]);
  }
  /** @param {Event} event */
  const outside = event => {
    const target = /** @type {Node} */ (event.target);
    if (target.isConnected && root?.isConnected && !root.contains(target)) close();
  };
  document.addEventListener('pointerdown', outside);
  document.addEventListener('focusin', outside);
  return {
    /** @param {HTMLElement | null} element */
    mount(element) {
      root = element;
      if (!root) return;
      root.onclick = event => {
        const target = /** @type {Element} */ (event.target);
        if (target.closest('#kind-toggle')) {
          if (panel().hidden) open();
          else close(true);
          return;
        }
        const option = /** @type {HTMLElement | null} */ (target.closest('[data-kind]'));
        if (option) {
          const value = option.dataset.kind;
          close();
          onChange(value);
          toggle()?.focus({ preventScroll: true });
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
        if (panel().hidden) {
          open();
          return;
        }
        const all = options(),
          index = all.indexOf(/** @type {HTMLElement} */ (document.activeElement));
        const next =
          event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? all.length - 1
              : (index + (event.key === 'ArrowDown' ? 1 : -1) + all.length) % all.length;
        focusOption(all[next]);
      };
    },
  };
}
