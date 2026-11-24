import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startApp } from '../../server.ts';
import { page } from '../fixtures/dom.ts';

test('setHtml updates a real DOM node in place and refuses unbranded HTML', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'repo-pulse-dom-'));
  let app: Awaited<ReturnType<typeof startApp>> | undefined;
  t.after(async () => {
    await app?.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  app = await startApp({ demo: true, port: 0, dataDir });
  await page.goto(app.launchUrl);
  const result = await page.evaluate(async () => {
    const domPath = '/src/ui/dom.js';
    const formatPath = '/src/ui/format.js';
    const { setHtml } = (await import(domPath)) as typeof import('../../src/ui/dom.ts');
    const { SafeHtml, html } = (await import(formatPath)) as typeof import('../../src/ui/format.ts');
    const element = document.createElement('main');
    const node = document.createElement('div');
    node.dataset.flag = 'true';
    node.textContent = 'old';
    element.append(node);
    const nested = html`<b>${'<img src=x onerror=alert(1)>'}</b>`;
    setHtml(element, html`<div data-flag="${false}" data-on="${true}">${[nested, null, undefined, ' & "quotes"']}</div>`);
    const lookalike: InstanceType<typeof SafeHtml> = Object.create(SafeHtml.prototype, { toString: { value: () => '<b>spoof</b>' } });
    const rejected = ['<b>plain</b>', { toString: () => '<b>spoof</b>' }, lookalike].map(value => {
      try {
        // @ts-expect-error Untrusted markup is rejected by the type and at runtime.
        setHtml(element, value);
        return false;
      } catch (error) {
        return error instanceof TypeError;
      }
    });
    return {
      keptNode: element.firstElementChild === node,
      attributes: Object.fromEntries(Object.entries(node.dataset)),
      text: node.textContent,
      hasImage: Boolean(element.querySelector('img')),
      rejected,
    };
  });
  assert.deepEqual(result, {
    keptNode: true,
    attributes: { flag: 'false', on: 'true' },
    text: '<img src=x onerror=alert(1)> & "quotes"',
    hasImage: false,
    rejected: [true, true, true],
  });
});
