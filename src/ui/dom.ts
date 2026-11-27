import { Idiomorph } from '../../web/vendor/idiomorph.esm.js';
import { SafeHtml } from './format.ts';

/** The handler for a control's `data-action` name; web.ts dispatches clicks to it. */
export type Action = (element: HTMLElement) => Promise<void> | void;

type ElementType<T extends Element> = new (...args: never[]) => T;

function ofType<T extends Element>(element: Element, Type: ElementType<T>, selector: string, role: string) {
  if (element instanceof Type) return element;
  throw new Error(`Repo Pulse: ${role} ${selector} is a <${element.localName}>, expected ${Type.name}`);
}

/**
 * Look up an element the UI cannot work without. A missing or mistyped element is a broken page, so fail with the
 * selector in the message instead of a later "cannot read properties of null". Without a Type it must be an HTMLElement.
 */
export function required(selector: string): HTMLElement;
export function required<T extends Element>(selector: string, Type: ElementType<T>, root?: ParentNode): T;
export function required(selector: string, Type: ElementType<Element> = HTMLElement, root: ParentNode = document) {
  const element = root.querySelector(selector);
  if (!element) throw new Error(`Repo Pulse: missing required element ${selector}`);
  return ofType(element, Type, selector, 'required element');
}

/** The result of an optional lookup (querySelector, closest) as the type the caller reads. Absent stays null; another type throws. */
export function checked<T extends Element>(element: Element | null, Type: ElementType<T>, selector: string): T | null {
  return element && ofType(element, Type, selector, 'element');
}

/** Every element under root that matches, each of which must be a Type. */
export function all<T extends Element>(selector: string, Type: ElementType<T>, root: ParentNode = document): T[] {
  return [...root.querySelectorAll(selector)].map(element => ofType(element, Type, selector, 'element'));
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
