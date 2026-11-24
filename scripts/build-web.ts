import { spawnSync } from 'node:child_process';
import { globSync, rmSync, watch } from 'node:fs';
import { fileURLToPath } from 'node:url';
import config from '../tsconfig.json' with { type: 'json' };

const root = fileURLToPath(new URL('../', import.meta.url));
const tsc = fileURLToPath(new URL('./bin/tsc', import.meta.resolve('typescript/package.json')));
// The root project checks all code. Only browser source files are inputs to this emitter.
const options = {
  ...config.compilerOptions,
  allowJs: false,
  noEmit: false,
  types: [],
  noEmitOnError: true,
  rootDir: '.',
  outDir: 'dist',
  rewriteRelativeImportExtensions: true,
};
const flags = Object.entries(options).flatMap(([name, value]) => [`--${name}`, String(value)]);

function build() {
  const sources = globSync(['src/**/*.ts', 'web/**/*.ts'], { cwd: root, exclude: ['web/vendor/**'] }).sort();
  const result = spawnSync(process.execPath, [tsc, '--ignoreConfig', ...flags, ...sources], { cwd: root, stdio: 'inherit' });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

if (process.argv.includes('--watch')) {
  let pending: ReturnType<typeof setTimeout> | undefined;
  for (const directory of ['src/', 'web/']) {
    watch(new URL(`../${directory}`, import.meta.url), { recursive: true }, (event, filename) => {
      if (directory === 'web/' && filename && /^vendor(?:[\\/]|$)/.test(filename)) return;
      if (event === 'change' && filename && !filename.endsWith('.ts')) return;
      clearTimeout(pending);
      pending = setTimeout(() => {
        console.log('Rebuilding browser files…');
        build();
      }, 100);
    });
  }
  build();
  console.log('Watching browser files…');
} else {
  rmSync(new URL('../dist', import.meta.url), { recursive: true, force: true });
  process.exitCode = build();
}
