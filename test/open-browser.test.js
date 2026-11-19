import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { browserOpener, openBrowser } from '../server/open-browser.js';

test('each platform opens the URL with its own opener, as one argument and without a shell', () => {
  assert.equal(browserOpener('darwin'), 'open');
  assert.equal(browserOpener('win32'), 'explorer.exe');
  assert.equal(browserOpener('linux'), 'xdg-open');
  const calls = [];
  const spawn = (file, args, options) => {
    calls.push({ file, args, options });
    return Object.assign(new EventEmitter(), { unref() {} });
  };
  openBrowser('http://127.0.0.1:1234/#launch=abc', { platform: 'linux', spawn });
  assert.deepEqual(calls, [
    { file: 'xdg-open', args: ['http://127.0.0.1:1234/#launch=abc'], options: { detached: true, stdio: 'ignore', windowsHide: true } },
  ]);
});

test('a missing or failing opener does not throw', () => {
  const failing = () => {
    const child = Object.assign(new EventEmitter(), { unref() {} });
    queueMicrotask(() => child.emit('error', Object.assign(new Error('spawn xdg-open ENOENT'), { code: 'ENOENT' })));
    return child;
  };
  assert.doesNotThrow(() => openBrowser('http://127.0.0.1:1/', { platform: 'linux', spawn: failing }));
  assert.doesNotThrow(() =>
    openBrowser('http://127.0.0.1:1/', {
      platform: 'linux',
      spawn: () => {
        throw new Error('no such program');
      },
    }),
  );
});
