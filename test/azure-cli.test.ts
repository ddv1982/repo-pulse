import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { win32 } from 'node:path';
import { createAzureCli } from '../server/azure-cli.ts';
import { stub, type Thrown } from './fixtures/typed.ts';

const flush = () => new Promise(resolve => setImmediate(resolve));
const read = (repo: string) => [
  'repos',
  'show',
  '--repository',
  repo,
  '--organization',
  'https://dev.azure.com/example',
  '--project',
  'Project',
  '--detect',
  'false',
];

test('budget-delayed reads keep a standalone caller alive until completion', async () => {
  const moduleUrl = new URL('../server/azure-cli.ts', import.meta.url).href;
  const script = `import {createAzureCli} from ${JSON.stringify(moduleUrl)};
    let offset=0;
    const cli=createAzureCli({limitPerMinute:1,now:()=>Date.now()+offset,executor:async()=>({ok:true})});
    await cli.run(['version']); offset=59990;
    await cli.run(['extension','show','--name','azure-devops']); cli.close(); console.log('completed');`;
  const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script], { timeout: 5000 });
  assert.match(stdout, /completed/);
});

test('CLI rejects writes and credential operations before execution', async () => {
  let calls = 0;
  const cli = createAzureCli({
    executor: async () => {
      calls++;
      return '{}';
    },
  });
  for (const args of [
    ['login'],
    ['account', 'get-access-token'],
    ['repos', 'delete', '--id', '1'],
    ['devops', 'invoke', '--area', 'git', '--resource', 'pushes', '--api-version', '7.1', '--http-method', 'POST'],
    ['devops', 'invoke', '--area', 'git', '--resource', 'commits', '--api-version', '7.1', '--http-method', 'GET', '--in-file', '/tmp/x'],
  ])
    await assert.rejects(cli.run(args), { code: 'READ_ONLY' });
  assert.equal(calls, 0);
  cli.close();
});

test('CLI shares duplicate reads and bounds concurrency and rolling starts', async () => {
  let time = 0,
    scheduled: (() => void) | undefined;
  const release: ((output: string) => void)[] = [];
  const settle = (output: string) => {
    const next = release.shift();
    assert.ok(next, 'a read is waiting');
    next(output);
  };
  const cli = createAzureCli({
    limitPerMinute: 2,
    concurrency: 1,
    now: () => time,
    setTimer: fn => {
      scheduled = fn;
      return stub<NodeJS.Timeout>({});
    },
    clearTimer: () => {},
    executor: () => new Promise(resolve => release.push(resolve)),
  });
  const a = cli.run(read('a')),
    duplicate = cli.run(read('a')),
    b = cli.run(read('b')),
    c = cli.run(read('c'));
  assert.equal(a, duplicate);
  await flush();
  assert.equal(release.length, 1);
  settle('{"id":"a"}');
  await a;
  await flush();
  assert.equal(release.length, 1);
  settle('{"id":"b"}');
  await b;
  await flush();
  assert.equal(cli.diagnostics().startsLastMinute, 2);
  assert.equal(cli.diagnostics().pending, 1);
  assert.equal(release.length, 0);
  time = 60_000;
  assert.ok(scheduled);
  scheduled();
  await flush();
  assert.equal(release.length, 1);
  settle('{"id":"c"}');
  await c;
  cli.close();
});

test('CLI redacts upstream stderr, rejects invalid JSON and closes queued work', async () => {
  const secret = 'PAT-secret-value';
  const cli = createAzureCli({
    executor: async () => {
      throw Object.assign(new Error(secret), { stderr: `403 token ${secret}` });
    },
  });
  await assert.rejects(cli.run(read('a')), (error: Thrown) => error.code === 'FORBIDDEN' && !error.message.includes(secret));
  assert.equal(JSON.stringify(cli.diagnostics()).includes(secret), false);
  cli.close();
  const malformed = createAzureCli({ executor: async () => 'password=secret' });
  await assert.rejects(malformed.run(read('a')), { code: 'INVALID_RESPONSE' });
  malformed.close();
  const blocked = createAzureCli({
    concurrency: 1,
    executor: async (_args, { signal }) =>
      new Promise((_, reject) =>
        signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))),
      ),
  });
  const active = blocked.run(read('a'));
  const queued = blocked.run(read('b'));
  await flush();
  blocked.close();
  await assert.rejects(queued, { code: 'CLOSED' });
  await assert.rejects(active);
});

test('CLI errors are classified from Azure output, not from the command arguments', async () => {
  const failing = (stderr: string) =>
    createAzureCli({
      executor: async args => {
        // execFile puts the whole command line in error.message.
        throw Object.assign(new Error(`Command failed: az ${args.join(' ')}\n${stderr}`), { code: 1, stderr });
      },
    });
  const args = [
    'repos',
    'show',
    '--repository',
    'repo-403-connection-500',
    '--organization',
    'https://dev.azure.com/example',
    '--project',
    'Project',
    '--detect',
    'false',
  ];
  const plain = failing('ERROR: something unexpected');
  await assert.rejects(plain.run(args), { code: 'CLI_ERROR' });
  plain.close();
  const forbidden = failing('ERROR: TF401027: You need the Git Read permission');
  await assert.rejects(forbidden.run(args), { code: 'FORBIDDEN' });
  forbidden.close();
  // Azure error numbers such as TF401180 contain 401 or 404 without being HTTP statuses.
  for (const [stderr, code] of [
    ['ERROR: TF401180: The requested pull request was not found.', 'NOT_FOUND'],
    ['ERROR: Operation returned a 401 (Unauthorized) status code.', 'AUTH_REQUIRED'],
  ] satisfies [string, string][]) {
    const cli = failing(stderr);
    await assert.rejects(cli.run(args), { code }, stderr);
    cli.close();
  }
});

test('closing the CLI reports running reads as closed, not timed out', async () => {
  const cli = createAzureCli({
    executor: async (_args, { signal }) =>
      new Promise((_, reject) =>
        signal.addEventListener('abort', () =>
          reject(Object.assign(new Error('The operation was aborted'), { name: 'AbortError', code: 'ABORT_ERR' })),
        ),
      ),
  });
  const running = cli.run(read('a'));
  await flush();
  cli.close();
  await assert.rejects(running, { code: 'CLOSED' });
  assert.notEqual(cli.diagnostics().lastError?.code, 'TIMEOUT');
});

test('Windows runs the interpreter each official az launcher calls, never through a shell', async () => {
  const { resolveAzCommand } = await import('../server/azure-cli.ts');
  const on =
    (...files: string[]) =>
    async (path: string) =>
      files.includes(path);
  const msi = 'C:\\Program Files\\Microsoft SDKs\\Azure\\CLI2';
  assert.deepEqual(
    await resolveAzCommand({
      platform: 'win32',
      env: { Path: `C:\\Windows\\system32;"${msi}\\wbin"` },
      exists: on(`${msi}\\wbin\\az.cmd`, `${msi}\\python.exe`),
    }),
    { file: `${msi}\\python.exe`, prefix: ['-IBm', 'azure.cli'], env: { AZ_INSTALLER: 'MSI' } },
  );
  assert.deepEqual(
    (await resolveAzCommand({ platform: 'win32', env: { PATH: 'D:\\az\\bin' }, exists: on('D:\\az\\bin\\az.cmd', 'D:\\az\\python.exe') }))
      .env,
    { AZ_INSTALLER: 'ZIP' },
  );
  assert.deepEqual(
    await resolveAzCommand({
      platform: 'win32',
      env: { PATH: 'C:\\venv\\Scripts' },
      exists: on('C:\\venv\\Scripts\\az.bat', 'C:\\venv\\Scripts\\python.exe'),
    }),
    {
      file: 'C:\\venv\\Scripts\\python.exe',
      prefix: ['-m', 'azure.cli'],
      env: { AZ_INSTALLER: 'PIP', PYTHONPATH: 'C:\\venv\\Scripts\\src' },
      cwd: 'C:\\venv\\Scripts',
    },
  );
  const relative = await resolveAzCommand({
    platform: 'win32',
    env: { PATH: '.venv\\Scripts' },
    exists: on('.venv\\Scripts\\az.bat', '.venv\\Scripts\\python.exe'),
  });
  assert(win32.isAbsolute(relative.cwd ?? ''));
  assert.equal(relative.file, win32.join(relative.cwd ?? '', 'python.exe'));
  assert.deepEqual(await resolveAzCommand({ platform: 'win32', env: { PATH: 'C:\\tools' }, exists: on('C:\\tools\\az.exe') }), {
    file: 'C:\\tools\\az.exe',
    prefix: [],
    env: {},
  });
  await assert.rejects(resolveAzCommand({ platform: 'win32', env: { PATH: 'C:\\broken\\wbin' }, exists: on('C:\\broken\\wbin\\az.cmd') }), {
    code: 'ENOENT',
  });
  assert.deepEqual(await resolveAzCommand({ platform: 'linux', env: {}, exists: on() }), { file: 'az', prefix: [], env: {} });
});
