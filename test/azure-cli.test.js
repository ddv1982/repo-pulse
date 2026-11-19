import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createAzureCli } from '../server/azure-cli.js';

const flush = () => new Promise(resolve => setImmediate(resolve));
const read = repo => [
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
  const moduleUrl = new URL('../server/azure-cli.js', import.meta.url).href;
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
  ])
    await assert.rejects(cli.run(args), { code: 'READ_ONLY' });
  assert.equal(calls, 0);
  cli.close();
});

test('CLI shares duplicate reads and bounds concurrency and rolling starts', async () => {
  let time = 0,
    scheduled;
  const release = [];
  const cli = createAzureCli({
    limitPerMinute: 2,
    concurrency: 1,
    now: () => time,
    setTimer: fn => {
      scheduled = fn;
      return 1;
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
  release.shift()('{"id":"a"}');
  await a;
  await flush();
  assert.equal(release.length, 1);
  release.shift()('{"id":"b"}');
  await b;
  await flush();
  assert.equal(cli.diagnostics().startsLastMinute, 2);
  assert.equal(cli.diagnostics().pending, 1);
  assert.equal(release.length, 0);
  time = 60_000;
  scheduled();
  await flush();
  assert.equal(release.length, 1);
  release.shift()('{"id":"c"}');
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
  await assert.rejects(cli.run(read('a')), error => error.code === 'FORBIDDEN' && !error.message.includes(secret));
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

test('read-only POST query files are private, cleaned after errors, and use the shared budget', async () => {
  const { mkdtemp, readFile, stat, readdir, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const tempRoot = await mkdtemp(join(tmpdir(), 'repo-pulse-query-test-'));
  const ids = ['a'.repeat(40)];
  const request = { organization: 'https://dev.azure.com/example', project: 'P', repositoryId: 'repo1', resource: 'commitsbatch' };
  let calls = 0,
    checkedPath;
  const cli = createAzureCli({
    tempRoot,
    executor: async args => {
      calls++;
      const path = args[args.indexOf('--in-file') + 1];
      checkedPath = path;
      assert.equal((await stat(path)).mode & 0o777, 0o600);
      assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), { ids });
      assert(args.includes('POST'));
      assert(args.includes('resource=anything') === false);
      throw Object.assign(new Error('must-not-leak'), { stderr: '403 forbidden token secret' });
    },
  });
  try {
    const a = cli.runReadQuery(request, { ids });
    const duplicate = cli.runReadQuery(request, { ids });
    assert.equal(a, duplicate);
    await assert.rejects(a, { code: 'FORBIDDEN' });
    assert.equal(calls, 1);
    assert.equal(cli.diagnostics().totalStarts, 1);
    assert(checkedPath.startsWith(tempRoot));
    assert.deepEqual(await readdir(tempRoot), []);
  } finally {
    cli.close();
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('only exact bounded read-query bodies can enter POST path', async () => {
  let calls = 0;
  const cli = createAzureCli({
    executor: async () => {
      calls++;
      return '{}';
    },
  });
  const repo = { organization: 'https://dev.azure.com/example', project: 'P', repositoryId: 'repo1', resource: 'commitsbatch' };
  for (const body of [
    { ids: ['bad'] },
    { ids: Array(101).fill('a'.repeat(40)) },
    { ids: ['a'.repeat(40)], itemVersion: {} },
    { ids: [] },
    { refs: [] },
  ])
    await assert.rejects(cli.runReadQuery(repo, body), { code: 'INVALID_QUERY' });
  await assert.rejects(cli.runReadQuery({ ...repo, resource: 'pushes' }, { ids: ['a'.repeat(40)] }), { code: 'INVALID_QUERY' });
  await assert.rejects(
    cli.runReadQuery({ ...repo, resource: 'pullrequestquery' }, { queries: [{ type: 'notSet', items: ['a'.repeat(40)] }] }),
    { code: 'INVALID_QUERY' },
  );
  await assert.rejects(
    cli.run([
      'devops',
      'invoke',
      '--area',
      'git',
      '--resource',
      'commitsbatch',
      '--api-version',
      '7.1',
      '--http-method',
      'POST',
      '--in-file',
      '/tmp/arbitrary',
    ]),
    { code: 'READ_ONLY' },
  );
  assert.equal(calls, 0);
  cli.close();
});

test('read queries cannot bypass a GET exhausted minute budget and remove successful query files', async () => {
  const { mkdtemp, readdir, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const tempRoot = await mkdtemp(join(tmpdir(), 'repo-pulse-budget-query-test-'));
  let time = 0,
    scheduled,
    executions = 0;
  const cli = createAzureCli({
    tempRoot,
    limitPerMinute: 1,
    now: () => time,
    setTimer: fn => {
      scheduled = fn;
      return 1;
    },
    clearTimer: () => {},
    executor: async () => {
      executions++;
      return '{}';
    },
  });
  try {
    await cli.run(['version']);
    await flush();
    const query = cli.runReadQuery(
      { organization: 'https://dev.azure.com/example', project: 'P', repositoryId: 'repo1', resource: 'pullrequestquery' },
      { queries: [{ type: 'lastMergeCommit', items: ['a'.repeat(40)] }] },
    );
    await flush();
    assert.equal(executions, 1);
    assert.deepEqual(await readdir(tempRoot), []);
    time = 60_000;
    scheduled();
    await query;
    assert.equal(executions, 2);
    assert.deepEqual(await readdir(tempRoot), []);
  } finally {
    cli.close();
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('CLI errors are classified from Azure output, not from the command arguments', async () => {
  const failing = stderr =>
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
  const { resolveAzCommand } = await import('../server/azure-cli.js');
  const on =
    (...files) =>
    async path =>
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
