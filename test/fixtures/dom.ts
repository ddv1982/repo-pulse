// Reads rendered markup the way a person or a screen reader meets it, so UI tests check text and elements rather
// than the exact HTML. See "Test what the page shows" in docs/MAINTAINING.md.
import { parseHTML } from 'linkedom';

/** A document holding the rendered markup in its body. @param markup SafeHtml or a string */
export function parse(markup: unknown) {
  return parseHTML(`<!doctype html><html><body>${String(markup)}</body></html>`).document;
}

/** The one element that matches, or a failure naming the selector. */
export function one(root: ParentNode, selector: string) {
  const found = root.querySelectorAll(selector);
  const [match] = found;
  if (!match || found.length !== 1) throw new Error(`expected one ${selector}, found ${found.length}`);
  return match;
}

/** Every element that matches. */
export function all(root: ParentNode, selector: string) {
  return [...root.querySelectorAll(selector)];
}

/** An Activity row by its event ID. */
export function row(root: ParentNode, id: string) {
  return one(root, `[data-event-id="${id}"]`);
}

const squash = (value: string) => value.replace(/\s+/g, ' ').trim();

/** The body of a document, or the element itself. */
const bodyOf = (element: Element | Document) => ('body' in element ? element.body : element);

/** Visible text: whitespace collapsed, screen-reader-only `.sr` text left out. */
export function text(element: Element | Document) {
  if ('closest' in element && element.closest('.sr')) return '';
  const copy = bodyOf(element).cloneNode(true) as Element;
  for (const hidden of copy.querySelectorAll('.sr')) hidden.remove();
  return squash(copy.textContent ?? '');
}

/** Text a screen reader reads, `.sr` text included. */
export function srText(element: Element | Document) {
  return squash(bodyOf(element).textContent ?? '');
}
