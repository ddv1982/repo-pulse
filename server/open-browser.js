// @ts-check

import { spawn as nodeSpawn } from 'node:child_process';

/**
 * The program that opens a URL in the default browser, called without a shell so the URL stays one argument.
 * @param {NodeJS.Platform} platform
 * @returns {string}
 */
export function browserOpener(platform) {
  if (platform === 'darwin') return 'open';
  if (platform === 'win32') return 'explorer.exe';
  return 'xdg-open';
}

/**
 * Opens the URL in the default browser and returns at once. A missing opener is not an error: the URL is printed too.
 * @param {string} url
 * @param {{ platform?: NodeJS.Platform, spawn?: typeof nodeSpawn }} [options]
 */
export function openBrowser(url, { platform = process.platform, spawn = nodeSpawn } = {}) {
  try {
    const child = spawn(browserOpener(platform), [url], { detached: true, stdio: 'ignore', windowsHide: true });
    child.on('error', () => {});
    child.unref();
  } catch {
    /* No opener on this system; the printed link still works. */
  }
}
