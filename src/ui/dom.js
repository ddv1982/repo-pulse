import { Idiomorph } from '../../web/vendor/idiomorph.esm.js';
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
 * The markup is parsed into an inert template and merged into the live children (idiomorph), so nodes that still match
 * keep their identity, focus, caret, text selection and listeners instead of being replaced on every render.
 * @param {Element} element
 * @param {SafeHtml} markup
 */
export function setHtml(element, markup) {
  const template = element.ownerDocument.createElement('template');
  template.innerHTML = SafeHtml.unwrap(markup);
  // A focused field's value is not protected: every input rendered here writes what is typed into state on each input
  // event, so the markup already carries it, and a value that differs is one the app chose, such as a cleared picker.
  // An element marked data-owned is filled by its own component (the repository picker), so an outer render leaves its
  // children alone instead of emptying them until the component renders again.
  Idiomorph.morph(element, template.content, {
    morphStyle: 'innerHTML',
    callbacks: { beforeNodeMorphed: node => !(node !== element && node instanceof Element && node.hasAttribute('data-owned')) },
  });
}
