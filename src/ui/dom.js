import { SafeHtml } from './format.js';

/**
 * Look up an element the UI cannot work without. A missing or mistyped element is a broken page, so fail with the
 * selector in the message instead of a later "cannot read properties of null".
 * The default Type is cast because HTMLElement fits T only when T keeps its default, which JSDoc cannot express.
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

/**
 * Writes trusted SafeHtml to an element. This is the single innerHTML sink in browser code.
 * @param {Element} element
 * @param {SafeHtml} markup
 */
export function setHtml(element, markup) {
  element.innerHTML = SafeHtml.unwrap(markup);
}
