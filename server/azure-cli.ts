import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { stat } from 'node:fs/promises';
import { win32 } from 'node:path';
import type { CliLastError as LastError } from '../src/contract.d.ts';

export type CliError = Error & { code: string };

export type ExecFailure = { code?: string; name?: string; stderr?: unknown; killed?: boolean; message?: string };

export type ExecutorOptions = { signal: AbortSignal; timeoutMs: number; retryAfter?: (ms: number) => void; throttledUntil?: () => number };

export type Executor = (args: string[], options: ExecutorOptions) => Promise<unknown>;

export type AzCommand = { file: string; prefix: string[]; env: Record<string, string>; cwd?: string };

export type QueueJob = { args: string[]; key: string; resolve: (value: unknown) => void; reject: (reason: unknown) => void };

export type { LastError };

const exec = promisify(execFile);
const MAX_RETRY_AFTER_MS = 10 * 60000;
const RESOURCES: Record<string, Set<string>> = {
  git: new Set(['pushes', 'refs', 'pullrequests', 'pullrequestthreads', 'commits']),
  build: new Set(['builds']),
  policy: new Set(['evaluations']),
  location: new Set(['connectiondata']),
};

export function cliError(code: string, message: string): CliError {
  return Object.assign(new Error(message), { code });
}

export function classifyCliError(error: ExecFailure | null | undefined) {
  if (error?.code === 'CLOSED') return error;
  // execFile's message repeats the command line, whose arguments must not drive classification.
  const stderr = error?.stderr;
  const text = Buffer.isBuffer(stderr) ? stderr.toString() : typeof stderr === 'string' ? stderr : '';
  if (error?.code === 'ENOENT')
    return cliError('CLI_MISSING', 'Azure CLI was not found. Install Azure CLI and its azure-devops extension.');
  // Reads are aborted only by close(); the timeout option kills the process instead.
  if (error?.name === 'AbortError') return cliError('CLOSED', 'Azure CLI queue is closed.');
  if (error?.killed || error?.code === 'ETIMEDOUT') return cliError('TIMEOUT', 'Azure CLI timed out. Cached activity is retained.');
  // Status numbers match as whole words: Azure error numbers such as TF401180 contain 401 without being a status.
  if (/\b429\b|too many requests|rate.limit|TF400733/i.test(text))
    return cliError('THROTTLED', 'Azure DevOps asked us to slow down. Retrying later.');
  if (/\b403\b|forbidden|TF401027|permission|not authorized/i.test(text))
    return cliError('FORBIDDEN', 'Azure DevOps refused this read. Check the CLI identity and repository permissions.');
  if (/\b401\b|az login|authentication|unauthorized|AADSTS|token.*expired|sign.in/i.test(text))
    return cliError('AUTH_REQUIRED', 'Azure CLI sign-in is unavailable or expired. Reconnect in your terminal, then retry.');
  if (/\b404\b|not found|TF401019|TF401180/i.test(text))
    return cliError('NOT_FOUND', 'The requested Azure DevOps resource was not found or is not accessible.');
  if (/extension|unrecognized arguments|not in the.*command group|misspelled/i.test(text))
    return cliError('CLI_SETUP', 'Azure CLI or its azure-devops extension does not support this read. Check the installation.');
  if (/\b5\d\d\b|connection|network|resolve|timeout|SSL|certificate|proxy|unreachable/i.test(text))
    return cliError('UNAVAILABLE', 'Azure DevOps could not be reached. Check your connection or VPN.');
  return cliError('CLI_ERROR', 'Azure CLI could not complete this read. Check access and try again.');
}

function allowed(args: unknown) {
  if (!Array.isArray(args) || args.some(a => typeof a !== 'string' || a.includes('\0'))) return false;
  if (args.some(a => ['--debug', '--verbose', '--query', '--in-file', '--out-file', '--subscription'].includes(a))) return false;
  const command = args.slice(0, 3).join(' ');
  if (args[0] === 'version') return args.length === 1;
  if (command === 'extension show --name') return args[3] === 'azure-devops' && args.length === 4;
  if (args.slice(0, 2).join(' ') === 'account show') return args.length === 2;
  if (args.slice(0, 3).join(' ') === 'repos pr show' && args.includes('--id')) return true;
  if (['repos show --repository', 'devops project list'].includes(command)) return true;
  if (args.slice(0, 2).join(' ') !== 'devops invoke') return false;
  const value = (flag: string) => args[args.indexOf(flag) + 1];
  if (!args.includes('--http-method') || value('--http-method') !== 'GET') return false;
  return RESOURCES[value('--area')]?.has(value('--resource')?.toLowerCase()) === true && args.includes('--api-version');
}

const isFile = (path: string) =>
  stat(path).then(
    entry => entry.isFile(),
    () => false,
  );

/**
 * Windows ships az as a batch file, which Node runs only through cmd.exe, and cmd.exe would
 * reparse arguments such as project names (CVE-2024-27980). Instead run the interpreter each
 * official launcher calls, with the same flags, so arguments go to Python unparsed.
 */
export async function resolveAzCommand({
  platform = process.platform,
  env = process.env,
  exists = isFile,
}: { platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv; exists?: (path: string) => Promise<boolean> } = {}): Promise<AzCommand> {
  if (platform !== 'win32') return { file: 'az', prefix: [], env: {} };
  const pathKey = Object.keys(env).find(key => key.toUpperCase() === 'PATH');
  const dirs = String(env[String(pathKey)] || '')
    .split(';')
    .map(dir => dir.trim().replace(/^"(.*)"$/, '$1'))
    .filter(Boolean);
  for (const dir of dirs) {
    // A native az.exe, if Azure CLI ever ships one, can run directly.
    if (await exists(win32.join(dir, 'az.exe'))) return { file: win32.join(dir, 'az.exe'), prefix: [], env: {} };
    // MSI (wbin\az.cmd) and ZIP (bin\az.cmd): "%~dp0\..\python.exe" -IBm azure.cli %*
    const bundled = win32.join(dir, '..', 'python.exe');
    if ((await exists(win32.join(dir, 'az.cmd'))) && (await exists(bundled))) {
      return {
        file: bundled,
        prefix: ['-IBm', 'azure.cli'],
        env: { AZ_INSTALLER: win32.basename(dir).toLowerCase() === 'wbin' ? 'MSI' : 'ZIP' },
      };
    }
    // pip (venv Scripts\az.bat): "%~dp0\python.exe" -m azure.cli %*
    if ((await exists(win32.join(dir, 'az.bat'))) && (await exists(win32.join(dir, 'python.exe')))) {
      // Absolute, because the child runs from this folder and a relative PATH entry would resolve twice.
      const scripts = win32.resolve(dir);
      return {
        file: win32.join(scripts, 'python.exe'),
        prefix: ['-m', 'azure.cli'],
        env: { AZ_INSTALLER: 'PIP', PYTHONPATH: [win32.join(scripts, 'src'), env.PYTHONPATH].filter(Boolean).join(';') },
        // python -m puts the working directory on sys.path; run from the venv instead of wherever the app started.
        cwd: scripts,
      };
    }
  }
  throw Object.assign(new Error('Azure CLI was not found on PATH.'), { code: 'ENOENT' });
}

let azCommand: Promise<AzCommand> | undefined;
export async function defaultExecutor(args: string[], { signal, timeoutMs }: ExecutorOptions): Promise<string> {
  // Resolve once per process; a failed lookup is retried so a later install is picked up.
  azCommand ||= resolveAzCommand().catch(error => {
    azCommand = undefined;
    throw error;
  });
  const { file, prefix, env, cwd } = await azCommand;
  const { stdout } = await exec(file, [...prefix, ...args, '--output', 'json', '--only-show-errors'], {
    cwd,
    signal,
    timeout: timeoutMs,
    maxBuffer: 16 * 1024 * 1024,
    windowsHide: true,
    env: { ...process.env, ...env, AZURE_CORE_COLLECT_TELEMETRY: 'false', AZURE_EXTENSION_USE_DYNAMIC_INSTALL: 'no' },
  });
  return stdout;
}

/**
 * One process-wide queue: callers cannot bypass rate or concurrency limits.
 */
export function createAzureCli({
  limitPerMinute = 12,
  concurrency = 2,
  timeoutMs = 30_000,
  executor = defaultExecutor,
  now = Date.now,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
}: {
  limitPerMinute?: number;
  concurrency?: number;
  timeoutMs?: number;
  executor?: Executor;
  now?: () => number;
  setTimer?: (callback: () => void, ms: number) => NodeJS.Timeout;
  clearTimer?: (timer: NodeJS.Timeout) => void;
} = {}) {
  if (!Number.isInteger(limitPerMinute) || limitPerMinute < 1 || !Number.isInteger(concurrency) || concurrency < 1)
    throw new Error('Invalid CLI limits');
  const pending: QueueJob[] = [],
    inFlight: Map<string, Promise<unknown>> = new Map(),
    running: Set<AbortController> = new Set(),
    starts: number[] = [];
  let timer: NodeJS.Timeout | undefined,
    closed = false,
    totalStarts = 0,
    // Azure DevOps asks for this wait in a Retry-After header, which any response can carry.
    throttledUntil = 0,
    lastError: LastError | null = null;
  function enqueue(args: string[]): Promise<unknown> {
    const key = JSON.stringify(args);
    const existing = inFlight.get(key);
    if (existing) return existing;
    const promise = new Promise((resolve, reject) => pending.push({ args: [...args], key, resolve, reject }));
    inFlight.set(key, promise);
    pump();
    return promise;
  }
  function retryAfter(ms: number) {
    if (ms > 0) throttledUntil = Math.max(throttledUntil, now() + Math.min(ms, MAX_RETRY_AFTER_MS));
  }
  function pump() {
    if (closed) return;
    if (timer) {
      clearTimer(timer);
      timer = undefined;
    }
    const time = now();
    if (pending.length && time < throttledUntil) {
      timer = setTimer(pump, throttledUntil - time);
      return;
    }
    while (starts[0] !== undefined && starts[0] <= time - 60_000) starts.shift();
    while (pending.length && running.size < concurrency && starts.length < limitPerMinute) {
      // The loop condition guarantees a job.
      const job = pending.shift() as QueueJob;
      const controller = new AbortController();
      running.add(controller);
      starts.push(now());
      totalStarts++;
      Promise.resolve()
        .then(() => executor(job.args, { signal: controller.signal, timeoutMs, retryAfter, throttledUntil: () => throttledUntil }))
        .then(result => {
          if (closed) throw cliError('CLOSED', 'Azure CLI queue is closed.');
          try {
            return typeof result === 'string' ? JSON.parse(result) : result;
          } catch {
            throw cliError('INVALID_RESPONSE', 'Azure CLI returned an invalid JSON response.');
          }
        })
        .then(job.resolve, error => {
          const safe = error?.code === 'INVALID_RESPONSE' ? error : classifyCliError(error);
          lastError = { code: safe.code, message: safe.message };
          job.reject(safe);
        })
        .finally(() => {
          running.delete(controller);
          inFlight.delete(job.key);
          pump();
        });
    }
    // limitPerMinute is at least 1, so a full minute has an oldest start.
    const [oldest] = starts;
    if (pending.length && oldest !== undefined && starts.length >= limitPerMinute && running.size < concurrency) {
      timer = setTimer(pump, Math.max(1, oldest + 60_000 - now()));
    }
  }
  return {
    run(args: string[]) {
      if (closed) return Promise.reject(cliError('CLOSED', 'Azure CLI queue is closed.'));
      if (!allowed(args)) return Promise.reject(cliError('READ_ONLY', 'This Azure CLI operation is not allowed.'));
      return enqueue(args);
    },
    diagnostics(): import('../src/contract.d.ts').CliDiagnostics {
      const recent = starts.filter(time => time > now() - 60_000);
      return {
        startsLastMinute: recent.length,
        totalStarts,
        pending: pending.length,
        running: running.size,
        limitPerMinute,
        concurrency,
        upstreamRequests: null,
        lastError,
        throttledUntil: throttledUntil > now() ? new Date(throttledUntil).toISOString() : null,
      };
    },
    close() {
      closed = true;
      if (timer) clearTimer(timer);
      for (const job of pending.splice(0)) {
        inFlight.delete(job.key);
        job.reject(cliError('CLOSED', 'Azure CLI queue is closed.'));
      }
      for (const controller of running) controller.abort();
    },
  };
}
