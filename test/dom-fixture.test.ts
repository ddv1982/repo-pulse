import test from 'node:test';
import assert from 'node:assert/strict';
import { parse, one, all, row, text, srText } from './fixtures/dom.ts';

test('the DOM test helper reads visible and screen-reader text and finds elements by selector', () => {
  const doc = parse(`<ul><li class="row" data-event-id="a"><span class="title">New
      branch</span><span class="sr"> · branch </span><code>main</code></li><li class="row" data-event-id="b"><b>x</b></li></ul>`);
  assert.equal(text(row(doc, 'a')), 'New branchmain');
  assert.equal(srText(row(doc, 'a')), 'New branch · branch main');
  assert.equal(text(one(doc, '.title')), 'New branch');
  assert.equal(all(doc, '.row').length, 2);
  assert.throws(() => one(doc, '.row'), /expected one \.row, found 2/);
  assert.throws(() => row(doc, 'missing'), /found 0/);
  assert.equal(text(doc), 'New branchmainx');
  // Text a reader cannot see stays out, even when the element asked for is itself screen-reader-only.
  assert.equal(text(one(doc, '.sr')), '');
  assert.equal(srText(one(doc, '.sr')), '· branch');
  // The copy leaves the rendered markup untouched.
  assert.equal(all(doc, '.sr').length, 1);
});
