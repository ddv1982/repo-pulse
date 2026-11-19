// @ts-check

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, win32 } from 'node:path';
import { normalizeOrganization } from './repositories.js';

/**
 * @typedef {Error & { code: string }} CliError
 * @typedef {{ code?: string, name?: string, stderr?: unknown, killed?: boolean, message?: string }} ExecFailure
 * @typedef {{ signal: AbortSignal, timeoutMs: number }} ExecutorOptions
 * @typedef {(args: string[], options: ExecutorOptions) => Promise<unknown>} Executor
 * @typedef {{ file: string, prefix: string[], env: Record<string, string>, cwd?: string }} AzCommand
 * @typedef {'commitsbatch' | 'pullrequestquery'} ReadQueryResource
 * @typedef {{ organization: string, project: string, repositoryId: string, resource: ReadQueryResource }} ReadQueryTarget
 * @typedef {{ type: 'lastMergeCommit' | 'commit', items: string[] }} PullRequestQuery
 * @typedef {{ ids: string[] } | { queries: PullRequestQuery[] }} ReadQueryBody
 * @typedef {{ args: string[], body?: ReadQueryBody, key: string, resolve: (value: unknown) => void, reject: (reason: unknown) => void }} QueueJob
 * @typedef {{ code: string | undefined, message: string | undefined }} LastError
 */

const exec = promisify(execFile);
/** @type {Record<string, Set<string>>} */
const RESOURCES = {
  git: new Set(['pushes', 'refs', 'pullrequests', 'pullrequestthreads', 'commits']),
  build: new Set(['builds']),
  policy: new Set(['evaluations']),
  location: new Set(['connectiondata']),
};

/**
 * @param {string} code
 * @param {string} message
 * @returns {CliError}
 */
export function cliError(code, message) {
  return Object.assign(new Error(message), { code });
}

/** @param {ExecFailure | null | undefined} error */
export function classifyCliError(error) {
  if (error?.code === 'CLOSED') return error;
  // execFile's message repeats the command line, whose arguments must not drive classification.
  const text = String(error?.stderr || '');
  if (error?.code === 'ENOENT')
    return cliError('CLI_MISSING', 'Azure CLI was not found. Install Azure CLI and its azure-devops extension.');
  // Reads are aborted only by close(); the timeout option kills the process instead.
  if (error?.name === 'AbortError') return cliError('CLOSED', 'Azure CLI queue is closed.');
  if (error?.killed || error?.code === 'ETIMEDOUT') return cliError('TIMEOUT', 'Azure CLI timed out. Cached activity is retained.');
  if (/429|too many requests|rate.limit|TF400733/i.test(text))
    return cliError('THROTTLED', 'Azure DevOps asked us to slow down. Retrying later.');
  if (/403|forbidden|TF401027|permission|not authorized/i.test(text))
    return cliError('FORBIDDEN', 'Azure DevOps refused this read. Check the CLI identity and repository permissions.');
  if (/401|az login|authentication|unauthorized|AADSTS|token.*expired|sign.in/i.test(text))
    return cliError('AUTH_REQUIRED', 'Azure CLI sign-in is unavailable or expired. Reconnect in your terminal, then retry.');
  if (/404|not found|TF401019/i.test(text))
    return cliError('NOT_FOUND', 'The requested Azure DevOps resource was not found or is not accessible.');
  if (/extension|unrecognized arguments|not in the.*command group|misspelled/i.test(text))
    return cliError('CLI_SETUP', 'Azure CLI or its azure-devops extension does not support this read. Check the installation.');
  if (/5\d\d|connection|network|resolve|timeout|SSL|certificate|proxy|unreachable/i.test(text))
    return cliError('UNAVAILABLE', 'Azure DevOps could not be reached. Check your connection or VPN.');
  return cliError('CLI_ERROR', 'Azure CLI could not complete this read. Check access and try again.');
}

/** @param {unknown} args */
function allowed(args) {
  if (!Array.isArray(args) || args.some(a => typeof a !== 'string' || a.includes('\0'))) return false;
  if (args.some(a => ['--debug', '--verbose', '--query', '--in-file', '--out-file', '--subscription'].includes(a))) return false;
  const command = args.slice(0, 3).join(' ');
  if (args[0] === 'version') return args.length === 1;
  if (command === 'extension show --name') return args[3] === 'azure-devops' && args.length === 4;
  if (args.slice(0, 2).join(' ') === 'account show') return args.length === 2;
  if (args.slice(0, 3).join(' ') === 'repos pr show' && args.includes('--id')) return true;
  if (['repos show --repository', 'devops project list'].some(prefix => command === prefix || args.slice(0, 3).join(' ') === prefix))
    return true;
  if (args.slice(0, 2).join(' ') !== 'devops invoke') return false;
  /** @param {string} flag */
  const value = flag => args[args.indexOf(flag) + 1];
  if (!args.includes('--http-method') || value('--http-method') !== 'GET') return false;
  return RESOURCES[value('--area')]?.has(value('--resource')?.toLowerCase()) === true && args.includes('--api-version');
}

/**
 * @param {unknown} ids
 * @returns {string[]}
 */
export function normalizeCommitIds(ids) {
  if (!Array.isArray(ids) || ids.length > 100 || ids.some(id => typeof id !== 'string' || !/^[0-9a-f]{40}$/i.test(id))) {
    throw cliError('INVALID_QUERY', 'Commit queries require at most 100 complete commit IDs.');
  }
  return [...new Set(ids.map(id => id.toLowerCase()))];
}

/**
 * @param {string | undefined} resource
 * @param {unknown} body
 * @returns {ReadQueryBody}
 */
function readQueryBody(resource, body) {
  /**
   * Values stay untyped: callers check each one before use.
   * @template {string} K
   * @param {unknown} object
   * @param {K[]} keys
   * @returns {object is Record<K, any>}
   */
  const exactKeys = (object, keys) =>
    !!object &&
    typeof object === 'object' &&
    !Array.isArray(object) &&
    Object.keys(object).length === keys.length &&
    keys.every(key => Object.hasOwn(object, key));
  if (resource === 'commitsbatch' && exactKeys(body, ['ids'])) {
    const ids = normalizeCommitIds(body.ids);
    if (ids.length) return { ids };
  }
  if (
    resource === 'pullrequestquery' &&
    exactKeys(body, ['queries']) &&
    Array.isArray(body.queries) &&
    body.queries.length > 0 &&
    body.queries.length <= 2
  ) {
    const types = new Set();
    const queries = body.queries.map(query => {
      if (!exactKeys(query, ['type', 'items']) || !['lastMergeCommit', 'commit'].includes(query.type) || types.has(query.type))
        throw cliError('INVALID_QUERY', 'Only bounded commit-to-PR read queries are allowed.');
      types.add(query.type);
      const items = normalizeCommitIds(query.items);
      if (!items.length) throw cliError('INVALID_QUERY', 'Commit queries need at least one commit ID.');
      return { type: query.type, items };
    });
    return { queries };
  }
  throw cliError('INVALID_QUERY', 'Only bounded commit and commit-to-PR read queries are allowed.');
}

/** @param {Partial<ReadQueryTarget>} [target] */
function readQueryArgs({ organization, project, repositoryId, resource } = {}) {
  if (
    typeof resource !== 'string' ||
    !['commitsbatch', 'pullrequestquery'].includes(resource) ||
    typeof project !== 'string' ||
    !project ||
    project.length > 256 ||
    /[\x00-\x1f]/.test(project) ||
    project.startsWith('-') ||
    typeof repositoryId !== 'string' ||
    !/^[a-z0-9][a-z0-9._-]{0,199}$/i.test(repositoryId)
  ) {
    throw cliError('INVALID_QUERY', 'Choose a valid repository for this read query.');
  }
  return [
    'devops',
    'invoke',
    '--organization',
    normalizeOrganization(organization),
    '--detect',
    'false',
    '--area',
    'git',
    '--resource',
    resource,
    '--api-version',
    '7.1',
    '--http-method',
    'POST',
    '--route-parameters',
    `project=${project}`,
    `repositoryId=${repositoryId}`,
  ];
}

/** @param {string} path */
const isFile = path =>
  stat(path).then(
    entry => entry.isFile(),
    () => false,
  );

/**
 * Windows ships az as a batch file, which Node runs only through cmd.exe, and cmd.exe would
 * reparse arguments such as project names (CVE-2024-27980). Instead run the interpreter each
 * official launcher calls, with the same flags, so arguments go to Python unparsed.
 * @param {{ platform?: NodeJS.Platform, env?: NodeJS.ProcessEnv, exists?: (path: string) => Promise<boolean> }} [options]
 * @returns {Promise<AzCommand>}
 */
export async function resolveAzCommand({ platform = process.platform, env = process.env, exists = isFile } = {}) {
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

/** @type {Promise<AzCommand> | undefined} */
let azCommand;
/** @type {(args: string[], options: ExecutorOptions) => Promise<string>} */
export async function defaultExecutor(args, { signal, timeoutMs }) {
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
 * @param {{
 *   limitPerMinute?: number, concurrency?: number, timeoutMs?: number, executor?: Executor, now?: () => number,
 *   setTimer?: (callback: () => void, ms: number) => NodeJS.Timeout, clearTimer?: (timer: NodeJS.Timeout) => void, tempRoot?: string,
 * }} [options]
 */
export function createAzureCli({
  limitPerMinute = 12,
  concurrency = 2,
  timeoutMs = 30_000,
  executor = defaultExecutor,
  now = Date.now,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  tempRoot = tmpdir(),
} = {}) {
  if (!Number.isInteger(limitPerMinute) || limitPerMinute < 1 || !Number.isInteger(concurrency) || concurrency < 1)
    throw new Error('Invalid CLI limits');
  /** @type {QueueJob[]} */
  const pending = [],
    /** @type {Map<string, Promise<unknown>>} */
    inFlight = new Map(),
    /** @type {Set<AbortController>} */
    running = new Set(),
    /** @type {number[]} */
    starts = [];
  /** @type {NodeJS.Timeout | undefined} */
  let timer,
    closed = false,
    totalStarts = 0,
    /** @type {LastError | null} */
    lastError = null;
  /**
   * @param {QueueJob} job
   * @param {AbortSignal} signal
   */
  async function executeJob(job, signal) {
    if (!job.body) return executor(job.args, { signal, timeoutMs });
    // Invoke accepts JSON through a file only. The app owns this private file;
    // no caller can supply a path, extra flags, a general POST or arbitrary JSON.
    const directory = await mkdtemp(join(tempRoot, 'repo-pulse-query-'));
    try {
      const path = join(directory, 'query.json');
      await writeFile(path, JSON.stringify(job.body), { mode: 0o600, flag: 'wx' });
      if (signal.aborted) throw cliError('CLOSED', 'Azure CLI queue is closed.');
      return await executor([...job.args, '--in-file', path], { signal, timeoutMs });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
  /**
   * @param {string[]} args
   * @param {ReadQueryBody} [body]
   * @returns {Promise<unknown>}
   */
  function enqueue(args, body) {
    if (closed) return Promise.reject(cliError('CLOSED', 'Azure CLI queue is closed.'));
    const key = JSON.stringify([args, body]);
    const existing = inFlight.get(key);
    if (existing) return existing;
    const promise = new Promise((resolve, reject) => pending.push({ args: [...args], body, key, resolve, reject }));
    inFlight.set(key, promise);
    pump();
    return promise;
  }
  function pump() {
    if (closed) return;
    if (timer) {
      clearTimer(timer);
      timer = undefined;
    }
    const time = now();
    while (starts.length && starts[0] <= time - 60_000) starts.shift();
    while (pending.length && running.size < concurrency && starts.length < limitPerMinute) {
      // The loop condition guarantees a job.
      const job = /** @type {QueueJob} */ (pending.shift());
      const controller = new AbortController();
      running.add(controller);
      starts.push(now());
      totalStarts++;
      Promise.resolve()
        .then(() => executeJob(job, controller.signal))
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
    if (pending.length && starts.length >= limitPerMinute && running.size < concurrency) {
      timer = setTimer(pump, Math.max(1, starts[0] + 60_000 - now()));
    }
  }
  return {
    /** @param {string[]} args */
    run(args) {
      if (closed) return Promise.reject(cliError('CLOSED', 'Azure CLI queue is closed.'));
      if (!allowed(args)) return Promise.reject(cliError('READ_ONLY', 'This Azure CLI operation is not allowed.'));
      return enqueue(args);
    },
    /**
     * @param {Partial<ReadQueryTarget>} repository
     * @param {unknown} body
     */
    runReadQuery(repository, body) {
      try {
        const args = readQueryArgs(repository);
        return enqueue(args, readQueryBody(repository.resource, body));
      } catch (error) {
        return Promise.reject(error);
      }
    },
    diagnostics() {
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
