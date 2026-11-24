import { Idiomorph } from '../../web/vendor/idiomorph.esm.js';
import { SafeHtml } from './format.ts';

/**
 * Look up an element the UI cannot work without. A missing or mistyped element is a broken page, so fail with the
 * selector in the message instead of a later "cannot read properties of null". Without a Type it must be an HTMLElement.
 */
export function required(selector: string): HTMLElement;
export function required<T extends Element>(selector: string, Type: new (...args: never[]) => T, root?: ParentNode): T;
export function required<T extends Element>(
  selector: string,
  Type?: new (...args: never[]) => T,
  root: ParentNode = document,
): T | HTMLElement {
  const element = root.querySelector(selector);
  if (Type && element instanceof Type) return element;
  if (!Type && element instanceof HTMLElement) return element;
  throw new Error(`Repo Pulse: missing required element ${selector}`);
}

/**
 * Writes trusted SafeHtml to an element. This is the single innerHTML sink in browser code.
 * The markup is parsed into an inert template and merged into the live children (idiomorph), so nodes that still match
 * keep their identity, focus, caret, text selection and listeners instead of being replaced on every render.
 */
export function setHtml(element: Element, markup: SafeHtml) {
  const template = element.ownerDocument.createElement('template');
  template.innerHTML = SafeHtml.unwrap(markup);
  // A focused field's value is not protected: every input rendered here writes what is typed into state on each input
  // event, so the markup already carries it, and a value that differs is one the app chose, such as a cleared picker.
  // An element marked data-owned is filled by its own component (the repository picker), so an outer render leaves its
  // children alone instead of emptying them until the component renders again.
  // morph returns a Promise only when config.head.block is set, which this call leaves unset, so it runs synchronously and
  // throws to the caller.
  void Idiomorph.morph(element, template.content, {
    morphStyle: 'innerHTML',
    callbacks: { beforeNodeMorphed: node => !(node !== element && node instanceof Element && node.hasAttribute('data-owned')) },
  });
}
