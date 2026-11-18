/**
 * Look up an element the UI cannot work without. A missing or mistyped element is a broken page, so fail with the
 * selector in the message instead of a later "cannot read properties of null".
 * @template {Element} [T=HTMLElement]
 * @param {string} selector
 * @param {new (...args: any[]) => T} [Type]
 * @param {ParentNode} [root]
 * @returns {T}
 */
export function required(selector, Type = /** @type {new () => T} */ (/** @type {unknown} */ (HTMLElement)), root = document) {
  const element = root.querySelector(selector);
  if (!(element instanceof Type)) throw new Error(`Repo Pulse: missing required element ${selector}`);
  return element;
}
