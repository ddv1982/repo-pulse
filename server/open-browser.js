// @ts-check

import { spawn as nodeSpawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
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
 * Opens the launch link in the default browser and returns a function that removes anything it left behind.
 * Windows does not show one account's process arguments to another, so there the link goes to the opener directly.
 * Elsewhere (Linux /proc, macOS ps) other accounts can read them, so the single-use token must not appear on a command
 * line: the link goes
 * into an owner-only page in the private data directory, the opener gets only that page's file URL, and the page
 * forwards the browser to the link. The page is removed after `keepMs` or by the returned function. Nothing here stops
 * startup: if it fails, the printed link still works.
 * @param {string} url
 * @param {{ dataDir: string, platform?: NodeJS.Platform, spawn?: typeof nodeSpawn, keepMs?: number }} options
 * @returns {Promise<() => Promise<void>>}
 */
export async function openBrowser(url, { dataDir, platform = process.platform, spawn = nodeSpawn, keepMs = 60_000 }) {
  let target = url;
  let remove = async () => {};
  if (platform !== 'win32') {
    const page = resolve(dataDir, `launch-${randomBytes(8).toString('hex')}.html`);
    const link = new URL(url).href.replace(/"/g, '%22');
    try {
      await writeFile(
        page,
        `<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=${link}"><title>Repo Pulse</title>\n`,
        {
          mode: 0o600,
          flag: 'wx',
        },
      );
    } catch {
      return remove;
    }
    remove = () => rm(page, { force: true }).catch(() => {});
    setTimeout(remove, keepMs).unref();
    target = pathToFileURL(page).href;
  }
  try {
    const [file, args] = browserOpener(platform);
    const child = spawn(file, [...args, target], { detached: true, stdio: 'ignore', windowsHide: true });
    child.on('error', () => {});
    child.unref();
  } catch {
    /* No opener on this system; the printed link still works. */
  }
  return remove;
}
