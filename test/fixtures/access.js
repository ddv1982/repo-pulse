// The access key every test app is created with, and helpers that send it like the real page does.
export const TEST_KEY = 'test-access-key-0123456789abcdefghijklmnopqrstuvwxyz';

/** fetch that adds the access key header. */
export function keyedFetch(key = TEST_KEY) {
  return (input, init = {}) => globalThis.fetch(input, { ...init, headers: { 'x-repo-pulse-key': key, ...init.headers } });
}

/** Stores the key in a page before the app loads, as opening the launch link once does. */
export function rememberKey(page, key = TEST_KEY) {
  return page.addInitScript(value => localStorage.setItem('repo-pulse-access-key', value), key);
}

const runtimeKeys = new Map();

/** Records the key a started app printed in its launch link, so fetchWithKey can send it to that app. */
export function rememberRuntime(runtime) {
  runtimeKeys.set(runtime.url, new URL(runtime.launchUrl).searchParams.get('key'));
  return runtime;
}

/** fetch that sends the key of the app it calls: a recorded started app, or TEST_KEY. */
export function fetchWithKey(input, init = {}) {
  const key = runtimeKeys.get(new URL(String(input)).origin) ?? TEST_KEY;
  return globalThis.fetch(input, { ...init, headers: { 'x-repo-pulse-key': key, ...init.headers } });
}
