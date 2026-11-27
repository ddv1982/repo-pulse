// Characterization of what each Azure failure becomes, end to end: a read through the live composition (the shared
// queue, the REST reader with its token, and the Azure client) with a fake fetch and a fake az, the error the stream
// stores, and the sync status a person sees. Only `live()` knows how the pieces are composed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createAzureCli } from '../server/azure-cli.ts';
import { createRestExecutor } from '../server/azure-rest.ts';
import { createAzureClient } from '../server/azure-client.ts';
import { syncStatus } from '../server/sync-status.ts';
import type { AzureRepo, AzureStream, StreamState } from '../src/contract.ts';

const START = Date.parse('2026-11-18T10:00:00Z');
const TOKEN = 'secret-token-value';
const repo: AzureRepo = {
  organization: 'https://dev.azure.com/example',
  project: 'P',
  projectId: 'p-id',
  azureId: 'repo-1',
  webUrl: 'https://dev.azure.com/example/P/_git/R',
};

/** What the fake fetch answers for one request. */
type Answer = { status?: number; headers?: Record<string, string>; body?: unknown } | { error: unknown };
/** What the fake az prints or how it fails, by command. */
type AzAnswer = { stdout?: string } | { error: unknown };

/** An az failure as execFile reports it: the command line in the message, Azure's text in stderr. */
const azFailure = (stderr: string) =>
  Object.assign(new Error(`Command failed: az ${'x'.repeat(5)} 401 403 404 429 503`), { code: 1, stderr });

function live({ answers = [], az = () => undefined }: { answers?: Answer[]; az?: (args: string[]) => AzAnswer | undefined } = {}) {
  const time = START;
  const requests: string[] = [];
  const cliExecutor = async (args: string[]) => {
    const answer = az(args);
    if (answer && 'error' in answer) throw answer.error;
    if (answer?.stdout !== undefined) return answer.stdout;
    if (args[0] === 'account' && args[1] === 'get-access-token')
      return JSON.stringify({ accessToken: TOKEN, expires_on: Math.floor(time / 1000) + 3600, tokenType: 'Bearer' });
    if (args[0] === 'version') return JSON.stringify({ 'azure-cli': '2.70.0' });
    if (args[0] === 'extension') return JSON.stringify({ version: '1.0.1' });
    if (args[0] === 'account' && args[1] === 'show') return JSON.stringify({ user: { name: 'person@example.com' } });
    if (args[0] === 'repos' && args[1] === 'show') return JSON.stringify({ id: repo.azureId });
    throw new Error(`unexpected az ${args.join(' ')}`);
  };
  const fetch = async (url: string | URL | Request) => {
    requests.push(url instanceof Request ? url.url : url.toString());
    const answer = answers.shift() ?? { status: 200, body: { value: [] } };
    if ('error' in answer) throw answer.error;
    return new Response(JSON.stringify(answer.body ?? {}), {
      ...(answer.status === undefined ? {} : { status: answer.status }),
      ...(answer.headers ? { headers: answer.headers } : {}),
    });
  };
  const cli = createAzureCli({
    executor: createRestExecutor({ cliExecutor, fetch, now: () => time }),
    limitPerMinute: 60,
    concurrency: 4,
    now: () => time,
  });
  const provider = createAzureClient({ cli, now: () => time });
  return { cli, provider, requests };
}

/** The failure of one pushes read, with the fields a stream stores and the HTTP layer maps. */
async function failedRead(options: Parameters<typeof live>[0]) {
  const { cli, provider, requests } = live(options);
  const caught: unknown = await provider.read(repo, 'pushes', { since: '2026-11-18T09:00:00Z', until: '2026-11-18T10:00:00Z' }).then(
    () => assert.fail('the read should fail'),
    (error: unknown) => error,
  );
  const { code, message, kind } = caught as { code: string; message: string; kind: string };
  const diagnostics = cli.diagnostics();
  cli.close();
  assert.doesNotMatch(JSON.stringify({ message, caught, diagnostics }), new RegExp(TOKEN), 'the token never leaves the REST reader');
  return { code, message, kind, throttledUntil: diagnostics.throttledUntil, lastError: diagnostics.lastError, requests };
}

/** The status of a repository whose pushes stream stored this error after `failures` failed reads, as sync stores it. */
function statusAfter(error: { code: string; message: string }, failures: number, throttledUntil: string | null = null) {
  const streams = (['pushes', 'refs', 'prs', 'closedPrs', 'builds', 'activeBuilds'] as AzureStream[]).map((stream): StreamState => ({
    repoId: 'a',
    stream,
    initialized: true,
    lastSuccess: new Date(START - 60000).toISOString(),
    lastAttempt: new Date(START).toISOString(),
    nextAt: new Date(START + 120000).toISOString(),
    error: stream === 'pushes' ? error : null,
    failures: stream === 'pushes' ? failures : 0,
    pending: false,
  }));
  return syncStatus({
    repos: [{ id: 'a' }],
    streams,
    jobs: [],
    inProgress: [],
    settings: { refreshEnabled: true, refreshResumedAt: null },
    startedAt: START - 3600000,
    now: START,
    throttledUntil,
  }).repos.a;
}

const AUTH = { code: 'AUTH_REQUIRED', message: 'Azure CLI sign-in is unavailable or expired. Reconnect in your terminal, then retry.' };
const FORBIDDEN = { code: 'FORBIDDEN', message: 'Azure DevOps refused this read. Check the CLI identity and repository permissions.' };
const NOT_FOUND = { code: 'NOT_FOUND', message: 'The requested Azure DevOps resource was not found or is not accessible.' };
const THROTTLED = { code: 'THROTTLED', message: 'Azure DevOps asked us to slow down. Retrying later.' };
const UNAVAILABLE = { code: 'UNAVAILABLE', message: 'Azure DevOps could not be reached. Check your connection or VPN.' };
const CLI_SETUP = {
  code: 'CLI_SETUP',
  message: 'Azure CLI or its azure-devops extension does not support this read. Check the installation.',
};
const CLI_ERROR = { code: 'CLI_ERROR', message: 'Azure CLI could not complete this read. Check access and try again.' };

test('a 401 on the read and on the retry with a renewed token is a sign-in problem from the first failure', async () => {
  const result = await failedRead({ answers: [{ status: 401 }, { status: 401 }] });
  assert.deepEqual([result.code, result.message, result.kind], [AUTH.code, AUTH.message, 'upstream']);
  assert.equal(result.requests.length, 2, 'the read is retried once with a renewed token');
  assert.deepEqual(result.lastError, AUTH);
  assert.deepEqual(statusAfter(AUTH, 1), {
    state: 'problem',
    reason: 'Sign in to Azure again.',
    stream: 'pushes',
    signInRequired: true,
    since: new Date(START - 60000).toISOString(),
  });
});

test('a 403 is an access problem from the first failure', async () => {
  const result = await failedRead({ answers: [{ status: 403 }] });
  assert.deepEqual([result.code, result.message, result.kind], [FORBIDDEN.code, FORBIDDEN.message, 'upstream']);
  assert.equal(result.requests.length, 1);
  assert.deepEqual(statusAfter(FORBIDDEN, 1), {
    state: 'problem',
    reason: "Your Azure account has no access to this repository's pushes.",
    stream: 'pushes',
    since: new Date(START - 60000).toISOString(),
  });
});

test('a 404 is not found, and a problem only once it repeats', async () => {
  const result = await failedRead({ answers: [{ status: 404 }] });
  assert.deepEqual([result.code, result.message, result.kind], [NOT_FOUND.code, NOT_FOUND.message, 'not-found']);
  assert.equal(statusAfter(NOT_FOUND, 1)?.state, 'synced');
  assert.deepEqual(statusAfter(NOT_FOUND, 2), {
    state: 'problem',
    reason: NOT_FOUND.message,
    stream: 'pushes',
    since: new Date(START - 60000).toISOString(),
  });
});

test('a 429 with Retry-After is throttled, pauses the queue for that long, and shows as delayed', async () => {
  const result = await failedRead({ answers: [{ status: 429, headers: { 'retry-after': '120' } }] });
  assert.deepEqual([result.code, result.message, result.kind], [THROTTLED.code, THROTTLED.message, 'upstream']);
  assert.equal(result.throttledUntil, new Date(START + 120000).toISOString());
  assert.deepEqual(statusAfter(THROTTLED, 3, result.throttledUntil), {
    state: 'delayed',
    reason: 'Azure DevOps asked us to slow down',
    since: new Date(START - 60000).toISOString(),
  });
});

test('a 429 without Retry-After is throttled without pausing the queue', async () => {
  const result = await failedRead({ answers: [{ status: 429 }] });
  assert.deepEqual([result.code, result.message], [THROTTLED.code, THROTTLED.message]);
  assert.equal(result.throttledUntil, null);
});

for (const status of [500, 502, 503])
  test(`a ${status} is unavailable, and a problem only once it repeats`, async () => {
    const result = await failedRead({ answers: [{ status }] });
    assert.deepEqual([result.code, result.message, result.kind], [UNAVAILABLE.code, UNAVAILABLE.message, 'upstream']);
    assert.equal(statusAfter(UNAVAILABLE, 1)?.state, 'synced');
    assert.deepEqual(statusAfter(UNAVAILABLE, 2), {
      state: 'problem',
      reason: UNAVAILABLE.message,
      stream: 'pushes',
      since: new Date(START - 60000).toISOString(),
    });
  });

for (const status of [400, 409, 410])
  test(`a ${status} is a generic read failure`, async () => {
    const result = await failedRead({ answers: [{ status }] });
    assert.deepEqual([result.code, result.message, result.kind], [CLI_ERROR.code, CLI_ERROR.message, 'upstream']);
  });

test('a network failure is unavailable and a timeout is a timeout', async () => {
  const network = await failedRead({ answers: [{ error: new TypeError('fetch failed') }] });
  assert.deepEqual([network.code, network.message], [UNAVAILABLE.code, UNAVAILABLE.message]);
  const timeout = await failedRead({ answers: [{ error: Object.assign(new Error('timed out'), { name: 'TimeoutError' }) }] });
  assert.deepEqual([timeout.code, timeout.message], ['TIMEOUT', 'Azure CLI timed out. Cached activity is retained.']);
});

test('a token az cannot give, or gives unusable, is a sign-in problem and no request is sent', async () => {
  const signedOut = await failedRead({
    az: args => (args[1] === 'get-access-token' ? { error: azFailure("ERROR: Please run 'az login' to setup account.") } : undefined),
  });
  assert.deepEqual([signedOut.code, signedOut.message], [AUTH.code, AUTH.message]);
  assert.equal(signedOut.requests.length, 0);
  const unusable = await failedRead({ az: args => (args[1] === 'get-access-token' ? { stdout: '{"accessToken":""}' } : undefined) });
  assert.deepEqual([unusable.code, unusable.message], [AUTH.code, AUTH.message]);
  assert.equal(unusable.requests.length, 0);
  const missing = await failedRead({
    az: args => (args[1] === 'get-access-token' ? { error: Object.assign(new Error('spawn az ENOENT'), { code: 'ENOENT' }) } : undefined),
  });
  assert.deepEqual(
    [missing.code, missing.message],
    ['CLI_MISSING', 'Azure CLI was not found. Install Azure CLI and its azure-devops extension.'],
  );
  assert.deepEqual(statusAfter(missing, 1), {
    state: 'problem',
    reason: 'Install the Azure CLI.',
    stream: 'pushes',
    since: new Date(START - 60000).toISOString(),
  });
});

test('az without the azure-devops command group is a setup problem from the first failure', async () => {
  const { cli, provider } = live({
    az: args => (args[0] === 'repos' ? { error: azFailure("ERROR: 'repos' is misspelled or not recognized by the system.") } : undefined),
  });
  await assert.rejects(provider.resolveRepository({ organization: repo.organization, project: 'P', name: 'R' }), {
    code: CLI_SETUP.code,
    message: CLI_SETUP.message,
  });
  cli.close();
  assert.deepEqual(statusAfter(CLI_SETUP, 1), {
    state: 'problem',
    reason: CLI_SETUP.message,
    stream: 'pushes',
    since: new Date(START - 60000).toISOString(),
  });
});

test('the az commands that stay az are classified from their stderr', async () => {
  const cases: [string, { code: string; message: string }][] = [
    ['ERROR: AADSTS70043: The refresh token has expired due to inactivity.', AUTH],
    // The permission rule runs before the sign-in rule, so "not authorized" with a 401 reads as a permission problem.
    ['ERROR: TF400813: The user is not authorized to access this resource. 401', FORBIDDEN],
    ['ERROR: Forbidden', FORBIDDEN],
    ['ERROR: TF401019: The Git repository with name or identifier R does not exist.', NOT_FOUND],
    ['ERROR: Too many requests', THROTTLED],
    ['ERROR: Max retries exceeded with url (Caused by ProxyError)', UNAVAILABLE],
    ['ERROR: something else', CLI_ERROR],
  ];
  for (const [stderr, expected] of cases) {
    const { cli, provider } = live({ az: args => (args[0] === 'repos' ? { error: azFailure(stderr) } : undefined) });
    await assert.rejects(provider.resolveRepository({ organization: repo.organization, project: 'P', name: 'R' }), expected, stderr);
    cli.close();
  }
});

test('a repository connection check reports a REST read failure the way an activity read reports it', async () => {
  for (const [status, expected] of [
    [401, AUTH],
    [403, FORBIDDEN],
    [404, NOT_FOUND],
    [503, UNAVAILABLE],
  ] as const) {
    const { cli, provider } = live({ answers: [{ status }, { status }] });
    const result = await provider.checkConnection(undefined, repo);
    cli.close();
    assert.equal(result.available, true);
    assert.deepEqual(result.access, { status: 'failed', checkedAt: new Date(START).toISOString(), ...expected }, String(status));
  }
});

test('a read that succeeds after one 401 renews the token and returns the page', async () => {
  const { cli, provider, requests } = live({ answers: [{ status: 401 }, { status: 200, body: { value: [] } }] });
  const page = await provider.read(repo, 'pushes', { since: '2026-11-18T09:00:00Z', until: '2026-11-18T10:00:00Z' });
  cli.close();
  assert.deepEqual(page, { items: [], nextCursor: null });
  assert.equal(requests.length, 2);
});
