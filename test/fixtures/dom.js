// Reads rendered markup the way a person or a screen reader meets it, so UI tests check text and elements rather
// than the exact HTML. See "Test what the page shows" in docs/MAINTAINING.md.
import { parseHTML } from 'linkedom';

/** A document holding the rendered markup in its body. @param {unknown} markup SafeHtml or a string */
export function parse(markup) {
  return parseHTML(`<!doctype html><html><body>${String(markup)}</body></html>`).document;
}

/** The one element that matches, or a failure naming the selector. @param {ParentNode} root @param {string} selector */
export function one(root, selector) {
  const found = root.querySelectorAll(selector);
  if (found.length !== 1) throw new Error(`expected one ${selector}, found ${found.length}`);
  return found[0];
}

/** Every element that matches. @param {ParentNode} root @param {string} selector */
export function all(root, selector) {
  return [...root.querySelectorAll(selector)];
}

/** An Activity row by its event ID. @param {ParentNode} root @param {string} id */
export function row(root, id) {
  return one(root, `[data-event-id="${id}"]`);
}

const squash = value => value.replace(/\s+/g, ' ').trim();

/** Visible text: whitespace collapsed, screen-reader-only `.sr` text left out. @param {Element | Document} element */
export function text(element) {
  const copy = /** @type {Element} */ ((element.body ?? element).cloneNode(true));
  for (const hidden of copy.querySelectorAll('.sr')) hidden.remove();
  return squash(copy.textContent ?? '');
}

/** Text a screen reader reads, `.sr` text included. @param {Element | Document} element */
export function srText(element) {
  return squash((element.body ?? element).textContent ?? '');
}
