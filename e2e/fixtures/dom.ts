// Inspect rendered fragments in Chromium without running scripts or loading resources from the markup.
import { after, afterEach, before, beforeEach } from 'node:test';
import { chromium } from '@playwright/test';
import type { Browser, JSHandle, Page } from '@playwright/test';
import { browserPath } from './browser.ts';

let browser: Browser;
export let page: Page;
before(async () => {
  browser = await chromium.launch({ executablePath: await browserPath(), headless: true });
});
beforeEach(async () => {
  page = await browser.newPage();
});
afterEach(async () => {
  await page?.close();
});
after(async () => {
  await browser?.close();
});

type DomHandle = JSHandle<Document | Element>;

export class DomNode {
  readonly handle: () => Promise<DomHandle>;
  constructor(load: () => Promise<DomHandle>) {
    let handle: Promise<DomHandle> | undefined;
    this.handle = () => (handle ??= load());
  }

  async getAttribute(name: string) {
    return (await this.handle()).evaluate((node, arg) => (node as Element).getAttribute(arg), name);
  }

  async hasAttribute(name: string) {
    return (await this.handle()).evaluate((node, arg) => (node as Element).hasAttribute(arg), name);
  }

  async classes() {
    return (await this.handle()).evaluate(node => [...(node as Element).classList]);
  }

  async hasClass(name: string) {
    return (await this.handle()).evaluate((node, arg) => (node as Element).classList.contains(arg), name);
  }

  async matches(selector: string) {
    return (await this.handle()).evaluate((node, arg) => (node as Element).matches(arg), selector);
  }

  async outerHtml() {
    return (await this.handle()).evaluate(node => (node as Element).outerHTML);
  }
}

/** A document holding the rendered markup in its body. */
export function parse(markup: unknown) {
  const html = String(markup);
  return new DomNode(() => page.evaluateHandle(source => new DOMParser().parseFromString(source, 'text/html'), html));
}

/** Require exactly one match when the returned element is read. */
export function one(root: DomNode, selector: string) {
  return new DomNode(async () => {
    const matches = await all(root, selector);
    const [match] = matches;
    if (!match || matches.length !== 1) throw new Error(`expected one ${selector}, found ${matches.length}`);
    return match.handle();
  });
}

export async function all(root: DomNode, selector: string) {
  const handle = await (await root.handle()).evaluateHandle((node, arg) => [...node.querySelectorAll(arg)], selector);
  const elements = await handle.getProperties();
  await handle.dispose();
  return [...elements.values()].map(element => new DomNode(async () => element));
}

export function row(root: DomNode, id: string) {
  return one(root, `[data-event-id="${id}"]`);
}

export async function text(element: DomNode) {
  return (await element.handle()).evaluate(node => {
    if (node instanceof Element && node.closest('.sr')) return '';
    const copy = (node instanceof Document ? node.body : node).cloneNode(true) as Element;
    for (const hidden of copy.querySelectorAll('.sr')) hidden.remove();
    return (copy.textContent ?? '').replace(/\s+/g, ' ').trim();
  });
}

export async function srText(element: DomNode) {
  return (await element.handle()).evaluate(node =>
    ((node instanceof Document ? node.body : node).textContent ?? '').replace(/\s+/g, ' ').trim(),
  );
}
