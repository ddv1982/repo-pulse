import test from 'node:test';
import assert from 'node:assert/strict';
import { formatDoctorReport, runDoctor } from '../scripts/doctor.js';

const defaultAz = async () => ({ file: 'az', prefix: [], env: {} });

test('runDoctor passes when Node 26+, Git, Azure CLI, azure-devops extension, and sign-in are ready', async () => {
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
  assert.match(text, /\[OK\]\s+Azure CLI sign-in: signed in/);
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
  assert.match(text, /\[SKIP\] Azure CLI sign-in/);
});

test('runDoctor reports missing azure-devops extension and signed-out Azure CLI with exact fix commands', async () => {
  const report = await runDoctor({
    nodeVersion: '26.0.0',
    resolveAz: async () => ({ file: 'C:\\az\\python.exe', prefix: ['-IBm', 'azure.cli'], env: { AZ_INSTALLER: 'MSI' } }),
    async runCommand(file, args) {
      if (file === 'git') return { stdout: 'git version 2.47.0\n', stderr: '' };
      if (args.includes('version')) return { stdout: JSON.stringify({ 'azure-cli': '2.70.0' }), stderr: '' };
      if (args.includes('extension')) throw new Error('The extension azure-devops is not installed.');
      if (args.includes('account')) throw new Error('Please run az login');
      throw new Error('Unexpected');
    },
  });

  assert.equal(report.ok, false);
  assert.deepEqual(
    report.checks.map(check => [check.id, check.status]),
    [
      ['node', 'ok'],
      ['git', 'ok'],
      ['az', 'ok'],
      ['az-devops', 'fail'],
      ['az-login', 'fail'],
    ],
  );
  const text = formatDoctorReport(report);
  assert.match(text, /Fix: Run: az extension add --name azure-devops/);
  assert.match(text, /Fix: Run: az login/);
});

test('runDoctor fails cleanly on malformed JSON and command timeouts', async () => {
  const report = await runDoctor({
    nodeVersion: '26.1.0',
    resolveAz: defaultAz,
    async runCommand(file, args) {
      if (file === 'git') throw Object.assign(new Error('timeout'), { killed: true });
      if (args[0] === 'version') return { stdout: JSON.stringify({ 'azure-cli': '2.93.0' }), stderr: '' };
      if (args[0] === 'extension') return { stdout: 'not-json', stderr: '' };
      if (args[0] === 'account') return { stdout: '{}', stderr: '' };
      throw new Error('Unexpected');
    },
  });

  assert.equal(report.ok, false);
  assert.equal(report.checks.find(c => c.id === 'git')?.detail, 'timed out');
  assert.equal(report.checks.find(c => c.id === 'az-devops')?.status, 'fail');
  assert.equal(report.checks.find(c => c.id === 'az-login')?.status, 'fail');
});

test('runDoctor handles resolveAz failures and unexpected az version payloads without throwing', async () => {
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
