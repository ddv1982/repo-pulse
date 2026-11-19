import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { browserOpener, canOpenBrowser, openBrowser } from '../server/open-browser.js';

const fakeSpawn = calls => (file, args, options) => {
  calls.push({ file, args, options });
  return Object.assign(new EventEmitter(), { unref() {} });
};

test('each platform has an opener that takes the URL as one argument', () => {
  assert.deepEqual(browserOpener('darwin'), ['open', []]);
  assert.deepEqual(browserOpener('win32'), ['rundll32.exe', ['url.dll,FileProtocolHandler']]);
  assert.deepEqual(browserOpener('linux'), ['xdg-open', []]);
});

test('a Linux session without a display does not try to open a browser', () => {
  assert.equal(canOpenBrowser('linux', {}), false);
  assert.equal(canOpenBrowser('linux', { DISPLAY: ':0' }), true);
  assert.equal(canOpenBrowser('linux', { WAYLAND_DISPLAY: 'wayland-0' }), true);
  assert.equal(canOpenBrowser('darwin', {}), true);
  assert.equal(canOpenBrowser('win32', {}), true);
});

test('the opener gets an owner-only page, not the launch link, and the page forwards to the link', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'repo-pulse-open-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const url = 'http://127.0.0.1:1234/#launch=secret-token';
  const calls = [];
  const remove = await openBrowser(url, { dataDir, platform: 'linux', spawn: fakeSpawn(calls) });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].file, 'xdg-open');
  assert.equal(calls[0].args.length, 1);
  assert.equal(calls[0].args[0].includes('secret-token'), false);
  assert.deepEqual(calls[0].options, { detached: true, stdio: 'ignore', windowsHide: true });
  const page = fileURLToPath(calls[0].args[0]);
  assert.match(
    await readFile(page, 'utf8'),
    /<meta http-equiv="refresh" content="0;url=http:\/\/127\.0\.0\.1:1234\/#launch=secret-token">/,
  );
  if (process.platform !== 'win32') assert.equal((await stat(page)).mode & 0o777, 0o600);
  await remove();
  await assert.rejects(stat(page), { code: 'ENOENT' });
});

test('a missing or failing opener does not throw', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'repo-pulse-open-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const failing = () => {
    const child = Object.assign(new EventEmitter(), { unref() {} });
    queueMicrotask(() => child.emit('error', Object.assign(new Error('spawn xdg-open ENOENT'), { code: 'ENOENT' })));
    return child;
  };
  await openBrowser('http://127.0.0.1:1/', { dataDir, platform: 'linux', spawn: failing });
  const throwing = () => {
    throw new Error('no such program');
  };
  await openBrowser('http://127.0.0.1:1/', { dataDir, platform: 'linux', spawn: throwing });
});
