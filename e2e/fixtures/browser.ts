import { readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { chromium } from '@playwright/test';

export async function browserPath() {
  if (process.env.CHROME) return process.env.CHROME;
  if (existsSync(chromium.executablePath())) return chromium.executablePath();
  const cache = join(homedir(), '.cache', 'ms-playwright');
  for (const name of (await readdir(cache).catch(() => []))
    .filter(name => /^chromium-\d+$/.test(name))
    .sort()
    .reverse()) {
    for (const relative of ['chrome-linux64/chrome', 'chrome-linux/chrome']) {
      const candidate = join(cache, name, relative);
      if (existsSync(candidate)) return candidate;
    }
  }
  throw new Error('Install Chromium with npx playwright install chromium, or set CHROME.');
}
