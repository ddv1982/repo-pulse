import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { formatDoctorReport, runDoctor } from '../scripts/doctor.js';

const execFileAsync = promisify(execFile);
const DOCTOR_SCRIPT = resolve(fileURLToPath(new URL('../scripts/doctor.js', import.meta.url)));
const defaultAz = async () => ({ file: 'az', prefix: [], env: {} });

test('runDoctor passes when Node 26+, Git, Azure CLI, azure-devops extension, and cached account are ready', async () => {
  const calls = [];
  const report = await runDoctor({
    nodeVersion: '26.13.1',
    resolveAz: defaultAz,
    async runCommand(file, args) {
      calls.push([file, ...args]);
      if (file === 'git') return { stdout: 'git version 2.43.0\n', stderr: '' };
      if (args[0] === 'version') return { stdout: JSON.stringify({ 'azure-cli': '2.93.0' }), stderr: '' };
      if (args[0] === 'extension') return { stdout: JSON.stringify({ name: 'azure-devops', version: '1.0.2' }), stderr: '' };
      if (args[0] === 'account') return { stdout: JSON.stringify({ id: 'sub-1', name: 'Private Corp Sub' }), stderr: '' };
      throw new Error(`Unexpected command: ${file} ${args.join(' ')}`);
    },
  });

  assert.equal(report.ok, true);
  assert.deepEqual(
    report.checks.map(check => [check.id, check.status]),
    [
      ['node', 'ok'],
      ['git', 'ok'],
      ['az', 'ok'],
      ['az-devops', 'ok'],
      ['az-login', 'ok'],
    ],
  );
  assert.deepEqual(calls, [
    ['git', '--version'],
    ['az', 'version', '--output', 'json'],
    ['az', 'extension', 'show', '--name', 'azure-devops', '--output', 'json'],
    ['az', 'account', 'show', '--output', 'json'],
  ]);

  const text = formatDoctorReport(report);
  assert.match(text, /\[OK\]\s+Node\.js: v26\.13\.1/);
  assert.match(text, /\[OK\]\s+Azure CLI: 2\.93\.0/);
  assert.match(text, /\[OK\]\s+azure-devops extension: 1\.0\.2/);
  assert.match(text, /\[OK\]\s+Azure CLI account: cached Azure CLI account found/);
  assert.doesNotMatch(text, /Private Corp Sub|sub-1/, 'doctor output must not echo subscription names or IDs');
});

test('runDoctor reports old Node, missing Git, and missing Azure CLI while skipping downstream az checks', async () => {
  const calls = [];
  const report = await runDoctor({
    nodeVersion: '22.14.0',
    resolveAz: defaultAz,
    async runCommand(file, args) {
      calls.push([file, ...args]);
      throw Object.assign(new Error('not found'), { code: 'ENOENT' });
    },
  });

  assert.equal(report.ok, false);
  assert.deepEqual(
    report.checks.map(check => [check.id, check.status]),
    [
      ['node', 'fail'],
      ['git', 'fail'],
      ['az', 'fail'],
      ['az-devops', 'skip'],
      ['az-login', 'skip'],
    ],
  );
  assert.equal(calls.length, 2, 'must not invoke extension/account checks after az fails');
  const text = formatDoctorReport(report);
  assert.match(text, /requires Node\.js 26\+/);
  assert.match(text, /\[SKIP\] azure-devops extension/);
  assert.match(text, /\[SKIP\] Azure CLI account/);
});

test('runDoctor forwards Windows pip-style launcher executable, prefix, env overrides, and cwd to all Azure calls', async () => {
  const azCalls = [];
  const inheritedSentinel = process.env.PATH;
  const report = await runDoctor({
    nodeVersion: '26.0.0',
    resolveAz: async () => ({
      file: 'C:\\venv\\Scripts\\python.exe',
      prefix: ['-m', 'azure.cli'],
      env: { AZ_INSTALLER: 'PIP', PYTHONPATH: 'C:\\venv\\Scripts\\src' },
      cwd: 'C:\\venv\\Scripts',
    }),
    async runCommand(file, args, options) {
      if (file === 'git') return { stdout: 'git version 2.47.0\n', stderr: '' };
      azCalls.push({ file, args, options });
      if (args.includes('version')) return { stdout: JSON.stringify({ 'azure-cli': '2.70.0' }), stderr: '' };
      if (args.includes('extension')) {
        throw Object.assign(new Error('Command failed'), { stderr: 'The extension azure-devops is not installed.' });
      }
      if (args.includes('account')) {
        throw Object.assign(new Error('Command failed'), { stderr: "Please run 'az login' to setup account." });
      }
      throw new Error('Unexpected');
    },
  });

  assert.equal(report.ok, false);
  assert.equal(azCalls.length, 3);
  assert.deepEqual(
    azCalls.map(call => [call.file, call.args, call.options?.cwd]),
    [
      ['C:\\venv\\Scripts\\python.exe', ['-m', 'azure.cli', 'version', '--output', 'json'], 'C:\\venv\\Scripts'],
      [
        'C:\\venv\\Scripts\\python.exe',
        ['-m', 'azure.cli', 'extension', 'show', '--name', 'azure-devops', '--output', 'json'],
        'C:\\venv\\Scripts',
      ],
      ['C:\\venv\\Scripts\\python.exe', ['-m', 'azure.cli', 'account', 'show', '--output', 'json'], 'C:\\venv\\Scripts'],
    ],
  );
  for (const call of azCalls) {
    assert.equal(call.options?.env?.AZ_INSTALLER, 'PIP');
    assert.equal(call.options?.env?.PYTHONPATH, 'C:\\venv\\Scripts\\src');
    assert.equal(call.options?.env?.PATH, inheritedSentinel);
  }
  const text = formatDoctorReport(report);
  assert.match(text, /\[FAIL\] azure-devops extension: not installed/);
  assert.match(text, /Fix: Run: az extension add --name azure-devops/);
  assert.match(text, /\[FAIL\] Azure CLI account: not signed in/);
  assert.match(text, /Fix: Run: az login/);
});

test('runDoctor uses neutral failure messages for unclassified errors and redacts private stderr details', async () => {
  const secret = 'alice@corp.example tenant-12345678 bearer-secret-token';
  const report = await runDoctor({
    nodeVersion: '26.1.0',
    resolveAz: defaultAz,
    async runCommand(file, args) {
      if (file === 'git') throw Object.assign(new Error('timeout'), { killed: true });
      if (args[0] === 'version') return { stdout: JSON.stringify({ 'azure-cli': '2.93.0' }), stderr: '' };
      if (args[0] === 'extension') {
        throw Object.assign(new Error(`stdout maxBuffer length exceeded ${secret}`), {
          code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
          stderr: `Traceback involving ${secret}`,
        });
      }
      if (args[0] === 'account') {
        throw Object.assign(new Error(`unexpected sqlite lock for ${secret}`), {
          stderr: `Failed reading cache for ${secret}`,
        });
      }
      throw new Error('Unexpected');
    },
  });

  assert.equal(report.ok, false);
  assert.equal(report.checks.find(c => c.id === 'git')?.detail, 'timed out');
  assert.equal(report.checks.find(c => c.id === 'az-devops')?.detail, 'could not inspect azure-devops extension');
  assert.equal(report.checks.find(c => c.id === 'az-login')?.detail, 'could not inspect cached Azure CLI account');
  const text = formatDoctorReport(report);
  assert.doesNotMatch(text, /alice@corp\.example|tenant-12345678|bearer-secret-token/);
  assert.doesNotMatch(JSON.stringify(report), /alice@corp\.example|tenant-12345678|bearer-secret-token/);

  const ambiguous = await runDoctor({
    nodeVersion: '26.1.0',
    resolveAz: defaultAz,
    async runCommand(file, args) {
      if (file === 'git') return { stdout: 'git version 2.43.0\n', stderr: '' };
      if (args[0] === 'version') return { stdout: JSON.stringify({ 'azure-cli': '2.93.0' }), stderr: '' };
      if (args[0] === 'extension') {
        throw Object.assign(new Error('Command failed'), { stderr: 'Python dependency is not installed' });
      }
      if (args[0] === 'account') {
        throw Object.assign(new Error('Command failed'), { stderr: 'Cache read failed during sign in' });
      }
      throw new Error('Unexpected');
    },
  });
  assert.equal(ambiguous.ok, false);
  assert.equal(ambiguous.checks.find(c => c.id === 'az-devops')?.detail, 'could not inspect azure-devops extension');
  assert.equal(ambiguous.checks.find(c => c.id === 'az-login')?.detail, 'could not inspect cached Azure CLI account');
});

test('runDoctor handles malformed JSON, resolveAz failures, and unexpected az version payloads without throwing', async () => {
  const malformed = await runDoctor({
    nodeVersion: '26.1.0',
    resolveAz: defaultAz,
    async runCommand(file, args) {
      if (file === 'git') return { stdout: 'git version 2.43.0\n', stderr: '' };
      if (args[0] === 'version') return { stdout: JSON.stringify({ 'azure-cli': '2.93.0' }), stderr: '' };
      if (args[0] === 'extension') return { stdout: 'not-json', stderr: '' };
      if (args[0] === 'account') return { stdout: '{}', stderr: '' };
      throw new Error('Unexpected');
    },
  });
  assert.equal(malformed.ok, false);
  assert.equal(malformed.checks.find(c => c.id === 'az-devops')?.detail, 'extension metadata could not be read');
  assert.equal(malformed.checks.find(c => c.id === 'az-login')?.detail, 'account details could not be read');

  const resolverFailed = await runDoctor({
    nodeVersion: '26.1.0',
    resolveAz: async () => {
      throw new Error('PATH lookup failed');
    },
    async runCommand() {
      return { stdout: 'git version 2.43.0\n', stderr: '' };
    },
  });
  assert.equal(resolverFailed.ok, false);
  assert.equal(resolverFailed.checks.find(c => c.id === 'az')?.status, 'fail');
  assert.equal(resolverFailed.checks.find(c => c.id === 'az-devops')?.status, 'skip');

  const malformedVersion = await runDoctor({
    nodeVersion: '26.1.0',
    resolveAz: defaultAz,
    async runCommand(file) {
      if (file === 'git') return { stdout: 'git version 2.43.0\n', stderr: '' };
      return { stdout: '[]', stderr: '' };
    },
  });
  assert.equal(malformedVersion.ok, false);
  assert.equal(malformedVersion.checks.find(c => c.id === 'az')?.detail, 'returned unexpected output from `az version`');
  assert.equal(malformedVersion.checks.find(c => c.id === 'az-login')?.status, 'skip');
});

test('doctor CLI runs on direct invocation and stays silent when imported', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rp-doctor-'));
  const isolatedEnv = { ...process.env, PATH: dir };
  try {
    let failed;
    try {
      await execFileAsync(process.execPath, [DOCTOR_SCRIPT], { env: isolatedEnv, encoding: 'utf8' });
    } catch (error) {
      failed = error;
    }
    assert.ok(failed, 'doctor CLI should exit non-zero when git and az are missing');
    assert.equal(failed.code, 1);
    assert.match(String(failed.stdout), /\[OK\]\s+Node\.js:/);
    assert.match(String(failed.stdout), /\[FAIL\] Git: not found on PATH/);
    assert.match(String(failed.stdout), /\[FAIL\] Azure CLI: not found on PATH/);

    const imported = await execFileAsync(
      process.execPath,
      ['--input-type=module', '-e', `import ${JSON.stringify(new URL('../scripts/doctor.js', import.meta.url).href)};`],
      { env: isolatedEnv, encoding: 'utf8' },
    );
    assert.equal(imported.stdout, '');
    assert.equal(imported.stderr, '');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('doctor CLI runs when invoked through a symlink', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'rp-doctor-link-'));
  const link = join(dir, 'doctor-link.js');
  const isolatedEnv = { ...process.env, PATH: dir };
  try {
    try {
      symlinkSync(DOCTOR_SCRIPT, link);
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && (error.code === 'EPERM' || error.code === 'EACCES')) {
        t.skip('Creating file symlinks requires elevated permissions on this host.');
        return;
      }
      throw error;
    }

    let failed;
    try {
      await execFileAsync(process.execPath, [link], { env: isolatedEnv, encoding: 'utf8' });
    } catch (error) {
      failed = error;
    }
    assert.ok(failed, 'symlinked doctor CLI should exit non-zero when git and az are missing');
    assert.equal(failed.code, 1);
    assert.match(String(failed.stdout), /\[OK\]\s+Node\.js:/);
    assert.match(String(failed.stdout), /\[FAIL\] Git: not found on PATH/);
    assert.match(String(failed.stdout), /\[FAIL\] Azure CLI: not found on PATH/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
