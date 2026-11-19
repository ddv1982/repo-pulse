// @ts-check

import { spawn as nodeSpawn } from 'node:child_process';
import { rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * The program and leading arguments that open a URL in the default browser, called without a shell.
 * @param {NodeJS.Platform} platform
 * @returns {[string, string[]]}
 */
export function browserOpener(platform) {
  if (platform === 'darwin') return ['open', []];
  // explorer.exe can read an unquoted '=' as a delimiter; the URL protocol handler takes the URL as given.
  if (platform === 'win32') return ['rundll32.exe', ['url.dll,FileProtocolHandler']];
  return ['xdg-open', []];
}

/**
 * Whether this session can show a browser. On Linux and similar systems that needs a graphical display.
 * @param {NodeJS.Platform} platform @param {NodeJS.ProcessEnv} env
 */
export function canOpenBrowser(platform, env) {
  return platform === 'darwin' || platform === 'win32' || Boolean(env.DISPLAY || env.WAYLAND_DISPLAY);
}

/**
 * Opens the launch link in the default browser without putting it on a command line, where other local accounts could
 * read the single-use token before the browser uses it. The link goes into an owner-only page in the private data
 * directory, the opener gets only that page's file URL, and the page forwards the browser to the link. The page is
 * removed after `keepMs`. A missing opener is not an error: the link is printed too.
 * @param {string} url
 * @param {{ dataDir: string, platform?: NodeJS.Platform, spawn?: typeof nodeSpawn, keepMs?: number }} options
 * @returns {Promise<() => Promise<void>>} removes the page
 */
export async function openBrowser(url, { dataDir, platform = process.platform, spawn = nodeSpawn, keepMs = 60_000 }) {
  const page = resolve(dataDir, 'launch.html');
  const target = new URL(url).href.replace(/"/g, '%22');
  // Exclusive create after removal, so a leftover page from an earlier run cannot keep wider permissions.
  await rm(page, { force: true });
  await writeFile(
    page,
    `<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=${target}"><title>Repo Pulse</title>\n`,
    {
      mode: 0o600,
      flag: 'wx',
    },
  );
  const remove = () => rm(page, { force: true });
  setTimeout(remove, keepMs).unref();
  try {
    const [file, args] = browserOpener(platform);
    const child = spawn(file, [...args, pathToFileURL(page).href], { detached: true, stdio: 'ignore', windowsHide: true });
    child.on('error', () => {});
    child.unref();
  } catch {
    /* No opener on this system; the printed link still works. */
  }
  return remove;
}
