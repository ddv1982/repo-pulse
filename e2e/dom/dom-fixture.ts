import test from 'node:test';
import assert from 'node:assert/strict';
import { parse, one, all, row, text, srText } from '../fixtures/dom.ts';

test('the DOM test helper reads visible and screen-reader text and finds elements by selector', async () => {
  const doc = parse(`<ul><li class="row" data-event-id="a"><span class="title">New
      branch</span><span class="sr"> · branch </span><code>main</code></li><li class="row" data-event-id="b"><b>x</b></li></ul>`);
  assert.equal(await text(row(doc, 'a')), 'New branchmain');
  assert.equal(await srText(row(doc, 'a')), 'New branch · branch main');
  assert.equal(await text(one(doc, '.title')), 'New branch');
  assert.equal((await all(doc, '.row')).length, 2);
  await assert.rejects(text(one(doc, '.row')), /expected one \.row, found 2/);
  await assert.rejects(text(row(doc, 'missing')), /found 0/);
  assert.equal(await text(doc), 'New branchmainx');
  // Text a reader cannot see stays out, even when the element asked for is itself screen-reader-only.
  assert.equal(await text(one(doc, '.sr')), '');
  assert.equal(await srText(one(doc, '.sr')), '· branch');
  // The copy leaves the rendered markup untouched.
  assert.equal((await all(doc, '.sr')).length, 1);
});
