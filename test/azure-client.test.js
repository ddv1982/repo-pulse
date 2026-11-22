import test from 'node:test';
import assert from 'node:assert/strict';
import { createAzureClient, reviewOf } from '../server/azure-client.js';
const repo = { id: 'local1', organization: 'https://dev.azure.com/example', project: 'Project', projectId: 'project1', azureId: 'repo1' };
const window = { since: '2026-11-10T11:12:13Z', until: '2026-11-17T11:12:13Z' };

test('push pagination keeps fixed window and includes all refs without branch filtering', async () => {
  const calls = [];
  const client = createAzureClient({
    cli: {
      run: async args => {
        calls.push(args);
        return { value: calls.length === 1 ? Array.from({ length: 100 }, (_, pushId) => ({ pushId })) : [{ pushId: 101 }] };
      },
    },
  });
  const first = await client.read(repo, 'pushes', window);
  assert.deepEqual(first.nextCursor, { skip: 100 });
  const second = await client.read(repo, 'pushes', { ...window, cursor: first.nextCursor });
  assert.equal(second.nextCursor, null);
  assert(calls[1].includes('$skip=100'));
  assert(calls[1].includes('searchCriteria.fromDate=2026-11-10T11:12:13.000Z'));
  assert(calls[1].includes('searchCriteria.includeRefUpdates=true'));
  assert(!calls[1].some(value => value.startsWith('searchCriteria.refName=')));
});

test('closed PR stream uses closed time and pagination instead of creation time', async () => {
  let args;
  const client = createAzureClient({
    cli: {
      run: async input => {
        args = input;
        return { value: [] };
      },
    },
  });
  await client.read(repo, 'closedPrs', window);
  assert(args.includes('searchCriteria.repositoryId=repo1'));
  assert(args.includes('searchCriteria.queryTimeRangeType=closed'));
  assert(args.includes('searchCriteria.status=all'));
  assert(args.includes('searchCriteria.maxTime=2026-11-17T11:12:13.000Z'));
});

test('refs use continuation token and build cache isolates repositories while coalescing matching reads', async () => {
  const calls = [];
  const client = createAzureClient({
    cli: {
      run: async args => {
        calls.push(args);
        return { value: [{ id: 1 }], continuation_token: 'page2' };
      },
    },
  });
  const refs = await client.read(repo, 'refs', window);
  assert.deepEqual(refs.nextCursor, { token: 'page2', allRefs: true });
  await client.read(repo, 'refs', { ...window, cursor: refs.nextCursor });
  assert(calls[1].includes('continuationToken=page2'));
  const [a, b] = await Promise.all([
    client.read(repo, 'builds', window),
    client.read({ ...repo, azureId: 'repo2' }, 'builds', { ...window, since: '2026-11-10T11:13:13Z' }),
  ]);
  assert.equal(calls.length, 4);
  assert.deepEqual(a, b);
  assert(calls[2].includes('repositoryId=repo1'));
  assert(calls[3].includes('repositoryId=repo2'));
  assert(calls[2].includes('repositoryType=TfsGit'));
  await client.read(repo, 'builds', window);
  assert.equal(calls.length, 4);
  assert.equal(a.nextCursor.from, '2026-11-10T11:10:00.000Z');
  const active = await client.read(repo, 'activeBuilds', window);
  assert.equal(active.items[0].id, 1);
  assert(!calls.at(-1).some(value => value.startsWith('minTime=')));
  assert(calls.at(-1).includes('repositoryId=repo1'));
  assert.deepEqual(await client.buildsById(repo, [123]), [{ id: 1 }]);
  assert(calls.at(-1).includes('buildIds=123'));
});

test('malformed responses fail rather than becoming healthy empty activity', async () => {
  const client = createAzureClient({ cli: { run: async () => ({ error: 'bad' }) } });
  await assert.rejects(client.read(repo, 'refs', window), { code: 'INVALID_RESPONSE' });
});

test('resolution strips credentials and connection check never claims CLI account is effective identity', async () => {
  const calls = [];
  const client = createAzureClient({
    cli: {
      run: async args => {
        calls.push(args);
        if (args[0] === 'version') return { 'azure-cli': '2.93.0' };
        if (args[0] === 'extension') return { version: '1.0.2' };
        if (args[0] === 'devops') return { value: [] };
        return {
          id: 'abc',
          name: 'Repo',
          project: { id: 'p', name: 'Project' },
          remoteUrl: 'https://secret@dev.azure.com/example/Project/_git/Repo',
        };
      },
    },
  });
  const resolved = await client.resolveRepository('https://example@dev.azure.com/example/Project/_git/Repo');
  assert.equal(resolved.webUrl, 'https://dev.azure.com/example/Project/_git/Repo');
  assert(!JSON.stringify(resolved).includes('secret'));
  const before = calls.length;
  for (const input of [
    { organization: repo.organization, project: '@notes.txt', name: 'Repo' },
    { organization: repo.organization, project: 'Project', name: '@notes.txt' },
  ])
    await assert.rejects(client.resolveRepository(input), /valid Azure repository/);
  assert.equal(calls.length, before);
  const connection = await client.checkConnection(repo.organization);
  assert.equal(connection.available, true);
  assert.equal(connection.identityVerified, false);
  assert.equal(connection.identity, null);
  assert(!calls.some(args => args.includes('get-access-token')));
});

test('active PR reads are explicitly repo-scoped and exact PR reconciliation uses typed CLI', async () => {
  const calls = [];
  const client = createAzureClient({
    cli: {
      run: async args => {
        calls.push(args);
        return args[0] === 'repos' ? { pullRequestId: 123, repository: { id: 'repo1' } } : { value: [] };
      },
    },
  });
  await client.read(repo, 'prs', window);
  assert(calls[0].includes('searchCriteria.repositoryId=repo1'));
  assert.equal((await client.pullRequest(repo, 123)).pullRequestId, 123);
  assert.deepEqual(calls[1].slice(0, 3), ['repos', 'pr', 'show']);
  const foreign = createAzureClient({ cli: { run: async () => ({ pullRequestId: 123, repository: { id: 'different' } }) } });
  await assert.rejects(foreign.pullRequest(repo, 123), { code: 'WRONG_REPOSITORY' });
  const malformed = createAzureClient({ cli: { run: async () => ({ repository: { id: 'repo1' } }) } });
  await assert.rejects(malformed.pullRequest(repo, 123), { code: 'INVALID_RESPONSE' });
});

test('connection detection reuses local CLI sign-in without acquiring credentials or requiring setup', async () => {
  const calls = [];
  const client = createAzureClient({
    cli: {
      async run(args) {
        calls.push(args);
        if (args[0] === 'version') return { 'azure-cli': '2.93.0' };
        if (args[0] === 'extension') return { version: '1.0.2' };
        if (args[0] === 'account') return { user: { name: 'existing@example.test' }, tenantId: 'tenant', accessToken: 'must-not-return' };
        throw new Error('Unexpected remote operation');
      },
    },
  });
  const status = await client.checkConnection();
  assert.equal(status.available, true);
  assert.equal(status.signedIn, true);
  assert.deepEqual(status.account, { name: 'existing@example.test' });
  assert.equal(status.identityVerified, false);
  assert.equal(JSON.stringify(status).includes('must-not-return'), false);
  assert.deepEqual(
    calls.map(args => args.slice(0, 2).join(' ')),
    ['version', 'extension show', 'account show'],
  );
  await client.checkConnection();
  assert.equal(calls.length, 3, 'local detection is cached');
});

test('a missing account-show context does not reject existing DevOps CLI credentials', async () => {
  const client = createAzureClient({
    cli: {
      async run(args) {
        if (args[0] === 'version') return { 'azure-cli': '2.93.0' };
        if (args[0] === 'extension') return { version: '1.0.2' };
        if (args[0] === 'account') throw Object.assign(new Error('No cached Entra account'), { code: 'AUTH_REQUIRED' });
        return { value: [] };
      },
    },
  });
  const status = await client.checkConnection(repo.organization);
  assert.equal(status.available, true);
  assert.equal(status.signedIn, false);
  assert.equal(status.capabilities.organizationRead, true);
  assert.match(status.message, /Existing Azure CLI access works/);
});

test('dropped commits read one page from the old tip that the new tip does not reach', async () => {
  const old = 'a'.repeat(40),
    tip = 'b'.repeat(40),
    calls = [];
  const client = createAzureClient({
    cli: {
      run: async args => {
        calls.push(args);
        return { value: Array.from({ length: 100 }, () => ({ commitId: old })) };
      },
    },
  });
  const page = await client.droppedCommits(repo, old, tip);
  assert.equal(page.items.length, 100);
  assert.deepEqual(page.nextCursor, { skip: 100 }, 'a full page says more were dropped');
  assert.equal(calls.length, 1);
  const args = calls[0];
  assert(args.includes(`searchCriteria.compareVersion.version=${old}`));
  assert(args.includes(`searchCriteria.itemVersion.version=${tip}`));
  assert(args.includes('searchCriteria.compareVersion.versionType=commit'));
  assert(args.includes('searchCriteria.itemVersion.versionType=commit'));
  assert(args.includes('searchCriteria.$skip=0'));
  assert(!args.some(arg => /fromCommitId|toCommitId|fromDate|toDate|showOldestCommitsFirst/.test(arg)));
});

test('ref creation/deletion/equal tips cannot scan historical ancestry and malformed ranges fail closed', async () => {
  const old = 'a'.repeat(40),
    tip = 'b'.repeat(40),
    zero = '0'.repeat(40);
  let calls = 0;
  const client = createAzureClient({
    cli: {
      run: async () => {
        calls++;
        return { value: [{ commitId: 'not-a-sha' }] };
      },
    },
  });
  for (const [from, to] of [
    [zero, tip],
    [old, zero],
    [old, old],
  ])
    assert.deepEqual(await client.droppedCommits(repo, from, to), { items: [], nextCursor: null });
  assert.equal(calls, 0);
  await assert.rejects(client.droppedCommits(repo, 'refs/heads/main', tip), { code: 'INVALID_QUERY' });
  await assert.rejects(client.droppedCommits(repo, old, tip), { code: 'INVALID_RESPONSE' });
});

test('checkout PR lookup is bounded and accepts completed PRs in the same source and target repository only', async () => {
  const calls = [];
  const sourceRefName = 'refs/heads/feature/test';
  const pr = id => ({
    pullRequestId: id,
    status: 'completed',
    repository: { id: repo.azureId },
    sourceRefName,
    targetRefName: 'refs/heads/release',
    lastMergeSourceCommit: { commitId: 'a'.repeat(40) },
    lastMergeCommit: { commitId: 'b'.repeat(40) },
    completionOptions: { mergeStrategy: 'rebase' },
  });
  const client = createAzureClient({
    cli: {
      run: async args => {
        calls.push(args);
        return {
          value: [
            pr(1),
            { ...pr(2), forkSource: { repository: { id: 'fork' } } },
            { ...pr(3), repository: { id: 'other' } },
            { ...pr(4), status: 'active' },
          ],
        };
      },
    },
  });
  const [pull] = await client.completedCheckoutPulls(repo, sourceRefName);
  assert.equal(pull.id, 1);
  assert.equal(pull.strategy, 'rebase');
  assert.equal((await client.completedCheckoutPulls(repo, sourceRefName)).length, 1);
  assert.equal(calls.length, 1);
  assert.ok(calls[0].includes('$top=20'));
  assert.ok(calls[0].includes('searchCriteria.sourceRepositoryId=repo1'));
  assert.ok(calls[0].includes('searchCriteria.repositoryId=repo1'));
  assert.ok(calls[0].includes('searchCriteria.sourceRefName=' + sourceRefName));
});

test('repository connection check preserves local CLI state when the scoped read fails', async () => {
  const calls = [];
  const client = createAzureClient({
    now: () => 0,
    cli: {
      async run(args) {
        calls.push(args);
        if (args[0] === 'version') return { 'azure-cli': '2.93.0' };
        if (args[0] === 'extension') return { version: '1.0.2' };
        if (args[0] === 'account') return {};
        throw Object.assign(new Error('Repository read refused'), { code: 'FORBIDDEN' });
      },
    },
  });
  const status = await client.checkConnection(undefined, repo);
  assert.equal(status.available, true);
  assert.equal(status.version, '2.93.0');
  assert.deepEqual(status.access, {
    status: 'failed',
    checkedAt: '1970-01-01T00:00:00.000Z',
    code: 'FORBIDDEN',
    message: 'Repository read refused',
  });
  assert.deepEqual(calls.at(-1), [
    'repos',
    'show',
    '--repository',
    repo.azureId,
    '--project',
    repo.projectId || repo.project,
    '--organization',
    repo.organization,
    '--detect',
    'false',
  ]);
});

test('a repository connection check also proves the REST activity read', async () => {
  const calls = [];
  const client = createAzureClient({
    now: () => 0,
    cli: {
      async run(args) {
        calls.push(args);
        if (args[0] === 'version') return { 'azure-cli': '2.93.0' };
        if (args[0] === 'extension') return { version: '1.0.2' };
        if (args[0] === 'account') return {};
        if (args[0] === 'repos') return { id: repo.azureId };
        throw Object.assign(new Error('Azure CLI sign-in is unavailable or expired.'), { code: 'AUTH_REQUIRED' });
      },
    },
  });
  const status = await client.checkConnection(undefined, repo);
  assert.equal(status.access.status, 'failed');
  assert.equal(status.access.code, 'AUTH_REQUIRED');
  const read = calls.at(-1);
  assert.deepEqual(
    [read[0], read[1], read[read.indexOf('--resource') + 1], read[read.indexOf('--http-method') + 1]],
    ['devops', 'invoke', 'refs', 'GET'],
  );
});

test('PR review data counts people’s threads only and keeps each enabled policy result', () => {
  const thread = (status, extra = {}) => ({ status, comments: [{ commentType: 'text' }], ...extra });
  const review = reviewOf(
    [
      thread('active'),
      thread('pending'),
      thread('fixed'),
      thread('closed'),
      thread('active', { isDeleted: true }),
      thread(undefined, { properties: { CodeReviewThreadType: { $value: 'VoteUpdate' } } }),
    ],
    [
      { status: 'approved', configuration: { isEnabled: true, isBlocking: true, type: { displayName: 'Minimum number of reviewers' } } },
      { status: 'rejected', configuration: { isEnabled: true, isBlocking: false, type: { displayName: 'Build' } } },
      { status: 'approved', configuration: { isEnabled: false, type: { displayName: 'Disabled policy' } } },
    ],
  );
  assert.deepEqual(review, {
    threads: { open: 2, resolved: 2 },
    policies: [
      { name: 'Minimum number of reviewers', status: 'approved', blocking: true },
      { name: 'Build', status: 'rejected', blocking: false },
    ],
  });
  assert.throws(() => reviewOf(undefined, []), { code: 'INVALID_RESPONSE' });
});

test('refs restart a snapshot saved by the branch-only query and ask policies for not-applicable results', async () => {
  const calls = [];
  const client = createAzureClient({
    cli: {
      run: async args => {
        calls.push(args);
        return { value: [] };
      },
    },
  });
  const restarted = await client.read(repo, 'refs', { cursor: { token: 'from-heads-only' } });
  assert(!calls[0].some(arg => arg.startsWith('continuationToken=')));
  assert.equal(restarted.restarted, true);
  await client.read(repo, 'refs', { cursor: { token: 'all', allRefs: true } });
  assert(calls[1].includes('continuationToken=all'));
  await client.prReview(repo, 4);
  assert(calls.at(-1).includes('includeNotApplicable=true'));
});

test('a single commit read returns its parents and the push that brought it, and fails closed on bad input', async () => {
  const id = 'a'.repeat(40),
    parent = 'b'.repeat(40);
  const calls = [];
  let body = { commitId: id, parents: [parent.toUpperCase()], push: { pushId: 41 }, comment: 'not kept' };
  const client = createAzureClient({
    cli: {
      run: async args => {
        calls.push(args);
        return body;
      },
    },
  });
  assert.deepEqual(await client.commit(repo, id.toUpperCase()), { parents: [parent], pushId: 41 });
  assert(calls[0].includes(`commitId=${id}`));
  assert(calls[0].includes('changeCount=0'));
  body = { commitId: id, parents: [] };
  assert.deepEqual(await client.commit(repo, id), { parents: [], pushId: null });
  await assert.rejects(client.commit(repo, 'main'), { code: 'INVALID_QUERY' });
  body = { commitId: id, parents: ['not-a-sha'] };
  await assert.rejects(client.commit(repo, id), { code: 'INVALID_RESPONSE' });
  body = { commitId: id };
  await assert.rejects(client.commit(repo, id), { code: 'INVALID_RESPONSE' });
  assert.equal(calls.length, 4);
});
