import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { openPage, startTestApp } from '../fixtures/app.ts';

/** The app page with nested .item elements in its body, for lookups through the built dom module. */
async function fixturePage(t: TestContext) {
  const app = await startTestApp(t);
  const page = await openPage(t);
  await page.goto(app.runtime.launchUrl);
  await page.evaluate(() => {
    const fixture = document.createElement('section');
    fixture.innerHTML =
      '<p class="item" id="outside">outside</p><div id="root"><span class="item">inside</span><b class="item">bold</b></div>';
    document.body.append(fixture);
  });
  return page;
}

test('required names a missing element and a wrong element type apart, and looks only inside its root', async t => {
  const page = await fixturePage(t);
  const result = await page.evaluate(async () => {
    const domPath = '/src/ui/dom.js';
    const { required } = (await import(domPath)) as typeof import('../../src/ui/dom.ts');
    const failure = (lookup: () => unknown) => {
      try {
        lookup();
        return 'no error';
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    };
    const root = required('#root', HTMLDivElement);
    return {
      missing: failure(() => required('#nowhere')),
      wrongType: failure(() => required('#root', HTMLInputElement)),
      scoped: required('.item', HTMLElement, root).textContent,
      outsideRoot: failure(() => required('#outside', HTMLElement, root)),
    };
  });
  assert.deepEqual(result, {
    missing: 'Repo Pulse: missing required element #nowhere',
    wrongType: 'Repo Pulse: required element #root is a <div>, expected HTMLInputElement',
    scoped: 'inside',
    outsideRoot: 'Repo Pulse: missing required element #outside',
  });
});

test('optional lookups keep an absent element null and reject a wrong element type', async t => {
  const page = await fixturePage(t);
  const result = await page.evaluate(async () => {
    const domPath = '/src/ui/dom.js';
    const { required, checked, all } = (await import(domPath)) as typeof import('../../src/ui/dom.ts');
    const failure = (lookup: () => unknown) => {
      try {
        lookup();
        return 'no error';
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    };
    const root = required('#root', HTMLDivElement);
    return {
      absent: checked(document.querySelector('#nowhere'), HTMLElement, '#nowhere'),
      found: checked(root.querySelector('.item'), HTMLSpanElement, '.item')?.textContent,
      closest: checked(required('.item', HTMLElement, root).closest('#root'), HTMLDivElement, '#root')?.id,
      wrongType: failure(() => checked(document.querySelector('#root'), HTMLButtonElement, '#root')),
      allScoped: all('.item', HTMLElement, root).map(element => element.textContent),
      allNone: all('.nothing', HTMLElement, root),
      allWrongType: failure(() => all('.item', HTMLSpanElement, root)),
    };
  });
  assert.deepEqual(result, {
    absent: null,
    found: 'inside',
    closest: 'root',
    wrongType: 'Repo Pulse: element #root is a <div>, expected HTMLButtonElement',
    allScoped: ['inside', 'bold'],
    allNone: [],
    allWrongType: 'Repo Pulse: element .item is a <b>, expected HTMLSpanElement',
  });
});
