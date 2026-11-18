import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizeOrganization } from './repositories.js';

const exec = promisify(execFile);
const RESOURCES = { git: new Set(['pushes', 'refs', 'pullrequests', 'commits']), build: new Set(['builds']), location: new Set(['connectiondata']) };

export function cliError(code, message) {
  return Object.assign(new Error(message), { code });
}

export function classifyCliError(error) {
  if (error?.code === 'CLOSED') return error;
  // execFile's message repeats the command line, whose arguments must not drive classification.
  const text = String(error?.stderr || '');
  if (error?.code === 'ENOENT') return cliError('CLI_MISSING', 'Azure CLI was not found. Install Azure CLI and its azure-devops extension.');
  // Reads are aborted only by close(); the timeout option kills the process instead.
  if (error?.name === 'AbortError') return cliError('CLOSED', 'Azure CLI queue is closed.');
  if (error?.killed || error?.code === 'ETIMEDOUT') return cliError('TIMEOUT', 'Azure CLI timed out. Cached activity is retained.');
  if (/429|too many requests|rate.limit|TF400733/i.test(text)) return cliError('THROTTLED', 'Azure DevOps asked us to slow down. Retrying later.');
  if (/403|forbidden|TF401027|permission|not authorized/i.test(text)) return cliError('FORBIDDEN', 'Azure DevOps refused this read. Check the CLI identity and repository permissions.');
  if (/401|az login|authentication|unauthorized|AADSTS|token.*expired|sign.in/i.test(text)) return cliError('AUTH_REQUIRED', 'Azure CLI sign-in is unavailable or expired. Reconnect in your terminal, then retry.');
  if (/404|not found|TF401019/i.test(text)) return cliError('NOT_FOUND', 'The requested Azure DevOps resource was not found or is not accessible.');
  if (/extension|unrecognized arguments|not in the.*command group|misspelled/i.test(text)) return cliError('CLI_SETUP', 'Azure CLI or its azure-devops extension does not support this read. Check the installation.');
  if (/5\d\d|connection|network|resolve|timeout|SSL|certificate|proxy|unreachable/i.test(text)) return cliError('UNAVAILABLE', 'Azure DevOps could not be reached. Check your connection or VPN.');
  return cliError('CLI_ERROR', 'Azure CLI could not complete this read. Check access and try again.');
}

function allowed(args) {
  if (!Array.isArray(args) || args.some(a => typeof a !== 'string' || a.includes('\0'))) return false;
  if (args.some(a => ['--debug', '--verbose', '--query', '--in-file', '--out-file', '--subscription'].includes(a))) return false;
  const command = args.slice(0, 3).join(' ');
  if (args[0] === 'version') return args.length === 1;
  if (command === 'extension show --name') return args[3] === 'azure-devops' && args.length === 4;
  if (args.slice(0, 2).join(' ') === 'account show') return args.length === 2;
  if (args.slice(0, 3).join(' ') === 'repos pr show' && args.includes('--id')) return true;
  if (['repos show --repository', 'devops project list'].some(prefix => command === prefix || args.slice(0, 3).join(' ') === prefix)) return true;
  if (args.slice(0, 2).join(' ') !== 'devops invoke') return false;
  const value = flag => args[args.indexOf(flag) + 1];
  if (!args.includes('--http-method') || value('--http-method') !== 'GET') return false;
  return RESOURCES[value('--area')]?.has(value('--resource')?.toLowerCase()) === true && args.includes('--api-version');
}

export function normalizeCommitIds(ids) {
  if (!Array.isArray(ids) || ids.length > 100 || ids.some(id => typeof id !== 'string' || !/^[0-9a-f]{40}$/i.test(id))) {
    throw cliError('INVALID_QUERY', 'Commit queries require at most 100 complete commit IDs.');
  }
  return [...new Set(ids.map(id => id.toLowerCase()))];
}

function readQueryBody(resource, body) {
  const exactKeys = (object, keys) => object && typeof object === 'object' && !Array.isArray(object) && Object.keys(object).length === keys.length && keys.every(key => Object.hasOwn(object, key));
  if (resource === 'commitsbatch' && exactKeys(body, ['ids'])) {
    const ids = normalizeCommitIds(body.ids);
    if (ids.length) return { ids };
  }
  if (resource === 'pullrequestquery' && exactKeys(body, ['queries']) && Array.isArray(body.queries) && body.queries.length > 0 && body.queries.length <= 2) {
    const types = new Set();
    const queries = body.queries.map(query => {
      if (!exactKeys(query, ['type', 'items']) || !['lastMergeCommit', 'commit'].includes(query.type) || types.has(query.type)) throw cliError('INVALID_QUERY', 'Only bounded commit-to-PR read queries are allowed.');
      types.add(query.type);
      const items = normalizeCommitIds(query.items);
      if (!items.length) throw cliError('INVALID_QUERY', 'Commit queries need at least one commit ID.');
      return { type: query.type, items };
    });
    return { queries };
  }
  throw cliError('INVALID_QUERY', 'Only bounded commit and commit-to-PR read queries are allowed.');
}

function readQueryArgs({ organization, project, repositoryId, resource } = {}) {
  if (!['commitsbatch', 'pullrequestquery'].includes(resource) || typeof project !== 'string' || !project || project.length > 256 || /[\x00-\x1f]/.test(project) || project.startsWith('-') || typeof repositoryId !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,199}$/i.test(repositoryId)) {
    throw cliError('INVALID_QUERY', 'Choose a valid repository for this read query.');
  }
  return ['devops', 'invoke', '--organization', normalizeOrganization(organization), '--detect', 'false', '--area', 'git', '--resource', resource, '--api-version', '7.1', '--http-method', 'POST', '--route-parameters', `project=${project}`, `repositoryId=${repositoryId}`];
}

async function defaultExecutor(args, { signal, timeoutMs }) {
  const { stdout } = await exec('az', [...args, '--output', 'json', '--only-show-errors'], {
    signal, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, windowsHide: true,
    env: { ...process.env, AZURE_CORE_COLLECT_TELEMETRY: 'false', AZURE_EXTENSION_USE_DYNAMIC_INSTALL: 'no' },
  });
  return stdout;
}

/** One process-wide queue: callers cannot bypass rate or concurrency limits. */
export function createAzureCli({ limitPerMinute = 12, concurrency = 2, timeoutMs = 30_000, executor = defaultExecutor, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout, tempRoot = tmpdir() } = {}) {
  if (!Number.isInteger(limitPerMinute) || limitPerMinute < 1 || !Number.isInteger(concurrency) || concurrency < 1) throw new Error('Invalid CLI limits');
  const pending = [], inFlight = new Map(), running = new Set(), starts = [];
  let timer, closed = false, totalStarts = 0, lastError = null;
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
  function enqueue(args, body) {
    if (closed) return Promise.reject(cliError('CLOSED', 'Azure CLI queue is closed.'));
    const key = JSON.stringify([args, body]);
    if (inFlight.has(key)) return inFlight.get(key);
    const promise = new Promise((resolve, reject) => pending.push({ args: [...args], body, key, resolve, reject }));
    inFlight.set(key, promise); pump(); return promise;
  }
  function pump() {
    if (closed) return;
    if (timer) { clearTimer(timer); timer = undefined; }
    const time = now();
    while (starts.length && starts[0] <= time - 60_000) starts.shift();
    while (pending.length && running.size < concurrency && starts.length < limitPerMinute) {
      const job = pending.shift();
      const controller = new AbortController();
      running.add(controller); starts.push(now()); totalStarts++;
      Promise.resolve().then(() => executeJob(job, controller.signal)).then(result => {
        if (closed) throw cliError('CLOSED', 'Azure CLI queue is closed.');
        try { return typeof result === 'string' ? JSON.parse(result) : result; }
        catch { throw cliError('INVALID_RESPONSE', 'Azure CLI returned an invalid JSON response.'); }
      }).then(job.resolve, error => {
        const safe = error?.code === 'INVALID_RESPONSE' ? error : classifyCliError(error);
        lastError = { code: safe.code, message: safe.message }; job.reject(safe);
      }).finally(() => { running.delete(controller); inFlight.delete(job.key); pump(); });
    }
    if (pending.length && starts.length >= limitPerMinute && running.size < concurrency) {
      timer = setTimer(pump, Math.max(1, starts[0] + 60_000 - now()));
    }
  }
  return {
    run(args) {
      if (closed) return Promise.reject(cliError('CLOSED', 'Azure CLI queue is closed.'));
      if (!allowed(args)) return Promise.reject(cliError('READ_ONLY', 'This Azure CLI operation is not allowed.'));
      return enqueue(args);
    },
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
      return { startsLastMinute: recent.length, totalStarts, pending: pending.length, running: running.size, limitPerMinute, concurrency, upstreamRequests: null, lastError };
    },
    close() {
      closed = true; if (timer) clearTimer(timer);
      for (const job of pending.splice(0)) { inFlight.delete(job.key); job.reject(cliError('CLOSED', 'Azure CLI queue is closed.')); }
      for (const controller of running) controller.abort();
    },
  };
}
