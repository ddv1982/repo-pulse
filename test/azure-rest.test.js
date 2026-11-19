import test from 'node:test';
import assert from 'node:assert/strict';
import { createAzureCli } from '../server/azure-cli.js';
import { createRestExecutor, AZURE_DEVOPS_RESOURCE } from '../server/azure-rest.js';

const ORG = 'https://dev.azure.com/example';
const TOKEN = 'secret-token-value';
const invoke = (area, resource, route, query = []) => [
  'devops',
  'invoke',
  '--organization',
  ORG,
  '--detect',
  'false',
  '--area',
  area,
  '--resource',
  resource,
  '--api-version',
  '7.1',
  '--http-method',
  'GET',
  '--route-parameters',
  ...route,
  ...(query.length ? ['--query-parameters', ...query] : []),
];

function harness({
  responses = [],
  expiresIn = 3600,
  start = Date.parse('2026-11-18T10:00:00Z'),
  tokenOutput,
  tokenDelay = false,
  setTimer,
} = {}) {
  let time = start;
  const requests = [],
    cliCalls = [];
  const cliExecutor = async args => {
    cliCalls.push(args);
    if (args[0] === 'account' && args[1] === 'get-access-token') {
      if (tokenDelay) await new Promise(setImmediate);
      const custom = tokenOutput?.(cliCalls.length);
      if (custom !== undefined) return custom;
      return JSON.stringify({
        accessToken: `${TOKEN}-${cliCalls.length}`,
        expires_on: Math.floor(time / 1000) + expiresIn,
        tokenType: 'Bearer',
      });
    }
    return JSON.stringify({ via: 'cli', args });
  };
  const fetch = async (url, init) => {
    requests.push({ url: String(url), init });
    const next = (typeof responses === 'function' ? responses(init) : responses.shift()) || { status: 200, body: { count: 0, value: [] } };
    if (next.error) throw next.error;
    if (next.raw) return next.raw;
    return new Response(JSON.stringify(next.body ?? {}), { status: next.status, headers: next.headers });
  };
  const executor = createRestExecutor({ cliExecutor, fetch, now: () => time });
  const cli = createAzureCli({ executor, limitPerMinute: 1000, now: () => time, ...(setTimer && { setTimer, clearTimer: () => {} }) });
  return {
    cli,
    requests,
    cliCalls,
    advance(ms) {
      time += ms;
    },
  };
}

test('invoke reads go to the matching REST URL with a bearer token and keep the continuation token', async () => {
  const { cli, requests, cliCalls } = harness({
    responses: [
      { status: 200, body: { count: 1, value: [{ name: 'refs/heads/main' }] }, headers: { 'x-ms-continuationtoken': 'next-page' } },
    ],
  });
  const result = await cli.run(invoke('git', 'refs', ['project=Proj Id', 'repositoryId=repo-1'], ['filter=heads/', '$top=100']));
  assert.deepEqual(result, { count: 1, value: [{ name: 'refs/heads/main' }], continuationToken: 'next-page' });
  const url = new URL(requests[0].url);
  assert.equal(url.origin + url.pathname, `${ORG}/Proj%20Id/_apis/git/repositories/repo-1/refs`);
  assert.equal(url.searchParams.get('filter'), 'heads/');
  assert.equal(url.searchParams.get('$top'), '100');
  assert.equal(url.searchParams.get('api-version'), '7.1');
  assert.equal(requests[0].init.method, 'GET');
  assert.equal(requests[0].init.headers.authorization, `Bearer ${TOKEN}-1`);
  assert.equal(
    requests[0].init.headers['x-tfs-fedauthredirect'],
    'Suppress',
    'a rejected token is answered with 401, not a sign-in redirect',
  );
  assert.deepEqual(cliCalls, [['account', 'get-access-token', '--resource', AZURE_DEVOPS_RESOURCE]]);
  cli.close();
});

test('commit, build and connection reads use their own routes', async () => {
  const { cli, requests } = harness();
  await cli.run(invoke('git', 'commits', ['project=P', 'repositoryId=r', `commitId=${'a'.repeat(40)}`], ['changeCount=0']));
  await cli.run(invoke('build', 'builds', ['project=P'], ['buildIds=1,2']));
  await cli.run(invoke('location', 'connectionData', []));
  assert.deepEqual(
    requests.map(request => new URL(request.url).pathname),
    [`/example/P/_apis/git/repositories/r/commits/${'a'.repeat(40)}`, '/example/P/_apis/build/builds', '/example/_apis/connectionData'],
  );
  cli.close();
});

test('the token is reused until shortly before it expires and replaced after a 401', async () => {
  const { cli, requests, cliCalls, advance } = harness({
    responses: [{ status: 200 }, { status: 200 }, { status: 200 }, { status: 401 }, { status: 200 }],
  });
  const read = () => cli.run(invoke('git', 'pushes', ['project=P', 'repositoryId=r'], [`$skip=${requests.length}`]));
  await read();
  await read();
  assert.equal(cliCalls.length, 1, 'one token for both reads');
  advance(56 * 60000);
  await read();
  assert.equal(cliCalls.length, 2, 'a token within five minutes of expiry is renewed');
  await read();
  assert.equal(cliCalls.length, 3, 'a rejected token is renewed once and the read retried');
  assert.equal(requests.at(-1).init.headers.authorization, `Bearer ${TOKEN}-3`);
  cli.close();
});

test('other CLI commands still run through az, and writes and token requests are still refused', async () => {
  const { cli, requests, cliCalls } = harness();
  assert.deepEqual(await cli.run(['account', 'show']), { via: 'cli', args: ['account', 'show'] });
  for (const args of [
    ['account', 'get-access-token'],
    ['devops', 'invoke', '--area', 'git', '--resource', 'pushes', '--api-version', '7.1', '--http-method', 'DELETE'],
  ]) {
    await assert.rejects(cli.run(args), { code: 'READ_ONLY' });
  }
  assert.equal(requests.length, 0);
  assert.deepEqual(cliCalls, [['account', 'show']]);
  cli.close();
});

test('HTTP and network failures are classified without exposing the token', async () => {
  const cases = [
    [{ status: 429 }, 'THROTTLED'],
    [{ status: 403 }, 'FORBIDDEN'],
    [{ status: 404 }, 'NOT_FOUND'],
    [{ status: 503 }, 'UNAVAILABLE'],
    [{ error: new TypeError('fetch failed') }, 'UNAVAILABLE'],
    [{ error: Object.assign(new Error('timed out'), { name: 'TimeoutError' }) }, 'TIMEOUT'],
  ];
  for (const [response, code] of cases) {
    const { cli } = harness({ responses: [response] });
    const error = await cli.run(invoke('git', 'pushes', ['project=P', 'repositoryId=r'])).then(
      () => null,
      failure => failure,
    );
    assert.equal(error?.code, code, JSON.stringify(response));
    assert.doesNotMatch(JSON.stringify({ message: error.message, ...error }), new RegExp(TOKEN));
    assert.doesNotMatch(JSON.stringify(cli.diagnostics()), new RegExp(TOKEN));
    cli.close();
  }
});

test('a missing Azure CLI is reported as missing when the token is requested', async () => {
  const executor = createRestExecutor({
    cliExecutor: async () => {
      throw Object.assign(new Error('spawn az ENOENT'), { code: 'ENOENT' });
    },
    fetch: async () => assert.fail('no request without a token'),
  });
  const cli = createAzureCli({ executor });
  await assert.rejects(cli.run(invoke('git', 'pushes', ['project=P', 'repositoryId=r'])), { code: 'CLI_MISSING' });
  cli.close();
});

test('duplicate flags and dot route segments are refused before any request', async () => {
  const { cli, requests } = harness();
  const write = [...invoke('git', 'refs', ['project=P', 'repositoryId=r']), '--http-method', 'POST'];
  await assert.rejects(cli.run(write));
  for (const route of [['project=..', 'repositoryId=r'], ['project=P', 'repositoryId=.'], ['project=P']]) {
    await assert.rejects(cli.run(invoke('git', 'refs', route)), JSON.stringify(route));
  }
  assert.equal(requests.length, 0);
  cli.close();
});

test('an unusable token response is not cached and does not leak into the error', async () => {
  const { cli, cliCalls } = harness({ tokenOutput: call => (call === 1 ? `{"accessToken":"${TOKEN}-broken"` : undefined) });
  const error = await cli.run(invoke('git', 'pushes', ['project=P', 'repositoryId=r'])).then(
    () => null,
    failure => failure,
  );
  assert.equal(error?.code, 'AUTH_REQUIRED');
  assert.doesNotMatch(JSON.stringify({ message: error.message, ...error }), new RegExp(TOKEN));
  await cli.run(invoke('git', 'pushes', ['project=P', 'repositoryId=r'], ['$skip=1']));
  assert.equal(cliCalls.length, 2, 'the next read asks for a new token');
  cli.close();
});

test('concurrent 401s for one token share a single renewal', async () => {
  const { cli, cliCalls } = harness({
    tokenDelay: true,
    responses: init => (init.headers.authorization.endsWith('-1') ? { status: 401 } : { status: 200 }),
  });
  await Promise.all([0, 1].map(skip => cli.run(invoke('git', 'pushes', ['project=P', 'repositoryId=r'], [`$skip=${skip}`]))));
  assert.equal(cliCalls.length, 2, 'one initial token and one shared renewal');
  cli.close();
});

test('response body failures keep their timeout and invalid-response classification', async () => {
  const body = json => ({ raw: { ok: true, status: 200, headers: new Headers(), json } });
  const timeout = Object.assign(new Error('body stalled'), { name: 'TimeoutError' });
  for (const [response, code] of [
    [
      body(async () => {
        throw timeout;
      }),
      'TIMEOUT',
    ],
    [
      body(async () => {
        throw new SyntaxError('bad json');
      }),
      'INVALID_RESPONSE',
    ],
  ]) {
    const { cli } = harness({ responses: [response] });
    await assert.rejects(cli.run(invoke('git', 'pushes', ['project=P', 'repositoryId=r'])), { code });
    cli.close();
  }
});

test('a token with an unusable expiry is reported as a sign-in problem', async () => {
  const { cli } = harness({ tokenOutput: () => JSON.stringify({ accessToken: TOKEN, expiresOn: { toString: null } }) });
  await assert.rejects(cli.run(invoke('git', 'pushes', ['project=P', 'repositoryId=r'])), { code: 'AUTH_REQUIRED' });
  cli.close();
});

test('a replacement token rejected on the retry is not sent again', async () => {
  const { cli, requests } = harness({ responses: init => (init.headers.authorization.endsWith('-3') ? { status: 200 } : { status: 401 }) });
  await assert.rejects(cli.run(invoke('git', 'pushes', ['project=P', 'repositoryId=r'])), { code: 'AUTH_REQUIRED' });
  const before = requests.length;
  await cli.run(invoke('git', 'pushes', ['project=P', 'repositoryId=r'], ['$skip=1']));
  assert.deepEqual(
    requests.slice(before).map(request => request.init.headers.authorization),
    [`Bearer ${TOKEN}-3`],
  );
  cli.close();
});

test('discarded error responses have their bodies cancelled', async () => {
  const cancelled = [];
  const failing = status => ({
    raw: new Response(
      new ReadableStream({
        cancel() {
          cancelled.push(status);
        },
      }),
      { status },
    ),
  });
  const { cli } = harness({ responses: [failing(401), failing(503)] });
  await assert.rejects(cli.run(invoke('git', 'pushes', ['project=P', 'repositoryId=r'])), { code: 'UNAVAILABLE' });
  assert.deepEqual(cancelled, [401, 503]);
  cli.close();
});

for (const scheme of ['http://', ''])
  test(`live network settings send REST reads through the configured proxy${scheme ? '' : ' without a scheme'} and trust the system certificates`, async () => {
    const { createServer } = await import('node:http');
    const { execFile } = await import('node:child_process');
    let hits = 0;
    const proxy = createServer().on('connect', (request, socket) => {
      hits++;
      socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
    });
    await new Promise(done => proxy.listen(0, '127.0.0.1', done));
    const moduleUrl = new URL('../server/azure-rest.js', import.meta.url).href;
    const script = `import tls from 'node:tls'; import { useSystemNetworkSettings } from ${JSON.stringify(moduleUrl)};
    const before = tls.getCACertificates('default').length;
    useSystemNetworkSettings();
    const after = new Set(tls.getCACertificates('default'));
    const system = tls.getCACertificates('system').every(cert => after.has(cert));
    await fetch('https://dev.azure.com/', { signal: AbortSignal.timeout(5000) }).catch(() => {});
    console.log(JSON.stringify({ system, grew: after.size >= before }));`;
    const stdout = await new Promise((resolve, reject) =>
      execFile(
        process.execPath,
        ['--input-type=module', '-e', script],
        {
          env: {
            ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(https?|no|all)_proxy$/i.test(key))),
            HTTPS_PROXY: `${scheme}127.0.0.1:${proxy.address().port}`,
          },
          timeout: 10000,
        },
        (error, out) => (error ? reject(error) : resolve(out)),
      ),
    ).finally(() => proxy.close());
    assert.deepEqual(JSON.parse(stdout.trim().split('\n').at(-1)), { system: true, grew: true });
    assert.equal(hits, 1, 'the REST request went through the proxy');
  });

test('PR thread and policy evaluation reads use their own routes and the policy preview version', async () => {
  const { cli, requests } = harness();
  await cli.run(invoke('git', 'pullRequestThreads', ['project=P', 'repositoryId=r', 'pullRequestId=12']));
  const policy = invoke('policy', 'evaluations', ['project=P'], ['artifactId=vstfs:///CodeReview/CodeReviewId/p/12']);
  policy[policy.indexOf('--api-version') + 1] = '7.1-preview.1';
  await cli.run(policy);
  assert.deepEqual(
    requests.map(request => new URL(request.url).pathname),
    ['/example/P/_apis/git/repositories/r/pullRequests/12/threads', '/example/P/_apis/policy/evaluations'],
  );
  assert.equal(new URL(requests[1].url).searchParams.get('api-version'), '7.1-preview.1');
  await assert.rejects(cli.run(invoke('git', 'pullRequestThreads', ['project=P', 'repositoryId=r', 'pullRequestId=..'])));
  cli.close();
});

/** A harness whose queue timers are recorded instead of run, so a pause can be stepped through on the fake clock. */
function pausing(responses) {
  const timers = [];
  const h = harness({ responses, setTimer: (callback, ms) => timers.push({ callback, ms }) });
  return { ...h, timers };
}
const flush = () => new Promise(resolve => setImmediate(resolve));
const refs = repo => invoke('git', 'refs', ['project=P', `repositoryId=${repo}`]);

test('a 200 with Retry-After returns its data and starts no other call until the wait has passed', async () => {
  const { cli, requests, timers, advance } = pausing([{ status: 200, body: { value: [1] }, headers: { 'retry-after': '30' } }]);
  const start = Date.parse('2026-11-18T10:00:00Z');
  assert.deepEqual(await cli.run(refs('a')), { value: [1] });
  assert.equal(cli.diagnostics().throttledUntil, new Date(start + 30000).toISOString());
  const next = cli.run(refs('b'));
  await flush();
  assert.equal(requests.length, 1);
  assert.equal(timers.at(-1).ms, 30000);
  advance(29999);
  timers.at(-1).callback();
  await flush();
  assert.equal(requests.length, 1, 'still paused one millisecond before the end');
  advance(1);
  timers.at(-1).callback();
  await next;
  assert.equal(requests.length, 2);
  assert.equal(cli.diagnostics().throttledUntil, null);
  cli.close();
});

test('a 429 with Retry-After is a throttled read and pauses the queue the same way', async () => {
  const { cli, requests, timers } = pausing([{ status: 429, headers: { 'retry-after': '30' } }]);
  await assert.rejects(cli.run(refs('a')), { code: 'THROTTLED' });
  cli.run(refs('b')).catch(() => {});
  await flush();
  assert.equal(requests.length, 1);
  assert.equal(timers.at(-1).ms, 30000);
  cli.close();
});

test('Retry-After as an HTTP date pauses until that moment', async () => {
  const start = Date.parse('2026-11-18T10:00:00Z');
  const { cli, timers } = pausing([{ status: 200, headers: { 'retry-after': new Date(start + 45000).toUTCString() } }]);
  await cli.run(refs('a'));
  cli.run(refs('b')).catch(() => {});
  await flush();
  assert.equal(timers.at(-1).ms, 45000);
  cli.close();
});

test('a 401 that arrives while a Retry-After pause is active is not retried until the pause ends', async () => {
  const { cli, requests } = pausing([{ status: 200, headers: { 'retry-after': '30' } }, { status: 401 }, { status: 200 }]);
  const [first, second] = await Promise.allSettled([cli.run(refs('a')), cli.run(refs('b'))]);
  assert.equal(first.status, 'fulfilled');
  assert.equal(second.reason?.code, 'THROTTLED');
  assert.equal(requests.length, 2, 'no token-refresh retry is sent during the pause');
  cli.close();
});

test('an HTTP-date Retry-After is measured from the response Date, so a fast local clock keeps the wait', async () => {
  const start = Date.parse('2026-11-18T10:00:00Z');
  const server = start - 120000;
  const headers = { date: new Date(server).toUTCString(), 'retry-after': new Date(server + 45000).toUTCString() };
  const { cli, timers } = pausing([{ status: 200, headers }]);
  await cli.run(refs('a'));
  cli.run(refs('b')).catch(() => {});
  await flush();
  assert.equal(timers.at(-1)?.ms, 45000);
  cli.close();

  const unreadable = pausing([{ status: 200, headers: { date: 'whenever', 'retry-after': new Date(start + 45000).toUTCString() } }]);
  await unreadable.cli.run(refs('a'));
  unreadable.cli.run(refs('b')).catch(() => {});
  await flush();
  assert.equal(unreadable.timers.at(-1)?.ms, 45000, 'an unreadable Date falls back to the local clock');
  unreadable.cli.close();
});

test('an absurd Retry-After is capped at ten minutes and an unreadable one is ignored', async () => {
  const capped = pausing([{ status: 200, headers: { 'retry-after': '99999999' } }]);
  await capped.cli.run(refs('a'));
  capped.cli.run(refs('b')).catch(() => {});
  await flush();
  assert.equal(capped.timers.at(-1).ms, 10 * 60000);
  capped.cli.close();

  for (const value of ['soon', '-5', '1.5', '']) {
    const ignored = pausing([{ status: 200, headers: { 'retry-after': value } }]);
    await ignored.cli.run(refs('a'));
    await ignored.cli.run(refs('b'));
    assert.equal(ignored.requests.length, 2, `Retry-After ${JSON.stringify(value)} is ignored`);
    assert.equal(ignored.cli.diagnostics().throttledUntil, null);
    ignored.cli.close();
  }
});
