// @ts-check

import test from 'node:test';
import assert from 'node:assert/strict';
import { renderSettings } from '../src/ui/settings.js';

/** @typedef {import('../src/ui/refresh.js').PageState} PageState */

/** @param {{ pending: number, errors: number }} mergeQueue */
function troubleshooting(mergeQueue) {
  const state = /** @type {PageState} */ (
    /** @type {unknown} */ ({
      repos: [],
      watched: [],
      streams: [],
      settings: { refreshEnabled: true },
      diagnostics: { startsLastMinute: 0, limitPerMinute: 60, running: 0, concurrency: 4 },
      mergeQueue,
      jobs: [],
      demo: true,
    })
  );
  const html = renderSettings(state, { results: new Map(), local: null, pending: null, repoId: '' });
  return /** @type {string} */ (html.match(/<dl class="diagnostic-summary">[\s\S]*?<\/dl>/)?.[0]);
}

test('Troubleshooting leaves out merge checks that are only waiting', () => {
  const summary = troubleshooting({ pending: 533, errors: 0 });
  assert.match(summary, /Azure calls/);
  assert.doesNotMatch(summary, /merge|pending|classified/i);
});

test('Troubleshooting names pushes whose merge check keeps failing', () => {
  assert.match(troubleshooting({ pending: 533, errors: 2 }), /2 pushes couldn’t be classified yet, retrying/);
  assert.match(troubleshooting({ pending: 1, errors: 1 }), /1 push couldn’t be classified yet, retrying/);
  assert.doesNotMatch(troubleshooting({ pending: 533, errors: 2 }), /533|pending/);
});
