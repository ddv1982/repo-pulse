// Inspect rendered fragments in Chromium without running scripts or loading resources from the markup.
import type { TestContext } from 'node:test';
import type { JSHandle, Page } from '@playwright/test';
import type { SafeHtml } from '../../src/ui/format.ts';
import { openPage } from './app.ts';

/** One blank page per test, from the shared browser, opened on the test's first parse and closed when it ends. */
const pages = new WeakMap<TestContext, Promise<Page>>();
function pageFor(t: TestContext) {
  let page = pages.get(t);
  if (!page) {
    page = openPage(t);
    pages.set(t, page);
  }
  return page;
}

/** A node read lazily, so a lookup that fails reports when the test reads it, not when it builds the query. */
class DomNode<T extends Document | Element> {
  readonly handle: () => Promise<JSHandle<T>>;
  constructor(load: () => Promise<JSHandle<T>>) {
    let handle: Promise<JSHandle<T>> | undefined;
    this.handle = () => (handle ??= load());
  }
}

/** A parsed document; the rendered markup is in its body. */
class DomDocument extends DomNode<Document> {}

export class DomElement extends DomNode<Element> {
  async getAttribute(name: string) {
    return (await this.handle()).evaluate((element, arg) => element.getAttribute(arg), name);
  }

  async hasAttribute(name: string) {
    return (await this.handle()).evaluate((element, arg) => element.hasAttribute(arg), name);
  }

  async classes() {
    return (await this.handle()).evaluate(element => [...element.classList]);
  }

  async hasClass(name: string) {
    return (await this.handle()).evaluate((element, arg) => element.classList.contains(arg), name);
  }

  async matches(selector: string) {
    return (await this.handle()).evaluate((element, arg) => element.matches(arg), selector);
  }

  async outerHtml() {
    return (await this.handle()).evaluate(element => element.outerHTML);
  }
}

/** Where a lookup or a text read starts. */
export type DomRoot = DomDocument | DomElement;

/** A document holding the rendered markup in its body, in this test's page. */
export function parse(t: TestContext, markup: SafeHtml | string) {
  const html = String(markup);
  return new DomDocument(async () =>
    (await pageFor(t)).evaluateHandle(source => new DOMParser().parseFromString(source, 'text/html'), html),
  );
}

/** Require exactly one match when the returned element is read. */
export function one(root: DomRoot, selector: string) {
  return new DomElement(async () => {
    const matches = await all(root, selector);
    const [match] = matches;
    if (!match || matches.length !== 1) throw new Error(`expected one ${selector}, found ${matches.length}`);
    return match.handle();
  });
}

export async function all(root: DomRoot, selector: string) {
  const node: JSHandle<Document | Element> = await root.handle();
  const handle = await node.evaluateHandle((parent, arg) => [...parent.querySelectorAll(arg)], selector);
  const elements = await handle.getProperties();
  await handle.dispose();
  return [...elements.values()].map(element => new DomElement(async () => element));
}

export function row(root: DomRoot, id: string) {
  return one(root, `li[data-event-id="${id}"]`);
}

/** The element's text content with whitespace collapsed and .sr nodes removed. Text hidden by attributes or CSS stays in. */
export async function text(root: DomRoot) {
  const node: JSHandle<Document | Element> = await root.handle();
  return node.evaluate(node => {
    if (node instanceof Element && node.closest('.sr')) return '';
    const copy = (node instanceof Document ? node.body : node).cloneNode(true);
    if (!(copy instanceof Element)) throw new Error('the copied node is not an element');
    for (const hidden of copy.querySelectorAll('.sr')) hidden.remove();
    return (copy.textContent ?? '').replace(/\s+/g, ' ').trim();
  });
}

/**
 * The DOM textContent, whitespace collapsed, including visually hidden .sr text. This is not the accessible name:
 * it ignores aria-label, aria-hidden and the other inputs to that computation.
 */
export async function textIncludingHidden(root: DomRoot) {
  const node: JSHandle<Document | Element> = await root.handle();
  return node.evaluate(node => ((node instanceof Document ? node.body : node).textContent ?? '').replace(/\s+/g, ' ').trim());
}
