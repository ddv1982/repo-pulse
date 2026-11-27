import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isActionName } from '../src/ui/actions.ts';

const root = new URL('..', import.meta.url).pathname;

test('browser markup names actions only through action(), so the type check covers every name', async () => {
  const files = ['src/web.ts', ...(await readdir(join(root, 'src/ui'))).filter(name => name.endsWith('.ts')).map(name => `src/ui/${name}`)];
  const raw = [];
  for (const file of files) {
    if (file === 'src/ui/actions.ts') continue;
    const source = await readFile(join(root, file), 'utf8');
    // A selector such as [data-action="refresh"] reads markup; writing the attribute is what must go through action().
    if (/(?<!\[)data-action=/.test(source)) raw.push(file);
  }
  assert.deepEqual(raw, []);
});

test('every action the static page names is a listed action', async () => {
  const page = await readFile(join(root, 'web/index.html'), 'utf8');
  const names = [...page.matchAll(/data-action="([^"]*)"/g)].map(match => match[1] ?? '');
  assert.ok(names.length > 0);
  assert.deepEqual(
    names.filter(name => !isActionName(name)),
    [],
  );
});
