// The access key every test app is created with, and helpers that send it like the real page does.
import type { Page } from '@playwright/test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';

export const TEST_KEY = 'test-access-key-0123456789abcdefghijklmnopqrstuvwxyz';

/** Request options whose headers, if any, are a plain object, so the key header can be added beside them. */
type KeyedInit = Omit<RequestInit, 'headers'> & { headers?: Record<string, string> };

/** fetch that adds the access key header. */
export function keyedFetch(key = TEST_KEY) {
  return (input: string | URL, init: KeyedInit = {}) =>
    globalThis.fetch(input, { ...init, headers: { 'x-repo-pulse-key': key, ...init.headers } });
}

/** Stores the key in a page before the app loads, as opening the launch link once does. */
export function rememberKey(page: Page, key = TEST_KEY) {
  return page.addInitScript(value => localStorage.setItem('repo-pulse-access-key', value), key);
}

const runtimeKeys = new Map<string, string>();

/** Records the key a started app printed in its launch link, so fetchWithKey can send it to that app. */
export function rememberRuntime<T extends { url: string; accessKey: string; close: () => Promise<void> }>(runtime: T) {
  runtimeKeys.set(runtime.url, runtime.accessKey);
  const close = runtime.close;
  // Forget the key when the app stops, so a later app on the same port gets TEST_KEY again.
  runtime.close = () => {
    runtimeKeys.delete(runtime.url);
    return close();
  };
  return runtime;
}

/** fetch that sends the key of the app it calls: a recorded started app, or TEST_KEY. */
export function fetchWithKey(input: string | URL, init: KeyedInit = {}) {
  const key = runtimeKeys.get(new URL(String(input)).origin) ?? TEST_KEY;
  return globalThis.fetch(input, { ...init, headers: { 'x-repo-pulse-key': key, ...init.headers } });
}

/** The port a test server listens on. */
export function portOf(server: { address(): AddressInfo | string | null }) {
  const address = server.address();
  assert.ok(address && typeof address === 'object', 'the server listens on a TCP port');
  return address.port;
}
