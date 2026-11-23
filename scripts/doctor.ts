import { execFile } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { resolveAzCommand } from '../server/azure-cli.js';

const execFileAsync = promisify(execFile);
const MIN_NODE_MAJOR = 26;
const COMMAND_TIMEOUT_MS = 15000;

export type DoctorCheck = { id: string; label: string; status: 'ok' | 'fail' | 'skip'; detail: string; fix?: string };

export type DoctorReport = { ok: boolean; checks: DoctorCheck[] };

export type CommandOutput = { stdout: string; stderr: string };

export type CommandRunner = (
  file: string,
  args: string[],
  options?: { env?: NodeJS.ProcessEnv; cwd?: string; timeout?: number },
) => Promise<CommandOutput>;

export type AzCommand = Awaited<ReturnType<typeof resolveAzCommand>>;

async function defaultRunCommand(file: string, args: string[], options: { env?: NodeJS.ProcessEnv; cwd?: string; timeout?: number } = {}) {
  const { stdout, stderr } = await execFileAsync(file, args, {
    encoding: 'utf8',
    timeout: COMMAND_TIMEOUT_MS,
    maxBuffer: 1024 * 1024,
    ...options,
  });
  return { stdout: String(stdout || ''), stderr: String(stderr || '') };
}

function parseJsonObject(text: string): Record<string, any> | null {
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isMissingBinary(error: unknown) {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT');
}

function isTimeout(error: unknown) {
  return Boolean(
    error && typeof error === 'object' && (('killed' in error && error.killed) || ('code' in error && error.code === 'ETIMEDOUT')),
  );
}

function errorText(error: unknown) {
  if (!error || typeof error !== 'object') return '';
  const stderr = 'stderr' in error ? String(error.stderr || '') : '';
  const message = 'message' in error ? String(error.message || '') : '';
  return `${stderr}\n${message}`;
}

function runAz(az: AzCommand, runCommand: CommandRunner, args: string[]) {
  return runCommand(az.file, [...az.prefix, ...args], {
    env: Object.keys(az.env).length ? { ...process.env, ...az.env } : process.env,
    ...(az.cwd ? { cwd: az.cwd } : {}),
  });
}

function checkNode(nodeVersion: string): DoctorCheck {
  const cleaned = String(nodeVersion || '').replace(/^v/i, '');
  const major = Number(cleaned.split('.')[0]);
  if (Number.isInteger(major) && major >= MIN_NODE_MAJOR) {
    return { id: 'node', label: 'Node.js', status: 'ok', detail: `v${cleaned}` };
  }
  return {
    id: 'node',
    label: 'Node.js',
    status: 'fail',
    detail: `v${cleaned || 'unknown'} found; requires Node.js ${MIN_NODE_MAJOR}+`,
    fix: `Install Node.js ${MIN_NODE_MAJOR} or newer and rerun npm run doctor.`,
  };
}

async function checkGit(runCommand: CommandRunner): Promise<DoctorCheck> {
  try {
    const { stdout } = await runCommand('git', ['--version']);
    const line = stdout.trim().split(/\r?\n/)[0] || 'available';
    return { id: 'git', label: 'Git', status: 'ok', detail: line };
  } catch (error) {
    return {
      id: 'git',
      label: 'Git',
      status: 'fail',
      detail: isMissingBinary(error) ? 'not found on PATH' : isTimeout(error) ? 'timed out' : 'could not run git --version',
      fix: 'Install Git and ensure `git` is on your PATH.',
    };
  }
}

async function checkAzureCli(
  resolveAz: typeof resolveAzCommand,
  runCommand: CommandRunner,
): Promise<{ az: AzCommand | null; check: DoctorCheck }> {
  try {
    const az = await resolveAz();
    const { stdout } = await runAz(az, runCommand, ['version', '--output', 'json']);
    const parsed = parseJsonObject(stdout);
    const version = typeof parsed?.['azure-cli'] === 'string' ? parsed['azure-cli'] : null;
    if (version) return { az, check: { id: 'az', label: 'Azure CLI', status: 'ok', detail: version } };
    return {
      az: null,
      check: {
        id: 'az',
        label: 'Azure CLI',
        status: 'fail',
        detail: 'returned unexpected output from `az version`',
        fix: 'Reinstall or repair the Azure CLI: https://learn.microsoft.com/cli/azure/install-azure-cli',
      },
    };
  } catch (error) {
    return {
      az: null,
      check: {
        id: 'az',
        label: 'Azure CLI',
        status: 'fail',
        detail: isMissingBinary(error) ? 'not found on PATH' : isTimeout(error) ? 'timed out' : 'could not run `az version`',
        fix: 'Install the Azure CLI: https://learn.microsoft.com/cli/azure/install-azure-cli',
      },
    };
  }
}

async function checkDevopsExtension(az: AzCommand, runCommand: CommandRunner): Promise<DoctorCheck> {
  try {
    const { stdout } = await runAz(az, runCommand, ['extension', 'show', '--name', 'azure-devops', '--output', 'json']);
    const parsed = parseJsonObject(stdout);
    const version = typeof parsed?.version === 'string' ? parsed.version : null;
    if (version) return { id: 'az-devops', label: 'azure-devops extension', status: 'ok', detail: version };
    return {
      id: 'az-devops',
      label: 'azure-devops extension',
      status: 'fail',
      detail: 'extension metadata could not be read',
      fix: 'Run: az extension add --name azure-devops',
    };
  } catch (error) {
    const missing = /extension\s+['"`]?azure-devops['"`]?\s+(?:is\s+)?not\s+(?:installed|found)/i.test(errorText(error));
    return {
      id: 'az-devops',
      label: 'azure-devops extension',
      status: 'fail',
      detail: isTimeout(error) ? 'timed out' : missing ? 'not installed' : 'could not inspect azure-devops extension',
      fix: missing
        ? 'Run: az extension add --name azure-devops'
        : 'Check your Azure CLI installation or run: az extension add --name azure-devops',
    };
  }
}

async function checkAzureLogin(az: AzCommand, runCommand: CommandRunner): Promise<DoctorCheck> {
  try {
    const { stdout } = await runAz(az, runCommand, ['account', 'show', '--output', 'json']);
    const parsed = parseJsonObject(stdout);
    if (parsed && (parsed.id || parsed.name || parsed.user)) {
      return { id: 'az-login', label: 'Azure CLI account', status: 'ok', detail: 'cached Azure CLI account found' };
    }
    return {
      id: 'az-login',
      label: 'Azure CLI account',
      status: 'fail',
      detail: 'account details could not be read',
      fix: 'Run: az login',
    };
  } catch (error) {
    const signedOut = /please\s+run\s+['"`]?az login['"`]?|not\s+logged\s+in\s+to\s+azure|no\s+subscriptions?\s+found/i.test(
      errorText(error),
    );
    return {
      id: 'az-login',
      label: 'Azure CLI account',
      status: 'fail',
      detail: isTimeout(error) ? 'timed out' : signedOut ? 'not signed in' : 'could not inspect cached Azure CLI account',
      fix: signedOut ? 'Run: az login' : 'Check your Azure CLI installation or run: az login',
    };
  }
}

/**
 * Checks local prerequisites for running Repo Pulse against Azure DevOps.
 */
export async function runDoctor({
  nodeVersion = process.versions.node,
  runCommand = defaultRunCommand,
  resolveAz = resolveAzCommand,
}: { nodeVersion?: string; runCommand?: CommandRunner; resolveAz?: typeof resolveAzCommand } = {}): Promise<DoctorReport> {
  const nodeCheck = checkNode(nodeVersion);
  const gitCheck = await checkGit(runCommand);
  const { az, check: azCheck } = await checkAzureCli(resolveAz, runCommand);
  const checks: DoctorCheck[] = [nodeCheck, gitCheck, azCheck];

  if (!az) {
    checks.push(
      { id: 'az-devops', label: 'azure-devops extension', status: 'skip', detail: 'skipped (Azure CLI unavailable)' },
      { id: 'az-login', label: 'Azure CLI account', status: 'skip', detail: 'skipped (Azure CLI unavailable)' },
    );
    return { ok: false, checks };
  }

  checks.push(await checkDevopsExtension(az, runCommand), await checkAzureLogin(az, runCommand));
  return { ok: checks.every(check => check.status === 'ok'), checks };
}

export function formatDoctorReport(report: DoctorReport) {
  const tags = { ok: '[OK]  ', fail: '[FAIL]', skip: '[SKIP]' };
  const lines = [];
  for (const check of report.checks) {
    lines.push(`${tags[check.status]} ${check.label}: ${check.detail}`);
    if (check.fix) lines.push(`       Fix: ${check.fix}`);
  }
  lines.push('');
  const canRunDemo = report.checks.some(check => check.id === 'node' && check.status === 'ok');
  lines.push(
    report.ok
      ? 'All prerequisites look good. Run `npm start` to launch Repo Pulse (or `npm run demo` to try without Azure).'
      : 'One or more prerequisites failed. Fix the items above.' +
          (canRunDemo ? ' Run `npm run demo` to try Repo Pulse without Azure.' : ''),
  );
  return lines.join('\n');
}

function isMainEntry(entryPath: string | undefined) {
  if ('main' in import.meta && typeof import.meta.main === 'boolean') return import.meta.main;
  if (!entryPath) return false;
  try {
    return realpathSync(resolve(entryPath)) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return pathToFileURL(resolve(entryPath)).href === import.meta.url;
  }
}

if (isMainEntry(process.argv[1])) {
  const report = await runDoctor();
  console.log(formatDoctorReport(report));
  if (!report.ok) process.exitCode = 1;
}
