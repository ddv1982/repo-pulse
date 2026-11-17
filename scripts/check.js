import { readdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';

async function check(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || ['node_modules', 'test-results', 'playwright-report'].includes(entry.name)) continue;
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) await check(path);
    else if (/\.[cm]?js$/.test(entry.name)) execFileSync(process.execPath, ['--check', path], { stdio: 'inherit' });
  }
}
await check('.');
console.log('JavaScript syntax checks passed.');
